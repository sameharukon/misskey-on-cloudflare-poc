/**
 * Limits on federation I/O: response bodies read with a byte cap (AP GET, WebFinger, JSON-LD
 * contexts), the number of remote JSON-LD contexts one message may fetch, upstream's delivery
 * retry schedule, and webhook messages over the queue limit carried through R2.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BodyTooLargeError, readCapped } from "./safe-fetch.js";
import { apGet, ApPermanentError, webfingerSelf } from "./ap/remote.js";
import { JsonLd, MAX_REMOTE_CONTEXTS } from "./ap/ld-signature.js";
import { deliverRetryDelaySeconds } from "./ap/deliver.js";
import { processWebhookDeliver, releaseWebhookContent, sendToQueue, WEBHOOK_INLINE_MAX_BYTES, type AnyWebhookDeliverMessage } from "./webhooks-pg.js";
import { CF_MAX_RETRIES } from "../../shared/src/queue-jobs.js";
import type { ApiEnv } from "./env.js";

/** A body of `n` bytes sent in 1 KiB chunks, without content-length; counts the chunks pulled. */
function streamed(n: number) {
  let sent = 0;
  const pulled = { chunks: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (sent >= n) return ctl.close();
      const len = Math.min(1024, n - sent);
      sent += len;
      pulled.chunks++;
      ctl.enqueue(new Uint8Array(len).fill(0x20));
    },
  });
  return { body, pulled };
}

const env = (fetcher: (url: string, init?: RequestInit) => Promise<Response>) =>
  ({ INSTANCE_URL: "https://misskey.example.com", AP_FETCH: fetcher as unknown as typeof fetch }) as ApiEnv;

describe("readCapped", () => {
  it("stops reading once the body is over the limit", async () => {
    const { body, pulled } = streamed(10 * 1024 * 1024);
    await assert.rejects(readCapped(new Response(body), 64 * 1024), BodyTooLargeError);
    assert.ok(pulled.chunks <= 70, `pulled ${pulled.chunks} chunks`);
  });

  it("refuses a declared content-length over the limit without reading", async () => {
    const { body, pulled } = streamed(1024);
    await assert.rejects(readCapped(new Response(body, { headers: { "content-length": String(2 * 1024 * 1024) } }), 1024 * 1024), BodyTooLargeError);
    assert.equal(pulled.chunks, 0);
  });

  it("returns a body within the limit", async () => {
    assert.equal((await readCapped(new Response("hello"), 5)).byteLength, 5);
  });
});

describe("remote GETs", () => {
  it("apGet: a body over 1 MiB is a permanent error", async () => {
    const e = env(async () => new Response(streamed(2 * 1024 * 1024).body, { headers: { "content-type": "application/activity+json" } }));
    await assert.rejects(apGet(e, "https://remote.example/notes/1"), (err: Error) => err instanceof ApPermanentError && /too large/.test(err.message));
  });

  it("webfingerSelf: a body over 256 KiB is a permanent error", async () => {
    const e = env(async () => new Response(streamed(300 * 1024).body, { headers: { "content-type": "application/jrd+json" } }));
    await assert.rejects(webfingerSelf(e, "alice@remote.example"), (err: Error) => err instanceof ApPermanentError && /too large/.test(err.message));
  });
});

