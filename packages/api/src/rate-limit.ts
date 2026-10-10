/// <reference path="../../shared/src/cloudflare-workers.d.ts" />
/**
 * API rate limiting (upstream RateLimiterService + the ApiCallService / SigninApiService call sites).
 *
 * Upstream keeps a sliding-window log per `{actor}:{key}` in Redis (`ratelimiter`): a request is
 * refused when the window already holds `max` entries, and refused requests are logged too. The
 * actor is the user id, or for anonymous calls (`enableIpRateLimit`) a hash of the IP's /64 prefix.
 * `minInterval` is a second window of `minInterval * factor` ms with max 1; the long window allows
 * `max / factor` requests, where factor is the caller's `rateLimitFactor` role policy (0 = no limit).
 *
 * Here each actor has a RateLimiter Durable Object (`rl:{actor}`) holding its logs in DO storage, so
 * the checks are strongly consistent per actor. Without the RATE_LIMITER binding, or with
 * RATE_LIMIT = "off" (upstream: disabled outside production), nothing is limited.
 */

import type { ApiEnv, WorkersRateLimit } from "./env.js";
import { apiErrorResponse, type ApiErrorBody } from "./errors.js";
import { DurableObject } from "cloudflare:workers";
import type { RateLimiterRpc, RateLimitWindow } from "../../shared/src/do-rpc.js";

export type Limitation = { key: string; duration?: number; max?: number; minInterval?: number };

/** Limiter info as upstream's `ratelimiter` reports it (sent as the error's `info`). */
export type LimiterInfo = { total: number; remaining: number; reset: number; resetMs: number };
export type RateLimitResult = { code: "BRIEF_REQUEST_INTERVAL" | "RATE_LIMIT_EXCEEDED"; info: LimiterInfo };

export const RATE_LIMIT_EXCEEDED: ApiErrorBody = {
  message: "Rate limit exceeded. Please try again later.",
  code: "RATE_LIMIT_EXCEEDED",
  id: "d5826d14-3982-4d2e-8011-b9e9f02499ef",
  kind: "client",
};

// ---------------------------------------------------------------- actor

/** upstream getIpHash: the /64 prefix of the address (all of an IPv4 address), base 36. */
export function getIpHash(ip: string): string {
  let bits: string;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d+)?$/.exec(ip);
  if (v4) {
    bits = v4.slice(1, 5).map((o) => Number(o).toString(2).padStart(8, "0")).join("");
  } else {
    let addr = ip.replace(/^\[|\](?::\d+)?$/g, "").replace(/%.*$/, "");
    // IPv4-mapped tail (::ffff:1.2.3.4)
    const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
    if (tail) {
      const n = tail.slice(1, 5).map(Number);
      addr = addr.slice(0, tail.index) + `${((n[0]! << 8) | n[1]!).toString(16)}:${((n[2]! << 8) | n[3]!).toString(16)}`;
    }
    const [head, rest] = addr.includes("::") ? addr.split("::") as [string, string] : [addr, null];
    const h = head ? head.split(":") : [];
    const t = rest != null && rest !== "" ? rest.split(":") : [];
    const groups = rest == null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
    if (groups.length !== 8 || !groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return `ip-${ip}`;
    bits = groups.slice(0, 4).map((g) => parseInt(g, 16).toString(2).padStart(16, "0")).join("");
  }
  return "ip-" + BigInt("0b" + bits).toString(36);
}

/** Client IP as the edge reports it. */
export function clientIp(request: Request): string | null {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

// ---------------------------------------------------------------- DO

type Storage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list?<T = unknown>(opts?: { prefix?: string }): Promise<Map<string, T>>;
  getAlarm?(): Promise<number | null>;
  setAlarm?(t: number): Promise<void>;
};

/** Grace after the last window expires before the alarm clears the logs. */
const ALARM_GRACE_MS = 60_000;
/**
 * Extra time added when the alarm has to move later, so that repeated calls to the same window
 * rewrite it about once an hour instead of on every call (each setAlarm is a billed row write).
 */
const ALARM_SLACK_MS = 3_600_000;

type Window = RateLimitWindow;

/**
 * One instance per actor. `limit(windows)` (RPC) checks the windows in order and stops at
 * the first that is full (like upstream: the long window is not touched when minInterval refuses).
 * Each checked window logs the request, refused or not. Logs live in storage under `w:{id}`.
 * The single alarm only ever moves later, so it stays after the expiry of every logged entry (of
 * any window) and clears the logs once all of them have expired.
 */
export class RateLimiter extends DurableObject implements RateLimiterRpc {
  private readonly state: { storage: Storage };
  constructor(ctx: { storage: Storage }, env?: unknown) {
    super(ctx, env);
    this.state = ctx;
  }

