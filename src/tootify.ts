import { BlueskyAccount, ClientErrorResponse, ExpiredTokenError, getRecordUnauthed } from "./bluesky.ts";
import { readConfig } from "./config.ts";
import { initDatabase, Posts } from "./database.ts";
import { pdsHost } from "./did.ts";
import { MastodonAccount } from "./mastodon.ts";
import {
  appendLink,
  attachedImages,
  attachedVideo,
  bskyPostLink,
  expandFacets,
  linkEmbed,
  linksFromFacets,
  quotedPost,
  truncateAlt,
  type PostRecord,
} from "./posts.ts";

interface TootifyConfig {
  extract_link_from_quotes?: boolean;
}

function toInt(value: unknown): number {
  if (typeof value === "number") return Math.trunc(value);
  const n = parseInt(String(value ?? ""), 10);
  return Number.isNaN(n) ? 0 : n;
}

export class Tootify {
  private bluesky = new BlueskyAccount();
  private mastodon = new MastodonAccount();
  private config: TootifyConfig;
  checkInterval = 60;

  constructor() {
    this.config = readConfig<TootifyConfig>("tootify");
    initDatabase();
  }

  async loginToBluesky(handle: string, password: string): Promise<void> {
    const clean = handle.replace(/^@/, "");
    await this.bluesky.loginWithPassword(clean, password);
  }

  async loginToMastodon(handle: string, promptCode: () => Promise<string>): Promise<void> {
    await this.mastodon.oauthLogin(handle, promptCode);
  }

