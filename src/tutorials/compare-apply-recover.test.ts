import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMPARE_APPLY_RECOVER_TUTORIAL as tutorial } from "./compare-apply-recover";

test("The final tutorial ships accessible real captures and precise concepts for all seven steps", () => {
  assert.equal(tutorial.steps.length, 7);
  assert.equal(new Set(tutorial.steps.map(s => s.id)).size, 7);
  const visuals = tutorial.steps.flatMap(s => s.visuals ?? []);
  assert.equal(visuals.filter(v => v.kind === "cadtree").length, 17);
  assert.equal(visuals.filter(v => v.kind === "concept").length, 3);
  assert.equal(visuals.filter(v => v.kind === "os").length, 0);
  assert.equal(new Set(visuals.map(v => v.src)).size, visuals.length);
  for (const visual of visuals) {
    assert.ok(visual.alt && visual.caption);
    assert.ok(visual.src.startsWith("/tutorials/compare-apply-recover/"));
    const bytes = readFileSync(new URL(`../../public${visual.src}`, import.meta.url));
    if (visual.kind === "cadtree") {
      assert.equal(bytes.toString("hex", 0, 8), "89504e470d0a1a0a");
      assert.ok(bytes.readUInt32BE(16) >= 900, "high-resolution direct app capture");
    } else {
      assert.match(bytes.toString(), /<svg/);
      assert.match(bytes.toString(), /<desc/);
    }
  }
});
