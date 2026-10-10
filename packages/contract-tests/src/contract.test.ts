import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fixtureLocalUser,
  fixtureMeta,
  fixtureNote,
  testConfig,
} from "../../packers/src/fixtures.js";
import {
  meDetailedShape,
  handleMeta,
  handleNotesShow,
  handleNotesTimeline,
} from "./handlers.js";

describe("contract handlers", () => {
  const me = fixtureLocalUser({ id: "meeeeeeeeeeeee01", requireSigninToViewContents: false });
  const note = fixtureNote(me.id);
  const deps = {
    config: testConfig,
    meta: fixtureMeta({ rootUserId: me.id }),
    me,
    notes: [note],
    usersById: new Map([[me.id, me]]),
  };

  it("meta returns detailed shape with policies", () => {
    const res = handleMeta(deps, { detail: true });
    assert.equal(res.uri, testConfig.url);
    assert.ok("features" in res && res.features);
    assert.equal(typeof res.policies.ltlAvailable, "boolean");
  });

  it("meta detail=false returns lite without features", () => {
    const res = handleMeta(deps, { detail: false });
    assert.equal(res.uri, testConfig.url);
    assert.equal("features" in res, false);
  });

  it("a MeDetailed shape built from the packers assigns to IResponse", () => {
    const res = meDetailedShape(deps);
    assert.equal(res.id, me.id);
    assert.equal(res.username, "ai");
    assert.equal(res.isCat, true);
    assert.equal(typeof res.policies.driveCapacityMb, "number");
  });

  it("notes/show and notes/timeline return packed notes", () => {
    const shown = handleNotesShow(deps, note.id);
    assert.equal(shown.id, note.id);
    assert.equal(shown.user.username, "ai");
    const tl = handleNotesTimeline(deps);
    assert.equal(tl.length, 1);
    assert.equal(tl[0]!.id, note.id);
  });
});
