import { describe, expect, test } from "bun:test";
import { composeStatuses, NO_QUOTE, truncateToLimit, type ComposeInput } from "../src/compose.ts";
import { DEFAULT_CAPABILITIES, type InstanceCapabilities } from "../src/mastodon.ts";
import type { PostRecord } from "../src/posts.ts";

const MENTION = "app.bsky.richtext.facet#mention";
const LINK = "app.bsky.richtext.facet#link";

/** Mastodon's stock configuration: 500 characters, 4 attachments, no quotes. */
const MASTODON: InstanceCapabilities = { ...DEFAULT_CAPABILITIES };

/** A Mastodon 4.5 instance: same limits, but it can author quote posts. */
const MASTODON_4_5: InstanceCapabilities = { ...MASTODON, supportsQuotes: true };

/** A GoToSocial instance configured generously, as many of them are. */
const GOTOSOCIAL: InstanceCapabilities = {
  ...DEFAULT_CAPABILITIES,
  maxCharacters: 5000,
  maxMediaAttachments: 10,
};

function blob(cid: string, mimeType = "image/jpeg") {
  return { $type: "blob", ref: { $link: cid }, mimeType, size: 1000 };
}

function galleryOf(count: number) {
  return {
    $type: "app.bsky.embed.gallery",
    items: Array.from({ length: count }, (_, i) => ({
      $type: "app.bsky.embed.gallery#image",
      alt: `alt text ${i + 1}`,
      image: blob(`cid${i + 1}`),
      aspectRatio: { width: 4, height: 3 },
    })),
  };
}

function compose(record: PostRecord, overrides: Partial<ComposeInput> = {}) {
  return composeStatuses({
    record,
    rkey: "3mrrr6q4iv22h",
    selfHandle: "j4ck.xyz",
    mentions: new Map(),
    quote: NO_QUOTE,
    capabilities: MASTODON,
    options: { contentWarnings: true, splitLongPosts: true, splitMedia: true },
    ...overrides,
  });
}

describe("galleries of up to 10 images", () => {
  test("all ten images and all ten alt texts survive on an instance that allows them", () => {
    const { parts } = compose(
      { text: "ten pictures", embed: galleryOf(10) },
      { capabilities: GOTOSOCIAL },
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]!.media).toHaveLength(10);
    expect(parts[0]!.media.map((m) => m.alt)).toEqual(
      Array.from({ length: 10 }, (_, i) => `alt text ${i + 1}`),
    );
  });

  test("on a four-attachment instance the pictures spill into a thread, none lost", () => {
    const { parts, notes } = compose({ text: "ten pictures", embed: galleryOf(10) });

    expect(parts.map((p) => p.media.length)).toEqual([4, 4, 2]);
    expect(parts.flatMap((p) => p.media.map((m) => m.cid))).toHaveLength(10);
    // The text belongs on the opening status only.
    expect(parts[0]!.text).toBe("ten pictures");
    expect(parts[1]!.text).toBe("");
    expect(notes.join(" ")).toContain("spreading them over a thread");
  });

  test("with split_media off the overflow is dropped and the user is told", () => {
    const { parts, notes } = compose(
      { text: "ten pictures", embed: galleryOf(10) },
      { options: { contentWarnings: true, splitLongPosts: true, splitMedia: false } },
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]!.media).toHaveLength(4);
    expect(notes.join(" ")).toContain("dropping the rest");
  });

  test("a gallery attached to a quote keeps its images and links the quote", () => {
    const record: PostRecord = {
      text: "look at these",
      embed: {
        $type: "app.bsky.embed.recordWithMedia",
        record: { record: { uri: "at://did:plc:me/app.bsky.feed.post/aaa" } },
        media: galleryOf(3),
      },
    };
    const { parts, notes } = compose(record, {
      capabilities: MASTODON_4_5,
      quote: { statusId: "12345", link: "https://mastodon.example/@me/999" },
    });

    // Mastodon can't attach media to a quote post, so the pictures win.
    expect(parts[0]!.media).toHaveLength(3);
    expect(parts[0]!.quotedStatusId).toBeNull();
    expect(parts[0]!.text).toBe("look at these\n\nRE: https://mastodon.example/@me/999");
    expect(notes.join(" ")).toContain("posting the quote as a link instead");
  });
});

