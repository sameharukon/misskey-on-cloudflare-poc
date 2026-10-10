/**
 * Retry policy of the mk-timeline-fanout consumer. Kept out of index.ts: a Worker's entry module
 * may only export handlers and classes (workerd refuses to start on an exported number).
 */

/** `max_retries` of mk-timeline-fanout (packages/timeline/wrangler.toml). */
export const FANOUT_MAX_RETRIES = 5;

/** Backoff before a failed fanout message is retried: 10 s, 20 s, 40 s, … up to 5 min. */
export function fanoutRetryDelay(attempts: number): number {
  return Math.min(300, 10 * 2 ** Math.max(0, attempts - 1));
}
