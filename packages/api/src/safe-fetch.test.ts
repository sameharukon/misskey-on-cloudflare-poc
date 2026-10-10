/**
 * fetchChecked: every redirect hop is checked before it is requested.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchChecked, isPrivateHost, isPublicHttpUrl, UnsafeUrlError } from "./safe-fetch.js";

/** A fetcher answering from a table of url → response factory; records what was requested. */
function fake(routes: Record<string, () => Response>) {
  const seen: { url: string; method: string; redirect?: RequestRedirect }[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push({ url, method: init?.method ?? "GET", redirect: init?.redirect });
    const r = routes[url];
    return r ? r() : new Response("nf", { status: 404 });
  };
  return { fetcher, seen };
}
const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } });

describe("isPrivateHost / isPublicHttpUrl", () => {
  it("private, loopback, link-local, CGNAT, reserved and local names", () => {
    for (const h of ["localhost", "a.localhost", "x.local", "x.internal", "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "198.18.0.1", "224.0.0.1", "[::1]", "[fd00::1]", "[fe80::1]", "[::ffff:127.0.0.1]"]) {
      assert.equal(isPrivateHost(h), true, h);
    }
    for (const h of ["93.184.216.34", "example.com", "[2606:4700::1]"]) assert.equal(isPrivateHost(h), false, h);
  });

  it("decimal / hex IPv4 forms are normalized by URL first", () => {
    assert.equal(isPublicHttpUrl(new URL("http://2130706433/")), false);
    assert.equal(isPublicHttpUrl(new URL("http://0x7f.0.0.1/")), false);
  });

  it("only http(s) without userinfo", () => {
    assert.equal(isPublicHttpUrl(new URL("https://example.com/a")), true);
    assert.equal(isPublicHttpUrl(new URL("ftp://example.com/a")), false);
    assert.equal(isPublicHttpUrl(new URL("https://u:p@example.com/a")), false);
  });
});

describe("fetchChecked", () => {
  it("follows public redirects by hand and returns the final URL", async () => {
    const { fetcher, seen } = fake({
      "https://a.example/x": redirect("/y"),
      "https://a.example/y": redirect("https://b.example/z", 301),
      "https://b.example/z": () => new Response("ok"),
    });
    const { res, url } = await fetchChecked(fetcher, "https://a.example/x");
    assert.equal(await res.text(), "ok");
    assert.equal(url, "https://b.example/z");
    assert.deepEqual(seen.map((s) => [s.url, s.redirect]), [["https://a.example/x", "manual"], ["https://a.example/y", "manual"], ["https://b.example/z", "manual"]]);
  });

  it("refuses a redirect to a private host before requesting it", async () => {
    const { fetcher, seen } = fake({ "https://a.example/x": redirect("http://169.254.169.254/latest/meta-data/") });
    await assert.rejects(fetchChecked(fetcher, "https://a.example/x"), UnsafeUrlError);
    assert.deepEqual(seen.map((s) => s.url), ["https://a.example/x"]);
  });

  it("refuses the first URL, other schemes and userinfo", async () => {
    const { fetcher, seen } = fake({ "https://a.example/x": redirect("file:///etc/passwd") });
    await assert.rejects(fetchChecked(fetcher, "http://127.0.0.1/"), UnsafeUrlError);
    await assert.rejects(fetchChecked(fetcher, "https://a.example/x"), UnsafeUrlError);
    await assert.rejects(fetchChecked(fetcher, "not a url"), UnsafeUrlError);
    assert.deepEqual(seen.map((s) => s.url), ["https://a.example/x"]);
  });

  it("a custom check applies to every hop", async () => {
    const { fetcher } = fake({ "https://a.example/x": redirect("http://b.example/plain") });
    const httpsOnly = (u: URL) => u.protocol === "https:";
    await assert.rejects(fetchChecked(fetcher, "https://a.example/x", {}, { check: httpsOnly }), UnsafeUrlError);
  });

  it("maxRedirects: 0 returns the redirect; a loop ends with an error", async () => {
    const { fetcher } = fake({ "https://a.example/x": redirect("https://a.example/x") });
    const { res } = await fetchChecked(fetcher, "https://a.example/x", {}, { maxRedirects: 0 });
    assert.equal(res.status, 302);
    await assert.rejects(fetchChecked(fetcher, "https://a.example/x", {}, { maxRedirects: 3 }), /too many redirects/);
  });

  it("303 continues as GET", async () => {
    const { fetcher, seen } = fake({ "https://a.example/p": redirect("https://a.example/g", 303), "https://a.example/g": () => new Response("ok") });
    await fetchChecked(fetcher, "https://a.example/p", { method: "POST", body: "x" });
    assert.deepEqual(seen.map((s) => s.method), ["POST", "GET"]);
  });
});
