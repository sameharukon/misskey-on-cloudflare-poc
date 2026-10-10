/**
 * The server's file-size limit (upstream `config.maxFileSize`, default 250 MB there).
 *
 * Default 100 MB: Cloudflare caps a request body by the zone's plan (Free / Pro 100 MB,
 * Business 200 MB, Enterprise 500 MB), and uploads, `upload-from-url` and the media proxy hold
 * the whole file in memory (Workers: 128 MB). `MAX_FILE_SIZE` can set it, but a higher value
 * only works on a plan with a larger body limit, and above ~100 MB the in-memory handling
 * would also have to change (README: Workers constraints).
 */
import type { ApiEnv } from "./env.js";

export const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024;

export function serverMaxFileSize(env: Pick<ApiEnv, "MAX_FILE_SIZE">): number {
  const n = Number(env.MAX_FILE_SIZE);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FILE_SIZE;
}
