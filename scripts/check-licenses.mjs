// Dependency licence check (run in CI as `npm run check:licenses`).
//
// Lists every installed package with `npm query "*" --json` (built into npm,
// no network, no extra packages) and checks its declared licence against an
// allowlist of permissive licences. A missing licence, UNLICENSED, SEE LICENSE
// IN ... or an expression we cannot parse is a failure, unless the package is
// in LICENSE_EXCEPTIONS below. The root package itself is skipped.
//
// Usage: node scripts/check-licenses.mjs [projectDir]
// projectDir defaults to the repository root (the folder above this script).

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Permissive licences only (SPDX ids, compared case-insensitively). Do not add
// copyleft or custom licences here without a deliberate decision: GPL, LGPL,
// MPL, EPL, CC-BY-SA and similar must be reviewed by a person first.
export const ALLOWED_LICENSES = [
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-4.0", // data packages only (caniuse-lite)
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "Python-2.0",
  "Unlicense",
];

// Packages accepted despite a licence the check would reject: name -> reason.
// Each entry must say which licence was verified by reading the package's
// LICENSE file. Keep this empty unless there is a verified reason.
export const LICENSE_EXCEPTIONS = {
  // "example-package": "No license field; LICENSE file read and is MIT.",
};

// --- SPDX expression evaluation -------------------------------------------

function tokenize(expression) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g);
  return tokens ?? [];
}

// Normalise one licence id: drop a trailing "+" or "-or-later" (an "or later"
// licence is accepted when its base licence is allowed).
function normalizeId(id) {
  return id.replace(/\+$/, "").replace(/-or-later$/i, "");
}

/**
 * Evaluate a (simple) SPDX expression against an allowlist.
 * Grammar: or := and ("OR" and)*; and := atom ("AND" atom)*; atom := "(" or ")" | id.
 * Returns { ok: boolean, reason?: string }.
 */
export function evaluateLicenseExpression(expression, allowed = ALLOWED_LICENSES) {
  if (typeof expression !== "string" || expression.trim() === "") {
    return { ok: false, reason: "no licence declared" };
  }
  if (/^\s*SEE LICENSE IN\b/i.test(expression)) {
    return { ok: false, reason: "custom licence (SEE LICENSE IN ...)" };
  }
  if (/^\s*UNLICENSED\s*$/i.test(expression)) {
    return { ok: false, reason: "UNLICENSED" };
  }
  const allowedSet = new Set(allowed.map((id) => id.toLowerCase()));
  const tokens = tokenize(expression);
  let pos = 0;
  const bad = [];

  const parseOr = () => {
    let ok = parseAnd();
    while (tokens[pos] === "OR") {
      pos += 1;
      const right = parseAnd();
      ok = ok || right;
    }
    return ok;
  };
  const parseAnd = () => {
    let ok = parseAtom();
    while (tokens[pos] === "AND") {
      pos += 1;
      const right = parseAtom();
      ok = ok && right;
    }
    return ok;
  };
  const parseAtom = () => {
    const token = tokens[pos];
    if (token === undefined || token === ")" || token === "AND" || token === "OR") {
      throw new Error("unparseable licence expression");
    }
    pos += 1;
    if (token === "(") {
      const ok = parseOr();
      if (tokens[pos] !== ")") throw new Error("unparseable licence expression");
      pos += 1;
      return ok;
    }
    if (tokens[pos] === "WITH") {
      // Licence exceptions change the terms: never accept them automatically.
      throw new Error("licence exception (WITH ...) needs review");
    }
    const id = normalizeId(token);
    if (allowedSet.has(id.toLowerCase())) return true;
    bad.push(token);
    return false;
  };

  try {
    const ok = parseOr();
    if (pos !== tokens.length) throw new Error("unparseable licence expression");
    return ok
      ? { ok: true }
      : { ok: false, reason: `not on the allowlist: ${bad.join(", ")}` };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// Declared licence of one package.json-like object, as an SPDX string or null.
export function declaredLicense(pkg) {
  const field = pkg.license;
  if (typeof field === "string" && field.trim() !== "") return field.trim();
  if (field && typeof field === "object" && typeof field.type === "string") {
    return field.type.trim();
  }
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses
      .map((entry) => (typeof entry === "string" ? entry : entry?.type))
      .filter((type) => typeof type === "string" && type.trim() !== "")
      .map((type) => type.trim());
    if (types.length === 1) return types[0];
    if (types.length > 1) return `(${types.join(" OR ")})`;
  }
  return null;
}

/**
 * Check a list of `npm query` entries. Returns { checked, seen, failures }.
 * `seen` maps a licence string to a package count.
 */
export function checkPackages(entries, options = {}) {
  const allowed = options.allowed ?? ALLOWED_LICENSES;
  const exceptions = options.exceptions ?? LICENSE_EXCEPTIONS;
  const failures = [];
  const seen = new Map();
  let checked = 0;
  for (const entry of entries) {
    if (entry.location === "" || entry.location === undefined) continue; // root package
    checked += 1;
    const licence = declaredLicense(entry);
    const label = licence ?? "(none)";
    seen.set(label, (seen.get(label) ?? 0) + 1);
    if (Object.prototype.hasOwnProperty.call(exceptions, entry.name)) continue;
    const result = evaluateLicenseExpression(licence, allowed);
    if (!result.ok) {
      failures.push({
        name: entry.name,
        version: entry.version ?? "?",
        licence: label,
        reason: result.reason,
        dev: entry.dev === true,
      });
    }
  }
  failures.sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  );
  return { checked, seen, failures };
}

// --- Command line ----------------------------------------------------------

function listInstalledPackages(projectDir) {
  const output = execFileSync("npm", ["query", "*", "--json"], {
    cwd: projectDir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  return JSON.parse(output);
}

function main() {
  const root = path.resolve(
    process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const entries = listInstalledPackages(root);
  const { checked, seen, failures } = checkPackages(entries);
  if (failures.length > 0) {
    console.error(`Licence check failed: ${failures.length} of ${checked} packages.`);
    for (const f of failures) {
      console.error(`${f.name}@${f.version} — ${f.licence} — ${f.reason}${f.dev ? " (dev)" : ""}`);
    }
    process.exit(1);
  }
  const summary = [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([licence, count]) => `${licence} ${count}`)
    .join(", ");
  console.log(`Licence check passed: ${checked} packages (${summary}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