describe("self-quotes", () => {
  test("become a native quote post when the instance supports it", () => {
    const record: PostRecord = {
      text: "still true two days later",
      embed: {
        $type: "app.bsky.embed.record",
        record: { uri: "at://did:plc:me/app.bsky.feed.post/postA" },
      },
    };
    const { parts } = compose(record, {
      capabilities: MASTODON_4_5,
      quote: { statusId: "555", link: "https://mastodon.example/@j4ck/555" },
    });

    expect(parts[0]!.quotedStatusId).toBe("555");
    // Mastodon prepends its own RE: paragraph, so the body stays clean.
    expect(parts[0]!.text).toBe("still true two days later");
  });

  test("fall back to the fediverse URL, not the bsky.app link, without quote support", () => {
    const record: PostRecord = {
      text: "still true two days later",
      embed: {
        $type: "app.bsky.embed.record",
        record: { uri: "at://did:plc:me/app.bsky.feed.post/postA" },
      },
    };
    const { parts } = compose(record, {
      quote: { statusId: null, link: "https://mastodon.example/@j4ck/555" },
    });

    expect(parts[0]!.text).toBe(
      "still true two days later\n\nRE: https://mastodon.example/@j4ck/555",
    );
    expect(parts[0]!.text).not.toContain("bsky.app");
  });

  test("the fallback link is kept on the part so a refused quote can retry", () => {
    const { parts } = compose(
      { text: "x", embed: { $type: "app.bsky.embed.record", record: { uri: "at://x/y/z" } } },
      { capabilities: MASTODON_4_5, quote: { statusId: "1", link: "https://m.example/@me/1" } },
    );
    expect(parts[0]!.quoteLink).toBe("https://m.example/@me/1");
  });

  test("a link already present in the text isn't appended twice", () => {
    const link = "https://mastodon.example/@j4ck/555";
    const { parts } = compose(
      { text: `see ${link}` },
      { quote: { statusId: null, link } },
    );
    expect(parts[0]!.text).toBe(`see ${link}`);
  });
});

describe("mentions", () => {
  test("an @mention becomes a link to the Bluesky profile", () => {
    const record: PostRecord = {
      text: "thanks @alice.bsky.social!",
      facets: [
        { index: { byteStart: 7, byteEnd: 25 }, features: [{ $type: MENTION, did: "did:plc:a" }] },
      ],
    };
    const mentions = new Map([["did:plc:a", "https://bsky.app/profile/alice.bsky.social"]]);
    const { parts } = compose(record, { mentions });

    expect(parts[0]!.text).toBe("thanks https://bsky.app/profile/alice.bsky.social!");
  });

  test("a bridged mention becomes a real fediverse mention", () => {
    const record: PostRecord = {
      text: "@alice.bsky.social hi",
      facets: [
        { index: { byteStart: 0, byteEnd: 18 }, features: [{ $type: MENTION, did: "did:plc:a" }] },
      ],
    };
    const mentions = new Map([["did:plc:a", "@alice.bsky.social@bsky.brid.gy"]]);
    expect(compose(record, { mentions }).parts[0]!.text).toBe("@alice.bsky.social@bsky.brid.gy hi");
  });
});

describe("link cards, hashtags and language", () => {
  test("the link card URL is appended so Mastodon can render a card", () => {
    const record: PostRecord = {
      text: "good read",
      embed: {
        $type: "app.bsky.embed.external",
        external: { uri: "https://example.com/article", title: "t", description: "d" },
      },
    };
    expect(compose(record).parts[0]!.text).toBe("good read\n\nhttps://example.com/article");
  });

  test("a link card URL already in the text isn't repeated", () => {
    const record: PostRecord = {
      text: "read https://example.com/article",
      facets: [
        {
          index: { byteStart: 5, byteEnd: 32 },
          features: [{ $type: LINK, uri: "https://example.com/article" }],
        },
      ],
      embed: {
        $type: "app.bsky.embed.external",
        external: { uri: "https://example.com/article" },
      },
    };
    expect(compose(record).parts[0]!.text).toBe("read https://example.com/article");
  });

  test("extra hashtags are appended, and in-text ones aren't duplicated", () => {
    const record: PostRecord = { text: "spring #flowers", tags: ["flowers", "garden"] };
    expect(compose(record).parts[0]!.text).toBe("spring #flowers\n\n#garden");
  });

  test("the post language is carried across", () => {
    expect(compose({ text: "cześć", langs: ["pl"] }).parts[0]!.language).toBe("pl");
  });
});

