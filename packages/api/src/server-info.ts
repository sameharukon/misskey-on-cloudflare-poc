import type { ApiEnv } from "./env.js";
import { withHyperdriveClient } from "./pg.js";

/**
 * upstream admin/server-info shape. A Worker has no host to describe (systeminformation / os):
 * machine / os / cpu / mem / fs / net are fixed placeholders, `psql` is the PG server_version when
 * Hyperdrive is bound, and `redis` is absent (there is no Redis).
 */
export async function handleAdminServerInfo(env: Pick<ApiEnv, "HYPERDRIVE">): Promise<unknown> {
  let psql = "";
  const hd = env.HYPERDRIVE;
  if (hd?.connectionString) {
    try {
      psql = await withHyperdriveClient(hd, async (c) => String((await c.query("SHOW server_version")).rows[0]?.server_version ?? ""));
    } catch {
      /* not readable */
    }
  }
  const proc = (globalThis as { process?: { version?: string } }).process;
  return {
    machine: "cloudflare-workers",
    os: "workerd",
    node: proc?.version ?? "workerd",
    psql,
    cpu: { model: "", cores: (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 0 },
    mem: { total: 0 },
    fs: { total: 0, used: 0 },
    net: { interface: "" },
  };
}
