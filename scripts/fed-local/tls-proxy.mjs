#!/usr/bin/env node
/**
 * HTTPS front for the local federation environments: terminates TLS on :443 and forwards each
 * request (WebSocket upgrades included) to the `wrangler dev` port of its Host, keeping the Host
 * header so HTTP signatures over `host` verify as they would on a real domain.
 *
 *   node scripts/fed-local/tls-proxy.mjs <certDir> <host>=<port> [<host>=<port> ...]
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";

const [certDir, ...pairs] = process.argv.slice(2);
if (!certDir || pairs.length === 0) {
  console.error("usage: tls-proxy.mjs <certDir> <host>=<port> ...");
  process.exit(2);
}
const routes = new Map(pairs.map((p) => {
  const [h, port] = p.split("=");
  return [h, Number(port)];
}));
const portFor = (req) => routes.get(String(req.headers.host ?? "").replace(/:443$/, ""));

const server = https.createServer({ key: readFileSync(join(certDir, "server.key")), cert: readFileSync(join(certDir, "server.crt")) }, (req, res) => {
  const port = portFor(req);
  if (!port) {
    res.writeHead(421).end("unknown host\n");
    return;
  }
  const up = http.request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-proto": "https" } }, (r) => {
    // wrangler dev rewrites the upstream origin (https://<host>) in Location to its own http listener
    const headers = r.rawHeaders.map((v, i) => (i % 2 === 1 && /^location$/i.test(r.rawHeaders[i - 1]) ? v.replace(/^http:\/\//, "https://") : v));
    res.writeHead(r.statusCode ?? 502, headers);
    r.pipe(res);
  });
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502);
    res.end(`upstream error: ${e.message}\n`);
  });
  req.pipe(up);
});

server.on("upgrade", (req, socket, head) => {
  const port = portFor(req);
  if (!port) return socket.destroy();
  const up = net.connect(port, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket).pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(443, "127.0.0.1", () => console.log(`tls-proxy on :443 → ${pairs.join(", ")}`));
