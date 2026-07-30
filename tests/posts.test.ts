import { describe, expect, test } from "bun:test";
import {
  appendLink,
  attachedImages,
  attachedVideo,
  bskyPostLink,
  bskyProfileLink,
  chunkArray,
  collectMedia,
  contentWarning,
  countChars,
  detectLoginKind,
  expandFacets,
  extraHashtags,
  isPlausibleHandle,
  linkEmbed,
  linksFromFacets,
  mentionRefs,
  parseAtUri,
  postTimestamp,
  primaryLanguage,
  quotedPost,
  renderFacets,
  selfLabels,
  splitText,
  tidToDate,
  truncateAlt,
  type PostRecord,
} from "../src/posts.ts";

const LINK = "app.bsky.richtext.facet#link";
const MENTION = "app.bsky.richtext.facet#mention";
const TAG = "app.bsky.richtext.facet#tag";

function linkFacet(byteStart: number, byteEnd: number, uri: string) {
  return { index: { byteStart, byteEnd }, features: [{ $type: LINK, uri }] };
}

function mentionFacet(byteStart: number, byteEnd: number, did: string) {
  return { index: { byteStart, byteEnd }, features: [{ $type: MENTION, did }] };
}

function blob(cid: string, mimeType = "image/jpeg") {
  return { $type: "blob", ref: { $link: cid }, mimeType, size: 1234 };
}

describe("expandFacets", () => {
  test("returns text unchanged when there are no facets", () => {
    expect(expandFacets({ text: "just some text" })).toBe("just some text");
  });

  test("inlines a link facet (ASCII)", () => {
    const record: PostRecord = {
      text: "hello world",
      facets: [linkFacet(6, 11, "https://example.com")],
    };
    expect(expandFacets(record)).toBe("hello https://example.com");
  });

  test("uses UTF-8 byte offsets, not character offsets", () => {
    // "🦋" is 4 UTF-8 bytes; " " is 1; "link" occupies bytes 5..9.
    const record: PostRecord = {
      text: "🦋 link",
      facets: [linkFacet(5, 9, "https://example.com")],
    };
    expect(expandFacets(record)).toBe("🦋 https://example.com");
  });

  test("expands multiple facets in order", () => {
    const record: PostRecord = {
      text: "a b c",
      facets: [linkFacet(2, 3, "https://two.com"), linkFacet(0, 1, "https://one.com")],
    };
    expect(expandFacets(record)).toBe("https://one.com https://two.com c");
  });

  test("ignores non-link facet features", () => {
    const record: PostRecord = {
      text: "hi there",
      facets: [mentionFacet(0, 2, "did:x")],
    };
    expect(expandFacets(record)).toBe("hi there");
  });

  test("clamps out-of-range facet indices instead of corrupting the text", () => {
    const record: PostRecord = {
      text: "short",
      facets: [linkFacet(3, 9999, "https://example.com")],
    };
    expect(expandFacets(record)).toBe("shohttps://example.com");
  });

  test("ignores facets with a zero-width or inverted range", () => {
    const record: PostRecord = {
      text: "hello",
      facets: [linkFacet(2, 2, "https://a.com"), linkFacet(4, 1, "https://b.com")],
    };
    expect(expandFacets(record)).toBe("hello");
  });

  test("leaves hashtag facets alone so Mastodon linkifies them natively", () => {
    const record: PostRecord = {
      text: "look #bunnies",
      facets: [{ index: { byteStart: 5, byteEnd: 13 }, features: [{ $type: TAG, tag: "bunnies" }] }],
    };
    expect(renderFacets(record)).toBe("look #bunnies");
  });
});

