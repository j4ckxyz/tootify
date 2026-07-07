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
  service?: DidService[];
}

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
async function fetchDidDocument(did: string): Promise<DidDocument> {
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
