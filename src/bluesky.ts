import { ensureConfigDir, readConfig, writeConfig } from "./config.ts";
import { pdsHost, resolveHandle } from "./did.ts";

// AT Protocol client replacing the `minisky` gem plus app/bluesky_*.rb.

/** Thrown when the session (and its refresh token) has expired. */
export class ExpiredTokenError extends Error {
  constructor(message = "Bluesky session expired") {
    super(message);
    this.name = "ExpiredTokenError";
  }
}

/** Thrown on a 4xx XRPC response (e.g. record not found). */
export class ClientErrorResponse extends Error {
  status: number;
  data: unknown;
  constructor(status: number, data: unknown) {
    super(`Client error ${status}`);
    this.name = "ClientErrorResponse";
    this.status = status;
    this.data = data;
  }
}

interface BlueskyConfig {
  host?: string;
  id?: string;
  pass?: string;
  did?: string;
  accessToken?: string;
  refreshToken?: string;
}

function xrpcUrl(host: string, nsid: string, params?: Record<string, unknown>): URL {
  const url = new URL(`https://${host}/xrpc/${nsid}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value));
    }
  }
  return url;
}

/** Unauthenticated getRecord against an arbitrary PDS (for quoted posts). */
export async function getRecordUnauthed(
  host: string,
  repo: string,
  collection: string,
  rkey: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const res = await fetch(xrpcUrl(host, "com.atproto.repo.getRecord", { repo, collection, rkey }));
  if (!res.ok) {
    throw new ClientErrorResponse(res.status, await res.text().catch(() => null));
  }
  return res.json();
}

export class BlueskyAccount {
  private config: BlueskyConfig;

  constructor() {
    ensureConfigDir();
    this.config = readConfig<BlueskyConfig>("bluesky");
  }

  get did(): string {
    return this.config.did ?? "";
  }

  private get host(): string {
    return this.config.host ?? "";
  }

  private save(): void {
    writeConfig("bluesky", this.config);
  }

  async loginWithPassword(handle: string, password: string): Promise<void> {
    const did = await resolveHandle(handle);
    if (!did) {
      console.log(`Error: couldn't resolve handle ${JSON.stringify(handle)}`);
      process.exit(1);
    }

    this.config.host = await pdsHost(did);
    this.config.id = handle;
    this.config.pass = password;

    await this.logIn();
  }

  /** Create a fresh session from the stored id/password. */
  async logIn(): Promise<void> {
    const res = await fetch(xrpcUrl(this.host, "com.atproto.server.createSession"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: this.config.id, password: this.config.pass }),
    });
    if (!res.ok) {
      throw new ClientErrorResponse(res.status, await res.text().catch(() => null));
    }
    const json = (await res.json()) as {
      did: string;
      accessJwt: string;
      refreshJwt: string;
    };
    this.config.did = json.did;
    this.config.accessToken = json.accessJwt;
    this.config.refreshToken = json.refreshJwt;
    this.save();
  }

  /** Refresh the access token; returns false if the refresh token is dead. */
  private async refreshSession(): Promise<boolean> {
    const res = await fetch(xrpcUrl(this.host, "com.atproto.server.refreshSession"), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.refreshToken}` },
    });
    if (!res.ok) return false;
    const json = (await res.json()) as {
      did?: string;
      accessJwt: string;
      refreshJwt: string;
    };
    this.config.accessToken = json.accessJwt;
    this.config.refreshToken = json.refreshJwt;
    if (json.did) this.config.did = json.did;
    this.save();
    return true;
  }

  /** Authenticated fetch with a single transparent token-refresh retry. */
  private async authedFetch(url: URL, init: RequestInit, retry = true): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.config.accessToken}`);
    const res = await fetch(url, { ...init, headers });
    if (res.ok) return res;

    const status = res.status;
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep raw text
    }
    const errorCode = (body as { error?: string } | null)?.error;

    if (retry && status === 400 && (errorCode === "ExpiredToken" || errorCode === "InvalidToken")) {
      if (!(await this.refreshSession())) throw new ExpiredTokenError();
      return this.authedFetch(url, init, false);
    }
    throw new ClientErrorResponse(status, body);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getRequest(nsid: string, params?: Record<string, unknown>): Promise<any> {
    const res = await this.authedFetch(xrpcUrl(this.host, nsid, params), { method: "GET" });
    return res.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async postRequest(nsid: string, params: Record<string, unknown>): Promise<any> {
    const res = await this.authedFetch(xrpcUrl(this.host, nsid), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    return res.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async fetchLikes(): Promise<any[]> {
    const json = await this.getRequest("com.atproto.repo.listRecords", {
      repo: this.did,
      collection: "app.bsky.feed.like",
      limit: 100,
    });
    return json.records;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async fetchRecord(repo: string, collection: string, rkey: string): Promise<any> {
    return this.getRequest("com.atproto.repo.getRecord", { repo, collection, rkey });
  }

  /** Fetch a blob's raw bytes (getBlob returns binary, not JSON). */
  async fetchBlob(cid: string): Promise<Uint8Array> {
    const res = await this.authedFetch(
      xrpcUrl(this.host, "com.atproto.sync.getBlob", { did: this.did, cid }),
      { method: "GET" },
    );
    return new Uint8Array(await res.arrayBuffer());
  }

  async deleteRecordAt(uri: string): Promise<void> {
    const [repo, collection, rkey] = uri.split("/").slice(2, 5);
    await this.postRequest("com.atproto.repo.deleteRecord", { repo, collection, rkey });
  }
}
