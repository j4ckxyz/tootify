import { describe, expect, test } from "bun:test";
import { ineligibleReason, type PostRecord } from "../src/posts.ts";

const ME = "did:plc:me";
const THEM = "did:plc:them";

const DEFAULTS = { skipReplies: false, skipHiddenPosts: true };

function post(uri: string): { uri: string } {
  return { uri };
}

function at(did: string, rkey: string): string {
  return `at://${did}/app.bsky.feed.post/${rkey}`;
}

function check(record: PostRecord, options = DEFAULTS): string | null {
  return ineligibleReason(record, ME, options);
}

describe("top-level posts", () => {
  test("a plain post is eligible", () => {
    expect(check({ text: "hello" })).toBeNull();
  });

  test("a post with media is eligible", () => {
    expect(check({ text: "", embed: { $type: "app.bsky.embed.gallery", items: [] } })).toBeNull();
  });
});

describe("your own threads", () => {
  test("a reply to your own post, in your own thread, is eligible", () => {
    const record: PostRecord = {
      text: "and another thing",
      reply: { parent: post(at(ME, "a")), root: post(at(ME, "a")) },
    };
    expect(check(record)).toBeNull();
  });

  test("the third post of your own thread is eligible", () => {
    const record: PostRecord = {
      text: "third",
      reply: { parent: post(at(ME, "b")), root: post(at(ME, "a")) },
    };
    expect(check(record)).toBeNull();
  });
});

describe("other people's conversations", () => {
  test("a reply to someone else is refused", () => {
    const record: PostRecord = {
      text: "I disagree",
      reply: { parent: post(at(THEM, "x")), root: post(at(THEM, "x")) },
    };
    expect(check(record)).toBe("reply to someone else's post");
  });

  test("a reply to someone else's reply is refused", () => {
    const record: PostRecord = {
      text: "actually",
      reply: { parent: post(at(THEM, "y")), root: post(at(ME, "a")) },
    };
    expect(check(record)).toBe("reply to someone else's post");
  });

  test("replying to yourself underneath someone else's post is still refused", () => {
    // The parent is yours, so a parent-only check would let this through and
    // cross-post one side of a conversation with no context.
    const record: PostRecord = {
      text: "to add to what I said",
      reply: { parent: post(at(ME, "myreply")), root: post(at(THEM, "theirpost")) },
    };
    expect(check(record)).toBe("reply inside someone else's thread");
  });

  test("a malformed reply reference is refused rather than guessed at", () => {
    expect(check({ reply: { parent: post("not-an-at-uri"), root: post(at(ME, "a")) } })).toBe(
      "reply with an unreadable parent reference",
    );
    expect(check({ reply: {} })).toBe("reply with an unreadable parent reference");
    expect(check({ reply: { parent: post(at(ME, "a")), root: post("garbage") } })).toBe(
      "reply with an unreadable root reference",
    );
  });

  test("a reply with no root falls back to checking the parent", () => {
    expect(check({ reply: { parent: post(at(ME, "a")) } })).toBeNull();
    expect(check({ reply: { parent: post(at(THEM, "a")) } })).toBe("reply to someone else's post");
  });
});

describe("skip_replies", () => {
  test("refuses even your own replies when set", () => {
    const record: PostRecord = {
      text: "part two",
      reply: { parent: post(at(ME, "a")), root: post(at(ME, "a")) },
    };
    expect(check(record, { ...DEFAULTS, skipReplies: true })).toBe(
      "replies are disabled (skip_replies)",
    );
  });

  test("leaves top-level posts alone", () => {
    expect(check({ text: "hi" }, { ...DEFAULTS, skipReplies: true })).toBeNull();
  });
});

describe("posts hidden from logged-out viewers", () => {
  const hidden: PostRecord = {
    text: "followers-ish",
    labels: {
      $type: "com.atproto.label.defs#selfLabels",
      values: [{ val: "!no-unauthenticated" }],
    },
  };

  test("are refused by default, since a toot would be world-readable", () => {
    expect(check(hidden)).toBe("post is hidden from logged-out viewers on Bluesky");
  });

  test("can be allowed through explicitly", () => {
    expect(check(hidden, { ...DEFAULTS, skipHiddenPosts: false })).toBeNull();
  });

  test("ordinary content labels don't block a post", () => {
    const record: PostRecord = {
      text: "art",
      labels: { $type: "com.atproto.label.defs#selfLabels", values: [{ val: "nudity" }] },
    };
    expect(check(record)).toBeNull();
  });
});
