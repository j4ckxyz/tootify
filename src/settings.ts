import { readConfig } from "./config.ts";

// Every option can be set either in config/tootify.json (snake_case) or through
// an environment variable (TOOTIFY_UPPER_SNAKE). The environment wins, so a
// deployment can flip behaviour without editing files on disk.

export type MentionStyle = "link" | "bridge" | "plain" | "keep";
export type QuoteMode = "auto" | "on" | "off";
export type Visibility = "public" | "unlisted" | "private" | "direct";

export interface TootifySettings {
  /** Cross-post every eligible post instead of only self-liked ones. */
  crosspostAll: boolean;
  /** Only consider posts at or after this instant (ISO 8601), or null. */
  backfillSince: string | null;
  /** Ignore the backfill watermark entirely and consider the whole repo. */
  backfillAll: boolean;
  /** Safety cap on how many posts a single run may cross-post. */
  maxPostsPerRun: number;
  checkInterval: number;
  mentionStyle: MentionStyle;
  /** Fediverse domain that bridges Bluesky accounts, for `bridge` mentions. */
  bridgeDomain: string;
  quoteMode: QuoteMode;
  extractLinkFromQuotes: boolean;
  /** Split posts over the instance character limit into a thread. */
  splitLongPosts: boolean;
  /** Spill media over the instance attachment limit into follow-up posts. */
  splitMedia: boolean;
  /** Map Bluesky self-labels onto content warnings. */
  contentWarnings: boolean;
  /** Skip posts labelled !no-unauthenticated (logged-in viewers only). */
  skipHiddenPosts: boolean;
  /** Never cross-post replies, not even to your own posts. */
  skipReplies: boolean;
  visibility: Visibility | null;
  /** Log what would be posted without touching Mastodon or your likes. */
  dryRun: boolean;
}

interface RawConfig {
  crosspost_all?: unknown;
  backfill_since?: unknown;
  backfill_all?: unknown;
  max_posts_per_run?: unknown;
  interval?: unknown;
  mention_style?: unknown;
  bridge_domain?: unknown;
  quote_posts?: unknown;
  extract_link_from_quotes?: unknown;
  split_long_posts?: unknown;
  split_media?: unknown;
  content_warnings?: unknown;
  skip_hidden_posts?: unknown;
  skip_replies?: unknown;
  visibility?: unknown;
  dry_run?: unknown;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "y", "enabled"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", "n", "disabled", ""]);

function parseBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return null;
}

function parseIntOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value !== "string") return null;
  const n = parseInt(value.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

function parseStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  const str = parseStringOrNull(value)?.toLowerCase();
  return str != null && (allowed as readonly string[]).includes(str) ? (str as T) : null;
}

/** ISO 8601 timestamp, or a bare date like 2026-01-31 meaning midnight UTC. */
function parseTimestamp(value: unknown): string | null {
  const str = parseStringOrNull(value);
  if (!str) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(str) ? `${str}T00:00:00Z` : str);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export type Env = Record<string, string | undefined>;

const MENTION_STYLES = ["link", "bridge", "plain", "keep"] as const;
const QUOTE_MODES = ["auto", "on", "off"] as const;
const VISIBILITIES = ["public", "unlisted", "private", "direct"] as const;

/**
 * Merge defaults, `config/tootify.json` and the environment into the settings
 * the rest of the app reads. Exported separately from `loadSettings` so it can
 * be unit-tested without touching the filesystem.
 */
export function resolveSettings(raw: RawConfig = {}, env: Env = {}): TootifySettings {
  const bool = (fileValue: unknown, envName: string, fallback: boolean): boolean =>
    parseBool(env[envName]) ?? parseBool(fileValue) ?? fallback;

  const int = (fileValue: unknown, envName: string, fallback: number): number =>
    parseIntOrNull(env[envName]) ?? parseIntOrNull(fileValue) ?? fallback;

  const str = (fileValue: unknown, envName: string, fallback: string): string =>
    parseStringOrNull(env[envName]) ?? parseStringOrNull(fileValue) ?? fallback;

  const maxPostsPerRun = int(raw.max_posts_per_run, "TOOTIFY_MAX_POSTS_PER_RUN", 20);
  const checkInterval = int(raw.interval, "TOOTIFY_INTERVAL", 60);

  return {
    crosspostAll: bool(raw.crosspost_all, "TOOTIFY_CROSSPOST_ALL", false),
    backfillSince:
      parseTimestamp(env["TOOTIFY_BACKFILL_SINCE"]) ?? parseTimestamp(raw.backfill_since),
    backfillAll: bool(raw.backfill_all, "TOOTIFY_BACKFILL_ALL", false),
    // 0 or a negative cap means "no cap"; anything else is taken literally.
    maxPostsPerRun: maxPostsPerRun > 0 ? maxPostsPerRun : Number.POSITIVE_INFINITY,
    checkInterval: checkInterval >= 0 ? checkInterval : 60,
    mentionStyle:
      parseEnum(env["TOOTIFY_MENTION_STYLE"], MENTION_STYLES) ??
      parseEnum(raw.mention_style, MENTION_STYLES) ??
      "link",
    bridgeDomain: str(raw.bridge_domain, "TOOTIFY_BRIDGE_DOMAIN", "bsky.brid.gy"),
    quoteMode:
      parseEnum(env["TOOTIFY_QUOTE_POSTS"], QUOTE_MODES) ??
      parseEnum(raw.quote_posts, QUOTE_MODES) ??
      "auto",
    extractLinkFromQuotes: bool(
      raw.extract_link_from_quotes,
      "TOOTIFY_EXTRACT_LINK_FROM_QUOTES",
      false,
    ),
    splitLongPosts: bool(raw.split_long_posts, "TOOTIFY_SPLIT_LONG_POSTS", true),
    splitMedia: bool(raw.split_media, "TOOTIFY_SPLIT_MEDIA", true),
    contentWarnings: bool(raw.content_warnings, "TOOTIFY_CONTENT_WARNINGS", true),
    skipHiddenPosts: bool(raw.skip_hidden_posts, "TOOTIFY_SKIP_HIDDEN_POSTS", true),
    skipReplies: bool(raw.skip_replies, "TOOTIFY_SKIP_REPLIES", false),
    visibility:
      parseEnum(env["TOOTIFY_VISIBILITY"], VISIBILITIES) ??
      parseEnum(raw.visibility, VISIBILITIES),
    dryRun: bool(raw.dry_run, "TOOTIFY_DRY_RUN", false),
  };
}

export function loadSettings(env: Env = process.env): TootifySettings {
  return resolveSettings(readConfig<RawConfig>("tootify"), env);
}
