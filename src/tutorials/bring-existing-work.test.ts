import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BRING_EXISTING_WORK_TUTORIAL as tutorial } from "./bring-existing-work";

test("Tutorial 3 ships readable assets and explains copying rather than a live source connection", () => {
  assert.equal(tutorial.steps.length, 6);
  assert.deepEqual(tutorial.steps.map(s => s.visuals?.length), [1, 3, 1, 3, 1, 3]);
  const copy = tutorial.steps.map(s => [s.summary, ...s.points, s.note ?? ""].join(" ")).join(" ");
  assert.match(copy, /workspace already created by cAdtree/);
  assert.match(copy, /source location is no longer required/);
  assert.match(copy, /not synchronized/);
  assert.match(copy, /Ordinary CAD-folder import does not create a saved revision/);
  assert.match(copy, /does not rewrite native CAD references/);
  assert.match(copy, /Edit the managed Main copy from now on/);
  const visuals = tutorial.steps.flatMap(s => s.visuals ?? []);
  assert.equal(visuals.filter(v => v.kind === "cadtree").length, 7);
  assert.equal(visuals.filter(v => v.kind === "os").length, 2);
  assert.equal(new Set(visuals.map(v => v.src)).size, visuals.length);
  for (const visual of visuals) {
    assert.ok(visual.alt && visual.caption);
    assert.ok(visual.src.startsWith("/tutorials/bring-existing-work/"));
    const bytes = readFileSync(new URL(`../../public${visual.src}`, import.meta.url));
    if (visual.src.endsWith(".png")) {
      assert.equal(bytes.toString("hex", 0, 8), "89504e470d0a1a0a");
      assert.ok(bytes.readUInt32BE(16) >= 1000, "screenshots stay sharp at tutorial width");
    } else {
      assert.equal(visual.kind, "concept");
      assert.match(bytes.toString(), /<svg/);
    }
  }
});
