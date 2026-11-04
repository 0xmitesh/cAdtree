import test from "node:test";
import assert from "node:assert/strict";
import { START_TUTORIAL, clampTutorialStep } from "./start-tutorial";

test("START_TUTORIAL defines 5 steps covering Cadtree Home -> Workspace -> Project with real visual assets", () => {
  assert.equal(START_TUTORIAL.id, "start-with-cadtree");
  assert.equal(START_TUTORIAL.title, "Start with cAdtree");
  assert.equal(START_TUTORIAL.steps.length, 5);
  assert.deepEqual(
    START_TUTORIAL.steps.map((s) => s.title),
    [
      "Cadtree Home",
      "Create or connect Cadtree Home",
      "Workspace",
      "Project",
      "Ready to work",
    ],
  );
  assert.equal(START_TUTORIAL.steps[1].visuals?.length, 3);
  assert.deepEqual(
    START_TUTORIAL.steps[1].visuals?.map((v) => v.kind),
    ["cadtree", "os", "cadtree"],
  );
  assert.deepEqual(
    START_TUTORIAL.steps[1].visuals?.map((v) => v.caption),
    [
      "1. Click Start my Cadtree home.",
      "2. Select a dedicated empty folder for Cadtree Home.",
      "3. Paste the folder's full address and complete setup.",
    ],
  );
  assert.equal(START_TUTORIAL.steps[2].visuals?.length, 2);
  assert.deepEqual(
    START_TUTORIAL.steps[2].visuals?.map((v) => v.kind),
    ["cadtree", "cadtree"],
  );
  assert.equal(START_TUTORIAL.steps[3].visuals?.length, 2);
  assert.deepEqual(
    START_TUTORIAL.steps[3].visuals?.map((v) => v.kind),
    ["cadtree", "cadtree"],
  );
  assert.match(
    START_TUTORIAL.steps[1].note ?? "",
    /cannot provide or verify its full local filesystem address/,
  );
  // Step 4 does not expose internal shared vault implementation detail
  assert.ok(
    !JSON.stringify(START_TUTORIAL.steps[3]).toLowerCase().includes("vault"),
  );
  // Step 5 explains Copy path with system file manager wording
  assert.match(
    START_TUTORIAL.steps[4].points[1],
    /paste it into your system file manager/,
  );
  assert.equal(
    START_TUTORIAL.steps[4].nextHint,
    "Next: save your first revision.",
  );
});

test("clampTutorialStep bounds step index within valid range", () => {
  assert.equal(clampTutorialStep(-1, 5), 0);
  assert.equal(clampTutorialStep(0, 5), 0);
  assert.equal(clampTutorialStep(2, 5), 2);
  assert.equal(clampTutorialStep(4, 5), 4);
  assert.equal(clampTutorialStep(9, 5), 4);
  assert.equal(clampTutorialStep(3, 0), 0);
});