  async limit(windows: Window[]): Promise<{ limited: false } | { limited: true; index: number; info: LimiterInfo }> {
    if (!Array.isArray(windows) || windows.some((w) => typeof w?.id !== "string" || !(w.duration > 0) || !(w.max >= 0))) {
      throw new Error("bad_request");
    }
    const now = Date.now();
    // every checked window logs this request (refused or not), so the alarm must cover each of them
    let due = 0;
    for (const [i, w] of windows.entries()) {
      due = Math.max(due, now + w.duration + ALARM_GRACE_MS);
      const key = `w:${w.id}`;
      const log = ((await this.state.storage.get<number[]>(key)) ?? []).filter((t) => t > now - w.duration);
      const count = log.length;
      log.push(now);
      // keep at most the entries that can still matter (refused requests are logged as upstream)
      const kept = log.slice(-Math.max(1, Math.ceil(w.max)));
      await this.state.storage.put(key, kept);
      // upstream ratelimiter: remaining = count < max ? max - count : 0 (max may be fractional)
      const remaining = count < w.max ? w.max - count : 0;
      // reset = oldest entry still inside the window + duration
      const resetMs = kept[0]! + w.duration;
      if (remaining === 0) {
        await this.keepAlarmAfter(due);
        return { limited: true, index: i, info: { total: w.max, remaining: 0, reset: Math.ceil(resetMs / 1000), resetMs } };
      }
    }
    if (due > 0) await this.keepAlarmAfter(due);
    return { limited: false };
  }

  /**
   * Make sure the alarm fires no earlier than `due`. Never moves it earlier: a short window must not
   * pull it in front of a longer window's logs (alarm() drops every log).
   */
  private async keepAlarmAfter(due: number): Promise<void> {
    const storage = this.state.storage;
    if (!storage.setAlarm) return;
    const current = (await storage.getAlarm?.()) ?? null;
    if (current != null && current >= due) return;
    await storage.setAlarm(due + ALARM_SLACK_MS);
  }

  /** Fires after every logged entry has left its window (see keepAlarmAfter): drop the logs. */
  async alarm(): Promise<void> {
    const keys = this.state.storage.list ? [...(await this.state.storage.list({ prefix: "w:" })).keys()] : [];
    for (const k of keys) await this.state.storage.delete(k);
  }
}

// ---------------------------------------------------------------- check

/** Is limiting on for this deployment? */
export function rateLimitEnabled(env: ApiEnv): boolean {
  return Boolean(env.RATE_LIMITER) && env.RATE_LIMIT !== "off";
}

/** RateLimiterService.limit: null when allowed. Errors from the DO fail open (logged). */
export async function rateLimit(env: ApiEnv, limitation: Limitation, actor: string, factor = 1): Promise<RateLimitResult | null> {
  const ns = env.RATE_LIMITER;
  if (!ns || env.RATE_LIMIT === "off") return null;
  const windows: Window[] = [];
  const codes: RateLimitResult["code"][] = [];
  if (limitation.minInterval != null) {
    windows.push({ id: `${limitation.key}:min`, duration: limitation.minInterval * factor, max: 1 });
    codes.push("BRIEF_REQUEST_INTERVAL");
  }
  if (limitation.duration != null && limitation.max != null) {
    windows.push({ id: limitation.key, duration: limitation.duration, max: limitation.max / factor });
    codes.push("RATE_LIMIT_EXCEEDED");
  }
  if (!windows.length) return null;
  try {
    const r = await ns.get(ns.idFromName(`rl:${actor}`)).limit(windows);
    return r.limited ? { code: codes[r.index]!, info: r.info } : null;
  } catch (e) {
    console.warn(`rate limiter unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** The 429 upstream sends (`Retry-After` from the limiter's resetMs). */
export function rateLimitResponse(r: RateLimitResult): Response {
  const res = apiErrorResponse(RATE_LIMIT_EXCEEDED, 429, r.info);
  res.headers.set("Retry-After", String(Math.max(0, Math.ceil((r.info.resetMs - Date.now()) / 1000))));
  return res;
}

/**
 * A Workers Rate Limiting check keyed by the client's IP (its /64 for IPv6): true when over the
 * limit. Unbound, without an IP, or when the binding fails: not limited.
 */
export async function ipOverLimit(binding: WorkersRateLimit | undefined, request: Request): Promise<boolean> {
  const ip = binding ? clientIp(request) : null;
  if (!binding || !ip) return false;
  try {
    return !(await binding.limit({ key: getIpHash(ip) })).success;
  } catch (e) {
    console.warn(`rate limit binding unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** 429 for a {@link ipOverLimit} refusal; kept out of shared caches. */
export function ipLimitedResponse(): Response {
  return new Response(null, { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } });
}

/** IP actor for anonymous calls, unless ENABLE_IP_RATE_LIMIT = "false" (upstream config.enableIpRateLimit). */
export function ipActor(env: ApiEnv, request: Request): string | null {
  if (env.ENABLE_IP_RATE_LIMIT === "false") return null;
  const ip = clientIp(request);
  return ip ? getIpHash(ip) : null;
}
