/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Ported from misskey-dev/misskey packages/backend/src/misc/id/aidx.ts
 * AIDX = 8(base36 ms since 2000-01-01) + 4(nodeId) + 4(counter)
 */

/** Epoch: 2000-01-01T00:00:00.000Z */
export const TIME2000 = 946684800000;
const TIME_LENGTH = 8;
const NODE_LENGTH = 4;
const NOISE_LENGTH = 4;
export const AIDX_LENGTH = TIME_LENGTH + NODE_LENGTH + NOISE_LENGTH;

export const aidxRegExp = /^[0-9a-z]{16}$/;

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomNodeId(): string {
  const bytes = new Uint8Array(NODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < NODE_LENGTH; i++) {
    out += ALPHABET[bytes[i]! % 36];
  }
  return out;
}

/**
 * Module-level node id (Misskey uses nanoid once per process). Overridable for tests.
 * Lazy-init: Workers forbid crypto.getRandomValues at global scope (deploy validation).
 */
let nodeId: string | null = null;
let counter = 0;

function ensureNodeId(): string {
  if (nodeId == null) nodeId = randomNodeId();
  return nodeId;
}

/** Test / deterministic override for the 4-char node segment. */
export function setAidxNodeId(id: string): void {
  if (!/^[0-9a-z]{4}$/.test(id)) {
    throw new Error("nodeId must be 4 chars of [0-9a-z]");
  }
  nodeId = id;
}

export function getAidxNodeId(): string {
  return ensureNodeId();
}

/** Reset counter (tests). */
export function resetAidxCounter(value = 0): void {
  counter = value;
}

function getTime(time: number): string {
  time = time - TIME2000;
  if (time < 0) time = 0;
  return time.toString(36).padStart(TIME_LENGTH, "0").slice(-TIME_LENGTH);
}

function getNoise(): string {
  return counter.toString(36).padStart(NOISE_LENGTH, "0").slice(-NOISE_LENGTH);
}

export function parseBigInt36(str: string): bigint {
  const chunkSize = 10;
  const powerOfChunkSize = 36n ** 10n;
  const chunks: string[] = [];
  let s = str;
  while (s.length > 0) {
    chunks.unshift(s.slice(-chunkSize));
    s = s.slice(0, -chunkSize);
  }
  let result = 0n;
  for (const chunk of chunks) {
    result *= powerOfChunkSize;
    const int = parseInt(chunk, 36);
    if (Number.isNaN(int)) throw new Error("Invalid base36 string");
    result += BigInt(int);
  }
  return result;
}

export function genAidx(t: number): string {
  if (Number.isNaN(t)) throw new Error("Failed to create AIDX: Invalid Date");
  counter++;
  return getTime(t) + ensureNodeId() + getNoise();
}

export function parseAidx(id: string): { date: Date } {
  const time = parseInt(id.slice(0, TIME_LENGTH), 36) + TIME2000;
  return { date: new Date(time) };
}

export function parseAidxFull(id: string): { date: number; additional: bigint } {
  const date = parseInt(id.slice(0, TIME_LENGTH), 36) + TIME2000;
  const additional = parseBigInt36(id.slice(TIME_LENGTH, AIDX_LENGTH));
  return { date, additional };
}

export function isSafeAidxT(t: number): boolean {
  return t > TIME2000;
}
