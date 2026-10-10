/**
 * Linked Data signatures (upstream JsonLdService: RsaSignature2017 over URDNA2015-normalized
 * JSON-LD, after transmute-industries/RsaSignature2017). Uses the `jsonld` package with a
 * document loader that serves upstream's preloaded contexts and fetches anything else
 * (SSRF-guarded, ≤256 documents, frozen after compaction as upstream).
 */

import { BodyTooLargeError, fetchChecked, readCappedText, UnsafeUrlError } from "../safe-fetch.js";
import { importPkcs8Pem, importSpkiPem, isSafeRemoteUrl } from "../../../ap/src/index.js";
import { CONTEXT, PRELOADED_CONTEXTS } from "./ld-contexts.js";

/** jsonld (with rdf-canonize) loads on the first LD signature, not at Worker start. */
const loadJsonLd = async () => (await import("jsonld")).default;

type Doc = Record<string, unknown>;
type RemoteDocument = { contextUrl?: string; document: unknown; documentUrl: string };

export class JsonLdError extends Error {}

/** jsonld's own errors (`jsonld.*`: invalid documents, safe mode, loader failures) → JsonLdError. */
async function wrapJsonLdErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof JsonLdError) throw e;
    const name = e instanceof Error ? e.name : "";
    if (name.startsWith("jsonld.")) throw new JsonLdError(`${name}: ${(e as Error).message}`);
    throw e;
  }
}

const FORBIDDEN_DIRECTIVES = new Set(["@included", "@graph", "@reverse"]);
const textEncoder = new TextEncoder();

