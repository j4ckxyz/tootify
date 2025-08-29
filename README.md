# Tootify 🦋→⚡

A simple Bluesky-to-Nostr cross-posting service


## What does it do

Tootify allows you to do a selective one-way sync of Bluesky posts to your Nostr account.

The way it works lets you easily pick which skeets you want to turn into toots: it scans your recent posts and checks which of them you have liked yourself, and only those posts are reposted. The self-like is automatically removed afterwards.

Currently handles:

- post with link embeds
- quotes – posted as "RE: bsky.app/..."
- images (with alt text)
- videos
- threads of multiple chained posts from you


## Installation

At the moment:

    git clone https://github.com/mackuba/tootify.git
    cd tootify
    bundle install


## Usage

First, log in to the two accounts:

    ./tootify login nsec1yourprivatekey...
    ./tootify login @alf.bsky.team

Press like on the post(s) on Bluesky that you want to be synced to Nostr.

Then, you can either run the sync once:

    ./tootify check

Or run it continuously in a loop:

    ./tootify watch

By default it checks for new skeets every 60 seconds – use the `interval` parameter to customize the interval:

    ./tootify watch --interval=15


## Configs

Tootify stores configs and data in the `config` folder:

* `bluesky.yml` – created when you log in, stores Bluesky user ID/password and access tokens
* `nostr.yml` – created when you log in, stores your encrypted Nostr secret key and relay settings
* `tootify.yml` - optional additional configuration

The Nostr secret key is encrypted with a password entered during login. Set the same password in the `NSEC_PASSPHRASE` environment variable when running the sync so the key can be decrypted.

The config in `tootify.yml` currently supports one option:

- `extract_link_from_quotes: true` – if enabled, posts which are quotes of someone else's post that includes a link will be "collapsed" into a normal post that just includes that link directly without the quote

There is also an SQLite database file that's automatically created in `db/history.sqlite3`. It stores a mapping between Bluesky and Nostr event IDs, and is used to maintain reply references in threads.


## Credits

Copyright © 2025 Kuba Suder ([@mackuba.eu](https://bsky.app/profile/mackuba.eu)).

The code is available under the terms of the [zlib license](https://choosealicense.com/licenses/zlib/) (permissive, similar to MIT).
