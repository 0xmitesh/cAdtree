// Dependency licence check (run in CI as `npm run check:licenses`).
//
// Lists every installed package with `npm query "*" --json` (built into npm,
// no network, no extra packages), adds every package-lock.json entry (optional
// platform binaries are not installed on every machine), and checks its declared licence against an
// allowlist of permissive licences. A missing licence, UNLICENSED, SEE LICENSE
// IN ... or an expression we cannot parse is a failure, unless the package is
// in LICENSE_EXCEPTIONS below. The root package itself is skipped.
//
// Usage: node scripts/check-licenses.mjs [projectDir]
// projectDir defaults to the repository root (the folder above this script).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

// Packages accepted despite a licence the check would reject. Each entry
// matches by package name and accepts only when the declared licence is
// exactly `licence`; any other licence on a matching name still fails.
// Every entry must say which licence text was verified by reading the
// package's LICENSE file. Keep this list short and narrow.
export const LICENSE_EXCEPTIONS = [
  {
    // lightningcss and its per-platform binary packages (lightningcss-linux-x64-gnu,
    // lightningcss-win32-x64-msvc, lightningcss-darwin-arm64, ...).
    match: (name) => name === "lightningcss" || name.startsWith("lightningcss-"),
    licence: "MPL-2.0",
    label: "lightningcss",
    reason:
      "Build-time CSS engine pulled in by Tailwind and Vite; not shipped in the app bundle. " +
      "MPL-2.0 is file-level copyleft and lists AGPL-3.0 as a compatible secondary licence (section 3.3). " +
      "LICENSE text verified on 28 Nov 2026.",
  },
];

// --- SPDX expression evaluation -------------------------------------------

function tokenize(expression) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g);
  return tokens ?? [];
}

// Normalise one licence id. Only the GPL family (GPL, LGPL, AGPL) has "or
// later" forms in SPDX, so only there is a trailing "+" or "-or-later" dropped;
// anything else (for example "MIT-or-later") stays as written and is unknown.
function normalizeId(id) {
  if (/^(A|L)?GPL-/i.test(id)) return id.replace(/\+$/, "").replace(/-or-later$/i, "");
  return id;
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

// Entries of package-lock.json's `packages` map as check entries (the root
// "" entry is skipped). The name is the entry's `name` or the last
// node_modules/ segment of its key. `readInstalledLicense(key)` is consulted
// only when the entry has no licence field.
/**
 * @param {any} lock
 * @param {(key: string) => string | null} [readInstalledLicense]
 */
export function lockfileEntries(lock, readInstalledLicense = (_key) => null) {
  const entries = [];
  for (const [key, value] of Object.entries(lock?.packages ?? {})) {
    if (key === "") continue;
    const name = value.name ?? key.split("node_modules/").pop();
    const entry = {
      name,
      version: value.version,
      license: value.license,
      licenses: value.licenses,
      location: key,
      dev: value.dev === true,
      lockfileOnly: true,
    };
    if (declaredLicense(entry) === null) {
      const fallback = readInstalledLicense(key);
      if (fallback) entry.license = fallback;
    }
    entries.push(entry);
  }
  return entries;
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
 * Check a list of `npm query` entries. Returns { checked, lockfileOnly, seen, excepted, failures }. Entries are
 * deduplicated by name@version (the first one wins, so list installed ones first).
 * `seen` maps a licence string to a package count; `excepted` maps an
 * exception label to the number of packages accepted through it.
 */
export function checkPackages(entries, options = {}) {
  const allowed = options.allowed ?? ALLOWED_LICENSES;
  const exceptions = options.exceptions ?? LICENSE_EXCEPTIONS;
  const failures = [];
  const seen = new Map();
  const excepted = new Map();
  const done = new Set();
  let checked = 0;
  let lockfileOnly = 0;
  for (const entry of entries) {
    if (entry.location === "") continue; // root package
    const id = `${entry.name}@${entry.version}`;
    if (done.has(id)) continue; // installed and lockfile entries are one package
    done.add(id);
    checked += 1;
    if (entry.lockfileOnly) lockfileOnly += 1;
    const licence = declaredLicense(entry);
    const label = licence ?? "(none)";
    seen.set(label, (seen.get(label) ?? 0) + 1);
    const exception = exceptions.find(
      (item) => item.match(entry.name) && licence === item.licence,
    );
    if (exception) {
      excepted.set(exception.label, (excepted.get(exception.label) ?? 0) + 1);
      continue;
    }
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
  return { checked, lockfileOnly, seen, excepted, failures };
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

function readLockfile(projectDir) {
  try {
    return JSON.parse(readFileSync(path.join(projectDir, "package-lock.json"), "utf8"));
  } catch {
    return null; // no lockfile: only installed packages are checked
  }
}

function main() {
  const root = path.resolve(
    process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const installed = listInstalledPackages(root);
  const lock = readLockfile(root);
  // Optional platform binaries (win32, darwin, ...) are not installed on this
  // machine but are in the lockfile, so check the lockfile entries too.
  const readInstalledLicense = (key) => {
    try {
      const pkg = JSON.parse(readFileSync(path.join(root, key, "package.json"), "utf8"));
      return declaredLicense(pkg);
    } catch {
      return null;
    }
  };
  const entries = [...installed, ...lockfileEntries(lock, readInstalledLicense)];
  const { checked, lockfileOnly, seen, excepted, failures } = checkPackages(entries);
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
  let viaExceptions = "";
  if (excepted.size > 0) {
    const total = [...excepted.values()].reduce((sum, count) => sum + count, 0);
    const names = LICENSE_EXCEPTIONS.filter((item) => excepted.has(item.label))
      .map((item) => `${item.label} (${item.licence})`)
      .join(", ");
    viaExceptions = `, ${total} via exceptions: ${names}`;
  }
  console.log(`Licence check passed: ${checked} packages (${lockfileOnly} from the lockfile only; ${summary}${viaExceptions}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
