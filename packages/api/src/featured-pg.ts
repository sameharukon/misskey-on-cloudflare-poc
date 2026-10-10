/**
 * upstream FeaturedService rankings without Redis. Upstream keeps sorted sets per fixed window
 * (epoch 2023-01-01; 3 days for notes / gallery, 7 days per user) fed at random (30%) by
 * reactions (+1, not by the author, on notes younger than 3 days) and renotes (+5); a ranking
 * is the top `threshold + 1` of the current and the previous window. Here the same scores are
 * computed from note_reaction / note rows created in those windows (every event counted, no
 * sampling), so the ranking is an approximation of upstream's.
 */

import { genAidx } from "../../id/src/index.js";
import type { PgQueryable } from "./pg.js";

const EPOCH = new Date("2023-01-01T00:00:00Z").getTime();
export const NOTES_RANKING_WINDOW = 1000 * 60 * 60 * 24 * 3;
export const PER_USER_NOTES_RANKING_WINDOW = 1000 * 60 * 60 * 24 * 7;
const THREE_DAYS = 1000 * 60 * 60 * 24 * 3;

type Scope = { kind: "global" } | { kind: "channel"; channelId: string } | { kind: "user"; userId: string };

function windows(range: number): [number, number][] {
  const cur = Math.floor((Date.now() - EPOCH) / range);
  return [cur, cur - 1].map((w) => [EPOCH + w * range, EPOCH + (w + 1) * range] as [number, number]);
}

/** Note ids of a ranking (FeaturedService.getGlobalNotesRanking / getInChannelNotesRanking / getPerUserNotesRanking). */
export async function notesRankingPg(c: PgQueryable, scope: Scope, threshold: number): Promise<string[]> {
  const range = scope.kind === "user" ? PER_USER_NOTES_RANKING_WINDOW : NOTES_RANKING_WINDOW;
  const ranking = new Map<string, number>();
  for (const [from, to] of windows(range)) {
    // parameters per window: each query binds exactly the ones it uses
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const target =
      scope.kind === "channel"
        ? `t."channelId" = ${p(scope.channelId)} AND t."replyId" IS NULL`
        : `t."channelId" IS NULL AND t.visibility = 'public' AND t."userHost" IS NULL AND t."replyId" IS NULL${scope.kind === "user" ? ` AND t."userId" = ${p(scope.userId)}` : ""}`;
    const lo = p(genAidx(from));
    const hi = p(genAidx(to));
    // only notes younger than 3 days at the event (approximated by the window start)
    const young = p(genAidx(from - THREE_DAYS));
    // Renotes of one user's notes: counted per target note (LATERAL on the renoteId index), as a
    // join from the renotes side scans most of that index whatever the window
    const renotes = scope.kind === "user"
      ? `SELECT t.id, 5 * c.n AS score FROM note t
           CROSS JOIN LATERAL (SELECT count(*) AS n FROM note n WHERE n."renoteId" = t.id AND n.id >= ${lo} AND n.id < ${hi}) c
          WHERE c.n > 0 AND t.id >= ${young} AND ${target}`
      : `SELECT t.id, 5 AS score FROM note n JOIN note t ON t.id = n."renoteId"
          WHERE n.id >= ${lo} AND n.id < ${hi} AND t.id >= ${young} AND ${target}`;
    // event ids are aidx, so their time is comparable with the window bounds. A failure throws,
    // so callers do not keep an empty ranking as if it were the result.
    const r = await c.query(
      `SELECT id, SUM(score)::int AS score FROM (
         SELECT t.id, 1 AS score FROM note_reaction r JOIN note t ON t.id = r."noteId"
          WHERE r.id >= ${lo} AND r.id < ${hi} AND t.id >= ${young} AND r."userId" != t."userId" AND ${target}
         UNION ALL
         ${renotes}
       ) s GROUP BY id ORDER BY score DESC, id DESC LIMIT ${p(threshold + 1)}`,
      params,
    );
    for (const row of r.rows) {
      const id = String(row.id);
      const score = Number(row.score);
      const exist = ranking.get(id);
      ranking.set(id, exist != null ? (exist + score) / 2 : score);
    }
  }
  return [...ranking.keys()];
}