describe("content warnings", () => {
  test("a self-label becomes a spoiler and marks the post sensitive", () => {
    const record: PostRecord = {
      text: "art",
      labels: { $type: "com.atproto.label.defs#selfLabels", values: [{ val: "nudity" }] },
    };
    const { parts } = compose(record);
    expect(parts[0]!.spoilerText).toBe("Nudity");
    expect(parts[0]!.sensitive).toBe(true);
  });

  test("the warning is repeated on every status of a split thread", () => {
    const record: PostRecord = {
      text: "ten pictures",
      embed: galleryOf(10),
      labels: { $type: "com.atproto.label.defs#selfLabels", values: [{ val: "porn" }] },
    };
    const { parts } = compose(record);
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part.spoilerText).toBe("NSFW");
      expect(part.sensitive).toBe(true);
    }
  });

  test("warnings can be turned off", () => {
    const record: PostRecord = {
      text: "art",
      labels: { $type: "com.atproto.label.defs#selfLabels", values: [{ val: "nudity" }] },
    };
    const { parts } = compose(record, {
      options: { contentWarnings: false, splitLongPosts: true, splitMedia: true },
    });
    expect(parts[0]!.spoilerText).toBeNull();
    expect(parts[0]!.sensitive).toBe(false);
  });
});

describe("long posts", () => {
  test("a post whose expanded links blow the character limit becomes a thread", () => {
    // Bluesky counts a shortened link as its display text; expanding facets to
    // full URLs can push a legal 300-grapheme post past Mastodon's 500.
    const text = Array.from(
      { length: 12 },
      (_, i) => `Point number ${i} with some supporting detail attached to it.`,
    ).join("\n\n");

    const { parts, notes } = compose({ text });
    expect(parts.length).toBeGreaterThan(1);
    expect(notes.join(" ")).toContain("posting a thread");
    expect(parts.every((p) => p.text.length <= MASTODON.maxCharacters)).toBe(true);
  });

  test("the quote lives on the opening status only", () => {
    const text = "word ".repeat(200).trim();
    const { parts } = compose(
      { text },
      { capabilities: MASTODON_4_5, quote: { statusId: "77", link: "https://m.example/@me/77" } },
    );
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.quotedStatusId).toBe("77");
    expect(parts.slice(1).every((p) => p.quotedStatusId === null)).toBe(true);
  });

  test("with splitting off the text is clipped to fit instead", () => {
    const text = "word ".repeat(400).trim();
    const { parts } = compose(
      { text },
      { options: { contentWarnings: true, splitLongPosts: false, splitMedia: true } },
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]!.text.length).toBeLessThanOrEqual(MASTODON.maxCharacters);
    expect(parts[0]!.text.endsWith("…")).toBe(true);
  });
});

describe("posts with nothing to say", () => {
  test("an image-only post produces a status with no text", () => {
    const { parts } = compose({ text: "", embed: galleryOf(2) });
    expect(parts).toHaveLength(1);
    expect(parts[0]!.text).toBe("");
    expect(parts[0]!.media).toHaveLength(2);
  });

  test("a post with neither text nor media falls back to its permalink", () => {
    const { parts } = compose({ text: "" });
    expect(parts[0]!.text).toBe("https://bsky.app/profile/j4ck.xyz/post/3mrrr6q4iv22h");
  });

  test("a quote with no text of its own still says what it is quoting", () => {
    const record: PostRecord = {
      text: "",
      embed: { $type: "app.bsky.embed.record", record: { uri: "at://did:plc:me/c/postA" } },
    };
    const { parts } = compose(record, {
      quote: { statusId: null, link: "https://mastodon.example/@j4ck/555" },
    });
    expect(parts[0]!.text).toBe("RE: https://mastodon.example/@j4ck/555");
  });
});

describe("truncateToLimit", () => {
  test("leaves text that fits alone", () => {
    expect(truncateToLimit("short", 100, 23)).toBe("short");
  });

  test("clips to the limit and marks the cut", () => {
    const result = truncateToLimit("x".repeat(50), 10, 23);
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result.endsWith("…")).toBe(true);
  });
});
