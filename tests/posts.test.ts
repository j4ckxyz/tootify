import { describe, expect, test } from "bun:test";
import {
  appendLink,
  attachedImages,
  attachedVideo,
  bskyPostLink,
  detectLoginKind,
  expandFacets,
  linkEmbed,
  linksFromFacets,
  quotedPost,
  truncateAlt,
  type PostRecord,
} from "../src/posts.ts";

const LINK = "app.bsky.richtext.facet#link";

function linkFacet(byteStart: number, byteEnd: number, uri: string) {
  return { index: { byteStart, byteEnd }, features: [{ $type: LINK, uri }] };
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
      facets: [
        { index: { byteStart: 0, byteEnd: 2 }, features: [{ $type: "app.bsky.richtext.facet#mention", did: "did:x" }] },
      ],
    };
    expect(expandFacets(record)).toBe("hi there");
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
        embed: { $type: "app.bsky.embed.recordWithMedia", media: { external: { uri: "https://e.com" } } },
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
        embed: { $type: "app.bsky.embed.recordWithMedia", media: { $type: "app.bsky.embed.images", images: imgs } },
      }),
    ).toBe(imgs);
  });

  test("attachedVideo reads video and recordWithMedia video", () => {
    const videoEmbed = { $type: "app.bsky.embed.video", video: {} };
    expect(attachedVideo({ embed: videoEmbed })).toBe(videoEmbed);
    const media = { $type: "app.bsky.embed.video", video: {} };
    expect(
      attachedVideo({ embed: { $type: "app.bsky.embed.recordWithMedia", media } }),
    ).toBe(media);
  });

  test("accessors return null for unrelated embeds", () => {
    const record: PostRecord = { embed: { $type: "app.bsky.embed.images", images: [] } };
    expect(linkEmbed(record)).toBeNull();
    expect(quotedPost(record)).toBeNull();
    expect(attachedVideo(record)).toBeNull();
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
});

describe("truncateAlt", () => {
  test("clips over-length alt text and marks it", () => {
    const result = truncateAlt("x".repeat(20), 10);
    expect(result).toBe("x".repeat(7) + "(…)");
    expect(result.length).toBe(10);
  });

  test("leaves short alt text untouched", () => {
    expect(truncateAlt("short", 10)).toBe("short");
  });
});

describe("bskyPostLink", () => {
  test("builds a profile post URL", () => {
    expect(bskyPostLink("did:plc:abc", "xyz")).toBe("https://bsky.app/profile/did:plc:abc/post/xyz");
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