describe("renderFacets with mentions", () => {
  test("replaces a mention with the supplied rendering", () => {
    const record: PostRecord = {
      text: "hi @alice.bsky.social!",
      facets: [mentionFacet(3, 21, "did:plc:alice")],
    };
    const mentions = new Map([["did:plc:alice", "https://bsky.app/profile/alice.bsky.social"]]);
    expect(renderFacets(record, { mentions })).toBe(
      "hi https://bsky.app/profile/alice.bsky.social!",
    );
  });

  test("leaves the mention text alone when no rendering is supplied", () => {
    const record: PostRecord = {
      text: "hi @alice.bsky.social",
      facets: [mentionFacet(3, 21, "did:plc:alice")],
    };
    expect(renderFacets(record, { mentions: new Map() })).toBe("hi @alice.bsky.social");
  });

  test("handles a mention and a link in the same post", () => {
    const record: PostRecord = {
      text: "@bob.example see example.com",
      facets: [mentionFacet(0, 12, "did:plc:bob"), linkFacet(17, 28, "https://example.com/page")],
    };
    const mentions = new Map([["did:plc:bob", "@bob.example@bsky.brid.gy"]]);
    expect(renderFacets(record, { mentions })).toBe(
      "@bob.example@bsky.brid.gy see https://example.com/page",
    );
  });

  test("mentions with multi-byte text ahead of them stay aligned", () => {
    const text = "🦋 @alice.test hi";
    const start = Buffer.from("🦋 ").length;
    const end = start + "@alice.test".length;
    const record: PostRecord = { text, facets: [mentionFacet(start, end, "did:plc:alice")] };
    const mentions = new Map([["did:plc:alice", "alice.test"]]);
    expect(renderFacets(record, { mentions })).toBe("🦋 alice.test hi");
  });
});

describe("mentionRefs", () => {
  test("extracts the DID and the handle as typed", () => {
    const record: PostRecord = {
      text: "cc @alice.bsky.social and @bob.example",
      facets: [mentionFacet(3, 21, "did:plc:alice"), mentionFacet(26, 38, "did:plc:bob")],
    };
    expect(mentionRefs(record)).toEqual([
      { did: "did:plc:alice", handle: "alice.bsky.social" },
      { did: "did:plc:bob", handle: "bob.example" },
    ]);
  });

  test("deduplicates repeated mentions of the same account", () => {
    const record: PostRecord = {
      text: "@a.test @a.test",
      facets: [mentionFacet(0, 7, "did:plc:a"), mentionFacet(8, 15, "did:plc:a")],
    };
    expect(mentionRefs(record)).toHaveLength(1);
  });

  test("returns a null handle when the facet text isn't a handle", () => {
    const record: PostRecord = { text: "hey you", facets: [mentionFacet(0, 3, "did:plc:a")] };
    expect(mentionRefs(record)).toEqual([{ did: "did:plc:a", handle: null }]);
  });
});

describe("isPlausibleHandle", () => {
  test("accepts real handles and rejects junk", () => {
    expect(isPlausibleHandle("alice.bsky.social")).toBe(true);
    expect(isPlausibleHandle("j4ck.xyz")).toBe(true);
    expect(isPlausibleHandle("my-site.example.com")).toBe(true);
    expect(isPlausibleHandle("nodot")).toBe(false);
    expect(isPlausibleHandle("has space.com")).toBe(false);
    expect(isPlausibleHandle("")).toBe(false);
  });
});

describe("parseAtUri", () => {
  test("splits a well-formed AT-URI", () => {
    expect(parseAtUri("at://did:plc:abc/app.bsky.feed.post/xyz")).toEqual({
      repo: "did:plc:abc",
      collection: "app.bsky.feed.post",
      rkey: "xyz",
    });
  });

  test("returns null for truncated or foreign URIs", () => {
    expect(parseAtUri("at://did:plc:abc/app.bsky.feed.post")).toBeNull();
    expect(parseAtUri("https://example.com/a/b/c")).toBeNull();
    expect(parseAtUri(undefined)).toBeNull();
    expect(parseAtUri("")).toBeNull();
  });
});

