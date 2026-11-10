import test from "node:test";
import assert from "node:assert/strict";
import {
  caseNameHint,
  pathBudgetBlockMessage,
  pathBudgetBlockSentence,
  pathBudgetWarnSentence,
  projectNameHint,
  workspaceNameHint,
} from "../utils/path-budget-message";
import { workspaceWorstPath, joinAddress } from "../engine/path-budget";

const win = { requiredLength: 247, excess: 7, worstPath: "C:\\Cadtree\\Client\\projects\\X\\.cadtree\\ready.json.crswap", shorten: "project" as const };

test("block sentence names the numbers, the name to shorten and a Windows example", () => {
  assert.equal(
    pathBudgetBlockSentence(win),
    "This location would need a 247-character path; the limit is 240. Shorten the project name by 7 characters, or move your Cadtree home closer to the drive (e.g. C:\\Cadtree).",
  );
  assert.match(pathBudgetBlockSentence({ ...win, shorten: "case" }), /Shorten the design case name by 7/);
  assert.match(pathBudgetBlockSentence({ ...win, shorten: "workspace" }), /Shorten the workspace name by 7/);
});

test("block message adds the measured path on its own line and the Home options hint", () => {
  const lines = pathBudgetBlockMessage(win).split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[1], win.worstPath);
  assert.equal(lines[2], "If your Cadtree home has moved, update its address in Home options.");
});

test("a POSIX address gets a POSIX example and the Windows note", () => {
  const posix = { requiredLength: 250, excess: 10, worstPath: "/Users/me/Cadtree/W/projects/P/vault/x.crswap", shorten: "workspace" as const };
  assert.equal(
    pathBudgetBlockSentence(posix),
    "This location would need a 250-character path; the limit is 240. Shorten the workspace name by 10 characters, or move your Cadtree home closer to the drive (e.g. /Users/<you>/Cadtree). Windows can't open longer paths.",
  );
  assert.ok(!pathBudgetBlockSentence(win).includes("Windows can't open longer paths."));
});

test("warn sentence only for status warn", () => {
  assert.equal(
    pathBudgetWarnSentence({ status: "warn", requiredLength: 212, worstPath: "x" }),
    "This location uses 212 of 240 characters. Shorter names leave room for design cases and deeper folders.",
  );
  assert.equal(pathBudgetWarnSentence({ status: "ok", requiredLength: 100, worstPath: "x" }), "");
  assert.equal(pathBudgetWarnSentence({ status: "unchecked", requiredLength: 0, worstPath: "" }), "");
  assert.equal(pathBudgetWarnSentence(undefined), "");
});

/** An address that leaves exactly `remaining` characters for a workspace named `name`. */
function addressLeaving(remaining: number, name: string): string {
  for (let pad = 0; pad < 300; pad++) {
    const address = `D:\\${"h".repeat(pad)}`;
    const hint = workspaceNameHint(address, name)!;
    if (hint.remaining === remaining) return address;
  }
  throw new Error("no address");
}

test("hints: silent when the address is unknown or nothing is typed, text only below 30, block when over", () => {
  assert.equal(workspaceNameHint(undefined, "Alpha"), undefined);
  assert.equal(projectNameHint(undefined, "Alpha"), undefined);
  assert.equal(caseNameHint(undefined, "Alpha", { files: [], directories: [] }), undefined);
  const address = addressLeaving(40, "a");
  assert.equal(workspaceNameHint(address, "  "), undefined);
  const at = (n: number) => workspaceNameHint(address, "a".repeat(n))!;
  assert.equal(at(1).text, "");
  assert.equal(at(11).remaining, 30);
  assert.equal(at(11).text, "");
  assert.equal(at(12).text, "29 characters left");
  assert.equal(at(40).text, "1 character left");
  assert.equal(at(41).text, "0 characters left");
  assert.equal(at(41).block, null);
  const over = at(43);
  assert.equal(over.text, "");
  assert.equal(over.block?.excess, 2);
  assert.equal(over.block?.shorten, "workspace");
  assert.equal(over.block?.requiredLength, 242);
  assert.equal(over.block?.worstPath.length, 242);
});

test("workspace hint measures the folder form of the name", () => {
  const address = "D:\\Cadtree";
  const typed = workspaceNameHint(address, 'A/B:C')!;
  assert.equal(typed.requiredLength, workspaceWorstPath(joinAddress(address, "A-B-C")).length);
});

test("project and case hints use their own worst cases", () => {
  const ws = "D:\\Cadtree\\Work";
  const p = projectNameHint(ws, "Gripper")!;
  assert.equal(p.block, null);
  assert.equal(projectNameHint(ws + "x".repeat(200), "Gripper")!.block?.shorten, "project");
  const source = { files: [{ path: "Parts/Collar.SLDPRT" }], directories: ["Parts"] };
  const c = caseNameHint(ws + "\\projects\\Gripper" + "y".repeat(190), "Lighter collar", source)!;
  assert.equal(c.block?.shorten, "case");
  assert.ok(c.block!.worstPath.endsWith("Parts\\Collar.SLDPRT.crswap") || c.block!.worstPath.includes("Lighter collar"));
});
