import { BlueskyAccount, ClientErrorResponse, ExpiredTokenError, getRecordUnauthed } from "./bluesky.ts";
import { composeStatuses, NO_QUOTE, type ResolvedQuote, type StatusPart } from "./compose.ts";
import { CROSSPOST_ALL_WATERMARK, initDatabase, Meta, Posts, type PostRow } from "./database.ts";
import { didToHandle, pdsHost } from "./did.ts";
import { APIError, MastodonAccount, type InstanceCapabilities } from "./mastodon.ts";
import {
  appendLink,
  bskyPostLink,
  bskyProfileLink,
  ineligibleReason,
  linkEmbed,
  linksFromFacets,
  mentionRefs,
  parseAtUri,
  postTimestamp,
  quotedPost,
  tidToDate,
  truncateAlt,
  type MediaItem,
  type PostRecord,
} from "./posts.ts";
import { loadSettings, type TootifySettings } from "./settings.ts";

const POST_COLLECTION = "app.bsky.feed.post";

/** A post that passed the eligibility checks and is queued for cross-posting. */
interface Candidate {
  rkey: string;
  record: PostRecord;
  timestamp: Date | null;
  /** AT-URI of the self-like that selected this post, in like mode only. */
  likeUri: string | null;
}

/** Status codes that mean the request was rejected without creating anything. */
function isRejection(e: unknown): e is APIError {
  return e instanceof APIError && [400, 404, 422].includes(e.status);
}

export class Tootify {
  private bluesky = new BlueskyAccount();
  private mastodon = new MastodonAccount();
  private settings: TootifySettings;
  private ownHandle: string | null = null;
  private mentionCache = new Map<string, string>();

  constructor(settings?: TootifySettings) {
    this.settings = settings ?? loadSettings();
    initDatabase();
  }

  get checkInterval(): number {
    return this.settings.checkInterval;
  }

  set checkInterval(value: number) {
    this.settings.checkInterval = value;
  }

  async loginToBluesky(handle: string, password: string): Promise<void> {
    const clean = handle.replace(/^@/, "");
    await this.bluesky.loginWithPassword(clean, password);
  }

  async loginToMastodon(handle: string, promptCode: () => Promise<string>): Promise<void> {
    await this.mastodon.oauthLogin(handle, promptCode);
  }

  /* ---------------------------------------------------------------------- */
  /* Main loop                                                               */
  /* ---------------------------------------------------------------------- */