describe("tidToDate", () => {
  test("decodes a known record key to its creation time", () => {
    // 3l6oveex3ii2l is a real TID from October 2024.
    const date = tidToDate("3l6oveex3ii2l");
    expect(date).not.toBeNull();
    expect(date!.getUTCFullYear()).toBe(2024);
  });

  test("round-trips: later record keys decode to later times", () => {
    const earlier = tidToDate("3l6oveex3ii2l")!;
    const later = tidToDate("3mrrr6q4iv22h")!;
    expect(later.getTime()).toBeGreaterThan(earlier.getTime());
  });

  test("returns null for custom (non-TID) record keys", () => {
    expect(tidToDate("self")).toBeNull();
    expect(tidToDate("not-a-tid-at-all")).toBeNull();
    expect(tidToDate("!!!!!!!!!!!!!")).toBeNull();
  });
});

describe("postTimestamp", () => {
  test("prefers the record key over a backdated createdAt", () => {
    const record: PostRecord = { createdAt: "1999-01-01T00:00:00Z" };
    const at = postTimestamp(record, "3mrrr6q4iv22h")!;
    expect(at.getUTCFullYear()).toBeGreaterThan(2020);
  });

  test("falls back to createdAt for custom record keys", () => {
    const record: PostRecord = { createdAt: "2024-05-05T12:00:00Z" };
    expect(postTimestamp(record, "custom")!.toISOString()).toBe("2024-05-05T12:00:00.000Z");
  });

  test("returns null when neither is usable", () => {
    expect(postTimestamp({ createdAt: "nonsense" }, "custom")).toBeNull();
    expect(postTimestamp({}, "custom")).toBeNull();
  });
});

describe("linksFromFacets", () => {
  test("collects link URIs and drops hashtag links", () => {
    const record: PostRecord = {
      text: "x",
      facets: [
        linkFacet(0, 1, "https://a.com"),
        linkFacet(1, 2, "https://bsky.app/hashtag/foo"),
        linkFacet(2, 3, "https://b.com"),
      ],
    };
    expect(linksFromFacets(record)).toEqual(["https://a.com", "https://b.com"]);
  });
});

describe("embed accessors", () => {
  test("linkEmbed reads app.bsky.embed.external", () => {
    expect(
      linkEmbed({ embed: { $type: "app.bsky.embed.external", external: { uri: "https://e.com" } } }),
    ).toBe("https://e.com");
  });

  test("linkEmbed reads recordWithMedia external", () => {
    expect(
      linkEmbed({
        embed: {
          $type: "app.bsky.embed.recordWithMedia",
          media: { external: { uri: "https://e.com" } },
        },
      }),
    ).toBe("https://e.com");
  });

  test("quotedPost reads app.bsky.embed.record", () => {
    expect(quotedPost({ embed: { $type: "app.bsky.embed.record", record: { uri: "at://q" } } })).toBe(
      "at://q",
    );
  });

  test("quotedPost reads recordWithMedia nested record", () => {
    expect(
      quotedPost({
        embed: { $type: "app.bsky.embed.recordWithMedia", record: { record: { uri: "at://q" } } },
      }),
    ).toBe("at://q");
  });

  test("attachedImages reads images and recordWithMedia images", () => {
    const imgs = [{ alt: "a", image: {} }];
    expect(attachedImages({ embed: { $type: "app.bsky.embed.images", images: imgs } })).toBe(imgs);
    expect(
      attachedImages({
        embed: {
          $type: "app.bsky.embed.recordWithMedia",
          media: { $type: "app.bsky.embed.images", images: imgs },
        },
      }),
    ).toBe(imgs);
  });

  test("attachedVideo reads video and recordWithMedia video", () => {
    const videoEmbed = { $type: "app.bsky.embed.video", video: {} };
    expect(attachedVideo({ embed: videoEmbed })).toBe(videoEmbed);
    const media = { $type: "app.bsky.embed.video", video: {} };
    expect(attachedVideo({ embed: { $type: "app.bsky.embed.recordWithMedia", media } })).toBe(media);
  });

  test("accessors return null for unrelated embeds", () => {
    const record: PostRecord = { embed: { $type: "app.bsky.embed.images", images: [] } };
    expect(linkEmbed(record)).toBeNull();
    expect(quotedPost(record)).toBeNull();
    expect(attachedVideo(record)).toBeNull();
  });
});

