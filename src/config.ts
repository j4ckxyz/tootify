import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root is one level above src/.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const CONFIG_DIR = join(ROOT, "config");
export const DB_FILE = join(ROOT, "db", "history.sqlite3");

/** Ensure the config directory exists (mirrors BlueskyClient#initialize). */
export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function configPath(name: string): string {
  return join(CONFIG_DIR, `${name}.json`);
}

/** Read a JSON config file, returning {} if it doesn't exist. */
export function readConfig<T extends object = Record<string, unknown>>(name: string): T {
  const path = configPath(name);
  if (!existsSync(path)) return {} as T;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Write a JSON config file (pretty-printed). */
export function writeConfig(name: string, data: unknown): void {
  ensureConfigDir();
  writeFileSync(configPath(name), JSON.stringify(data, null, 2) + "\n");
}
