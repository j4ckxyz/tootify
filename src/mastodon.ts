import { readConfig, writeConfig } from "./config.ts";

// Mastodon client porting app/mastodon_api.rb and app/mastodon_account.rb.

const CODE_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";
const MEDIA_CHECK_INTERVAL = 5000; // ms
const APP_NAME = "Tootify";
const MAX_ALT_LENGTH = 1500;

const OAUTH_SCOPES = [
  "read:accounts",
  "read:statuses",
  "read:search",
  "write:media",
  "write:statuses",
].join(" ");

export class APIError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`APIError ${status}: ${body}`);
    this.name = "APIError";
    this.status = status;
    this.body = body;
  }
}

export class UnauthenticatedError extends Error {}
export class UnexpectedResponseError extends Error {}

/** Encode params as application/x-www-form-urlencoded, expanding array values. */
function encodeForm(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) sp.append(key, String(item));
    } else {
      sp.append(key, String(value));
    }
  }
  return sp.toString();
}

export interface PostStatusOptions {
  mediaIds?: string[] | null;
  parentId?: string | null;
  quotedStatusId?: string | null;
}

export class MastodonAPI {
  private host: string;
  private root: string;
  accessToken?: string;

  constructor(host: string, accessToken?: string) {
    this.host = host;
    this.root = `https://${host}/api/v1`;
    this.accessToken = accessToken;
  }

  private resolveUrl(path: string): string {
    return path.startsWith("https://") ? path : this.root + path;
  }

  private authHeaders(): Record<string, string> {
    return this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {};
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getJson(path: string, params?: Record<string, unknown>): Promise<any> {
    const url = new URL(this.resolveUrl(path));
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value != null) url.searchParams.set(key, String(value));
      }
    }
    const res = await fetch(url, { headers: this.authHeaders() });
    if (Math.floor(res.status / 100) === 2) return res.json();
    throw new APIError(res.status, await res.text());
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async postJson(path: string, params: Record<string, unknown>): Promise<any> {
    const res = await fetch(this.resolveUrl(path), {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: encodeForm(params),
    });
    if (Math.floor(res.status / 100) === 2) return res.json();
    throw new APIError(res.status, await res.text());
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerOauthApp(appName: string, scopes: string): Promise<any> {
    return this.postJson(`https://${this.host}/api/v1/apps`, {
      client_name: appName,
      redirect_uris: CODE_REDIRECT_URI,
      scopes,
    });
  }

  generateOauthLoginUrl(clientId: string, scopes: string): string {
    const url = new URL(`https://${this.host}/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: CODE_REDIRECT_URI,
      response_type: "code",
      scope: scopes,
    }).toString();
    return url.toString();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  completeOauthLogin(clientId: string, clientSecret: string, code: string): Promise<any> {
    return this.postJson(`https://${this.host}/oauth/token`, {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: CODE_REDIRECT_URI,
      grant_type: "authorization_code",
      code,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  accountInfo(): Promise<any> {
    if (!this.accessToken) throw new UnauthenticatedError();
    return this.getJson("/accounts/verify_credentials");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  instanceInfo(): Promise<any> {
    return this.getJson(`https://${this.host}/api/v2/instance`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async lookupAccount(username: string): Promise<any> {
    const json = await this.getJson("/accounts/lookup", { acct: username });
    if (!(json && typeof json === "object" && typeof json.id === "string")) {
      throw new UnexpectedResponseError();
    }
    return json;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  accountStatuses(userId: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.getJson(`/accounts/${userId}/statuses`, params);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  postStatus(text: string, options: PostStatusOptions = {}): Promise<any> {
    const params: Record<string, unknown> = { status: text };
    if (options.mediaIds) params["media_ids[]"] = options.mediaIds;
    if (options.parentId) params["in_reply_to_id"] = options.parentId;
    if (options.quotedStatusId) params["quoted_status_id"] = options.quotedStatusId;
    return this.postJson("/statuses", params);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async uploadMedia(
    data: Uint8Array,
    filename: string,
    contentType: string,
    alt?: string | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const form = new FormData();
    form.append("file", new Blob([data], { type: contentType }), filename);
    if (alt) form.append("description", alt);

    const res = await fetch(`https://${this.host}/api/v2/media`, {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
    });

    if (Math.floor(res.status / 100) !== 2) {
      throw new APIError(res.status, await res.text());
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any = await res.json();
    while (json.url == null) {
      await Bun.sleep(MEDIA_CHECK_INTERVAL);
      json = await this.getMedia(json.id);
    }
    return json;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getMedia(mediaId: string): Promise<any> {
    return this.getJson(`/media/${mediaId}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async searchPostByUrl(url: string): Promise<any> {
    const json = await this.getJson(`https://${this.host}/api/v2/search`, {
      q: url,
      type: "statuses",
      resolve: true,
    });
    return json.statuses && json.statuses[0];
  }
}

interface MastodonConfig {
  handle?: string;
  access_token?: string;
  user_id?: string;
}

export class MastodonAccount {
  private config: MastodonConfig;

  constructor() {
    this.config = readConfig<MastodonConfig>("mastodon");
  }

  get maxAltLength(): number {
    return MAX_ALT_LENGTH;
  }

  private get instance(): string {
    return this.config.handle!.split("@").pop()!;
  }

  private api(): MastodonAPI {
    return new MastodonAPI(this.instance, this.config.access_token);
  }

  private save(): void {
    writeConfig("mastodon", this.config);
  }

  /** OAuth out-of-band login. `promptCode` reads the pasted authorization code. */
  async oauthLogin(handle: string, promptCode: () => Promise<string>): Promise<void> {
    const instance = handle.split("@").pop()!;
    const registerApi = new MastodonAPI(instance);
    const appResponse = await registerApi.registerOauthApp(APP_NAME, OAUTH_SCOPES);

    const api = new MastodonAPI(instance);
    const loginUrl = api.generateOauthLoginUrl(appResponse.client_id, OAUTH_SCOPES);

    console.log("Open this URL in your web browser and authorize the app:");
    console.log();
    console.log(loginUrl);
    console.log();
    console.log("Then, enter the received code here:");
    console.log();

    const code = await promptCode();

    const json = await api.completeOauthLogin(
      appResponse.client_id,
      appResponse.client_secret,
      code,
    );

    api.accessToken = json.access_token;
    const info = await api.accountInfo();

    this.config.handle = handle;
    this.config.access_token = api.accessToken;
    this.config.user_id = info.id;
    this.save();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  instanceInfo(): Promise<any> {
    return this.api().instanceInfo();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  postStatus(text: string, options: PostStatusOptions = {}): Promise<any> {
    return this.api().postStatus(text, options);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uploadMedia(
    data: Uint8Array,
    filename: string,
    contentType: string,
    alt?: string | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    return this.api().uploadMedia(data, filename, contentType, alt);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  searchPostByUrl(url: string): Promise<any> {
    return this.api().searchPostByUrl(url);
  }
}