function b64(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(data: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(data)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Size limit of a fetched JSON-LD context (upstream getJson: 256 KiB). */
const CONTEXT_MAX_BYTES = 256 * 1024;
/**
 * Contexts one instance (one inbox message) may fetch, beyond the preloaded ones. Legitimate
 * signatures use only preloaded contexts; upstream allows 256, which at 5 s each could hold a
 * queue consumer past its 15-minute limit.
 */
export const MAX_REMOTE_CONTEXTS = 16;
/** Time limit of all context fetches of one instance together. */
export const CONTEXT_FETCH_DEADLINE_MS = 20_000;

export class JsonLd {
  private frozen = false;
  private cache = new Map<string, RemoteDocument>();
  private fetched = 0;
  private deadline: AbortSignal | null = null;
  public preLoad = true;
  public loaderTimeout = 5000;

  constructor(private fetcher: typeof fetch = fetch) {}

  async signRsaSignature2017(data: Doc, privateKeyPem: string, creator: string, domain?: string, created?: Date): Promise<Doc> {
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const options: Record<string, string> = {
      type: "RsaSignature2017",
      creator,
      nonce: [...nonce].map((b) => b.toString(16).padStart(2, "0")).join(""),
      created: (created ?? new Date()).toISOString(),
    };
    if (domain) options.domain = domain;
    const toBeSigned = await this.createVerifyData(data, options);
    const key = await importPkcs8Pem(privateKeyPem);
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, textEncoder.encode(toBeSigned));
    return { ...data, signature: { ...options, signatureValue: b64(sig) } };
  }

  async verifyRsaSignature2017(data: Doc, publicKeyPem: string): Promise<boolean> {
    const sig = data.signature as Record<string, unknown> | undefined;
    if (!sig || typeof sig.signatureValue !== "string") return false;
    const toBeSigned = await this.createVerifyData(data, sig);
    const key = await importSpkiPem(publicKeyPem);
    let raw: Uint8Array;
    try {
      raw = unb64(sig.signatureValue);
    } catch {
      return false;
    }
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, raw as unknown as ArrayBuffer, textEncoder.encode(toBeSigned));
  }

  async createVerifyData(data: Doc, options: Record<string, unknown>): Promise<string> {
    const transformedOptions: Doc = { ...options, "@context": "https://w3id.org/identity/v1" };
    delete transformedOptions.type;
    delete transformedOptions.id;
    delete transformedOptions.signatureValue;
    const optionsHash = await sha256Hex(await this.normalize(transformedOptions));
    const transformedData: Doc = { ...data };
    delete transformedData.signature;
    const documentHash = await sha256Hex(await this.normalize(transformedData));
    return `${optionsHash}${documentHash}`;
  }

  async compact(data: Doc, context: unknown = CONTEXT): Promise<Doc> {
    const jsonld = await loadJsonLd();
    return wrapJsonLdErrors(async () => (await jsonld.compact(data as never, context as never, { documentLoader: this.loader() } as never)) as unknown as Doc);
  }

  /**
   * URDNA2015 (RDFC-1.0) N-Quads. As upstream, jsonld's defaults apply, including its safe mode:
   * a property the contexts do not define makes canonicalization fail instead of being dropped.
   */
  async normalize(data: Doc): Promise<string> {
    const jsonld = await loadJsonLd();
    return wrapJsonLdErrors(async () => (await jsonld.normalize(data as never, { documentLoader: this.loader() } as never)) as unknown as string);
  }

  /** No more context fetches (upstream: during signature verification). */
  freeze(): void {
    this.frozen = true;
  }

  checkForForbiddenDirectives(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const v of value) this.checkForForbiddenDirectives(v);
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_DIRECTIVES.has(k)) throw new JsonLdError(`${k} is forbidden by Misskey in ActivityPub documents`);
      this.checkForForbiddenDirectives(v);
    }
  }

  private loader() {
    return async (url: string): Promise<RemoteDocument> => {
      if (!/^https?:\/\//.test(url)) throw new JsonLdError(`Invalid URL ${url}`);
      if (this.preLoad && url in PRELOADED_CONTEXTS) {
        return { contextUrl: undefined, document: PRELOADED_CONTEXTS[url], documentUrl: url };
      }
      const cached = this.cache.get(url);
      if (cached) return cached;
      if (this.frozen) throw new JsonLdError("attempt to insert into frozen context cache");
      if (++this.fetched > MAX_REMOTE_CONTEXTS) throw new JsonLdError("too many remote contexts");
      const document = await this.fetchDocument(url);
      this.checkForForbiddenDirectives(document);
      const remote = { contextUrl: undefined, document, documentUrl: url };
      this.cache.set(url, remote);
      if (this.cache.size > 256) throw new JsonLdError("context cache overflow");
      return remote;
    };
  }

  private async fetchDocument(url: string): Promise<unknown> {
    if (!isSafeRemoteUrl(url)) throw new JsonLdError(`unsafe context url ${url}`);
    const { res } = await fetchChecked(this.fetcher, url, {
      headers: { Accept: "application/ld+json, application/json", "User-Agent": "misskey-cf" },
      // each fetch: loaderTimeout; all fetches of this instance: CONTEXT_FETCH_DEADLINE_MS from the first
      signal: AbortSignal.any([AbortSignal.timeout(this.loaderTimeout), (this.deadline ??= AbortSignal.timeout(CONTEXT_FETCH_DEADLINE_MS))]),
    }, { check: (u) => isSafeRemoteUrl(u.href) }).catch((e) => {
      throw e instanceof UnsafeUrlError ? new JsonLdError(`unsafe context url ${e.url}`) : e;
    });
    if (!res.ok) throw new JsonLdError(`${res.status} ${res.statusText}`);
    // upstream validateContentTypeSetAsJsonLD
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!/^application\/(ld\+json|json)\b/.test(ct)) throw new JsonLdError(`invalid content type ${ct}`);
    const text = await readCappedText(res, CONTEXT_MAX_BYTES).catch((e) => {
      throw e instanceof BodyTooLargeError ? new JsonLdError(`context too large ${url}`) : e;
    });
    return JSON.parse(text);
  }
}
