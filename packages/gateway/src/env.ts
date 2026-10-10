/**
 * Gateway Worker bindings / vars.
 * The API Worker is always bound: /api, /streaming, ActivityPub / well-known and media go there.
 */
export interface GatewayEnv {
  /** Service binding to API Worker (`wrangler` services). */
  API: Fetcher;
  /**
   * misskey-cf-api `ApiInternal` RPC entrypoint (service binding with `entrypoint = "ApiInternal"`):
   * data for the server-rendered `/@user` and `/notes/:id` pages.
   */
  API_INTERNAL?: import("./ssr.js").ApiInternalSsr;
  /** misskey-cf-media (sharp Container): `/twemoji-badge/*` images. */
  MEDIA?: Fetcher;
  /** Cloudflare Static Assets binding (optional). */
  ASSETS?: { fetch(request: Request): Promise<Response> };

  /** Instance public URL, e.g. https://misskey.example.com */
  INSTANCE_URL?: string;
  /** Packaged / injected meta JSON cache (dev). */
  BOOTSTRAP_META_JSON?: string;
}

type Fetcher = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
