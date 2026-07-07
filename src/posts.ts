// Pure transformation helpers ported from app/tootify.rb. These have no
// network or config dependencies so they can be unit-tested in isolation.

const LINK_FACET = "app.bsky.richtext.facet#link";

export interface FacetIndex {
  byteStart: number;
  byteEnd: number;
}

export interface FacetFeature {
  $type: string;
  uri?: string;
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
  createdAt?: string;
  [key: string]: unknown;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Inline link facets into the post text. Facet indices are UTF-8 byte offsets,
 * so we operate on the encoded bytes and rebuild the string. Only
 * `app.bsky.richtext.facet#link` features are expanded.
 */
export function expandFacets(record: PostRecord): string {
  const textBytes = encoder.encode(record.text ?? "");

  const linkFacets = (record.facets ?? [])
    .map((f) => ({
      index: f.index,
      link: f.features.find((ft) => ft.$type === LINK_FACET),
    }))
    .filter((x): x is { index: FacetIndex; link: FacetFeature } => x.link != null)
    .sort((a, b) => a.index.byteStart - b.index.byteStart);

  const chunks: Uint8Array[] = [];
  let cursor = 0;

  for (const { index, link } of linkFacets) {
    if (index.byteStart < cursor) continue; // skip overlapping facets
    chunks.push(textBytes.subarray(cursor, index.byteStart));
    chunks.push(encoder.encode(link.uri ?? ""));
    cursor = index.byteEnd;
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

/** Collect link URIs from facets, excluding Bluesky hashtag links. */
export function linksFromFacets(record: PostRecord): string[] {
  const links: string[] = [];
  for (const f of record.facets ?? []) {
    const link = f.features.find((ft) => ft.$type === LINK_FACET);
    if (link?.uri) links.push(link.uri);
  }
  return links.filter((x) => !x.startsWith("https://bsky.app/hashtag/"));
}

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

const BSKY_POST_LINK = /^https:\/\/bsky\.app\/profile\/.+\/post\/.+/;

/**
 * Append a link to the text on its own blank-line-separated line. Links to
 * Bluesky posts get a "RE: " prefix. Returns the new text (the Ruby version
 * mutated the string in place).
 */
export function appendLink(text: string, link: string): string {
  let result = text;
  if (!result.endsWith("\n")) result += "\n";
  result += "\n";
  result += BSKY_POST_LINK.test(link) ? `RE: ${link}` : link;
  return result;
}

/** Truncate alt text to `max` characters, ending with "(…)" when clipped. */
export function truncateAlt(alt: string, max: number): string {
  if (alt.length > max) {
    return alt.slice(0, max - 3) + "(…)";
  }
  return alt;
}

export function bskyPostLink(repo: string, rkey: string): string {
  return `https://bsky.app/profile/${repo}/post/${rkey}`;
}

export type LoginKind = "mastodon" | "bluesky" | "help" | "invalid";

/** Classify a login argument the way the Ruby `login` dispatcher did. */
export function detectLoginKind(name: string | undefined | null): LoginKind {
  if (name == null) return "help";
  if (/^[^@]+@[^@]+$/.test(name)) return "mastodon";
  if (/^@?[^@]+$/.test(name)) return "bluesky";
  return "invalid";
}
