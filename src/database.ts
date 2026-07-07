import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_FILE } from "./config.ts";

export interface PostRow {
  id: number;
  bluesky_rkey: string;
  mastodon_id: string;
}

let db: Database | null = null;

/**
 * Open the SQLite history database and create the schema if needed. This
 * replaces the ActiveRecord migration in db/migrate/001_create_posts.rb; the
 * column layout matches, so an existing Ruby-created database keeps working.
 */
export function initDatabase(): Database {
  if (db) return db;

  mkdirSync(dirname(DB_FILE), { recursive: true });
  db = new Database(DB_FILE);
  db.run(
    "CREATE TABLE IF NOT EXISTS posts (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "bluesky_rkey TEXT NOT NULL, " +
      "mastodon_id TEXT NOT NULL)",
  );
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS index_posts_on_bluesky_rkey " +
      "ON posts (bluesky_rkey)",
  );
  return db;
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

  /** Record a new Bluesky→Mastodon mapping (Post.create!). */
  create(rkey: string, mastodonId: string): void {
    conn()
      .query("INSERT INTO posts (bluesky_rkey, mastodon_id) VALUES (?, ?)")
      .run(rkey, mastodonId);
  },
};