  async sync(): Promise<void> {
    if (this.settings.dryRun) {
      this.log("DRY RUN – nothing will be posted to Mastodon and no likes will be removed");
    }

    const candidates = this.settings.crosspostAll
      ? await this.collectAllPosts()
      : await this.collectLikedPosts();

    // Oldest first, so a parent is always cross-posted before its replies and
    // an earlier post exists to be quoted by a later one.
    candidates.sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));

    const queued = candidates.slice(0, this.settings.maxPostsPerRun);
    if (queued.length < candidates.length) {
      this.log(
        `Cross-posting ${queued.length} of ${candidates.length} eligible posts this run ` +
          `(max_posts_per_run); the rest will follow on the next run`,
      );
    }

    for (const candidate of queued) {
      try {
        await this.crosspost(candidate);
      } catch (e) {
        // Keep going: one bad post must not stall a `watch` loop. Replies to
        // this post are skipped automatically, since it never reached the
        // history database.
        this.log(`Failed to cross-post ${candidate.rkey}: ${errorMessage(e)}`);
      }
    }
  }

  async watch(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await this.sync();
      } catch (e) {
        this.log(`Sync failed: ${errorMessage(e)}`);
      }
      await Bun.sleep(this.checkInterval * 1000);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Selecting posts                                                         */
  /* ---------------------------------------------------------------------- */

  /** Like mode: a post is cross-posted when you have liked it yourself. */
  private async collectLikedPosts(): Promise<Candidate[]> {
    const likes = await this.withAuth(() => this.bluesky.fetchLikes());
    const candidates: Candidate[] = [];

    for (const like of likes) {
      const likeUri: string = like.uri;
      const subject = parseAtUri(like.value?.subject?.uri);
      if (!subject) continue;

      if (subject.repo !== this.bluesky.did || subject.collection !== POST_COLLECTION) continue;

      if (Posts.findByRkey(subject.rkey)) {
        this.log(`Post ${subject.rkey} was already cross-posted, skipping`);
        await this.removeLike(likeUri);
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let response: any;
      try {
        response = await this.withAuth(() =>
          this.bluesky.fetchRecord(subject.repo, subject.collection, subject.rkey),
        );
      } catch (e) {
        if (e instanceof ClientErrorResponse) {
          this.log(`Record not found: ${like.value.subject.uri}`);
          await this.removeLike(likeUri);
          continue;
        }
        throw e;
      }

      const record: PostRecord = response.value;
      const reason = this.ineligibleReason(record);
      if (reason) {
        this.log(`Skipping ${subject.rkey}: ${reason}`);
        await this.removeLike(likeUri);
        continue;
      }

      candidates.push({
        rkey: subject.rkey,
        record,
        timestamp: postTimestamp(record, subject.rkey),
        likeUri,
      });
    }

    return candidates;
  }

  /**
   * Crosspost-all mode: every eligible post in the repo, newer than the
   * backfill watermark and not already cross-posted. Likes are left completely
   * alone in this mode — they are no longer a signal, so removing them would
   * be destroying data the user didn't ask us to touch.
   */
  private async collectAllPosts(): Promise<Candidate[]> {
    const since = this.backfillWatermark();
    if (since) {
      this.log(`Scanning posts created since ${since.toISOString()}`);
    } else {
      this.log("Scanning the entire post history (backfill_all)");
    }

    const records = await this.withAuth(() =>
      this.bluesky.fetchPosts(
        (record) => {
          // Records come back ordered by record key, so the first key older
          // than the watermark ends the scan. `createdAt` deliberately isn't
          // used here: it's client-supplied, and a backdated post must not cut
          // the scan short and hide the genuinely newer posts behind it.
          const parsed = parseAtUri(record?.uri);
          if (!parsed || !since) return false;
          const at = tidToDate(parsed.rkey);
          return at != null && at.getTime() < since.getTime();
        },
        // A full backfill is allowed to walk much further back than a routine
        // incremental run needs to.
        this.settings.backfillAll ? 500 : 20,
      ),
    );

    const candidates: Candidate[] = [];

    for (const entry of records) {
      const parsed = parseAtUri(entry?.uri);
      if (!parsed) continue;

      const record: PostRecord = entry.value ?? {};
      const at = postTimestamp(record, parsed.rkey);

      // A backdated `createdAt` can put a post behind the watermark even
      // though its record key is newer, so re-check per record.
      if (since && at != null && at.getTime() < since.getTime()) continue;
      if (Posts.findByRkey(parsed.rkey)) continue;

      const reason = this.ineligibleReason(record);
      if (reason) {
        this.log(`Skipping ${parsed.rkey}: ${reason}`);
        continue;
      }

      candidates.push({ rkey: parsed.rkey, record, timestamp: at, likeUri: null });
    }

    return candidates;
  }

  /**
   * The instant crosspost-all mode started caring about posts. Established on
   * the first run so that turning the mode on doesn't dump years of history
   * onto Mastodon; override with backfill_since or backfill_all.
   */
  private backfillWatermark(): Date | null {
    if (this.settings.backfillAll) return null;

    if (this.settings.backfillSince) return new Date(this.settings.backfillSince);

    const stored = Meta.get(CROSSPOST_ALL_WATERMARK);
    if (stored) return new Date(stored);

    const now = new Date();
    if (this.settings.dryRun) {
      this.log("First crosspost-all run (dry run): the watermark would be set to now");
    } else {
      Meta.set(CROSSPOST_ALL_WATERMARK, now.toISOString());
      this.log(
        "First run in crosspost-all mode: only posts from now on will be cross-posted. " +
          "Set TOOTIFY_BACKFILL_SINCE or TOOTIFY_BACKFILL_ALL to include older posts.",
      );
    }
    return now;
  }

  private ineligibleReason(record: PostRecord): string | null {
    return ineligibleReason(record, this.bluesky.did, this.settings);
  }

  /* ---------------------------------------------------------------------- */
  /* Cross-posting one record                                                */
  /* ---------------------------------------------------------------------- */

  private async crosspost(candidate: Candidate): Promise<void> {
    const { rkey, record, likeUri } = candidate;

    let parentStatusId: string | null = null;
    if (record.reply) {
      const parent = parseAtUri(record.reply.parent?.uri);
      const parentRow = parent ? Posts.findByRkey(parent.rkey) : null;
      if (!parentRow) {
        this.log(`Skipping ${rkey}: reply to a post that wasn't cross-posted`);
        await this.removeLike(likeUri);
        return;
      }
      // Chain onto the last status of the parent so a thread that was split
      // across several toots still reads in order.
      parentStatusId = parentRow.mastodon_last_id ?? parentRow.mastodon_id;
    }

    const capabilities = await this.mastodon.getCapabilities();

    const { parts, notes } = composeStatuses({
      record,
      rkey,
      selfHandle: await this.selfHandle(),
      mentions: await this.buildMentionMap(record),
      quote: await this.resolveQuote(record, capabilities),
      capabilities,
      options: this.settings,
    });
    for (const note of notes) this.log(note);

    if (this.settings.dryRun) {
      this.log(`Would cross-post ${rkey} as ${parts.length} status(es):`);
      for (const part of parts) {
        this.log(JSON.stringify({ ...part, media: part.media.map((m) => summarizeMedia(m)) }));
      }
      return;
    }

    let replyTo = parentStatusId;
    let firstId: string | null = null;

    for (const part of parts) {
      const mediaIds = await this.uploadMedia(part.media, capabilities);

      // Every attachment failed to upload and there is nothing else to say:
      // posting an empty status would just error out.
      if (mediaIds.length === 0 && part.text.trim().length === 0) continue;

      const status = await this.postStatus(part, mediaIds, replyTo);
      this.log(`Posted ${status.url ?? status.id}`);

      if (firstId == null) {
        firstId = status.id;
        // Recorded before the rest of the thread goes out, so a crash here
        // can't cause the whole post to be sent again on the next run.
        Posts.create(rkey, status.id, status.url ?? null);
      } else {
        Posts.setLastId(rkey, status.id);
      }
      replyTo = status.id;
    }

    if (firstId == null) {
      this.log(`Nothing to post for ${rkey} (no text and no usable media)`);
      return;
    }

    await this.removeLike(likeUri);
  }

  /** POST the status, retrying without the quote if the instance refuses it. */
  private async postStatus(
    part: StatusPart,
    mediaIds: string[],
    replyTo: string | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const base = {
      mediaIds,
      parentId: replyTo,
      language: part.language,
      spoilerText: part.spoilerText,
      sensitive: part.sensitive,
      visibility: this.settings.visibility,
    };

    if (!part.quotedStatusId) {
      return this.mastodon.postStatus(part.text, base);
    }

    try {
      return await this.mastodon.postStatus(part.text, {
        ...base,
        quotedStatusId: part.quotedStatusId,
      });
    } catch (e) {
      if (!isRejection(e)) throw e;
      // The instance advertised quote support but rejected this particular
      // quote (revoked authorisation, unknown post, a fork that only
      // half-implements it). Nothing was created, so it's safe to retry as a
      // plain post with the link in the body.
      this.log(`Quote rejected (${e.status}), falling back to a link: ${e.body}`);
      const text =
        part.quoteLink && !part.text.includes(part.quoteLink)
          ? appendLink(part.text, part.quoteLink, "RE: ")
          : part.text;
      return this.mastodon.postStatus(text, base);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Mentions                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Work out what each `@mention` should become. Bluesky mentions carry a DID,
   * and the handle in the text can be stale, so the DID document is the source
   * of truth. A bare `@someone.bsky.social` left in the text would either mean
   * nothing on Mastodon or resolve to an unrelated local account, so the
   * default is to turn it into a link to the Bluesky profile.
   */
  private async buildMentionMap(record: PostRecord): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (this.settings.mentionStyle === "keep") return map;

    for (const ref of mentionRefs(record)) {
      const cached = this.mentionCache.get(ref.did);
      if (cached != null) {
        map.set(ref.did, cached);
        continue;
      }

      const handle = (await didToHandle(ref.did)) ?? ref.handle ?? ref.did;
      const rendered = await this.renderMention(handle);
      this.mentionCache.set(ref.did, rendered);
      map.set(ref.did, rendered);
    }
    return map;
  }

  private async renderMention(handle: string): Promise<string> {
    switch (this.settings.mentionStyle) {
      case "plain":
        return handle;

      case "bridge": {
        // Bridgy Fed mirrors Bluesky accounts as handle@bsky.brid.gy; when the
        // person is bridged this becomes a real, notifying fediverse mention.
        const acct = `${handle}@${this.settings.bridgeDomain}`;
        const account = await this.mastodon.findAccount(acct);
        if (account?.acct) return `@${account.acct}`;
        return bskyProfileLink(handle);
      }

      default:
        return bskyProfileLink(handle);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Quotes                                                                  */
  /* ---------------------------------------------------------------------- */

  private quotesEnabled(capabilities: InstanceCapabilities): boolean {
    switch (this.settings.quoteMode) {
      case "on":
        return true;
      case "off":
        return false;
      default:
        return capabilities.supportsQuotes;
    }
  }

  private async resolveQuote(
    record: PostRecord,
    capabilities: InstanceCapabilities,
  ): Promise<ResolvedQuote> {
    const quoted = parseAtUri(quotedPost(record));
    if (!quoted) return NO_QUOTE;

    // Feeds, lists and starter packs can be embedded like quotes but have no
    // fediverse equivalent, so they just become links.
    if (quoted.collection !== POST_COLLECTION) {
      return { statusId: null, link: bskyRecordLink(quoted.collection, quoted.repo, quoted.rkey) };
    }

    return quoted.repo === this.bluesky.did
      ? this.resolveSelfQuote(quoted.rkey, capabilities)
      : this.resolveForeignQuote(record, quoted.repo, quoted.rkey, capabilities);
  }

  /**
   * Quoting your own earlier post. The history database already knows which
   * toot it became, so this needs no search and works no matter how long ago
   * the original went out: a native quote where the instance supports one, and
   * a link to the actual toot — not the bsky.app URL — where it doesn't.
   */
  private async resolveSelfQuote(
    rkey: string,
    capabilities: InstanceCapabilities,
  ): Promise<ResolvedQuote> {
    const row = Posts.findByRkey(rkey);
    if (!row) {
      this.log(`Quoted own post ${rkey} hasn't been cross-posted; linking to Bluesky instead`);
      return { statusId: null, link: bskyPostLink(await this.selfHandle(), rkey) };
    }

    const link = (await this.statusUrl(row, rkey)) ?? bskyPostLink(await this.selfHandle(), rkey);

    // You are always allowed to quote yourself, so there's no approval policy
    // to check here.
    return { statusId: this.quotesEnabled(capabilities) ? row.mastodon_id : null, link };
  }

  private async resolveForeignQuote(
    record: PostRecord,
    repo: string,
    rkey: string,
    capabilities: InstanceCapabilities,
  ): Promise<ResolvedQuote> {
    const quoteUri = `at://${repo}/${POST_COLLECTION}/${rkey}`;
    let quotedRecord: PostRecord | null = null;

    const fetchQuoted = async (): Promise<PostRecord | null> => {
      if (quotedRecord) return quotedRecord;
      try {
        quotedRecord = await this.fetchRecordByAtUri(quoteUri);
      } catch (e) {
        this.log(`Couldn't read quoted post ${quoteUri}: ${errorMessage(e)}`);
        quotedRecord = null;
      }
      return quotedRecord;
    };

    let statusId: string | null = null;
    let link: string | null = null;

    // Look for the fediverse copy even when the instance can't author quotes:
    // linking to the bridged toot still reads far better than a bsky.app URL.
    const local = await this.findBridgedStatus(await fetchQuoted(), repo, rkey);
    if (local) {
      link = local.url ?? null;
      if (this.quotesEnabled(capabilities)) {
        const policy = local.quote_approval?.current_user;
        if (policy === "automatic" || policy === "manual") {
          statusId = local.id;
        } else if (policy) {
          this.log(`Not allowed to quote ${local.url} (policy: ${policy}); linking instead`);
        }
      }
    }

    if (!statusId && this.settings.extractLinkFromQuotes) {
      // "Collapse" a quote of someone else's link post into a plain post that
      // links straight to the article, so Mastodon shows that link's card
      // rather than a card for the bsky.app page.
      const quoted = await fetchQuoted();
      if (quoted) {
        let quoteLink = linkEmbed(quoted);
        if (quoteLink == null) {
          const textLinks = linksFromFacets(quoted);
          if (textLinks.length === 1) quoteLink = textLinks[0]!;
        }
        if (quoteLink) return { statusId: null, link: quoteLink };
      }
    }

    const handle = (await didToHandle(repo)) ?? repo;
    return { statusId, link: link ?? bskyPostLink(handle, rkey) };
  }

  /**
   * Try to find the fediverse copy of a Bluesky post. Bridgy Fed publishes
   * bridged posts under a few different identifiers depending on age, so try
   * each one; a miss just means the author isn't bridged.
   */
  private async findBridgedStatus(
    quotedRecord: PostRecord | null,
    repo: string,
    rkey: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any | null> {
    const candidates: string[] = [];

    // Posts that Bridgy itself mirrored *onto* Bluesky record where they came
    // from, which is the canonical fediverse URL.
    const original = (quotedRecord as { bridgyOriginalUrl?: unknown } | null)?.bridgyOriginalUrl;
    if (typeof original === "string" && original.length > 0) candidates.push(original);

    const handle = (await didToHandle(repo)) ?? repo;
    candidates.push(bskyPostLink(handle, rkey));
    if (handle !== repo) candidates.push(bskyPostLink(repo, rkey));

    for (const url of candidates) {
      const status = await this.mastodon.searchPostByUrl(url);
      if (status?.id) return status;
    }
    return null;
  }

  /** The public URL of one of our own toots, fetched and cached on demand. */
  private async statusUrl(row: PostRow, rkey: string): Promise<string | null> {
    if (row.mastodon_url) return row.mastodon_url;

    try {
      const status = await this.mastodon.getStatus(row.mastodon_id);
      if (status?.url) {
        Posts.setUrl(rkey, status.url);
        return status.url;
      }
    } catch (e) {
      this.log(`Couldn't look up status ${row.mastodon_id}: ${errorMessage(e)}`);
    }
    return null;
  }

  /* ---------------------------------------------------------------------- */
  /* Media                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Fetch each blob from the PDS and upload it, carrying the alt text across.
   * A single failed attachment is logged and skipped rather than failing the
   * whole post, so one oversized image doesn't cost you the other nine.
   */
  private async uploadMedia(
    items: MediaItem[],
    capabilities: InstanceCapabilities,
  ): Promise<string[]> {
    const ids: string[] = [];

    for (const item of items) {
      if (
        capabilities.supportedMimeTypes &&
        !capabilities.supportedMimeTypes.includes(item.mimeType)
      ) {
        this.log(`Instance doesn't accept ${item.mimeType}; skipping attachment ${item.cid}`);
        continue;
      }

      try {
        const data = await this.withAuth(() => this.bluesky.fetchBlob(item.cid));
        const alt = item.alt ? truncateAlt(item.alt, capabilities.altLength) : undefined;
        const uploaded = await this.mastodon.uploadMedia(
          data,
          filenameFor(item),
          item.mimeType,
          alt,
        );
        ids.push(uploaded.id);
      } catch (e) {
        this.log(`Couldn't attach ${item.cid}: ${errorMessage(e)}`);
      }
    }

    return ids;
  }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Run a Bluesky call, logging back in once if the session has expired. */
  private async withAuth<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ExpiredTokenError)) throw e;
      await this.bluesky.logIn();
      return fn();
    }
  }

  /** Remove the self-like that triggered a cross-post, unless we're dry-running. */
  private async removeLike(likeUri: string | null): Promise<void> {
    if (!likeUri || this.settings.dryRun) return;
    await this.withAuth(() => this.bluesky.deleteRecordAt(likeUri));
  }

  private async selfHandle(): Promise<string> {
    if (this.ownHandle == null) {
      this.ownHandle = (await didToHandle(this.bluesky.did)) ?? this.bluesky.did;
    }
    return this.ownHandle;
  }

  private async fetchRecordByAtUri(quoteUri: string): Promise<PostRecord> {
    const parts = parseAtUri(quoteUri);
    if (!parts) throw new Error(`Not an AT-URI: ${quoteUri}`);
    const host = await pdsHost(parts.repo);
    const resp = await getRecordUnauthed(host, parts.repo, parts.collection, parts.rkey);
    return resp.value;
  }

  private log(obj: unknown): void {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    console.log(`[${new Date().toISOString()}] ${text}`);
  }
}

function bskyRecordLink(collection: string, repo: string, rkey: string): string {
  const path =
    collection === "app.bsky.feed.generator"
      ? "feed"
      : collection === "app.bsky.graph.list"
        ? "lists"
        : collection === "app.bsky.graph.starterpack"
          ? "starter-pack"
          : "post";
  return `https://bsky.app/profile/${repo}/${path}/${rkey}`;
}

function filenameFor(item: MediaItem): string {
  const extension = item.mimeType.split("/")[1]?.split("+")[0] ?? "bin";
  return `${item.cid}.${extension}`;
}

function summarizeMedia(item: MediaItem): string {
  return `${item.kind}:${item.mimeType}${item.alt ? ` alt=${JSON.stringify(item.alt)}` : " (no alt)"}`;
}

function errorMessage(e: unknown): string {
  if (e instanceof APIError) return `${e.name} ${e.status}: ${e.body}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
