/** disposable-domains.txt is generated from the installed disposable-email-domains. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

it("disposable-domains.txt matches disposable-email-domains (node scripts/gen-disposable-domains.mjs)", () => {
  const list = createRequire(import.meta.url)("disposable-email-domains") as string[];
  const text = readFileSync(new URL("./disposable-domains.txt", import.meta.url), "utf8");
  assert.equal(text, `\n${list.join("\n")}\n`);
});
