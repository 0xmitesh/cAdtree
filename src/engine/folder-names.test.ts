import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryFileSystemAdapter, splitAndValidatePath } from "./fs-adapter";
import { validateWindowsSegments } from "../utils/folder-path";
import {
  folderNameFor,
  clashKey,
  isReservedFolderName,
  withCounter,
  pickFreeName,
} from "./folder-names";

const bytes = (s: string) => new TextEncoder().encode(s).length;
const noLoneSurrogate = (s: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

test("folderNameFor keeps readable names", () => {
  assert.equal(folderNameFor("Packaging Gripper", "X"), "Packaging Gripper");
  assert.equal(folderNameFor("  Client ABC.  ", "X"), "Client ABC");
  assert.equal(folderNameFor("Client/ABC", "X"), "Client-ABC");
  assert.equal(folderNameFor("a   b", "X"), "a b");
  assert.equal(folderNameFor("தமிழ்", "X"), "தமிழ்");
  assert.equal(folderNameFor("ＡＢＣ", "X"), "ABC");
  assert.equal(folderNameFor(".hidden", "X"), "hidden");
  assert.equal(folderNameFor("Part (rev 2)-b", "X"), "Part (rev 2)-b");
});

test("folderNameFor replaces unsafe characters", () => {
  for (const ch of ["<", ">", ":", '"', "/", "\\", "|", "?", "*"]) {
    assert.equal(folderNameFor(`a${ch}b`, "X"), "a-b", ch);
  }
  assert.equal(folderNameFor("a\u0000b\u001fc\u007fd", "X"), "a-b-c-d");
});

test("folderNameFor replaces lone surrogates", () => {
  assert.equal(folderNameFor("a\ud800b", "X"), "a-b");
  assert.equal(folderNameFor("a\udc00b", "X"), "a-b");
  assert.equal(folderNameFor("ab\ud800", "X"), "ab-");
  assert.equal(folderNameFor("a😀b", "X"), "a😀b");
});

test("folderNameFor falls back when empty", () => {
  assert.equal(folderNameFor("...", "Project"), "Project");
  assert.equal(folderNameFor("   ", "Workspace"), "Workspace");
  assert.equal(folderNameFor("", "Design case"), "Design case");
});

test("folderNameFor caps at 255 bytes cleanly", () => {
  const tamil = folderNameFor("த".repeat(200), "X");
  assert.ok(bytes(tamil) <= 255);
  assert.ok(noLoneSurrogate(tamil));
  assert.doesNotMatch(tamil, /[. ]$/);

  const emoji = folderNameFor("😀".repeat(100), "X");
  assert.ok(bytes(emoji) <= 255);
  assert.ok(noLoneSurrogate(emoji));
  assert.equal(emoji, "😀".repeat(63));

  // 254 ASCII bytes, then "." lands at byte 255 and a letter after it is cut.
  const dotted = folderNameFor("a".repeat(254) + ".b", "X");
  assert.equal(dotted, "a".repeat(254));
  const spaced = folderNameFor("a".repeat(254) + " b", "X");
  assert.equal(spaced, "a".repeat(254));
});

test("isReservedFolderName", () => {
  for (const n of ["CON", "con", "Con.txt", "NUL", "COM1", "COM0", "LPT9", "COM¹", "LPT³", "aux.tar.gz", "CON .x"]) {
    assert.equal(isReservedFolderName(n), true, n);
  }
  for (const n of ["CONSOLE", "CON (2)", "COM10", "Parts", "xCON"]) {
    assert.equal(isReservedFolderName(n), false, n);
  }
});

test("clashKey is case and width insensitive", () => {
  assert.equal(clashKey("ＰＡＲＴＳ"), clashKey("parts"));
});

test("withCounter rejects invalid counters", () => {
  for (const n of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => withCounter("Parts", n), RangeError, String(n));
  }
});

test("withCounter", () => {
  assert.equal(withCounter("Parts", 1), "Parts");
  assert.equal(withCounter("Parts", 2), "Parts (2)");
  const long = withCounter("a".repeat(255), 12);
  assert.ok(bytes(long) <= 255);
  assert.ok(long.endsWith(" (12)"));
  assert.ok(bytes(withCounter("த".repeat(85), 2)) <= 255);
  assert.equal(withCounter("a".repeat(250) + ". x", 2).includes(". ("), false);
  assert.equal(withCounter("Con.txt", 2), "Con (2).txt");
  assert.equal(withCounter("NUL", 2), "NUL (2)");
  assert.equal(withCounter("Rev.2 bracket", 2), "Rev.2 bracket (2)");
  const dotted = withCounter("Con." + "த".repeat(84), 12);
  assert.ok(bytes(dotted) <= 255);
  assert.ok(noLoneSurrogate(dotted));
  assert.ok(dotted.startsWith("Con (12)."));
});

