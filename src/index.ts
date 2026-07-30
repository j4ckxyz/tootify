#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { detectLoginKind } from "./posts.ts";
import { loadSettings } from "./settings.ts";
import { Tootify } from "./tootify.ts";

const PROGRAM = "tootify";

function printHelp(): never {
  console.log(`Usage: ${PROGRAM} login mastodon@account | login @bluesky`);
  console.log(`       ${PROGRAM} check | watch [--interval=SECONDS] [--all] [--dry-run]`);
  console.log();
  console.log("Options:");
  console.log("  --interval=N   seconds between checks in watch mode (default 60)");
  console.log("  --all          cross-post every post, not only self-liked ones");
  console.log("  --dry-run      show what would be posted without posting it");
  console.log();
  console.log("Every option can also be set with an environment variable");
  console.log("(TOOTIFY_CROSSPOST_ALL, TOOTIFY_DRY_RUN, ...) – see the README.");
  process.exit(1);
}

/** Read a single echoed line from stdin. */
async function readLine(promptText: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(promptText)).replace(/\r$/, "");
  } finally {
    rl.close();
  }
}

/** Read a line from stdin without echoing it (for passwords). */
function readPassword(promptText: string): Promise<string> {
  process.stdout.write(promptText);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode?.(true);
  stdin.resume();

  const chars: string[] = [];
  return new Promise<string>((resolve) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") {
          stdin.removeListener("data", onData);
          stdin.setRawMode?.(wasRaw ?? false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(chars.join(""));
          return;
        } else if (code === 3) {
          // Ctrl-C
          stdin.setRawMode?.(wasRaw ?? false);
          process.stdout.write("\n");
          process.exit(1);
        } else if (code === 127 || code === 8) {
          // backspace / delete
          chars.pop();
        } else {
          chars.push(ch);
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function login(app: Tootify, name: string | undefined): Promise<void> {
  switch (detectLoginKind(name)) {
    case "mastodon":
      await app.loginToMastodon(name!, () => readLine(">> "));
      break;
    case "bluesky": {
      const password = await readPassword("App password: ");
      await app.loginToBluesky(name!, password);
      break;
    }
    case "help":
      printHelp();
      break;
    case "invalid":
      console.log(`Invalid handle: ${JSON.stringify(name)}`);
      process.exit(1);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options = argv.filter((x) => x.startsWith("-"));
  const args = argv.filter((x) => !x.startsWith("-"));

  // Command-line flags are the highest-priority layer: they win over both the
  // environment and config/tootify.json.
  const env: Record<string, string | undefined> = { ...process.env };
  for (const o of options) {
    if (o.startsWith("--interval=")) {
      env["TOOTIFY_INTERVAL"] = o.split("=")[1] ?? "";
    } else if (o === "--all") {
      env["TOOTIFY_CROSSPOST_ALL"] = "1";
    } else if (o === "--dry-run") {
      env["TOOTIFY_DRY_RUN"] = "1";
    } else {
      console.log(`Unknown option: ${o}`);
      printHelp();
    }
  }

  const app = new Tootify(loadSettings(env));

  switch (args[0]) {
    case "login":
      await login(app, args[1]);
      break;
    case "check":
      await app.sync();
      break;
    case "watch":
      await app.watch();
      break;
    default:
      printHelp();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
