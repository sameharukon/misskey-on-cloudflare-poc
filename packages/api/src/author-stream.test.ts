/**
 * The author's own timeline connections get a new note straight from notes/create, as
 * upstream's {Home,Hybrid,Local,Global}TimelineChannel see their own notes; the fanout consumer
 * leaves the author out of these channels.
 */
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import type { ApiEnv } from "./env.js";
import { recordingHubNamespace } from "../../shared/src/testing/do-namespace.js";

const hubCalls: { userId: string; path: string; body: any }[] = [];
const hub = recordingHubNamespace((userId, path, body) => hubCalls.push({ userId, path, body }));

let f: Fixture;
before(async () => {
  f = await makeFixture("AuthorStream", { STREAM_HUB: hub as unknown as ApiEnv["STREAM_HUB"] });
});
beforeEach(() => void (hubCalls.length = 0));

/** Channels the author's hub got the note on. */
const authorChannels = (noteId: string) =>
  hubCalls.filter((c) => c.userId === f.ids.a && c.path === "/publish" && c.body.type === "note" && c.body.body?.id === noteId).map((c) => c.body.channel).sort();

describe("notes/create → the author's streams", () => {
  it("public: home, hybrid, local and global", async () => {
    const r = await f.call("notes/create", { text: "hello", visibility: "public" }, "a");
    assert.deepEqual(authorChannels(r.data.createdNote.id), ["globalTimeline", "homeTimeline", "hybridTimeline", "localTimeline"]);
  });

  it("home / followers: home and hybrid only", async () => {
    for (const visibility of ["home", "followers"]) {
      const r = await f.call("notes/create", { text: visibility, visibility }, "a");
      assert.deepEqual(authorChannels(r.data.createdNote.id), ["homeTimeline", "hybridTimeline"], visibility);
    }
  });
});