describe("collectMedia", () => {
  test("reads a classic images embed with alt text", () => {
    const record: PostRecord = {
      embed: {
        $type: "app.bsky.embed.images",
        images: [
          { alt: "a cat", image: blob("cid1", "image/png") },
          { alt: "", image: blob("cid2") },
        ],
      },
    };
    expect(collectMedia(record)).toEqual([
      { kind: "image", cid: "cid1", mimeType: "image/png", alt: "a cat" },
      { kind: "image", cid: "cid2", mimeType: "image/jpeg", alt: undefined },
    ]);
  });

  test("reads a gallery embed, which is how posts of up to 10 images are stored", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      $type: "app.bsky.embed.gallery#image",
      alt: `picture ${i}`,
      image: blob(`cid${i}`),
      aspectRatio: { width: 3, height: 2 },
    }));
    const media = collectMedia({ embed: { $type: "app.bsky.embed.gallery", items } });

    expect(media).toHaveLength(10);
    expect(media.map((m) => m.alt)).toEqual(items.map((i) => i.alt));
    expect(media.every((m) => m.kind === "image")).toBe(true);
  });

  test("reads a gallery nested under recordWithMedia", () => {
    const record: PostRecord = {
      embed: {
        $type: "app.bsky.embed.recordWithMedia",
        record: { record: { uri: "at://did:plc:me/app.bsky.feed.post/abc" } },
        media: {
          $type: "app.bsky.embed.gallery",
          items: [{ alt: "one", image: blob("g1") }],
        },
      },
    };
    expect(collectMedia(record)).toEqual([
      { kind: "image", cid: "g1", mimeType: "image/jpeg", alt: "one" },
    ]);
  });

  test("reads a video embed with its alt text and presentation hint", () => {
    const record: PostRecord = {
      embed: {
        $type: "app.bsky.embed.video",
        video: blob("vid", "video/mp4"),
        alt: "a clip",
        presentation: "gif",
      },
    };
    expect(collectMedia(record)).toEqual([
      { kind: "video", cid: "vid", mimeType: "video/mp4", alt: "a clip", presentation: "gif" },
    ]);
  });

  test("accepts legacy blobs that store the CID without a ref", () => {
    const record: PostRecord = {
      embed: {
        $type: "app.bsky.embed.images",
        images: [{ alt: "old", image: { cid: "legacycid", mimeType: "image/png" } }],
      },
    };
    expect(collectMedia(record)[0]?.cid).toBe("legacycid");
  });

  test("skips items with an unreadable blob rather than throwing", () => {
    const record: PostRecord = {
      embed: {
        $type: "app.bsky.embed.gallery",
        items: [{ alt: "broken" }, { alt: "fine", image: blob("ok") }],
      },
    };
    expect(collectMedia(record).map((m) => m.cid)).toEqual(["ok"]);
  });

  test("returns nothing for link-card and quote-only posts", () => {
    expect(collectMedia({ embed: { $type: "app.bsky.embed.external", external: {} } })).toEqual([]);
    expect(collectMedia({ embed: { $type: "app.bsky.embed.record", record: {} } })).toEqual([]);
    expect(collectMedia({})).toEqual([]);
  });

  test("whitespace-only alt text is treated as no alt text", () => {
    const record: PostRecord = {
      embed: { $type: "app.bsky.embed.images", images: [{ alt: "   ", image: blob("c") }] },
    };
    expect(collectMedia(record)[0]?.alt).toBeUndefined();
  });
});