  async sync(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let likes: any[];
    try {
      likes = await this.bluesky.fetchLikes();
    } catch (e) {
      if (e instanceof ExpiredTokenError) {
        await this.bluesky.logIn();
        likes = await this.bluesky.fetchLikes();
      } else {
        throw e;
      }
    }

    const records: Array<[PostRecord, string, string]> = [];

    for (const r of likes) {
      const likeUri: string = r.uri;
      const postUri: string = r.value.subject.uri;
      const parts = postUri.split("/");
      const repo = parts[2];
      const collection = parts[3];
      const rkey = parts[4]!;

      if (!(repo === this.bluesky.did && collection === "app.bsky.feed.post")) continue;

      if (Posts.findByRkey(rkey)) {
        this.log(`Post ${rkey} was already cross-posted, skipping`);
        await this.bluesky.deleteRecordAt(likeUri);
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let record: any;
      try {
        record = await this.bluesky.fetchRecord(repo!, collection!, rkey);
      } catch (e) {
        if (e instanceof ClientErrorResponse) {
          this.log(`Record not found: ${postUri}`);
          await this.bluesky.deleteRecordAt(likeUri);
          continue;
        }
        throw e;
      }

      const reply = record.value.reply;
      if (reply) {
        const parentUri: string = reply.parent.uri;
        const prepo = parentUri.split("/")[2];

        if (prepo !== this.bluesky.did) {
          this.log("Skipping reply to someone else");
          await this.bluesky.deleteRecordAt(likeUri);
          continue;
        }
        // self-reply, we'll try to cross-post it
      }

      records.push([record.value, rkey, likeUri]);
    }

    records.sort((a, b) => {
      const av = String(a[0].createdAt ?? "");
      const bv = String(b[0].createdAt ?? "");
      return av < bv ? -1 : av > bv ? 1 : 0;
    });

    for (const [record, rkey, likeUri] of records) {
      let mastodonParentId: string | null = null;

      const reply = record.reply;
      if (reply) {
        const parentUri = reply.parent?.uri ?? "";
        const parentRkey = parentUri.split("/")[4]!;
        const parentPost = Posts.findByRkey(parentRkey);

        if (parentPost) {
          mastodonParentId = parentPost.mastodon_id;
        } else {
          this.log("Skipping reply to a post that wasn't cross-posted");
          await this.bluesky.deleteRecordAt(likeUri);
          continue;
        }
      }

      const response = await this.postToMastodon(record, mastodonParentId);
      this.log(response);

      Posts.create(rkey, response.id);

      await this.bluesky.deleteRecordAt(likeUri);
    }
  }

  async watch(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await this.sync();
      await Bun.sleep(this.checkInterval * 1000);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async postToMastodon(record: PostRecord, mastodonParentId: string | null = null): Promise<any> {
    this.log(record);

    let text = expandFacets(record);

    const link = linkEmbed(record);
    if (link && !text.includes(link)) {
      text = appendLink(text, link);
    }

    let quoteId: string | undefined;

    const quoteUri = quotedPost(record);
    if (quoteUri) {
      const parts = quoteUri.split("/");
      const repo = parts[2]!;
      const collection = parts[3];
      const rkey = parts[4]!;

      if (collection === "app.bsky.feed.post") {
        let linkToAppend = bskyPostLink(repo, rkey);
        const instanceInfo = await this.mastodon.instanceInfo();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let quotedRecord: any;

        if (toInt(instanceInfo?.api_versions?.mastodon) >= 7) {
          quotedRecord = await this.fetchRecordByAtUri(quoteUri);

          // TODO: we need to wait for Bridgy to add support for quote_authorizations
          const quotedPostUrl = quotedRecord.bridgyOriginalUrl;

          if (quotedPostUrl) {
            const localPost = await this.mastodon.searchPostByUrl(quotedPostUrl);
            if (localPost) {
              const quotePolicy = localPost.quote_approval?.current_user;
              if (quotePolicy === "automatic" || quotePolicy === "manual") {
                quoteId = localPost.id;
              }
            }
          }
        }

        if (!quoteId && this.config.extract_link_from_quotes) {
          quotedRecord ??= await this.fetchRecordByAtUri(quoteUri);
          let quoteLink = linkEmbed(quotedRecord);

          if (quoteLink == null) {
            const textLinks = linksFromFacets(quotedRecord);
            if (textLinks.length === 1) quoteLink = textLinks[0]!;
          }

          if (quoteLink) {
            linkToAppend = quoteLink;
          }
        }

        if (!quoteId && !text.includes(linkToAppend)) {
          text = appendLink(text, linkToAppend);
        }
      }
    }

    let mediaIds: string[] | undefined;

    const images = attachedImages(record);
    if (images) {
      mediaIds = [];
      for (const embed of images) {
        let alt: string | undefined = embed.alt;
        const cid = embed.image.ref.$link;
        const mime = embed.image.mimeType;

        if (alt) alt = truncateAlt(alt, this.mastodon.maxAltLength);

        const data = await this.bluesky.fetchBlob(cid);
        const uploaded = await this.mastodon.uploadMedia(data, cid, mime, alt);
        mediaIds.push(uploaded.id);
      }
    } else {
      const embed = attachedVideo(record);
      if (embed) {
        let alt: string | undefined = embed.alt;
        const cid = embed.video.ref.$link;
        const mime = embed.video.mimeType;

        if (alt) alt = truncateAlt(alt, this.mastodon.maxAltLength);

        const data = await this.bluesky.fetchBlob(cid);
        const uploaded = await this.mastodon.uploadMedia(data, cid, mime, alt);
        mediaIds = [uploaded.id];
      }
    }

    if (record.tags) {
      text += "\n\n" + record.tags.map((t) => "#" + t.replace(/ /g, "")).join(" ");
    }

    return this.mastodon.postStatus(text, {
      mediaIds,
      parentId: mastodonParentId,
      quotedStatusId: quoteId,
    });
  }

  private async fetchRecordByAtUri(quoteUri: string): Promise<PostRecord> {
    const parts = quoteUri.split("/");
    const repo = parts[2]!;
    const collection = parts[3]!;
    const rkey = parts[4]!;
    const host = await pdsHost(repo);
    const resp = await getRecordUnauthed(host, repo, collection, rkey);
    return resp.value;
  }

  private log(obj: unknown): void {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    console.log(`[${new Date().toISOString()}] ${text}`);
  }
}
