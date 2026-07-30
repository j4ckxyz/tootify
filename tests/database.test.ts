import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../src/database.ts";

interface ColumnInfo {
  name: string;
}

function columns(db: Database): string[] {
  return db.query<ColumnInfo, []>("PRAGMA table_info(posts)").all().map((c) => c.name);
}

/** The schema created by the original Ruby version's ActiveRecord migration. */
function legacyDatabase(): Database {
  const db = new Database(":memory:");
  db.run(
    "CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "bluesky_rkey TEXT NOT NULL, mastodon_id TEXT NOT NULL)",
  );
  db.run("CREATE UNIQUE INDEX index_posts_on_bluesky_rkey ON posts (bluesky_rkey)");
  return db;
}

describe("migrate", () => {
  test("creates the schema from nothing", () => {
    const db = new Database(":memory:");
    migrate(db);

    expect(columns(db)).toEqual(
      expect.arrayContaining(["bluesky_rkey", "mastodon_id", "mastodon_url", "mastodon_last_id"]),
    );
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'meta'").all()).toHaveLength(1);
  });

  test("upgrades a database created by the Ruby version without losing history", () => {
    const db = legacyDatabase();
    db.run("INSERT INTO posts (bluesky_rkey, mastodon_id) VALUES ('rkey1', '111')");

    migrate(db);

    const row = db
      .query<
        { bluesky_rkey: string; mastodon_id: string; mastodon_last_id: string | null },
        []
      >("SELECT * FROM posts")
      .get()!;

    expect(row.bluesky_rkey).toBe("rkey1");
    expect(row.mastodon_id).toBe("111");
    // A pre-existing cross-post was a single status, so it is its own tail and
    // replies to it still chain correctly.
    expect(row.mastodon_last_id).toBe("111");
  });

  test("is idempotent", () => {
    const db = legacyDatabase();
    migrate(db);
    migrate(db);
    migrate(db);
    expect(columns(db).filter((c) => c === "mastodon_url")).toHaveLength(1);
  });

  test("keeps the rkey unique so a post can't be cross-posted twice", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.run("INSERT INTO posts (bluesky_rkey, mastodon_id) VALUES ('rkey1', '111')");
    db.run("INSERT OR IGNORE INTO posts (bluesky_rkey, mastodon_id) VALUES ('rkey1', '222')");

    expect(db.query("SELECT * FROM posts").all()).toHaveLength(1);
  });
});
