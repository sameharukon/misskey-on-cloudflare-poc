import { createServer } from "node:http";
import { generateAlts } from "./alts.js";
import { twemojiBadge } from "./twemoji-badge.js";
import { convertProxyImage, type ProxyMode } from "./proxy.js";

const MAX_BODY = Number(process.env.MAX_BODY ?? 110 * 1024 * 1024);

async function readRaw(req: import("node:http").IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const port = Number(process.env.PORT ?? 8080);

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  try {
    if (req.method === "GET" && (url === "/" || url === "/healthz")) {
      json(200, { ok: true, service: "media-container", ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg" });
      return;
    }
    if (req.method === "POST" && url === "/alts") {
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const buf = await readRaw(req);
      if (buf.length === 0) {
        json(400, { error: "empty body" });
        return;
      }
      json(200, await generateAlts(buf, q.get("type") ?? "application/octet-stream", q.get("web") !== "0"));
      return;
    }
    if (req.method === "POST" && url === "/twemoji-badge") {
      const buf = await readRaw(req);
      if (buf.length === 0 || buf.length > 1024 * 1024) {
        json(400, { error: "bad svg" });
        return;
      }
      const png = await twemojiBadge(buf);
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
      return;
    }
    if (req.method === "POST" && url === "/proxy") {
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const mode = q.get("mode") as ProxyMode | null;
      if (!mode || !["emoji", "avatar", "static", "preview", "badge", "svg"].includes(mode)) {
        json(400, { error: "bad mode" });
        return;
      }
      const out = await convertProxyImage(await readRaw(req), q.get("mime") ?? "application/octet-stream", mode, q.get("static") === "1");
      if (out.status !== 200) {
        json(404, { error: "not_found" });
        return;
      }
      res.writeHead(200, { "content-type": out.type, "x-ext": out.ext });
      res.end(out.data);
      return;
    }
    json(404, { error: "not_found" });
  } catch (e) {
    json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(port, () => {
  console.log(`media-container listening on ${port}`);
});
