import { describe, expect, test } from "bun:test";
import { resolveSettings } from "../src/settings.ts";

describe("defaults", () => {
  test("like mode, with the safe behaviours switched on", () => {
    const s = resolveSettings({}, {});
    expect(s.crosspostAll).toBe(false);
    expect(s.dryRun).toBe(false);
    expect(s.checkInterval).toBe(60);
    expect(s.maxPostsPerRun).toBe(20);
    expect(s.mentionStyle).toBe("link");
    expect(s.quoteMode).toBe("auto");
    expect(s.splitLongPosts).toBe(true);
    expect(s.splitMedia).toBe(true);
    expect(s.contentWarnings).toBe(true);
    expect(s.skipHiddenPosts).toBe(true);
    expect(s.skipReplies).toBe(false);
    expect(s.visibility).toBeNull();
  });
});

describe("TOOTIFY_CROSSPOST_ALL", () => {
  test("accepts the usual ways of writing yes", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " y "]) {
      expect(resolveSettings({}, { TOOTIFY_CROSSPOST_ALL: value }).crosspostAll).toBe(true);
    }
  });

  test("accepts the usual ways of writing no, including empty", () => {
    for (const value of ["0", "false", "no", "off", ""]) {
      expect(resolveSettings({}, { TOOTIFY_CROSSPOST_ALL: value }).crosspostAll).toBe(false);
    }
  });

  test("an unparseable value falls through to the config file, then the default", () => {
    expect(resolveSettings({ crosspost_all: true }, { TOOTIFY_CROSSPOST_ALL: "maybe" }).crosspostAll)
      .toBe(true);
    expect(resolveSettings({}, { TOOTIFY_CROSSPOST_ALL: "maybe" }).crosspostAll).toBe(false);
  });
});

describe("precedence", () => {
  test("the environment overrides the config file in both directions", () => {
    expect(resolveSettings({ crosspost_all: false }, { TOOTIFY_CROSSPOST_ALL: "1" }).crosspostAll)
      .toBe(true);
    expect(resolveSettings({ crosspost_all: true }, { TOOTIFY_CROSSPOST_ALL: "0" }).crosspostAll)
      .toBe(false);
  });

  test("the config file is used when the environment says nothing", () => {
    expect(resolveSettings({ mention_style: "plain" }, {}).mentionStyle).toBe("plain");
    expect(resolveSettings({ interval: 15 }, {}).checkInterval).toBe(15);
  });

  test("unrelated environment variables are ignored", () => {
    expect(resolveSettings({}, { CROSSPOST_ALL: "1", TOOTIFY: "1" }).crosspostAll).toBe(false);
  });
});

describe("backfill", () => {
  test("an ISO timestamp is normalised", () => {
    expect(resolveSettings({}, { TOOTIFY_BACKFILL_SINCE: "2026-01-15T10:00:00Z" }).backfillSince)
      .toBe("2026-01-15T10:00:00.000Z");
  });

  test("a bare date means midnight UTC", () => {
    expect(resolveSettings({}, { TOOTIFY_BACKFILL_SINCE: "2026-01-15" }).backfillSince).toBe(
      "2026-01-15T00:00:00.000Z",
    );
  });

  test("an unparseable date is ignored rather than becoming Invalid Date", () => {
    expect(resolveSettings({}, { TOOTIFY_BACKFILL_SINCE: "last tuesday" }).backfillSince).toBeNull();
  });

  test("backfill_all is a separate opt-in", () => {
    expect(resolveSettings({}, { TOOTIFY_BACKFILL_ALL: "1" }).backfillAll).toBe(true);
  });
});

describe("max_posts_per_run", () => {
  test("takes a positive number", () => {
    expect(resolveSettings({}, { TOOTIFY_MAX_POSTS_PER_RUN: "5" }).maxPostsPerRun).toBe(5);
  });

  test("zero or negative means no cap", () => {
    expect(resolveSettings({}, { TOOTIFY_MAX_POSTS_PER_RUN: "0" }).maxPostsPerRun).toBe(Infinity);
    expect(resolveSettings({}, { TOOTIFY_MAX_POSTS_PER_RUN: "-1" }).maxPostsPerRun).toBe(Infinity);
  });
});

describe("enumerated options", () => {
  test("valid values are accepted case-insensitively", () => {
    expect(resolveSettings({}, { TOOTIFY_MENTION_STYLE: "BRIDGE" }).mentionStyle).toBe("bridge");
    expect(resolveSettings({}, { TOOTIFY_QUOTE_POSTS: "off" }).quoteMode).toBe("off");
    expect(resolveSettings({}, { TOOTIFY_VISIBILITY: "unlisted" }).visibility).toBe("unlisted");
  });

  test("invalid values fall back to the default instead of reaching the API", () => {
    expect(resolveSettings({}, { TOOTIFY_MENTION_STYLE: "hyperlink" }).mentionStyle).toBe("link");
    expect(resolveSettings({}, { TOOTIFY_QUOTE_POSTS: "sometimes" }).quoteMode).toBe("auto");
    expect(resolveSettings({}, { TOOTIFY_VISIBILITY: "secret" }).visibility).toBeNull();
  });
});

describe("interval", () => {
  test("a negative interval falls back to the default", () => {
    expect(resolveSettings({}, { TOOTIFY_INTERVAL: "-5" }).checkInterval).toBe(60);
  });

  test("zero is allowed, for a tight loop", () => {
    expect(resolveSettings({}, { TOOTIFY_INTERVAL: "0" }).checkInterval).toBe(0);
  });
});