describe("selfLabels and contentWarning", () => {
  test("reads self-label values", () => {
    const record: PostRecord = {
      labels: { $type: "com.atproto.label.defs#selfLabels", values: [{ val: "porn" }] },
    };
    expect(selfLabels(record)).toEqual(["porn"]);
  });

  test("returns an empty list when there are no labels", () => {
    expect(selfLabels({})).toEqual([]);
    expect(selfLabels({ labels: {} })).toEqual([]);
  });

  test("maps known labels to readable warnings and passes unknown ones through", () => {
    expect(contentWarning(["porn"])).toBe("NSFW");
    expect(contentWarning(["nudity", "graphic-media"])).toBe("Nudity, Graphic media");
    expect(contentWarning(["spiders"])).toBe("spiders");
  });

  test("deduplicates warnings that map to the same text", () => {
    expect(contentWarning(["gore", "graphic-media"])).toBe("Graphic media");
  });

  test("ignores system labels, which aren't content warnings", () => {
    expect(contentWarning(["!no-unauthenticated"])).toBeNull();
    expect(contentWarning([])).toBeNull();
  });
});

describe("primaryLanguage", () => {
  test("takes the first language and strips the region", () => {
    expect(primaryLanguage({ langs: ["en-GB", "pl"] })).toBe("en");
    expect(primaryLanguage({ langs: ["ja"] })).toBe("ja");
  });

  test("returns null when absent or malformed", () => {
    expect(primaryLanguage({})).toBeNull();
    expect(primaryLanguage({ langs: [] })).toBeNull();
    expect(primaryLanguage({ langs: ["!!"] })).toBeNull();
  });
});

describe("extraHashtags", () => {
  test("adds tags that aren't already in the text", () => {
    expect(extraHashtags({ tags: ["bunnies", "cats"] }, "look at this #cats")).toEqual(["bunnies"]);
  });

  test("strips whitespace and leading hashes, and deduplicates", () => {
    expect(extraHashtags({ tags: ["#photo blogging", "PhotoBlogging"] }, "")).toEqual([
      "photoblogging",
    ]);
  });

  test("returns nothing when there are no extra tags", () => {
    expect(extraHashtags({}, "text")).toEqual([]);
  });
});

describe("appendLink", () => {
  test("prefixes Bluesky post links with RE:", () => {
    const link = "https://bsky.app/profile/alice/post/abc";
    expect(appendLink("body", link)).toBe(`body\n\nRE: ${link}`);
  });

  test("appends other links plainly", () => {
    expect(appendLink("body", "https://example.com")).toBe("body\n\nhttps://example.com");
  });

  test("does not add a double newline when text already ends with newline", () => {
    expect(appendLink("body\n", "https://example.com")).toBe("body\n\nhttps://example.com");
  });

  test("returns just the link when there is no text", () => {
    expect(appendLink("", "https://example.com")).toBe("https://example.com");
    expect(appendLink("   \n ", "https://example.com")).toBe("https://example.com");
  });

  test("an explicit prefix forces RE: on a fediverse URL", () => {
    expect(appendLink("body", "https://mastodon.example/@me/1", "RE: ")).toBe(
      "body\n\nRE: https://mastodon.example/@me/1",
    );
  });

  test("an empty prefix suppresses the automatic RE:", () => {
    expect(appendLink("body", "https://bsky.app/profile/a/post/b", "")).toBe(
      "body\n\nhttps://bsky.app/profile/a/post/b",
    );
  });
});

describe("truncateAlt", () => {
  test("clips over-length alt text and marks it", () => {
    const result = truncateAlt("x".repeat(20), 10);
    expect(result).toBe("x".repeat(7) + "(…)");
    expect(result.length).toBe(10);
  });

  test("leaves short alt text untouched", () => {
    expect(truncateAlt("short", 10)).toBe("short");
    expect(truncateAlt("exactly10!", 10)).toBe("exactly10!");
  });

  test("handles absurdly small limits without producing negative slices", () => {
    expect(truncateAlt("hello", 2)).toBe("he");
    expect(truncateAlt("hello", 0)).toBe("");
  });
});

