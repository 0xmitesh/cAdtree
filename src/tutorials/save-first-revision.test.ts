import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SAVE_FIRST_REVISION_TUTORIAL as tutorial } from "./save-first-revision";
import { formatRevisionNumber } from "../engine/vault-service";

test("Tutorial 2 describes the actual first-revision workflow and ships every visual", () => {
  assert.equal(tutorial.id, "save-first-revision");
  assert.deepEqual(tutorial.steps.map(s => s.title), [
    "CAD saves and cAdtree revisions", "Reach your CAD files", "Make a change",
    "Review detected changes", "Add useful revision notes", "Save your first revision",
  ]);
  assert.deepEqual(tutorial.steps.map(s => s.visuals?.length), [1, 3, 1, 2, 2, 2]);
  assert.match(tutorial.steps[1].points.join(" "), /empty project.*Settings/);
  assert.match(tutorial.steps[1].points.join(" "), /containing folder/);
  assert.match(tutorial.steps[2].points.join(" "), /does not interpret geometry/);
  assert.match(tutorial.steps[3].points.join(" "), /first revision, files appear as Added/);
  assert.match(tutorial.steps[3].note!, /complete project state/);
  assert.match(tutorial.steps[4].points[0], /required Revision summary/);
  assert.match(tutorial.steps[5].visuals![1].caption, new RegExp(formatRevisionNumber(1)));
  assert.equal(tutorial.steps.flatMap(s => s.visuals ?? []).filter(v => v.kind === "cadtree").length, 8);
  for (const step of tutorial.steps) for (const visual of step.visuals ?? []) {
    assert.ok(visual.alt && visual.caption);
    assert.ok(visual.src.startsWith("/tutorials/save-first-revision/"));
    const bytes = readFileSync(new URL(`../../public${visual.src}`, import.meta.url));
    if (visual.src.endsWith(".png")) {
      assert.equal(bytes.toString("hex", 0, 8), "89504e470d0a1a0a");
      assert.ok(bytes.readUInt32BE(16) >= 1000, "screenshots remain sharp at tutorial width");
    } else {
      assert.equal(visual.kind, "concept");
      assert.match(bytes.toString(), /<svg/);
    }
  }
});