describe("JSON-LD contexts", () => {
  const contextFetcher = (fetched: string[], body?: () => BodyInit) =>
    (async (url: string) => {
      fetched.push(url);
      return new Response(body ? body() : JSON.stringify({ "@context": { x: "https://example.org/x" } }), { headers: { "content-type": "application/ld+json" } });
    }) as unknown as typeof fetch;

  it(`fetches at most ${MAX_REMOTE_CONTEXTS} remote contexts per instance`, async () => {
    const doc: Record<string, unknown> = { "@context": "https://ctx.example/0", "@id": "https://a.example/1" };
    for (let i = 1; i <= MAX_REMOTE_CONTEXTS + 4; i++) doc[`https://example.org/p${i}`] = { "@context": `https://ctx.example/${i}`, x: "v" };
    const fetched: string[] = [];
    // the loader's error reaches the caller wrapped by jsonld (as a failed remote context)
    await assert.rejects(new JsonLd(contextFetcher(fetched)).compact(doc));
    assert.equal(fetched.length, MAX_REMOTE_CONTEXTS);
    // within the limit the document compacts
    const ok: Record<string, unknown> = { "@context": "https://ctx.example/0", "@id": "https://a.example/1" };
    for (let i = 1; i < MAX_REMOTE_CONTEXTS; i++) ok[`https://example.org/p${i}`] = { "@context": `https://ctx.example/${i}`, x: "v" };
    await new JsonLd(contextFetcher([])).compact(ok);
  });

  it("a context over 256 KiB is refused", async () => {
    const fetched: string[] = [];
    const big = () => JSON.stringify({ "@context": { x: "https://example.org/x" }, pad: "p".repeat(300 * 1024) });
    await assert.rejects(new JsonLd(contextFetcher(fetched, big)).compact({ "@context": "https://ctx.example/big", "@id": "https://a.example/1" }));
    assert.deepEqual(fetched, ["https://ctx.example/big"]);
  });
});

describe("delivery retries", () => {
  it("follow upstream httpRelatedBackoff over 12 attempts", () => {
    const noJitter = () => 0;
    const delays = Array.from({ length: CF_MAX_RETRIES["mk-deliver"]! }, (_, i) => deliverRetryDelaySeconds(i + 1, noJitter));
    assert.deepEqual(delays, [60, 180, 420, 900, 1860, 3780, 7620, 15300, 28800, 28800, 28800]);
    assert.equal(CF_MAX_RETRIES["mk-deliver"], 11);
    const total = delays.reduce((a, b) => a + b, 0);
    assert.ok(total > 32 * 3600 && total < 33 * 3600, `total ${total}`);
    // jitter adds up to 20 %
    assert.equal(deliverRetryDelaySeconds(9, () => 0.999999), 34560);
  });
});

describe("webhooks over the queue limit", () => {
  class FakeR2 {
    objs = new Map<string, string>();
    async put(k: string, v: string) {
      this.objs.set(k, v);
    }
    async get(k: string) {
      const v = this.objs.get(k);
      return v == null ? null : { arrayBuffer: async () => new TextEncoder().encode(v).buffer as ArrayBuffer };
    }
    async delete(k: string) {
      this.objs.delete(k);
    }
  }
  const msg = (content: unknown): AnyWebhookDeliverMessage => ({
    kind: "systemWebhook", webhookId: "w1", to: "https://hooks.example/in", secret: "s", type: "abuseReport", content, createdAt: 1, eventId: "ev1",
  });

  it("carries a large content through R2 and removes it when done", async () => {
    const r2 = new FakeR2();
    const queued: AnyWebhookDeliverMessage[] = [];
    const posted: any[] = [];
    const e = {
      ...env(async (_url, init) => {
        posted.push(JSON.parse(String(init!.body)));
        return new Response(null, { status: 204 });
      }),
      MEDIA_BUCKET: r2,
      Q_WEBHOOK_DELIVER: { send: async (m: AnyWebhookDeliverMessage) => void queued.push(m) },
    } as unknown as ApiEnv;

    const small = { text: "small" };
    await sendToQueue(e, msg(small));
    assert.deepEqual(queued[0]!.content, small);
    assert.equal(queued[0]!.contentKey, undefined);

    const large = { text: "x".repeat(WEBHOOK_INLINE_MAX_BYTES + 1) };
    await sendToQueue(e, msg(large));
    const q = queued[1]!;
    assert.equal(q.content, null);
    assert.equal(q.contentKey, "webhook-payloads/ev1.json");
    assert.ok(new TextEncoder().encode(JSON.stringify(q)).byteLength < 1024);
    assert.equal(await processWebhookDeliver(e, q), "delivered");
    assert.deepEqual(posted[0].body, large);
    await releaseWebhookContent(e, q);
    assert.equal(r2.objs.size, 0);
    // content gone (e.g. already released): dropped
    assert.equal(await processWebhookDeliver(e, q), "dropped");
  });
});
