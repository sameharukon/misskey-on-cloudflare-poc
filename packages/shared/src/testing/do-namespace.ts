/**
 * Tests only: Durable Object stubs and namespaces over in-process instances. A stub exposes the
 * instance's RPC methods with structured-cloned arguments and results, as Workers RPC does, and a
 * `fetch(url, init)` that builds the Request the instance's own `fetch` expects (WebSocket upgrades,
 * the DOs that still take HTTP).
 */

type FetchStub = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };

export function rpcStub<T extends object>(target: T): T & FetchStub {
  return new Proxy(target, {
    get(t, prop) {
      const v = (t as Record<string | symbol, unknown>)[prop];
      if (prop === "fetch" && typeof v === "function") {
        return (input: RequestInfo | URL, init?: RequestInit) => v.call(t, input instanceof Request ? input : new Request(String(input), init));
      }
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => structuredClone(await v.apply(t, structuredClone(args)));
    },
  }) as T & FetchStub;
}

/** A namespace with one instance per name (`make(name)`), kept for the test's lifetime. */
export function fakeNamespace<T extends object>(make: (name: string) => T) {
  const inst = new Map<string, T>();
  return {
    inst,
    idFromName: (name: string) => ({ toString: () => name }),
    get(id: { toString(): string }) {
      const name = id.toString();
      if (!inst.has(name)) inst.set(name, make(name));
      return rpcStub(inst.get(name)!);
    },
  };
}

/**
 * A StreamHub namespace that records what the API publishes: `onCall(userId, path, body)` gets each
 * RPC call keyed by its method (`/publish` once per event with `{ channel, type, body }`,
 * `/noteUpdated` with `{ id, type, body }`, `/broadcast` with `{ type, body }`).
 */
export function recordingHubNamespace(onCall: (userId: string, path: string, body: any) => void, delivered = 1) {
  return {
    idFromName: (name: string) => ({ toString: () => name }),
    get(id: { toString(): string }) {
      const userId = id.toString().replace(/^user:/, "");
      return {
        fetch: async () => new Response(null, { status: 200 }),
        publish: async (events: { channel: string; type: string; body: unknown }[]) => {
          for (const e of structuredClone(events)) onCall(userId, "/publish", { channel: e.channel, type: e.type, body: e.body });
          return { delivered, sockets: 1 };
        },
        noteUpdated: async (noteId: string, type: string, body: unknown) => {
          onCall(userId, "/noteUpdated", structuredClone({ id: noteId, type, body }));
          return delivered;
        },
        broadcast: async (type: string, body: unknown) => {
          onCall(userId, "/broadcast", structuredClone({ type, body }));
          return delivered;
        },
      };
    },
  };
}
