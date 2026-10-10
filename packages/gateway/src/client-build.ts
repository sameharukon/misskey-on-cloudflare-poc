/**
 * Upstream web client build info (what upstream HtmlTemplateService computes at boot
 * from `built/_frontend_vite_`), read from Static Assets at `/misskey-cf-client.json`.
 * Written by `scripts/build-frontend.sh` → `scripts/frontend-client-info.mjs`.
 */
import type { GatewayEnv } from "./env.js";

export interface ViteFiles {
  entryJs: string | null;
  css: string[];
  modulePreloads: string[];
}

export interface ClientBundle {
  viteFiles: ViteFiles | null;
  /** loader/boot.js — inlined into the page like upstream */
  bootJs: string | null;
  /** loader/style.css — inlined into the page like upstream */
  bootCss: string | null;
}

export interface ClientBuildInfo {
  version: string;
  upstreamRev?: string | null;
  /** @misskey-dev/emoji-assets version (for the jsDelivr fallback of /twemoji, /fluent-emoji) */
  emojiAssetsVersion?: string | null;
  builtAt?: string;
  langs: string[];
  frontend: ClientBundle;
  embed: ClientBundle | null;
}

export const CLIENT_BUILD_INFO_PATH = "/misskey-cf-client.json";

/** upstream packages/i18n/src/const.ts `languages` (fallback when no build info). */
export const DEFAULT_LANGS = [
  "ar-SA", "ca-ES", "cs-CZ", "da-DK", "de-DE", "en-US", "es-ES", "fr-FR", "id-ID", "it-IT",
  "ja-JP", "ja-KS", "kab-KAB", "kn-IN", "ko-KR", "nl-NL", "no-NO", "pl-PL", "pt-PT", "ru-RU",
  "sk-SK", "th-TH", "tr-TR", "ug-CN", "uk-UA", "vi-VN", "zh-CN", "zh-TW",
];

type ManifestChunk = {
  file: string;
  isEntry?: boolean;
  imports?: string[];
  css?: string[];
};

/** Port of upstream HtmlTemplateService.collectViteAssetFiles (vite backend integration). */
export function collectViteAssetFiles(manifest: Record<string, ManifestChunk>): ViteFiles {
  const entryFile = Object.values(manifest).find((chunk) => chunk.isEntry);
  if (!entryFile) return { entryJs: null, css: [], modulePreloads: [] };

  const seen = new Set<string>();
  const css = new Set<string>(entryFile.css ?? []);
  const modulePreloads = new Set<string>();

  const collect = (imports: string[], recursive = false): void => {
    for (const id of imports) {
      if (seen.has(id)) continue;
      seen.add(id);
      const chunk = manifest[id];
      if (!chunk) return;
      for (const c of chunk.css ?? []) css.add(c);
      if (Array.isArray(chunk.imports)) collect(chunk.imports, true);
      if (!recursive) modulePreloads.add(chunk.file);
    }
  };
  if (Array.isArray(entryFile.imports)) collect(entryFile.imports);

  return { entryJs: entryFile.file, css: [...css], modulePreloads: [...modulePreloads] };
}

const RETRY_MISSING_MS = 60_000;
let cached: { info: ClientBuildInfo | null; at: number; assets: unknown } | null = null;

/** Reset the per-isolate cache (tests). */
export function resetClientBuildCache(): void {
  cached = null;
}

/**
 * Load build info from the ASSETS binding (cached per isolate; a missing file is
 * re-checked after a minute). Returns null when no frontend build is mounted.
 */
export async function loadClientBuildInfo(
  env: GatewayEnv,
  requestUrl: string,
): Promise<ClientBuildInfo | null> {
  if (!env.ASSETS) return null;
  if (cached && cached.assets === env.ASSETS) {
    if (cached.info || Date.now() - cached.at < RETRY_MISSING_MS) return cached.info;
  }
  let info: ClientBuildInfo | null = null;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(CLIENT_BUILD_INFO_PATH, requestUrl)));
    if (res.ok) {
      const json = (await res.json()) as Partial<ClientBuildInfo>;
      if (json && typeof json === "object" && json.frontend) {
        info = {
          version: typeof json.version === "string" ? json.version : "0.0.0",
          upstreamRev: json.upstreamRev ?? null,
          emojiAssetsVersion: json.emojiAssetsVersion ?? null,
          builtAt: json.builtAt,
          langs: Array.isArray(json.langs) && json.langs.length > 0 ? json.langs : DEFAULT_LANGS,
          frontend: json.frontend,
          embed: json.embed ?? null,
        };
      }
    }
  } catch {
    info = null;
  }
  cached = { info, at: Date.now(), assets: env.ASSETS };
  return info;
}