describe("bskyPostLink / bskyProfileLink", () => {
  test("builds profile and post URLs", () => {
    expect(bskyPostLink("did:plc:abc", "xyz")).toBe("https://bsky.app/profile/did:plc:abc/post/xyz");
    expect(bskyProfileLink("j4ck.xyz")).toBe("https://bsky.app/profile/j4ck.xyz");
  });
});

describe("countChars", () => {
  test("counts plain text by characters", () => {
    expect(countChars("hello")).toBe(5);
  });

  test("counts every URL as the reserved weight, however long it is", () => {
    const long = "https://example.com/" + "a".repeat(200);
    expect(countChars(long, 23)).toBe(23);
    expect(countChars(`hi ${long}`, 23)).toBe(26);
  });

  test("counts two URLs separately", () => {
    expect(countChars("https://a.com https://b.com", 23)).toBe(47);
  });
});

describe("splitText", () => {
  test("returns a single chunk when the text already fits", () => {
    expect(splitText("short", 100)).toEqual(["short"]);
  });

  test("splits on a paragraph boundary when there is one", () => {
    const text = "First paragraph here.\n\nSecond paragraph here.";
    expect(splitText(text, 25)).toEqual(["First paragraph here.", "Second paragraph here."]);
  });

  test("splits on word boundaries when there are no paragraphs", () => {
    const chunks = splitText("alpha bravo charlie delta echo foxtrot", 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(20);
    expect(chunks.join(" ")).toBe("alpha bravo charlie delta echo foxtrot");
  });

  test("never cuts through the middle of a URL", () => {
    const url = "https://example.com/a/very/long/path/that/keeps/going/for/ages";
    const chunks = splitText(`some text before the link ${url} and words after`, 40, 23);
    expect(chunks.some((c) => c.includes(url))).toBe(true);
    for (const chunk of chunks) {
      // A fragment of the URL would show up as a chunk containing "https://"
      // without the whole thing.
      if (chunk.includes("https://")) expect(chunk).toContain(url);
    }
  });

  test("every chunk fits within the limit under URL weighting", () => {
    const text = Array.from({ length: 12 }, (_, i) => `line ${i} https://example.com/${i}`).join(
      "\n",
    );
    for (const chunk of splitText(text, 100, 23)) {
      expect(countChars(chunk, 23)).toBeLessThanOrEqual(100);
    }
  });

  test("loses no words when splitting", () => {
    const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    expect(splitText(text, 50).join(" ")).toBe(text);
  });

  test("a single unsplittable token is emitted rather than dropped", () => {
    const url = "https://example.com/" + "x".repeat(300);
    expect(splitText(url, 30, 23)).toEqual([url]);
  });
});

describe("chunkArray", () => {
  test("groups items by size", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("returns one chunk when everything fits", () => {
    expect(chunkArray([1, 2], 4)).toEqual([[1, 2]]);
  });

  test("returns no chunks for an empty list", () => {
    expect(chunkArray([], 4)).toEqual([]);
  });
});

describe("detectLoginKind", () => {
  test("classifies mastodon addresses", () => {
    expect(detectLoginKind("user@mastodon.social")).toBe("mastodon");
  });

  test("classifies bluesky handles with and without @", () => {
    expect(detectLoginKind("alice.bsky.social")).toBe("bluesky");
    expect(detectLoginKind("@alice.bsky.social")).toBe("bluesky");
  });

  test("returns help for missing name and invalid for malformed", () => {
    expect(detectLoginKind(undefined)).toBe("help");
    expect(detectLoginKind("a@b@c")).toBe("invalid");
    expect(detectLoginKind("")).toBe("invalid");
  });
});
