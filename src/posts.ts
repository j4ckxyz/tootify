// Pure transformation helpers. These have no network or config dependencies so
// they can be unit-tested in isolation.

const LINK_FACET = "app.bsky.richtext.facet#link";
const MENTION_FACET = "app.bsky.richtext.facet#mention";

export interface FacetIndex {
  byteStart: number;
  byteEnd: number;
}

export interface FacetFeature {
  $type: string;
  uri?: string;
  did?: string;
  tag?: string;
  [key: string]: unknown;
}

export interface Facet {
  index: FacetIndex;
  features: FacetFeature[];
}

// Embeds are loosely typed: the Bluesky embed shapes are deeply nested and
// vary by $type, so we mirror the original Ruby hash access with `any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Embed = { $type?: string; [key: string]: any };

export interface PostReplyRef {
  parent?: { uri?: string };
  root?: { uri?: string };
}

export interface PostRecord {
  text?: string;
  facets?: Facet[];
  embed?: Embed;
  reply?: PostReplyRef;
  tags?: string[];
  langs?: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  labels?: any;
  createdAt?: string;
  [key: string]: unknown;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* -------------------------------------------------------------------------- */
/* AT-URIs                                                                     */
/* -------------------------------------------------------------------------- */

export interface AtUriParts {
  repo: string;
  collection: string;
  rkey: string;
}

/**
 * Split an `at://repo/collection/rkey` URI. Returns null for anything that
 * doesn't have all three components, so callers never index into a short array.
 */
export function parseAtUri(uri: string | null | undefined): AtUriParts | null {
  if (!uri || !uri.startsWith("at://")) return null;
  const parts = uri.slice("at://".length).split("/");
  const [repo, collection, rkey] = parts;
  if (!repo || !collection || !rkey) return null;
  return { repo, collection, rkey };
}

/** The repo (DID or handle) an AT-URI points at, or null if unparseable. */
export function atUriRepo(uri: string | null | undefined): string | null {
  return parseAtUri(uri)?.repo ?? null;
}

const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

/**
 * Decode the creation time out of a TID record key. TIDs are 13 characters of
 * sortable base32 encoding a 64-bit value: 1 zero bit, 53 bits of microseconds
 * since the Unix epoch, then a 10-bit clock id. Returns null if `rkey` isn't a
 * well-formed TID (custom rkeys are legal, they just aren't timestamps).
 */
export function tidToDate(rkey: string): Date | null {
  if (rkey.length !== 13) return null;
  let value = 0n;
  for (const ch of rkey) {
    const digit = TID_ALPHABET.indexOf(ch);
    if (digit < 0) return null;
    value = value * 32n + BigInt(digit);
  }
  // Top bit must be zero for a valid TID.
  if (value >= 1n << 63n) return null;
  const micros = value >> 10n;
  const millis = Number(micros / 1000n);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Best-effort "when did this post happen" used for ordering and for the
 * backfill watermark. The TID is server-assigned and monotonic, so it is
 * preferred over the client-declared `createdAt`, which can be skewed or
 * deliberately backdated.
 */
export function postTimestamp(record: PostRecord, rkey: string): Date | null {
  const fromTid = tidToDate(rkey);
  if (fromTid) return fromTid;
  const created = record.createdAt ? new Date(record.createdAt) : null;
  return created && !Number.isNaN(created.getTime()) ? created : null;
}

/* -------------------------------------------------------------------------- */
/* Rich text                                                                   */
/* -------------------------------------------------------------------------- */

export interface RenderOptions {
  /** DID -> replacement text for `app.bsky.richtext.facet#mention` facets. */
  mentions?: Map<string, string>;
}

interface Splice {
  start: number;
  end: number;
  text: string;
}

/**
 * Inline link and mention facets into the post text. Facet indices are UTF-8
 * byte offsets, so we operate on the encoded bytes and rebuild the string.
 *
 * Tag facets are deliberately left alone: their text is already `#hashtag`,
 * which Mastodon and GoToSocial linkify natively.
 */
export function renderFacets(record: PostRecord, options: RenderOptions = {}): string {
  const textBytes = encoder.encode(record.text ?? "");
  const splices: Splice[] = [];

  for (const facet of record.facets ?? []) {
    const index = facet?.index;
    if (!index) continue;

    // Clamp to the actual text: malformed clients do emit out-of-range facets,
    // and a bad index must not corrupt or truncate the post body.
    const start = Math.max(0, Math.min(toInt(index.byteStart), textBytes.length));
    const end = Math.max(start, Math.min(toInt(index.byteEnd), textBytes.length));
    if (end <= start) continue;

    const features = facet.features ?? [];
    const link = features.find((f) => f?.$type === LINK_FACET);
    if (link?.uri) {
      splices.push({ start, end, text: link.uri });
      continue;
    }

    const mention = features.find((f) => f?.$type === MENTION_FACET);
    if (mention?.did && options.mentions) {
      const replacement = options.mentions.get(mention.did);
      if (replacement != null) splices.push({ start, end, text: replacement });
    }
  }

  if (splices.length === 0) return decoder.decode(textBytes);

  splices.sort((a, b) => a.start - b.start);

  const chunks: Uint8Array[] = [];
  let cursor = 0;

  for (const splice of splices) {
    if (splice.start < cursor) continue; // skip overlapping facets
    chunks.push(textBytes.subarray(cursor, splice.start));
    chunks.push(encoder.encode(splice.text));
    cursor = splice.end;
  }
  chunks.push(textBytes.subarray(cursor));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return decoder.decode(out);
}

/** Backwards-compatible wrapper: expand link facets only. */
export function expandFacets(record: PostRecord): string {
  return renderFacets(record);
}

export interface MentionRef {
  did: string;
  /** The handle as typed in the post text, without the leading "@". */
  handle: string | null;
}

/** Every mention facet in the post, with the handle text the author typed. */
export function mentionRefs(record: PostRecord): MentionRef[] {
  const textBytes = encoder.encode(record.text ?? "");
  const refs: MentionRef[] = [];
  const seen = new Set<string>();

  for (const facet of record.facets ?? []) {
    const mention = (facet?.features ?? []).find((f) => f?.$type === MENTION_FACET);
    if (!mention?.did || seen.has(mention.did)) continue;
    seen.add(mention.did);

    const index = facet.index;
    let handle: string | null = null;
    if (index) {
      const start = Math.max(0, Math.min(toInt(index.byteStart), textBytes.length));
      const end = Math.max(start, Math.min(toInt(index.byteEnd), textBytes.length));
      const raw = decoder.decode(textBytes.subarray(start, end)).replace(/^@/, "").trim();
      if (isPlausibleHandle(raw)) handle = raw.toLowerCase();
    }
    refs.push({ did: mention.did, handle });
  }
  return refs;
}

/** A syntactically valid AT Protocol handle (not a guarantee it resolves). */
export function isPlausibleHandle(value: string): boolean {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(
    value,
  );
}

/** Collect link URIs from facets, excluding Bluesky hashtag links. */
export function linksFromFacets(record: PostRecord): string[] {
  const links: string[] = [];
  for (const f of record.facets ?? []) {
    const link = (f?.features ?? []).find((ft) => ft?.$type === LINK_FACET);
    if (link?.uri) links.push(link.uri);
  }
  return links.filter((x) => !x.startsWith("https://bsky.app/hashtag/"));
}

/* -------------------------------------------------------------------------- */
/* Embeds                                                                      */
/* -------------------------------------------------------------------------- */

/** URI of an external link embed, if any (handles recordWithMedia). */
export function linkEmbed(record: PostRecord): string | null {
  const embed = record.embed;
  if (!embed) return null;
  switch (embed.$type) {
    case "app.bsky.embed.external":
      return embed.external?.uri ?? null;
    case "app.bsky.embed.recordWithMedia":
      return embed.media?.external?.uri ?? null;
    default:
      return null;
  }
}

/** AT-URI of a quoted post, if any (handles recordWithMedia). */
export function quotedPost(record: PostRecord): string | null {
  const embed = record.embed;
  if (!embed) return null;
  switch (embed.$type) {
    case "app.bsky.embed.record":
      return embed.record?.uri ?? null;
    case "app.bsky.embed.recordWithMedia":
      return embed.record?.record?.uri ?? null;
    default:
      return null;
  }
}

/** Attached images array, if any (handles recordWithMedia). */
export function attachedImages(record: PostRecord): Embed[] | null {
  const embed = record.embed;
  if (!embed) return null;
  switch (embed.$type) {
    case "app.bsky.embed.images":
      return embed.images ?? null;
    case "app.bsky.embed.recordWithMedia":
      return embed.media?.$type === "app.bsky.embed.images" ? embed.media.images : null;
    default:
      return null;
  }
}

/** The video embed object, if any (handles recordWithMedia). */
export function attachedVideo(record: PostRecord): Embed | null {
  const embed = record.embed;
  if (!embed) return null;
  switch (embed.$type) {
    case "app.bsky.embed.video":
      return embed;
    case "app.bsky.embed.recordWithMedia":
      return embed.media?.$type === "app.bsky.embed.video" ? embed.media : null;
    default:
      return null;
  }
}

export interface MediaItem {
  kind: "image" | "video";
  /** Blob CID, used both to fetch the blob and to name the upload. */
  cid: string;
  mimeType: string;
  alt?: string;
  /** Video presentation hint; "gif" means it should loop silently. */
  presentation?: string;
}

/**
 * A blob reference is `{ ref: { $link }, mimeType }` in the current data model
 * but posts written before the 2023 blob migration store `{ cid, mimeType }`.
 * Accept both so old posts don't silently lose their media.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function blobCid(blob: any): string | null {
  const cid = blob?.ref?.$link ?? blob?.ref?.toString?.() ?? blob?.cid;
  return typeof cid === "string" && cid.length > 0 ? cid : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function blobMime(blob: any, fallback: string): string {
  const mime = blob?.mimeType;
  return typeof mime === "string" && mime.includes("/") ? mime : fallback;
}

function cleanAlt(alt: unknown): string | undefined {
  if (typeof alt !== "string") return undefined;
  const trimmed = alt.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalise every media attachment on a post into a flat, upload-ready list.
 *
 * Covers all four media embed types: `images` (max 4), `gallery` (the newer
 * embed used for posts of up to 10 images), `video`, and any of those nested
 * under `recordWithMedia`. `external` embeds carry only a link card, which is
 * appended to the text instead, so they produce no media here.
 */
export function collectMedia(record: PostRecord): MediaItem[] {
  return mediaFromEmbed(record.embed);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mediaFromEmbed(embed: any): MediaItem[] {
  if (!embed) return [];

  switch (embed.$type) {
    case "app.bsky.embed.images": {
      const items: MediaItem[] = [];
      for (const image of embed.images ?? []) {
        const cid = blobCid(image?.image);
        if (!cid) continue;
        items.push({
          kind: "image",
          cid,
          mimeType: blobMime(image?.image, "image/jpeg"),
          alt: cleanAlt(image?.alt),
        });
      }
      return items;
    }

    case "app.bsky.embed.gallery": {
      const items: MediaItem[] = [];
      for (const item of embed.items ?? []) {
        // Every gallery item type so far wraps a blob in `image`; skip anything
        // shaped differently rather than throwing, so a future item type only
        // costs us that one attachment.
        const cid = blobCid(item?.image);
        if (!cid) continue;
        items.push({
          kind: "image",
          cid,
          mimeType: blobMime(item?.image, "image/jpeg"),
          alt: cleanAlt(item?.alt),
        });
      }
      return items;
    }

    case "app.bsky.embed.video": {
      const cid = blobCid(embed.video);
      if (!cid) return [];
      return [
        {
          kind: "video",
          cid,
          mimeType: blobMime(embed.video, "video/mp4"),
          alt: cleanAlt(embed.alt),
          presentation: typeof embed.presentation === "string" ? embed.presentation : undefined,
        },
      ];
    }

    case "app.bsky.embed.recordWithMedia":
      return mediaFromEmbed(embed.media);

    default:
      return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Labels, tags, language                                                      */
/* -------------------------------------------------------------------------- */

/** Self-applied label values on a post (`com.atproto.label.defs#selfLabels`). */
export function selfLabels(record: PostRecord): string[] {
  const values = record.labels?.values;
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => (typeof v?.val === "string" ? v.val : null))
    .filter((v): v is string => v != null);
}

/** Label meaning "hide this from logged-out viewers". */
export const NO_UNAUTHENTICATED = "!no-unauthenticated";

const LABEL_WARNINGS: Record<string, string> = {
  porn: "NSFW",
  sexual: "Suggestive",
  nudity: "Nudity",
  "graphic-media": "Graphic media",
  gore: "Graphic media",
};

/**
 * Turn Bluesky self-labels into a Mastodon content warning. Unknown label
 * values are passed through so custom labels still warn rather than vanish.
 */
export function contentWarning(labels: string[]): string | null {
  const warnings: string[] = [];
  for (const label of labels) {
    if (label.startsWith("!")) continue; // system labels, not content warnings
    const warning = LABEL_WARNINGS[label] ?? label;
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  return warnings.length > 0 ? warnings.join(", ") : null;
}

/** Normalise a Bluesky language tag to the ISO 639-1 code Mastodon wants. */
export function primaryLanguage(record: PostRecord): string | null {
  const lang = record.langs?.[0];
  if (typeof lang !== "string" || lang.length === 0) return null;
  const base = lang.split("-")[0]!.toLowerCase();
  return /^[a-z]{2,3}$/.test(base) ? base : null;
}

/**
 * Hashtags from the record's `tags` field, which holds tags that are *not* in
 * the post text. Tags already present in the text are dropped so they aren't
 * duplicated, and whitespace is stripped because Mastodon hashtags can't
 * contain it.
 */
export function extraHashtags(record: PostRecord, text: string): string[] {
  const existing = new Set(
    (text.match(/#[^\s#]+/g) ?? []).map((t) => t.slice(1).toLowerCase()),
  );
  const tags: string[] = [];

  for (const raw of record.tags ?? []) {
    if (typeof raw !== "string") continue;
    const tag = raw.replace(/^#/, "").replace(/[\s#]+/g, "");
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (existing.has(key)) continue;
    existing.add(key);
    tags.push(tag);
  }
  return tags;
}

/* -------------------------------------------------------------------------- */
/* Text assembly                                                               */
/* -------------------------------------------------------------------------- */

const BSKY_POST_LINK = /^https:\/\/bsky\.app\/profile\/[^/]+\/post\/.+/;

/**
 * Append a link to the text on its own blank-line-separated line. Links to
 * Bluesky posts get a "RE: " prefix by default; pass `prefix` to force one (or
 * `""` to suppress it) when appending a fediverse URL for a quoted post.
 */
export function appendLink(text: string, link: string, prefix?: string): string {
  const marker = prefix ?? (BSKY_POST_LINK.test(link) ? "RE: " : "");
  const body = marker + link;

  const base = text.replace(/\s+$/, "");
  return base.length === 0 ? body : `${base}\n\n${body}`;
}

/** Truncate alt text to `max` characters, ending with "(…)" when clipped. */
export function truncateAlt(alt: string, max: number): string {
  if (max <= 0) return "";
  if (alt.length <= max) return alt;
  if (max <= 3) return alt.slice(0, max);
  return alt.slice(0, max - 3) + "(…)";
}

export function bskyPostLink(repoOrHandle: string, rkey: string): string {
  return `https://bsky.app/profile/${repoOrHandle}/post/${rkey}`;
}

export function bskyProfileLink(repoOrHandle: string): string {
  return `https://bsky.app/profile/${repoOrHandle}`;
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

/**
 * Count characters the way Mastodon does: every URL costs a fixed weight
 * regardless of its real length, because the server rewrites them.
 */
export function countChars(text: string, urlWeight = 23): number {
  let total = 0;
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    total += [...text.slice(cursor, start)].length + urlWeight;
    cursor = start + match[0].length;
  }
  total += [...text.slice(cursor)].length;
  return total;
}

/** Byte ranges covered by URLs, used to avoid splitting a link in half. */
function urlRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    ranges.push([start, start + match[0].length]);
  }
  return ranges;
}

/** Largest prefix length of `text` that still fits within `maxChars`. */
function longestFittingPrefix(text: string, maxChars: number, urlWeight: number): number {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (countChars(text.slice(0, mid), urlWeight) <= maxChars) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/**
 * Split text that exceeds the instance's character limit into a sequence of
 * posts, preferring paragraph, then line, then sentence, then word boundaries,
 * and never cutting through the middle of a URL.
 */
export function splitText(text: string, maxChars: number, urlWeight = 23): string[] {
  if (maxChars <= 0 || countChars(text, urlWeight) <= maxChars) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > 0 && countChars(rest, urlWeight) > maxChars) {
    let cut = longestFittingPrefix(rest, maxChars, urlWeight);
    if (cut <= 0) break; // a single URL longer than the whole budget

    // Never cut inside a URL: back up to where the URL starts.
    for (const [start, end] of urlRanges(rest)) {
      if (cut > start && cut < end) {
        cut = start;
        break;
      }
    }

    const boundary = findBoundary(rest, cut);
    if (boundary <= 0) break; // no usable split point, emit what's left as-is

    chunks.push(rest.slice(0, boundary).replace(/\s+$/, ""));
    rest = rest.slice(boundary).replace(/^\s+/, "");
  }

  if (rest.length > 0) chunks.push(rest);
  return chunks.filter((c) => c.length > 0);
}

/** Find a natural break at or before `limit`, falling back to a hard cut. */
function findBoundary(text: string, limit: number): number {
  const window = text.slice(0, limit);
  // Only accept a boundary that isn't wastefully early in the chunk.
  const floor = Math.floor(limit * 0.4);

  const candidates = [
    window.lastIndexOf("\n\n"),
    window.lastIndexOf("\n"),
    lastSentenceEnd(window),
    window.lastIndexOf(" "),
  ];

  for (const candidate of candidates) {
    if (candidate > floor) return candidate;
  }
  return limit;
}

function lastSentenceEnd(text: string): number {
  const match = [...text.matchAll(/[.!?…](?=\s)/g)].pop();
  return match ? (match.index ?? -1) + 1 : -1;
}

/** Split an array into consecutive groups of at most `size` items. */
export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return items.length > 0 ? [items] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function toInt(value: unknown): number {
  if (typeof value === "number") return Math.trunc(value);
  const n = parseInt(String(value ?? ""), 10);
  return Number.isNaN(n) ? 0 : n;
}

/* -------------------------------------------------------------------------- */
/* Eligibility                                                                 */
/* -------------------------------------------------------------------------- */

export interface EligibilityOptions {
  /** Never cross-post replies, not even to your own posts. */
  skipReplies: boolean;
  /** Skip posts labelled !no-unauthenticated. */
  skipHiddenPosts: boolean;
}

/**
 * Why a post must never be cross-posted, or null if it may be. This is checked
 * before anything else and doesn't depend on whether a parent made it across.
 *
 * The reply rules are the important part: only threads that are entirely yours
 * travel. Replying to someone else never does, and neither does replying to
 * yourself underneath someone else's post — the parent being yours isn't
 * enough, because the conversation it sits in isn't.
 */
export function ineligibleReason(
  record: PostRecord,
  ownDid: string,
  options: EligibilityOptions,
): string | null {
  if (options.skipHiddenPosts && selfLabels(record).includes(NO_UNAUTHENTICATED)) {
    return "post is hidden from logged-out viewers on Bluesky";
  }

  const reply = record.reply;
  if (!reply) return null;

  if (options.skipReplies) return "replies are disabled (skip_replies)";

  const parent = parseAtUri(reply.parent?.uri);
  if (!parent) return "reply with an unreadable parent reference";
  if (parent.repo !== ownDid) return "reply to someone else's post";

  const root = parseAtUri(reply.root?.uri ?? reply.parent?.uri);
  if (!root) return "reply with an unreadable root reference";
  if (root.repo !== ownDid) return "reply inside someone else's thread";

  return null;
}

/* -------------------------------------------------------------------------- */
/* CLI helpers                                                                 */
/* -------------------------------------------------------------------------- */

export type LoginKind = "mastodon" | "bluesky" | "help" | "invalid";

/** Classify a login argument the way the Ruby `login` dispatcher did. */
export function detectLoginKind(name: string | undefined | null): LoginKind {
  if (name == null) return "help";
  if (/^[^@]+@[^@]+$/.test(name)) return "mastodon";
  if (/^@?[^@]+$/.test(name)) return "bluesky";
  return "invalid";
}
