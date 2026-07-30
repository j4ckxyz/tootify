import type { InstanceCapabilities } from "./mastodon.ts";
import {
  appendLink,
  bskyPostLink,
  chunkArray,
  collectMedia,
  contentWarning,
  countChars,
  extraHashtags,
  linkEmbed,
  primaryLanguage,
  renderFacets,
  selfLabels,
  splitText,
  type MediaItem,
  type PostRecord,
} from "./posts.ts";

// Turning a Bluesky record into one or more Mastodon statuses. Everything that
// needs the network — resolving mentions, finding the quoted toot, reading the
// instance's limits — is done by the caller and passed in, so the shaping
// itself stays pure and testable.

/** What a quoted Bluesky post resolved to on the Mastodon side. */
export interface ResolvedQuote {
  /** Set when the instance can represent this as a native quote post. */
  statusId: string | null;
  /** Best available URL to link to, preferring the fediverse copy. */
  link: string | null;
}

export const NO_QUOTE: ResolvedQuote = { statusId: null, link: null };

/** One Mastodon status in a (possibly multi-part) cross-post. */
export interface StatusPart {
  text: string;
  media: MediaItem[];
  quotedStatusId: string | null;
  /** URL to fall back to if the instance refuses the native quote. */
  quoteLink: string | null;
  language: string | null;
  spoilerText: string | null;
  sensitive: boolean;
}

export interface ComposeOptions {
  contentWarnings: boolean;
  splitLongPosts: boolean;
  splitMedia: boolean;
}

export interface ComposeInput {
  record: PostRecord;
  /** Record key of the post, used for the fallback permalink. */
  rkey: string;
  /** Your own handle, for building that permalink. */
  selfHandle: string;
  /** DID -> replacement text for mention facets. */
  mentions: Map<string, string>;
  quote: ResolvedQuote;
  capabilities: InstanceCapabilities;
  options: ComposeOptions;
}

export interface ComposeResult {
  parts: StatusPart[];
  /** Things worth telling the user about, logged by the caller. */
  notes: string[];
}

export function composeStatuses(input: ComposeInput): ComposeResult {
  const { record, rkey, selfHandle, mentions, quote, capabilities, options } = input;
  const notes: string[] = [];

  let text = renderFacets(record, { mentions });

  // The link card's URL isn't part of the post text on Bluesky, so it has to be
  // added explicitly for Mastodon to show a card for it.
  const link = linkEmbed(record);
  if (link && !text.includes(link)) {
    text = appendLink(text, link);
  }

  let media = collectMedia(record);
  let quotedStatusId = quote.statusId;

  if (quotedStatusId && media.length > 0) {
    // Mastodon refuses to attach media to a quote post. Losing the pictures
    // would cost more than losing the native quote, so the quote becomes a link.
    notes.push("Post has both a quote and media; posting the quote as a link instead");
    quotedStatusId = null;
  }

  if (!quotedStatusId && quote.link && !text.includes(quote.link)) {
    text = appendLink(text, quote.link, "RE: ");
  }

  const hashtags = extraHashtags(record, text);
  if (hashtags.length > 0) {
    const body = text.replace(/\s+$/, "");
    const tags = hashtags.map((t) => `#${t}`).join(" ");
    text = body.length > 0 ? `${body}\n\n${tags}` : tags;
  }

  // An empty status is rejected by the API, so link to the original instead.
  if (text.trim().length === 0 && media.length === 0) {
    text = bskyPostLink(selfHandle, rkey);
  }

  if (media.length > capabilities.maxMediaAttachments && !options.splitMedia) {
    notes.push(
      `Post has ${media.length} attachments but the instance allows ` +
        `${capabilities.maxMediaAttachments}; dropping the rest (split_media is off)`,
    );
    media = media.slice(0, capabilities.maxMediaAttachments);
  }

  const warning = options.contentWarnings ? contentWarning(selfLabels(record)) : null;

  const textChunks = options.splitLongPosts
    ? splitText(text, capabilities.maxCharacters, capabilities.urlWeight)
    : [truncateToLimit(text, capabilities.maxCharacters, capabilities.urlWeight)];

  const mediaChunks = chunkArray(media, capabilities.maxMediaAttachments);

  if (textChunks.length > 1) {
    notes.push(`Post is over the ${capabilities.maxCharacters} character limit; posting a thread`);
  }
  if (mediaChunks.length > 1) {
    notes.push(
      `Post has ${media.length} attachments but the instance allows ` +
        `${capabilities.maxMediaAttachments} per status; spreading them over a thread`,
    );
  }

  const shared = {
    language: primaryLanguage(record),
    spoilerText: warning,
    sensitive: warning != null,
    quoteLink: quote.link,
  };

  const count = Math.max(textChunks.length, mediaChunks.length, 1);
  const parts: StatusPart[] = [];

  for (let i = 0; i < count; i++) {
    parts.push({
      ...shared,
      text: textChunks[i] ?? "",
      media: mediaChunks[i] ?? [],
      // A quote belongs on the opening status of the thread only.
      quotedStatusId: i === 0 ? quotedStatusId : null,
    });
  }

  return { parts, notes };
}

/** Hard-clip text to the instance limit when thread splitting is disabled. */
export function truncateToLimit(text: string, maxChars: number, urlWeight: number): string {
  if (countChars(text, urlWeight) <= maxChars) return text;

  let out = text;
  while (out.length > 0 && countChars(out, urlWeight) > maxChars - 1) {
    out = out.slice(0, -1);
  }
  return out.replace(/\s+$/, "") + "…";
}
