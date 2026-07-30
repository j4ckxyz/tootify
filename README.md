# Tootify 🦋→🐘

A simple Bluesky-to-Mastodon cross-posting service


## What does it do

Tootify does a one-way sync of Bluesky posts to your Mastodon (or GoToSocial) account.

There are two ways to choose what gets synced:

- **Like mode** (the default) – it scans your recent posts and checks which of them you have liked yourself, and only those posts are reposted. The self-like is automatically removed afterwards.
- **Everything mode** – set `TOOTIFY_CROSSPOST_ALL=1` (or pass `--all`) and every eligible post is cross-posted automatically, with no like needed.

Either way, replies to other people are never cross-posted – see [What gets cross-posted](#what-gets-cross-posted).

Currently handles:

- link embeds (the URL is appended so your instance renders the card)
- **quotes**, including quotes of your own earlier posts, which become real Mastodon quote posts on instances that support them, and link to the *toot* – not to bsky.app – on instances that don't
- **@mentions**, rewritten to a link to the mentioned person's Bluesky profile, or to a real fediverse mention if they're bridged
- **images, including the newer 10-image gallery posts**, with every alt text carried across
- videos (with alt text)
- threads of multiple chained posts from you
- hashtags, post language, and self-labels mapped onto content warnings
- posts too long or with more pictures than your instance allows, which are split into a thread rather than truncated


## Installation

To run this tool, you need [Bun](https://bun.com) installed (v1.2+). You can install it with:

    curl -fsSL https://bun.com/install | bash

(see more installation options on [bun.com](https://bun.com/docs/installation)).

To install the app, run:

    git clone https://tangled.org/mackuba.eu/tootify
    cd tootify
    bun install


## Usage

First, log in to the two accounts:

    ./tootify login johnmastodon@example.com
    ./tootify login @alf.bsky.team

Press like on the post(s) on Bluesky that you want to be synced to Mastodon.

Then, you can either run the sync once:

    ./tootify check

Or run it continuously in a loop:

    ./tootify watch

By default it checks for new skeets every 60 seconds – use the `interval` parameter to customize the interval:

    ./tootify watch --interval=15


## Cross-posting everything

If you'd rather not have to like every post, set one environment variable and every eligible post gets cross-posted:

    TOOTIFY_CROSSPOST_ALL=1 ./tootify watch

or equivalently `./tootify watch --all`, or `{ "crosspost_all": true }` in `tootify.json`.

In this mode your likes are ignored completely and never deleted – they're no longer a signal, so Tootify leaves them alone.

**Turning it on does not backfill your history.** The first run in this mode records a watermark and only cross-posts things you post from that point on. To include older posts, either pick a starting point:

    TOOTIFY_CROSSPOST_ALL=1 TOOTIFY_BACKFILL_SINCE=2026-07-01 ./tootify check

or take the whole repo, which can be a lot of toots:

    TOOTIFY_CROSSPOST_ALL=1 TOOTIFY_BACKFILL_ALL=1 ./tootify check

Each run cross-posts at most `TOOTIFY_MAX_POSTS_PER_RUN` posts (20 by default, oldest first) so a mistake stays small; the rest follow on the next run. Set it to `0` to lift the cap.

Before letting it loose, do a dry run – it prints exactly what it would post, and touches nothing:

    TOOTIFY_CROSSPOST_ALL=1 TOOTIFY_DRY_RUN=1 ./tootify check


## What gets cross-posted

A post is cross-posted when it's yours and it isn't part of somebody else's conversation:

| Post | Cross-posted? |
| --- | --- |
| A top-level post | yes |
| A reply to your own post, in your own thread | yes, chained onto the toot the parent became |
| A reply to someone else's post | **no** |
| A reply to someone else's reply | **no** |
| A reply to yourself underneath someone else's post | **no** – the parent is yours, but the conversation isn't |
| A reply whose parent hasn't been cross-posted | no, to avoid an orphaned toot with no context |
| A post labelled "hide from logged-out viewers" | no by default (a toot would be world-readable) |

Quoting works in both directions of that rule: quoting *anyone* is fine, since a quote isn't a reply.


## Configuration

Tootify stores configs and data in the `config` folder:

* `bluesky.json` – created when you log in, stores Bluesky user ID/password and access tokens
* `mastodon.json` – created when you log in, stores Mastodon user ID/password and access tokens
* `tootify.json` – optional additional configuration

Every option can be set either in `tootify.json` (as `snake_case`) or as an environment variable. The environment wins over the file, and command-line flags win over both.

| Environment variable | `tootify.json` key | Default | What it does |
| --- | --- | --- | --- |
| `TOOTIFY_CROSSPOST_ALL` | `crosspost_all` | `false` | Cross-post every eligible post instead of only self-liked ones |
| `TOOTIFY_BACKFILL_SINCE` | `backfill_since` | – | Only consider posts from this date/timestamp onwards |
| `TOOTIFY_BACKFILL_ALL` | `backfill_all` | `false` | Ignore the watermark and consider your whole post history |
| `TOOTIFY_MAX_POSTS_PER_RUN` | `max_posts_per_run` | `20` | Cap on posts per run; `0` means no cap |
| `TOOTIFY_INTERVAL` | `interval` | `60` | Seconds between checks in `watch` mode |
| `TOOTIFY_DRY_RUN` | `dry_run` | `false` | Log what would be posted; post nothing, delete no likes |
| `TOOTIFY_MENTION_STYLE` | `mention_style` | `link` | How to render `@mentions` – see below |
| `TOOTIFY_BRIDGE_DOMAIN` | `bridge_domain` | `bsky.brid.gy` | Bridge domain used by `mention_style: bridge` |
| `TOOTIFY_QUOTE_POSTS` | `quote_posts` | `auto` | `auto` uses native quotes if the instance supports them; `on` forces, `off` always links |
| `TOOTIFY_EXTRACT_LINK_FROM_QUOTES` | `extract_link_from_quotes` | `false` | Collapse a quote of someone else's link post into a plain post linking straight to the article |
| `TOOTIFY_SPLIT_LONG_POSTS` | `split_long_posts` | `true` | Split posts over the instance's character limit into a thread instead of truncating |
| `TOOTIFY_SPLIT_MEDIA` | `split_media` | `true` | Spill pictures over the instance's attachment limit into follow-up posts instead of dropping them |
| `TOOTIFY_CONTENT_WARNINGS` | `content_warnings` | `true` | Map Bluesky self-labels onto content warnings |
| `TOOTIFY_SKIP_HIDDEN_POSTS` | `skip_hidden_posts` | `true` | Skip posts labelled `!no-unauthenticated` |
| `TOOTIFY_SKIP_REPLIES` | `skip_replies` | `false` | Never cross-post replies, not even your own threads |
| `TOOTIFY_VISIBILITY` | `visibility` | – | Force `public`, `unlisted`, `private` or `direct` on every toot |

Booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`.

### Mention styles

Bluesky mentions carry a DID, and a bare `@someone.bsky.social` means nothing on Mastodon (or worse, could match an unrelated local account), so it has to be rewritten. The handle is always re-resolved from the DID, so a mention still points at the right person if they've since changed handles.

- `link` (default) – `@alice.bsky.social` becomes `https://bsky.app/profile/alice.bsky.social`
- `bridge` – looks up `alice.bsky.social@bsky.brid.gy` on your instance and, if that account exists, emits a real fediverse mention that will actually notify them; falls back to `link` when they aren't bridged
- `plain` – just `alice.bsky.social`, with no `@` and no link
- `keep` – leave the text exactly as Bluesky had it

### Quotes

On Mastodon 4.5+ (API version 7) quotes of your own earlier posts become real quote posts: Tootify looks the original up in its own history database, so it works however long ago you posted it. Quotes of other people become real quote posts too when that person is bridged to the fediverse and their quote policy allows it.

Where a native quote isn't possible, the quoted post is appended as a link – preferring the fediverse URL of the toot and only falling back to a `bsky.app` link when there isn't one. Mastodon doesn't allow a quote and media on the same post, so a Bluesky post that has both keeps its pictures and links the quote.

### Instance limits

Limits are read from your instance's `/api/v2/instance` rather than assumed, so a GoToSocial server configured for 10 attachments and 5000 characters is used to its full extent, and a stock Mastodon (4 attachments, 500 characters) gets a neatly split thread instead of a rejected post or lost pictures. Alt text is truncated to the instance's own `description_limit`.

There is also an SQLite database file that's automatically created in `db/history.sqlite3`. It stores a mapping between Bluesky and Mastodon post IDs, and is used to maintain reply references in threads and to resolve self-quotes. A database created by an older version is migrated in place, keeping its history.


## Development

Run the tests with:

    bun test

They cover the post-transformation logic, the settings/environment layer, the database migration, and an end-to-end sync against a faked Bluesky PDS and Mastodon instance.

Type-check with:

    bun x tsc --noEmit


## Credits

Bun/TypeScript rewrite by jack ([@j4ck.xyz](https://bsky.app/profile/j4ck.xyz)).

Based on the original Tootify by Kuba Suder ([@mackuba.eu](https://bsky.app/profile/did:plc:oio4hkxaop4ao4wz2pp3f4cr)), copyright © 2025.

The code is available under the terms of the [zlib license](https://choosealicense.com/licenses/zlib/) (permissive, similar to MIT).

Bug reports and pull requests are welcome 😎