test("pickFreeName avoids reserved names", async () => {
  const root = new InMemoryFileSystemAdapter("root");
  for (const n of ["CON", "con", "NUL", "COM1", "LPT9", "COM¹"]) {
    assert.equal(await pickFreeName(root, n), `${n} (2)`, n);
  }
  assert.equal(await pickFreeName(root, "Con.txt"), "Con (2).txt");
  assert.equal(await pickFreeName(root, "CON.v2"), "CON (2).v2");
  assert.equal(await pickFreeName(root, "Rev.2 bracket"), "Rev.2 bracket");
  await root.getDirectory(["Con (2).txt"], { create: true });
  assert.equal(await pickFreeName(root, "Con.txt"), "Con (3).txt");
  assert.equal(await pickFreeName(root, "CONSOLE"), "CONSOLE");
  assert.equal(await pickFreeName(root, "CON (2)"), "CON (2)");
});

test("pickFreeName handles clashes", async () => {
  const root = new InMemoryFileSystemAdapter("root");
  assert.equal(await pickFreeName(root, "Parts"), "Parts");
  await root.getDirectory(["parts"], { create: true });
  assert.equal(await pickFreeName(root, "Parts"), "Parts (2)");
  await root.getDirectory(["Parts (2)"], { create: true });
  assert.equal(await pickFreeName(root, "Parts"), "Parts (3)");

  await root.writeFileText(["Notes"], "x");
  assert.equal(await pickFreeName(root, "notes"), "notes (2)");

  assert.equal(await pickFreeName(root, "Extra", { extraTaken: ["EXTRA"] }), "Extra (2)");
  assert.equal(await pickFreeName(root, "Extra", { extraTaken: new Set(["extra", "extra (2)"]) }), "Extra (3)");
});

test("pickFreeName matches adapter case rules and listing forms", async () => {
  const root = new InMemoryFileSystemAdapter("root");
  await root.getDirectory(["\u03f9"], { create: true });
  assert.equal(clashKey("\u03f9"), clashKey("\u03f2"));
  assert.equal(await pickFreeName(root, "\u03f2"), "\u03f2 (2)");

  await root.getDirectory(["Cafe\u0301"], { create: true });
  assert.equal(await pickFreeName(root, "Caf\u00e9"), "Caf\u00e9 (2)");
});

test("pickFreeName near the byte limit and exhaustion", async () => {
  const root = new InMemoryFileSystemAdapter("root");
  const base = "a".repeat(255);
  await root.getDirectory([base], { create: true });
  const next = await pickFreeName(root, base);
  assert.ok(bytes(next) <= 255);
  assert.equal(next, "a".repeat(251) + " (2)");
  await assert.rejects(() => pickFreeName(root, "Parts", { extraTaken: ["Parts", "Parts (2)"], maxAttempts: 2 }), /free folder name/);
});

test("pickFreeName creates nothing", async () => {
  const root = new InMemoryFileSystemAdapter("root");
  await root.getDirectory(["Parts"], { create: true });
  const before = JSON.stringify(await root.listEntries());
  await pickFreeName(root, "Parts");
  assert.equal(JSON.stringify(await root.listEntries()), before);
});

test("outputs are valid single path segments on every platform", async () => {
  const inputs = [
    "CON", "con.txt", "CON.v2", "Con .txt", "Rev.2 bracket", "NUL", "COM1", "COM¹", "LPT³", "LPT0", ".", "..", "...", ".hidden",
    "Client/ABC", "a\\b", "x:y", "த".repeat(200), "😀".repeat(100), "a".repeat(300),
    "a".repeat(254) + ".b", "", "   ", "trailing. . ", "ＣＯＮ", "tab\tname", "Parts?*",
  ];
  const root = new InMemoryFileSystemAdapter("root");
  for (const input of inputs) {
    const name = folderNameFor(input, "Project");
    // folderNameFor leaves reserved names to pickFreeName.
    const picked = await pickFreeName(root, name);
    assert.equal(isReservedFolderName(picked), false);
    const outs = isReservedFolderName(name) ? [picked] : [name, picked];
    for (const out of outs) {
      assert.doesNotThrow(() => splitAndValidatePath(out), JSON.stringify(input));
      assert.doesNotThrow(() => validateWindowsSegments([out]), JSON.stringify(input));
      assert.ok(bytes(out) <= 255);
      assert.ok(noLoneSurrogate(out));
    }
  }
});
