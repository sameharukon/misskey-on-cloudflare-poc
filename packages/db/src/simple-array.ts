/**
 * TypeORM `simple-array` columns (upstream MiUser.alsoKnownAs, a `text` column): the values
 * joined with "," — not a PostgreSQL array. Read and write them like TypeORM does, so rows stay
 * interchangeable with an existing Misskey database.
 */

/** Column value → string[] (null stays null; "" is an empty list, as TypeORM). */
export function fromSimpleArray(v: unknown): string[] | null {
  if (v == null) return null;
  if (typeof v === "string") return v.length ? v.split(",") : [];
  // a text[] row written by older misskey-cf builds ("{a,b}" read back through a text[] column)
  if (Array.isArray(v)) return v.map(String);
  return null;
}

/** string[] → column value (null stays null). */
export function toSimpleArray(v: readonly string[] | null | undefined): string | null {
  return v == null ? null : v.join(",");
}
