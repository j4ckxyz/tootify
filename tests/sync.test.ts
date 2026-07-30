import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSettings, type TootifySettings } from "../src/settings.ts";

// End-to-end exercise of a sync run: the Bluesky PDS, the PLC directory and the
// Mastodon instance are all faked, so the ordering, threading, quoting and
// media logic runs for real against realistic API shapes.

const TMP = mkdtempSync(join(tmpdir(), "tootify-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const ME = "did:plc:me";
const THEM = "did:plc:them";
const PDS = "pds.example";
const INSTANCE = "mastodon.example";

const CONFIGS: Record<string, object> = {
  bluesky: { host: PDS, id: "j4ck.xyz", pass: "hunter2", did: ME, accessToken: "tok" },
  mastodon: { handle: "j4ck@mastodon.example", access_token: "mtok", user_id: "1" },
  tootify: {},
};

mock.module("../src/config.ts", () => ({
  CONFIG_DIR: TMP,
  DB_FILE: join(TMP, "history.sqlite3"),
  ensureConfigDir: () => {},
  readConfig: (name: string) => structuredClone(CONFIGS[name] ?? {}),
  writeConfig: () => {},
}));

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function blob(cid: string, mimeType = "image/jpeg") {
  return { $type: "blob", ref: { $link: cid }, mimeType, size: 900 };
}

function at(did: string, rkey: string) {
  return { uri: `at://${did}/app.bsky.feed.post/${rkey}` };
}

/** A gallery embed, the shape Bluesky uses for posts of up to 10 images. */
function gallery(count: number) {
  return {
    $type: "app.bsky.embed.gallery",
    items: Array.from({ length: count }, (_, i) => ({
      $type: "app.bsky.embed.gallery#image",
      alt: `alt ${i + 1}`,
      image: blob(`gcid${i + 1}`),
      aspectRatio: { width: 4, height: 3 },
    })),
  };
}

interface PostFixture {
  rkey: string;
  value: Record<string, unknown>;
}

// Deliberately listed newest-first, the way listRecords returns them.
const BASE_POSTS: PostFixture[] = [
  {
    rkey: "postG",
    value: {
      text: "a thought after the pictures",
      createdAt: "2026-07-07T00:00:00Z",
      reply: { parent: at(ME, "postE"), root: at(ME, "postE") },
    },
  },
  {
    rkey: "postF",
    value: {
      text: "worth reading",
      createdAt: "2026-07-06T00:00:00Z",
      embed: { $type: "app.bsky.embed.record", record: at(THEM, "theirs") },
    },
  },
  {
    rkey: "postE",
    value: { text: "ten pictures", createdAt: "2026-07-05T00:00:00Z", embed: gallery(10) },
  },
  {
    rkey: "postD",
    value: {
      text: "I disagree",
      createdAt: "2026-07-04T00:00:00Z",
      reply: { parent: at(THEM, "theirs"), root: at(THEM, "theirs") },
    },
  },
  {
    rkey: "postC",
    value: {
      text: "still true",
      createdAt: "2026-07-03T00:00:00Z",
      embed: { $type: "app.bsky.embed.record", record: at(ME, "postA") },
    },
  },
  {
    rkey: "postB",
    value: {
      text: "and another thing",
      createdAt: "2026-07-02T00:00:00Z",
      reply: { parent: at(ME, "postA"), root: at(ME, "postA") },
    },
  },
  { rkey: "postA", value: { text: "first post", createdAt: "2026-07-01T00:00:00Z" } },
];

/* -------------------------------------------------------------------------- */
/* Fake network                                                                */
/* -------------------------------------------------------------------------- */

interface PostedStatus {
  status: string;
  media_ids: string[];
  in_reply_to_id?: string;
  quoted_status_id?: string;
  language?: string;
  spoiler_text?: string;
  visibility?: string;
}

interface Captured {
  statuses: PostedStatus[];
  uploads: Array<{ filename: string; description: string | null }>;
  deletedLikes: string[];
  blobsFetched: string[];
}

let captured: Captured;
let instanceDoc: Record<string, unknown>;
let likes: Array<{ uri: string; value: { subject: { uri: string } } }>;
let searchResult: unknown;
let posts: PostFixture[];
let bridgedAccounts: string[];

/** Add a fixture that sorts newest, so it is cross-posted last. */
function addNewestPost(rkey: string, value: Record<string, unknown>): void {
  posts = [{ rkey, value }, ...posts];
}

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function didDocument(did: string): Record<string, unknown> {
  return {
    id: did,
    alsoKnownAs: [did === ME ? "at://j4ck.xyz" : "at://them.example"],
    service: [
      {
        id: "#atproto_pds",
        type: "AtprotoPersonalDataServer",
        serviceEndpoint: `https://${PDS}`,
      },
    ],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installFakeFetch(): void {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const path = url.pathname;

    /* ---- PLC directory ------------------------------------------------- */
    if (url.host === "plc.directory") {
      return json(didDocument(path.slice(1)));
    }

    /* ---- Bluesky PDS --------------------------------------------------- */
    if (url.host === PDS) {
      const nsid = path.replace("/xrpc/", "");

      if (nsid === "com.atproto.repo.listRecords") {
        const collection = url.searchParams.get("collection");
        if (collection === "app.bsky.feed.like") return json({ records: likes });
        return json({
          records: posts.map((p) => ({ uri: `at://${ME}/app.bsky.feed.post/${p.rkey}`, value: p.value })),
        });
      }

      if (nsid === "com.atproto.repo.getRecord") {
        const repo = url.searchParams.get("repo")!;
        const rkey = url.searchParams.get("rkey")!;
        if (repo === THEM) {
          return json({ uri: `at://${THEM}/app.bsky.feed.post/${rkey}`, value: { text: "theirs" } });
        }
        const found = posts.find((p) => p.rkey === rkey);
        if (!found) return json({ error: "RecordNotFound" }, 400);
        return json({ uri: `at://${ME}/app.bsky.feed.post/${rkey}`, value: found.value });
      }

      if (nsid === "com.atproto.sync.getBlob") {
        captured.blobsFetched.push(url.searchParams.get("cid")!);
        return new Response(new Uint8Array([1, 2, 3, 4]));
      }

      if (nsid === "com.atproto.repo.deleteRecord") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        captured.deletedLikes.push(`at://${body.repo}/${body.collection}/${body.rkey}`);
        return json({});
      }

      if (nsid === "com.atproto.server.createSession") {
        return json({ did: ME, accessJwt: "tok", refreshJwt: "ref" });
      }
    }

    /* ---- Mastodon ------------------------------------------------------ */
    if (url.host === INSTANCE) {
      if (path === "/api/v2/instance") return json(instanceDoc);
      if (path === "/api/v2/search") return json(searchResult);

      if (path === "/api/v1/accounts/lookup") {
        const acct = url.searchParams.get("acct") ?? "";
        if (!bridgedAccounts.includes(acct)) return json({ error: "Record not found" }, 404);
        return json({ id: "42", acct, username: acct.split("@")[0] });
      }

      if (path === "/api/v2/media") {
        const form = init?.body as FormData;
        const file = form.get("file") as File;
        const description = form.get("description");
        captured.uploads.push({
          filename: file.name,
          description: description == null ? null : String(description),
        });
        const id = `media${captured.uploads.length}`;
        return json({ id, url: `https://${INSTANCE}/media/${id}` });
      }

      if (path === "/api/v1/statuses" && init?.method === "POST") {
        const params = new URLSearchParams(String(init.body));
        const posted: PostedStatus = {
          status: params.get("status") ?? "",
          media_ids: params.getAll("media_ids[]"),
        };
        for (const key of [
          "in_reply_to_id",
          "quoted_status_id",
          "language",
          "spoiler_text",
          "visibility",
        ] as const) {
          const value = params.get(key);
          if (value != null) posted[key] = value;
        }
        captured.statuses.push(posted);
        const id = String(100 + captured.statuses.length);
        return json({ id, url: `https://${INSTANCE}/@j4ck/${id}` });
      }
    }

    throw new Error(`Unexpected request: ${url.toString()}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

// Imported lazily so the config mock is registered before the module graph is
// loaded and picks up the real config paths.
async function newApp(overrides: Partial<TootifySettings> = {}) {
  const { Tootify } = await import("../src/tootify.ts");
  return new Tootify({ ...resolveSettings({}, {}), backfillAll: true, ...overrides });
}

async function runSync(overrides: Partial<TootifySettings> = {}): Promise<Captured> {
  await (await newApp(overrides)).sync();
  return captured;
}

beforeEach(async () => {
  // Each test starts from an empty history database.
  const { closeDatabase } = await import("../src/database.ts");
  closeDatabase();
  captured = { statuses: [], uploads: [], deletedLikes: [], blobsFetched: [] };
  instanceDoc = {
    api_versions: { mastodon: 7 },
    configuration: {
      statuses: { max_characters: 5000, max_media_attachments: 10, characters_reserved_per_url: 23 },
      media_attachments: { description_limit: 1500 },
    },
  };
  likes = [];
  searchResult = { statuses: [] };
  posts = BASE_POSTS.map((p) => ({ ...p }));
  bridgedAccounts = [];
  rmSync(join(TMP, "history.sqlite3"), { force: true });
  installFakeFetch();
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("crosspost-all mode", () => {
  test("posts every eligible post, oldest first, and skips the reply to someone else", async () => {
    const { statuses } = await runSync({ crosspostAll: true });

    expect(statuses.map((s) => s.status.split("\n")[0])).toEqual([
      "first post",
      "and another thing",
      "still true",
      "ten pictures",
      "worth reading",
      "a thought after the pictures",
    ]);
    // "I disagree" was a reply to someone else's post.
    expect(statuses.some((s) => s.status.includes("I disagree"))).toBe(false);
  });

  test("a self-reply chains onto the toot its parent became", async () => {
    const { statuses } = await runSync({ crosspostAll: true });

    const first = statuses[0]!;
    const reply = statuses[1]!;
    expect(first.in_reply_to_id).toBeUndefined();
    expect(reply.status).toBe("and another thing");
    expect(reply.in_reply_to_id).toBe("101"); // the id the first status got
  });

  test("quoting your own earlier post produces a native quote, not a bsky.app link", async () => {
    const { statuses } = await runSync({ crosspostAll: true });

    const quote = statuses.find((s) => s.status.startsWith("still true"))!;
    expect(quote.quoted_status_id).toBe("101");
    expect(quote.status).toBe("still true");
    expect(quote.status).not.toContain("bsky.app");
  });

  test("without instance quote support the self-quote links to the toot, not to Bluesky", async () => {
    instanceDoc = { ...instanceDoc, api_versions: { mastodon: 5 } };
    const { statuses } = await runSync({ crosspostAll: true });

    const quote = statuses.find((s) => s.status.startsWith("still true"))!;
    expect(quote.quoted_status_id).toBeUndefined();
    expect(quote.status).toBe("still true\n\nRE: https://mastodon.example/@j4ck/101");
  });

  test("all ten gallery images are uploaded with their alt text intact", async () => {
    const { statuses, uploads, blobsFetched } = await runSync({ crosspostAll: true });

    const gallery = statuses.find((s) => s.status === "ten pictures")!;
    expect(gallery.media_ids).toHaveLength(10);
    expect(blobsFetched).toEqual(Array.from({ length: 10 }, (_, i) => `gcid${i + 1}`));
    expect(uploads.map((u) => u.description)).toEqual(
      Array.from({ length: 10 }, (_, i) => `alt ${i + 1}`),
    );
    expect(uploads.every((u) => u.filename.endsWith(".jpeg"))).toBe(true);
  });

  test("a four-attachment instance spreads the gallery over a thread", async () => {
    instanceDoc = {
      ...instanceDoc,
      configuration: {
        statuses: { max_characters: 5000, max_media_attachments: 4 },
        media_attachments: { description_limit: 1500 },
      },
    };
    const { statuses, uploads } = await runSync({ crosspostAll: true });

    const galleryStatuses = statuses.filter((s) => s.media_ids.length > 0);
    expect(galleryStatuses.map((s) => s.media_ids.length)).toEqual([4, 4, 2]);

    // The overflow statuses chain onto the one before, so it reads as a thread.
    expect(galleryStatuses[0]!.status).toBe("ten pictures");
    expect(galleryStatuses[1]!.status).toBe("");
    expect(galleryStatuses[1]!.in_reply_to_id).toBe("104");
    expect(galleryStatuses[2]!.in_reply_to_id).toBe("105");

    // Ten distinct attachments, none uploaded twice and none dropped.
    const allMedia = galleryStatuses.flatMap((s) => s.media_ids);
    expect(new Set(allMedia).size).toBe(10);
    expect(uploads.map((u) => u.description)).toEqual(
      Array.from({ length: 10 }, (_, i) => `alt ${i + 1}`),
    );
  });

  test("a reply to a split cross-post chains onto its last status, not its first", async () => {
    instanceDoc = {
      ...instanceDoc,
      configuration: {
        statuses: { max_characters: 5000, max_media_attachments: 4 },
        media_attachments: { description_limit: 1500 },
      },
    };
    const { statuses } = await runSync({ crosspostAll: true });

    // The ten-picture post became statuses 104, 105 and 106.
    const reply = statuses.find((s) => s.status === "a thought after the pictures")!;
    expect(reply.in_reply_to_id).toBe("106");
  });

  test("a reply to an unsplit cross-post chains onto it directly", async () => {
    const { statuses } = await runSync({ crosspostAll: true });

    const reply = statuses.find((s) => s.status === "a thought after the pictures")!;
    expect(reply.in_reply_to_id).toBe("104");
  });

  test("quoting someone else falls back to their bsky.app permalink, with their handle", async () => {
    const { statuses } = await runSync({ crosspostAll: true });

    const quote = statuses.find((s) => s.status.startsWith("worth reading"))!;
    expect(quote.status).toBe("worth reading\n\nRE: https://bsky.app/profile/them.example/post/theirs");
  });

  test("a bridged quote of someone else becomes a native quote", async () => {
    searchResult = {
      statuses: [
        {
          id: "900",
          url: "https://other.example/@them/900",
          quote_approval: { current_user: "automatic" },
        },
      ],
    };
    const { statuses } = await runSync({ crosspostAll: true });

    const quote = statuses.find((s) => s.status.startsWith("worth reading"))!;
    expect(quote.quoted_status_id).toBe("900");
  });

  test("running twice doesn't post anything a second time", async () => {
    const app = await newApp({ crosspostAll: true });

    await app.sync();
    const afterFirst = captured.statuses.length;
    await app.sync();

    expect(afterFirst).toBe(6);
    expect(captured.statuses).toHaveLength(6);
  });

  test("likes are never touched in crosspost-all mode", async () => {
    likes = [{ uri: `at://${ME}/app.bsky.feed.like/l1`, value: { subject: at(ME, "postA") } }];
    const { deletedLikes } = await runSync({ crosspostAll: true });
    expect(deletedLikes).toEqual([]);
  });

  test("max_posts_per_run caps a run without losing the remainder", async () => {
    const { statuses } = await runSync({ crosspostAll: true, maxPostsPerRun: 2 });
    expect(statuses.map((s) => s.status)).toEqual(["first post", "and another thing"]);
  });

  test("a dry run posts nothing at all", async () => {
    const { statuses, uploads } = await runSync({ crosspostAll: true, dryRun: true });
    expect(statuses).toEqual([]);
    expect(uploads).toEqual([]);
  });
});

describe("like mode", () => {
  test("only the liked post is cross-posted, and the like is then removed", async () => {
    likes = [{ uri: `at://${ME}/app.bsky.feed.like/l1`, value: { subject: at(ME, "postA") } }];
    const { statuses, deletedLikes } = await runSync({ crosspostAll: false });

    expect(statuses.map((s) => s.status)).toEqual(["first post"]);
    expect(deletedLikes).toEqual([`at://${ME}/app.bsky.feed.like/l1`]);
  });

  test("a like on someone else's post is ignored and left alone", async () => {
    likes = [{ uri: `at://${ME}/app.bsky.feed.like/l2`, value: { subject: at(THEM, "theirs") } }];
    const { statuses, deletedLikes } = await runSync({ crosspostAll: false });

    expect(statuses).toEqual([]);
    expect(deletedLikes).toEqual([]);
  });

  test("liking a reply to someone else removes the like without posting", async () => {
    likes = [{ uri: `at://${ME}/app.bsky.feed.like/l3`, value: { subject: at(ME, "postD") } }];
    const { statuses, deletedLikes } = await runSync({ crosspostAll: false });

    expect(statuses).toEqual([]);
    expect(deletedLikes).toEqual([`at://${ME}/app.bsky.feed.like/l3`]);
  });

  test("liking a self-reply whose parent was never cross-posted doesn't orphan it", async () => {
    likes = [{ uri: `at://${ME}/app.bsky.feed.like/l4`, value: { subject: at(ME, "postB") } }];
    const { statuses, deletedLikes } = await runSync({ crosspostAll: false });

    expect(statuses).toEqual([]);
    expect(deletedLikes).toEqual([`at://${ME}/app.bsky.feed.like/l4`]);
  });

  test("liking both a post and its reply cross-posts them in thread order", async () => {
    likes = [
      { uri: `at://${ME}/app.bsky.feed.like/l5`, value: { subject: at(ME, "postB") } },
      { uri: `at://${ME}/app.bsky.feed.like/l6`, value: { subject: at(ME, "postA") } },
    ];
    const { statuses } = await runSync({ crosspostAll: false });

    expect(statuses.map((s) => s.status)).toEqual(["first post", "and another thing"]);
    expect(statuses[1]!.in_reply_to_id).toBe("101");
  });

  test("a dry run leaves the likes in place", async () => {
    likes = [{ uri: `at://${ME}/app.bsky.feed.like/l1`, value: { subject: at(ME, "postA") } }];
    const { statuses, deletedLikes } = await runSync({ crosspostAll: false, dryRun: true });

    expect(statuses).toEqual([]);
    expect(deletedLikes).toEqual([]);
  });
});

describe("mentions", () => {
  const MENTION = "app.bsky.richtext.facet#mention";

  function mentionPost() {
    addNewestPost("postM", {
      text: "great work @them.example",
      createdAt: "2026-07-08T00:00:00Z",
      facets: [
        { index: { byteStart: 11, byteEnd: 24 }, features: [{ $type: MENTION, did: THEM }] },
      ],
    });
  }

  test("becomes a link to the Bluesky profile by default", async () => {
    mentionPost();
    const { statuses } = await runSync({ crosspostAll: true });

    const posted = statuses[statuses.length - 1]!;
    expect(posted.status).toBe("great work https://bsky.app/profile/them.example");
  });

  test("uses the DID's current handle, not a stale one written in the text", async () => {
    // The post says @old-handle.example but the DID now resolves to
    // them.example, which is the link that will actually work.
    addNewestPost("postM", {
      text: "hi @old-handle.example",
      createdAt: "2026-07-08T00:00:00Z",
      facets: [
        { index: { byteStart: 3, byteEnd: 22 }, features: [{ $type: MENTION, did: THEM }] },
      ],
    });
    const { statuses } = await runSync({ crosspostAll: true });

    expect(statuses[statuses.length - 1]!.status).toBe("hi https://bsky.app/profile/them.example");
  });

  test("becomes a real fediverse mention when the account is bridged", async () => {
    mentionPost();
    bridgedAccounts = ["them.example@bsky.brid.gy"];
    const { statuses } = await runSync({ crosspostAll: true, mentionStyle: "bridge" });

    expect(statuses[statuses.length - 1]!.status).toBe("great work @them.example@bsky.brid.gy");
  });

  test("bridge style falls back to a profile link when the account isn't bridged", async () => {
    mentionPost();
    const { statuses } = await runSync({ crosspostAll: true, mentionStyle: "bridge" });

    expect(statuses[statuses.length - 1]!.status).toBe(
      "great work https://bsky.app/profile/them.example",
    );
  });

  test("plain style drops the @ so it can't become a bogus local mention", async () => {
    mentionPost();
    const { statuses } = await runSync({ crosspostAll: true, mentionStyle: "plain" });

    expect(statuses[statuses.length - 1]!.status).toBe("great work them.example");
  });
});

describe("native touches", () => {
  test("the post language and a self-label are carried across", async () => {
    addNewestPost("postL", {
      text: "sztuka",
      createdAt: "2026-07-08T00:00:00Z",
      langs: ["pl-PL"],
      labels: { $type: "com.atproto.label.defs#selfLabels", values: [{ val: "nudity" }] },
    });
    const { statuses } = await runSync({ crosspostAll: true });

    const posted = statuses[statuses.length - 1]!;
    expect(posted.language).toBe("pl");
    expect(posted.spoiler_text).toBe("Nudity");
  });

  test("a post hidden from logged-out viewers is not cross-posted", async () => {
    addNewestPost("postH", {
      text: "just for the logged in",
      createdAt: "2026-07-08T00:00:00Z",
      labels: {
        $type: "com.atproto.label.defs#selfLabels",
        values: [{ val: "!no-unauthenticated" }],
      },
    });
    const { statuses } = await runSync({ crosspostAll: true });

    expect(statuses.some((s) => s.status.includes("just for the logged in"))).toBe(false);
  });

  test("a link card's URL is added so Mastodon renders the card", async () => {
    addNewestPost("postX", {
      text: "good piece",
      createdAt: "2026-07-08T00:00:00Z",
      embed: {
        $type: "app.bsky.embed.external",
        external: { uri: "https://example.com/piece", title: "Piece", description: "..." },
      },
    });
    const { statuses } = await runSync({ crosspostAll: true });

    expect(statuses[statuses.length - 1]!.status).toBe("good piece\n\nhttps://example.com/piece");
  });

  test("a post too long for the instance is split into a thread", async () => {
    instanceDoc = {
      ...instanceDoc,
      configuration: {
        statuses: { max_characters: 100, max_media_attachments: 10 },
        media_attachments: { description_limit: 1500 },
      },
    };
    addNewestPost("postT", {
      text: Array.from({ length: 6 }, (_, i) => `Paragraph number ${i} of this long post.`).join(
        "\n\n",
      ),
      createdAt: "2026-07-08T00:00:00Z",
    });
    const { statuses } = await runSync({ crosspostAll: true });

    const thread = statuses.filter((s) => s.status.includes("Paragraph number"));
    expect(thread.length).toBeGreaterThan(1);
    for (const part of thread) expect(part.status.length).toBeLessThanOrEqual(100);
    // Each continuation replies to the one before it.
    expect(thread[1]!.in_reply_to_id).toBeDefined();
  });

  test("a configured visibility is applied to every status", async () => {
    const { statuses } = await runSync({ crosspostAll: true, visibility: "unlisted" });
    expect(statuses.every((s) => s.visibility === "unlisted")).toBe(true);
  });

  test("without instance quote support a bridged quote still links to the toot", async () => {
    instanceDoc = { ...instanceDoc, api_versions: { mastodon: 5 } };
    searchResult = { statuses: [{ id: "900", url: "https://other.example/@them/900" }] };
    const { statuses } = await runSync({ crosspostAll: true });

    const quote = statuses.find((s) => s.status.startsWith("worth reading"))!;
    expect(quote.quoted_status_id).toBeUndefined();
    expect(quote.status).toBe("worth reading\n\nRE: https://other.example/@them/900");
  });
});

describe("backfill watermark", () => {
  test("the first crosspost-all run posts nothing older than now", async () => {
    const { statuses } = await runSync({ crosspostAll: true, backfillAll: false });
    expect(statuses).toEqual([]);
  });

  test("an explicit backfill_since includes posts from that date on", async () => {
    const { statuses } = await runSync({
      crosspostAll: true,
      backfillAll: false,
      backfillSince: "2026-07-05T00:00:00.000Z",
    });
    expect(statuses.map((s) => s.status.split("\n")[0])).toEqual([
      "ten pictures",
      "worth reading",
      "a thought after the pictures",
    ]);
  });
});
