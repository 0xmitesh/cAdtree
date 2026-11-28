import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkPackages,
  declaredLicense,
  LICENSE_EXCEPTIONS,
  evaluateLicenseExpression,
} from "../../scripts/check-licenses.mjs";

const allowed = ["MIT", "ISC", "Apache-2.0"];
const ok = (expression: string) => evaluateLicenseExpression(expression, allowed).ok;

test("licence check: single allowed and disallowed licences", () => {
  assert.equal(ok("MIT"), true);
  assert.equal(ok("mit"), true);
  assert.equal(ok("GPL-3.0"), false);
  assert.equal(ok("MPL-2.0"), false);
});

test("licence check: OR passes if any part is allowed, AND only if all are", () => {
  assert.equal(ok("(MIT OR GPL-3.0)"), true);
  assert.equal(ok("GPL-3.0 OR LGPL-2.1"), false);
  assert.equal(ok("MIT AND ISC"), true);
  assert.equal(ok("MIT AND GPL-3.0"), false);
  assert.equal(ok("MIT OR GPL-3.0 AND LGPL-2.1"), true); // AND binds tighter
  assert.equal(ok("(MIT OR GPL-3.0) AND ISC"), true);
  assert.equal(ok("(GPL-3.0 OR LGPL-2.1) AND ISC"), false);
});

test("licence check: a trailing + is ignored and exceptions need review", () => {
  assert.equal(ok("Apache-2.0+"), true);
  assert.equal(ok("MIT WITH Classpath-exception-2.0"), false);
});

test("licence check: missing, UNLICENSED, custom and unparseable licences fail", () => {
  assert.equal(ok(""), false);
  assert.equal(evaluateLicenseExpression(undefined as unknown as string, allowed).ok, false);
  assert.equal(ok("UNLICENSED"), false);
  assert.equal(ok("SEE LICENSE IN LICENSE.txt"), false);
  assert.equal(ok("(MIT"), false);
  assert.equal(ok("MIT OR"), false);
  assert.equal(ok("MIT ISC"), false);
});

test("licence check: legacy licence fields", () => {
  assert.equal(declaredLicense({ license: { type: "MIT" } }), "MIT");
  assert.equal(declaredLicense({ licenses: [{ type: "MIT" }, { type: "ISC" }] }), "(MIT OR ISC)");
  assert.equal(declaredLicense({}), null);
});

test("licence check: checkPackages skips the root, honours exceptions and reports failures", () => {
  const entries = [
    { name: "root", version: "1.0.0", license: "AGPL-3.0-only", location: "" },
    { name: "b", version: "1.0.0", license: "GPL-3.0", location: "node_modules/b", dev: true },
    { name: "a", version: "2.0.0", location: "node_modules/a" },
    { name: "c", version: "1.0.0", license: "MIT", location: "node_modules/c" },
    { name: "d", version: "1.0.0", license: "UNLICENSED", location: "node_modules/d" },
  ];
  const result = checkPackages(entries, {
    allowed,
    exceptions: [{ match: (name: string) => name === "d", licence: "UNLICENSED", label: "d", reason: "test" }],
  });
  assert.equal(result.checked, 4);
  assert.deepEqual(
    result.failures.map((f: { name: string }) => f.name),
    ["a", "b"],
  );
  assert.equal(result.failures[1].dev, true);
});

test("licence check: the lightningcss exception is narrow", () => {
  const failing = (name: string, license: string) =>
    checkPackages([{ name, version: "1.0.0", license, location: `node_modules/${name}` }], {
      allowed,
      exceptions: LICENSE_EXCEPTIONS,
    });
  assert.equal(failing("lightningcss", "MPL-2.0").failures.length, 0);
  assert.equal(failing("lightningcss-win32-x64-msvc", "MPL-2.0").failures.length, 0);
  assert.equal(failing("lightningcss-darwin-arm64", "MPL-2.0").excepted.get("lightningcss"), 1);
  assert.equal(failing("lightningcss", "GPL-3.0").failures.length, 1);
  assert.equal(failing("some-other-pkg", "MPL-2.0").failures.length, 1);
});
