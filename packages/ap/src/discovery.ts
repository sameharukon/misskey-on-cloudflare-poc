/**
 * WebFinger `resource` parsing (`acct:user@host`).
 */

export function parseAcctResource(resource: string | null): { user: string; host: string } | null {
  if (!resource) return null;
  const m = /^acct:([^@]+)@([^@]+)$/i.exec(resource.trim());
  if (!m) return null;
  return { user: m[1]!, host: m[2]! };
}
