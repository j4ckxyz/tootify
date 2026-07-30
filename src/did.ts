import { resolveTxt } from "node:dns/promises";

// Identity helpers replacing the `didkit` gem: resolve a handle to a DID and
// resolve a DID document to its Personal Data Server host.

const PDS_SERVICE_ID = "#atproto_pds";

interface DidService {
  id?: string;
  type?: string;
  serviceEndpoint?: string;
}

interface DidDocument {
  alsoKnownAs?: string[];
  service?: DidService[];
}

// DID documents change rarely and we may look up the same account many times in
// one run, so cache resolutions for the lifetime of the process.
const documentCache = new Map<string, Promise<DidDocument>>();

/**
 * Resolve a Bluesky handle to a DID, trying the DNS TXT record first
 * (`_atproto.<handle>`) and falling back to the HTTPS well-known endpoint.
 * Returns null if the handle cannot be resolved.
 */
export async function resolveHandle(handle: string): Promise<string | null> {
  const fromDns = await resolveHandleViaDns(handle);
  if (fromDns) return fromDns;
  return resolveHandleViaWellKnown(handle);
}

async function resolveHandleViaDns(handle: string): Promise<string | null> {
  try {
    const records = await resolveTxt(`_atproto.${handle}`);
    for (const chunks of records) {
      const value = chunks.join("");
      if (value.startsWith("did=")) return value.slice("did=".length).trim();
    }
  } catch {
    // no TXT record / lookup failed – fall through to well-known
  }
  return null;
}

async function resolveHandleViaWellKnown(handle: string): Promise<string | null> {
  try {
    const res = await fetch(`https://${handle}/.well-known/atproto-did`);
    if (!res.ok) return null;
    const did = (await res.text()).trim();
    return did.startsWith("did:") ? did : null;
  } catch {
    return null;
  }
}

/** Fetch and parse a DID document from the appropriate registry. */
function fetchDidDocument(did: string): Promise<DidDocument> {
  let cached = documentCache.get(did);
  if (!cached) {
    cached = fetchDidDocumentUncached(did);
    documentCache.set(did, cached);
    // Don't cache failures: a transient network error shouldn't poison every
    // later lookup of the same account.
    cached.catch(() => documentCache.delete(did));
  }
  return cached;
}

async function fetchDidDocumentUncached(did: string): Promise<DidDocument> {
  let url: string;
  if (did.startsWith("did:plc:")) {
    url = `https://plc.directory/${did}`;
  } else if (did.startsWith("did:web:")) {
    const domain = did.slice("did:web:".length).replace(/:/g, "/");
    url = `https://${domain}/.well-known/did.json`;
  } else {
    throw new Error(`Unsupported DID method: ${did}`);
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to resolve DID document for ${did}: HTTP ${res.status}`);
  }
  return (await res.json()) as DidDocument;
}

/**
 * Return the bare host (e.g. "pds.example.com") of the DID's Personal Data
 * Server, matching how minisky used `did.document.pds_host`.
 */
export async function pdsHost(did: string): Promise<string> {
  const doc = await fetchDidDocument(did);
  const service = (doc.service ?? []).find(
    (s) => s.id?.endsWith(PDS_SERVICE_ID) || s.type === "AtprotoPersonalDataServer",
  );
  if (!service?.serviceEndpoint) {
    throw new Error(`No PDS service endpoint in DID document for ${did}`);
  }
  return new URL(service.serviceEndpoint).host;
}

/**
 * Resolve a DID to its current handle via the `alsoKnownAs` entry of the DID
 * document. Returns null rather than throwing: callers always have a fallback
 * (the handle text in the post, or the DID itself), and a mention should never
 * be able to fail a whole cross-post.
 */
export async function didToHandle(did: string): Promise<string | null> {
  try {
    const doc = await fetchDidDocument(did);
    for (const aka of doc.alsoKnownAs ?? []) {
      if (typeof aka === "string" && aka.startsWith("at://")) {
        const handle = aka.slice("at://".length).trim();
        if (handle.length > 0) return handle.toLowerCase();
      }
    }
  } catch {
    // unresolvable DID – fall back to whatever the caller has
  }
  return null;
}
