/**
 * Hyperdrive connectivity smoke (no schema assumptions beyond SELECT 1).
 * Never log connectionString.
 */

import type { HyperdriveBinding } from "../../db/src/hyperdrive.js";

export type { HyperdriveBinding };

export type DbSmokeResult = {
  ok: boolean;
  select1?: number;
  metaExists?: boolean | null;
  metaRows?: number | null;
  metaName?: string | null;
  rootUserId?: string | null;
  metaError?: string;
  error?: string;
};

export async function runHyperdriveSmoke(hd: HyperdriveBinding | undefined): Promise<DbSmokeResult> {
  if (!hd || typeof hd.connectionString !== "string" || !hd.connectionString) {
    return { ok: false, error: "HYPERDRIVE_UNBOUND" };
  }

  const { Client } = await import("pg");
  const client = new Client({ connectionString: hd.connectionString });
  try {
    await client.connect();
    const r = await client.query("SELECT 1 AS n");
    const select1 = Number(r.rows[0]?.n ?? 0);

    let metaExists: boolean | null = null;
    let metaRows: number | null = null;
    let metaName: string | null = null;
    let rootUserId: string | null = null;
    let metaError: string | undefined;
    try {
      const m = await client.query(
        `SELECT count(*)::int AS n, max(name) AS name, max("rootUserId") AS root FROM meta`,
      );
      metaRows = Number(m.rows[0]?.n ?? 0);
      metaExists = true;
      metaName = (m.rows[0]?.name as string | null) ?? null;
      rootUserId = (m.rows[0]?.root as string | null) ?? null;
    } catch (e) {
      metaExists = false;
      metaRows = null;
      metaError = e instanceof Error ? e.message : String(e);
    }

    return { ok: select1 === 1, select1, metaExists, metaRows, metaName, rootUserId, metaError };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}
