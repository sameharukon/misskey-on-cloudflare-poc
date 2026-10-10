import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TIME2000,
  aidxRegExp,
  genAidx,
  parseAidx,
  parseAidxFull,
  isSafeAidxT,
  setAidxNodeId,
  resetAidxCounter,
  getAidxNodeId,
} from "./aidx.js";

describe("aidx", () => {
  it("matches regexp and round-trips time", () => {
    setAidxNodeId("test");
    resetAidxCounter(0);
    const date = Date.now();
    const id = genAidx(date);
    assert.match(id, aidxRegExp);
    assert.equal(id.length, 16);
    assert.equal(parseAidx(id).date.getTime(), date);
  });

  it("uses fixed time segment for golden epoch offset", () => {
    setAidxNodeId("abcd");
    resetAidxCounter(0);
    // 2000-01-01 + 0 ms => time part "00000000"
    const id = genAidx(TIME2000);
    assert.equal(id.slice(0, 8), "00000000");
    assert.equal(id.slice(8, 12), "abcd");
    // counter increments before encoding noise → first call noise is 1
    assert.equal(id.slice(12, 16), "0001");
    assert.equal(parseAidx(id).date.getTime(), TIME2000);
  });

  it("encodes known millisecond offset in base36", () => {
    setAidxNodeId("0000");
    resetAidxCounter(9);
    // 36^2 = 1296 ms after TIME2000 => "00000100" in 8-char base36
    const t = TIME2000 + 36 ** 2;
    const id = genAidx(t);
    assert.equal(id.slice(0, 8), "00000100");
    assert.equal(parseAidx(id).date.getTime(), t);
  });

  it("parseAidxFull returns additional bigint", () => {
    setAidxNodeId("zzzz");
    resetAidxCounter(0);
    const id = genAidx(TIME2000 + 1);
    const full = parseAidxFull(id);
    assert.equal(full.date, TIME2000 + 1);
    assert.equal(typeof full.additional, "bigint");
    assert.ok(full.additional > 0n);
  });

  it("isSafeAidxT", () => {
    assert.equal(isSafeAidxT(TIME2000), false);
    assert.equal(isSafeAidxT(TIME2000 + 1), true);
  });

  it("rejects invalid date", () => {
    assert.throws(() => genAidx(Number.NaN), /Invalid Date/);
  });

  it("setAidxNodeId validates", () => {
    assert.throws(() => setAidxNodeId("no"), /nodeId/);
    setAidxNodeId("wxyz");
    assert.equal(getAidxNodeId(), "wxyz");
  });
});
