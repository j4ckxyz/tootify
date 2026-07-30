import { describe, expect, test } from "bun:test";
import { DEFAULT_CAPABILITIES, parseCapabilities } from "../src/mastodon.ts";

/** Shape of /api/v2/instance on a stock Mastodon 4.4 server. */
const MASTODON_4_4 = {
  api_versions: { mastodon: 5 },
  configuration: {
    statuses: { max_characters: 500, max_media_attachments: 4, characters_reserved_per_url: 23 },
    media_attachments: {
      description_limit: 1500,
      supported_mime_types: ["image/jpeg", "image/png", "video/mp4"],
    },
  },
};

describe("parseCapabilities", () => {
  test("reads a stock Mastodon instance", () => {
    const caps = parseCapabilities(MASTODON_4_4);
    expect(caps.maxCharacters).toBe(500);
    expect(caps.maxMediaAttachments).toBe(4);
    expect(caps.urlWeight).toBe(23);
    expect(caps.altLength).toBe(1500);
    expect(caps.supportedMimeTypes).toEqual(["image/jpeg", "image/png", "video/mp4"]);
  });

  test("quote posts need Mastodon API version 7", () => {
    expect(parseCapabilities(MASTODON_4_4).supportsQuotes).toBe(false);
    expect(parseCapabilities({ api_versions: { mastodon: 7 } }).supportsQuotes).toBe(true);
    expect(parseCapabilities({ api_versions: { mastodon: 8 } }).supportsQuotes).toBe(true);
  });

  test("reads a generously configured GoToSocial instance", () => {
    const caps = parseCapabilities({
      configuration: {
        statuses: { max_characters: 5000, max_media_attachments: 10 },
        media_attachments: { description_limit: 5000 },
      },
    });
    expect(caps.maxCharacters).toBe(5000);
    expect(caps.maxMediaAttachments).toBe(10);
    expect(caps.altLength).toBe(5000);
  });

  test("falls back to Mastodon's defaults when the instance says nothing", () => {
    const caps = parseCapabilities({});
    expect(caps.maxCharacters).toBe(DEFAULT_CAPABILITIES.maxCharacters);
    expect(caps.maxMediaAttachments).toBe(DEFAULT_CAPABILITIES.maxMediaAttachments);
    expect(caps.urlWeight).toBe(DEFAULT_CAPABILITIES.urlWeight);
    expect(caps.altLength).toBe(DEFAULT_CAPABILITIES.altLength);
    expect(caps.supportsQuotes).toBe(false);
    expect(caps.supportedMimeTypes).toBeNull();
  });

  test("survives null, garbage and partial documents", () => {
    expect(parseCapabilities(null).maxMediaAttachments).toBe(4);
    expect(parseCapabilities({ configuration: null }).maxCharacters).toBe(500);
    expect(
      parseCapabilities({ configuration: { statuses: { max_media_attachments: "eight" } } })
        .maxMediaAttachments,
    ).toBe(4);
    expect(
      parseCapabilities({ configuration: { statuses: { max_media_attachments: 0 } } })
        .maxMediaAttachments,
    ).toBe(4);
  });

  test("an empty mime type list is treated as no list, not as 'nothing allowed'", () => {
    expect(
      parseCapabilities({ configuration: { media_attachments: { supported_mime_types: [] } } })
        .supportedMimeTypes,
    ).toBeNull();
  });
});
