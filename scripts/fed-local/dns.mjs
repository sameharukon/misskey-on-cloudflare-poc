#!/usr/bin/env node
/**
 * Minimal DNS server for the local federation environments: A queries for `*.mk.test` answer
 * 127.0.0.1, AAAA for them answers no records, anything else is NXDOMAIN. Misskey resolves through
 * cacheable-lookup (DNS only, no /etc/hosts), so its container uses this as its only nameserver.
 *
 *   node scripts/fed-local/dns.mjs [port=53] [address=127.0.0.1]
 */
import dgram from "node:dgram";

const port = Number(process.argv[2] ?? 53);
const address = process.argv[3] ?? "127.0.0.1";
const SUFFIX = ".mk.test";

/** Question name, type and the offset where the question ends. */
function readQuestion(msg) {
  const labels = [];
  let i = 12;
  while (msg[i] !== 0) {
    const len = msg[i];
    labels.push(msg.subarray(i + 1, i + 1 + len).toString("latin1"));
    i += len + 1;
  }
  i += 1;
  return { name: labels.join(".").toLowerCase(), type: msg.readUInt16BE(i), end: i + 4 };
}

const server = dgram.createSocket("udp4");
server.on("message", (msg, rinfo) => {
  if (msg.length < 12 || msg.readUInt16BE(4) !== 1) return;
  let q;
  try {
    q = readQuestion(msg);
  } catch {
    return;
  }
  const ours = q.name === SUFFIX.slice(1) || q.name.endsWith(SUFFIX);
  const answerA = ours && q.type === 1;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(msg.readUInt16BE(0), 0); // id
  // QR, opcode 0, AA, RD copied, RA; rcode 0 or 3 (NXDOMAIN)
  header.writeUInt16BE(0x8400 | (msg.readUInt16BE(2) & 0x0100) | 0x0080 | (ours ? 0 : 3), 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answerA ? 1 : 0, 6);
  const question = msg.subarray(12, q.end);
  const parts = [header, question];
  if (answerA) {
    // name pointer to the question, type A, class IN, TTL 60, 4 bytes: 127.0.0.1
    parts.push(Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1]));
  }
  server.send(Buffer.concat(parts), rinfo.port, rinfo.address);
});
server.bind(port, address, () => console.log(`dns on ${address}:${port} (*${SUFFIX} → 127.0.0.1)`));
