import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_FILE } from "./config.ts";

export interface PostRow {
  id: number;
  bluesky_rkey: string;
  /** First status of the cross-post; the one a quote should point at. */
  mastodon_id: string;
  /** Public URL of that status, used when quoting without native support. */
  mastodon_url: string | null;
  /** Last status of the cross-post; the one a reply should chain onto. */
  mastodon_last_id: string | null;
}

let db: Database | null = null;

function hasColumn(conn: Database, table: string, column: string): boolean {
  const rows = conn.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

/**
 * Bring a history database up to the current schema. This replaces the
 * ActiveRecord migration in db/migrate/001_create_posts.rb; the original column
 * layout is preserved and newer columns are added in place, so a database
 * created by the Ruby version keeps working and keeps its history.
 */
export function migrate(conn: Database): void {
  conn.run(
    "CREATE TABLE IF NOT EXISTS posts (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "bluesky_rkey TEXT NOT NULL, " +
      "mastodon_id TEXT NOT NULL)",
  );
  conn.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS index_posts_on_bluesky_rkey " + "ON posts (bluesky_rkey)",
  );

  if (!hasColumn(conn, "posts", "mastodon_url")) {
    conn.run("ALTER TABLE posts ADD COLUMN mastodon_url TEXT");
  }
  if (!hasColumn(conn, "posts", "mastodon_last_id")) {
    conn.run("ALTER TABLE posts ADD COLUMN mastodon_last_id TEXT");
    // Rows written before cross-posts could span several statuses have exactly
    // one status, so it is both the first and the last.
    conn.run("UPDATE posts SET mastodon_last_id = mastodon_id WHERE mastodon_last_id IS NULL");
  }

  conn.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
}

/** Open the history database, creating and migrating it if needed. */
export function initDatabase(): Database {
  if (db) return db;

  mkdirSync(dirname(DB_FILE), { recursive: true });
  db = new Database(DB_FILE);
  migrate(db);
  return db;
}

/** Close the handle so the next call reopens the file. Used by the tests. */
export function closeDatabase(): void {
  db?.close();
  db = null;
}

function conn(): Database {
  return db ?? initDatabase();
}

export const Posts = {
  /** Look up a cross-posted record by its Bluesky rkey (Post.find_by). */
  findByRkey(rkey: string): PostRow | null {
    return conn()
      .query<PostRow, [string]>("SELECT * FROM posts WHERE bluesky_rkey = ?")
      .get(rkey);
  },

  /**
   * Record a new Bluesky→Mastodon mapping. Called as soon as the first status
   * exists so that a crash midway through a split thread can't cause the whole
   * post to be sent again on the next run.
   */
  create(rkey: string, mastodonId: string, mastodonUrl?: string | null): void {
    conn()
      .query(
        "INSERT OR IGNORE INTO posts (bluesky_rkey, mastodon_id, mastodon_url, mastodon_last_id) " +
          "VALUES (?, ?, ?, ?)",
      )
      .run(rkey, mastodonId, mastodonUrl ?? null, mastodonId);
  },

  /** Point the reply chain at the final status of a split cross-post. */
  setLastId(rkey: string, mastodonId: string): void {
    conn()
      .query("UPDATE posts SET mastodon_last_id = ? WHERE bluesky_rkey = ?")
      .run(mastodonId, rkey);
  },

  /** Backfill the status URL for rows written before it was recorded. */
  setUrl(rkey: string, url: string): void {
    conn().query("UPDATE posts SET mastodon_url = ? WHERE bluesky_rkey = ?").run(url, rkey);
  },
};

export const Meta = {
  get(key: string): string | null {
    const row = conn().query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
    return row?.value ?? null;
  },

  set(key: string, value: string): void {
    conn()
      .query(
        "INSERT INTO meta (key, value) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  },
};

/** Meta key holding the instant crosspost-all mode was first enabled. */
export const CROSSPOST_ALL_WATERMARK = "crosspost_all_since";
