import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { START_TUTORIAL, clampTutorialStep } from "./start-tutorial";
import { normalizeFolderPath } from "../utils/folder-path";

test("Tutorial 1 has six steps with distinct home creation and path-copy instructions", () => {
  const steps = START_TUTORIAL.steps;
  assert.equal(START_TUTORIAL.id, "start-with-cadtree");
  assert.deepEqual(steps.map(s => s.title), ["Cadtree Home", "Create Cadtree Home", "Copy the Cadtree Home address", "Workspace", "Project", "Ready to work"]);
  assert.deepEqual(steps.map(s => s.visuals?.length ?? 0), [0, 2, 2, 2, 2, 0]);
  assert.deepEqual(steps[1].visuals?.map(v => v.kind), ["cadtree", "os"]);
  assert.deepEqual(steps[2].visuals?.map(v => v.kind), ["os", "cadtree"]);
  assert.deepEqual(steps[3].visuals?.map(v => v.kind), ["cadtree", "cadtree"]);
  assert.deepEqual(steps[4].visuals?.map(v => v.kind), ["cadtree", "cadtree"]);
  assert.deepEqual(steps[1].visuals?.map(v => v.caption), ["1. Click Start my Cadtree home.", "2. Select a dedicated empty folder for Cadtree Home."]);
  assert.deepEqual(steps[2].visuals?.map(v => v.caption), ["1. In File Explorer, right-click Cadtree Home and choose Copy as path.", "2. Paste the folder address into cAdtree and click Complete setup."]);
  assert.ok(!steps[1].visuals?.some(v => v.src.includes("complete-home-setup")));
  assert.match(steps[2].note!, /cannot provide or verify its full local filesystem address/);
  assert.match(steps[2].points[0], /removes matching surrounding quotes automatically/);
  assert.equal(normalizeFolderPath('"D:\\Cadtree"'), "D:\\Cadtree", "the wording matches the existing path parser");
  assert.ok(!JSON.stringify(steps[4]).toLowerCase().includes("vault"));
  assert.match(steps[5].points[1], /paste it into your system file manager/);
  assert.equal(steps[5].nextHint, "Next: save your first revision.");
  for (const step of steps) for (const visual of step.visuals ?? []) {
    assert.ok(visual.alt && visual.caption);
    assert.ok(existsSync(new URL(`../../public${visual.src}`, import.meta.url)), `missing tutorial asset: ${visual.src}`);
  }
});

test("clampTutorialStep bounds step index within valid range", () => {
  assert.equal(clampTutorialStep(-1, 6), 0);
  assert.equal(clampTutorialStep(0, 6), 0);
  assert.equal(clampTutorialStep(2, 6), 2);
  assert.equal(clampTutorialStep(5, 6), 5);
  assert.equal(clampTutorialStep(9, 6), 5);
  assert.equal(clampTutorialStep(3, 0), 0);
});
