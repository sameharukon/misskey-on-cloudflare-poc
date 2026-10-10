/** Poll row insert + note packer `poll` field (kept apart from polls-pg to avoid a cycle with notes-pg). */
import type { PgQueryable } from "../pg.js";
import type { PackNoteSource } from "../../../packers/src/index.js";

export type PollInput = { choices: string[]; multiple: boolean; expiresAt: Date | null };

/** INSERT poll row (call inside the note insert, after the note row exists). */
export async function insertPollPg(c: PgQueryable, note: PackNoteSource, poll: PollInput): Promise<void> {
  await c.query(
    `INSERT INTO poll ("noteId", "expiresAt", multiple, choices, votes, "noteVisibility", "userId", "userHost", "channelId")
     VALUES ($1, $2, $3, $4::varchar[], $5::int[], $6::poll_notevisibility_enum, $7, $8, $9)`,
    [note.id, poll.expiresAt ? poll.expiresAt.toISOString() : null, poll.multiple, poll.choices, poll.choices.map(() => 0), note.visibility, note.userId, note.userHost ?? null, note.channelId ?? null],
  );
}


export type PackedPoll = { multiple: boolean; expiresAt: string | null; choices: { text: string; votes: number; isVoted: boolean }[] };

/** NoteEntityService.populatePoll for many notes at once. */
export async function fetchPollsForPack(c: PgQueryable, noteIds: string[], viewerId?: string | null): Promise<Map<string, PackedPoll>> {
  const out = new Map<string, PackedPoll>();
  if (noteIds.length === 0) return out;
  const r = await c.query(`SELECT "noteId", "expiresAt", multiple, choices, votes FROM poll WHERE "noteId" = ANY($1::varchar[])`, [noteIds]);
  for (const row of r.rows) {
    const choices = (row.choices as string[]) ?? [];
    const votes = ((row.votes as number[]) ?? []).map(Number);
    const exp = row.expiresAt == null ? null : new Date(row.expiresAt as string | Date).toISOString();
    out.set(String(row.noteId), {
      multiple: Boolean(row.multiple),
      expiresAt: exp,
      choices: choices.map((text, i) => ({ text, votes: votes[i] ?? 0, isVoted: false })),
    });
  }
  if (viewerId && out.size) {
    const v = await c.query(`SELECT "noteId", choice FROM poll_vote WHERE "userId" = $1 AND "noteId" = ANY($2::varchar[])`, [viewerId, [...out.keys()]]);
    for (const row of v.rows) {
      const p = out.get(String(row.noteId));
      const ch = p?.choices[Number(row.choice)];
      if (p && ch && (p.multiple || !p.choices.some((x) => x.isVoted))) ch.isVoted = true;
    }
  }
  return out;
}

