import type { FileSystemDirectoryAdapter } from "./fs-adapter";

/** Maximum UTF-8 byte length of a single folder name. */
const MAX_NAME_BYTES = 255;

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

/** Cuts `text` to at most `maxBytes` UTF-8 bytes on a code-point boundary. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  let used = 0;
  let out = "";
  for (const char of text) {
    const size = byteLength(char);
    if (used + size > maxBytes) break;
    used += size;
    out += char;
  }
  return out;
}

const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

const stripEdges = (text: string) => text.replace(/^[. ]+|[. ]+$/g, "");
const stripTrailing = (text: string) => text.replace(/[. ]+$/, "");

/**
 * Turns a user-facing name into a folder name that is valid on every platform:
 * unsafe characters become "-", whitespace is collapsed, leading/trailing dots
 * and spaces are removed, and the result is capped at 255 UTF-8 bytes.
 * Returns `fallback` when nothing usable remains.
 * The output may still be a reserved or clashing name: callers must go through
 * `pickFreeName` before creating anything.
 */
export function folderNameFor(name: string, fallback: string): string {
  const cleaned = name
    .replace(LONE_SURROGATE, "-")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, " ");
  let result = stripEdges(cleaned.trim());
  result = stripEdges(truncateToBytes(result, MAX_NAME_BYTES));
  return result || fallback;
}

/**
 * Key used to compare names the way case-insensitive filesystems do. Names
 * equal under plain `toLowerCase()` (as the adapters compare) share a key.
 */
export function clashKey(name: string): string {
  return name.toLowerCase().normalize("NFKC").toLowerCase();
}

const RESERVED_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$/;

/** True for Windows reserved device names (with or without an extension). */
export function isReservedFolderName(name: string): boolean {
  return RESERVED_DEVICE_NAME.test(name.split(".")[0].trim().toUpperCase());
}

/**
 * `base` for n === 1, otherwise `base (n)`, trimmed to fit 255 bytes.
 * When the part before the first dot is a reserved device name, the counter
 * goes before that dot ("Con.txt" -> "Con (2).txt"), so it is never reserved.
 */
export function withCounter(base: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`Counter must be an integer >= 1, got ${n}.`);
  }
  if (n === 1) return base;
  const suffix = ` (${n})`;
  const dot = base.indexOf(".");
  if (dot > 0 && isReservedFolderName(base)) {
    const stem = stripTrailing(base.slice(0, dot));
    const head = stripTrailing(
      truncateToBytes(stem, MAX_NAME_BYTES - byteLength(suffix)),
    );
    const rest = truncateToBytes(
      base.slice(dot),
      MAX_NAME_BYTES - byteLength(head + suffix),
    );
    return stripTrailing(`${head}${suffix}${rest}`);
  }
  const room = MAX_NAME_BYTES - byteLength(suffix);
  const head = stripTrailing(truncateToBytes(base, room));
  return `${head}${suffix}`;
}

/**
 * Picks the first free folder name under `parent`: `base`, `base (2)`, ...
 * Files and folders both count as taken, compared case-insensitively (NFKC),
 * and reserved device names are skipped. Nothing is created.
 *
 * The caller must hold the relevant writer lock and must still create the
 * folder with `exclusiveCreate: true` as the backstop against races.
 */
export async function pickFreeName(
  parent: FileSystemDirectoryAdapter,
  base: string,
  options?: { extraTaken?: Iterable<string>; maxAttempts?: number },
): Promise<string> {
  const taken = new Set<string>();
  for (const entry of await parent.listEntries()) {
    taken.add(clashKey(entry.name));
  }
  for (const name of options?.extraTaken ?? []) taken.add(clashKey(name));
  const maxAttempts = options?.maxAttempts ?? 1000;
  for (let n = 1; n <= maxAttempts; n++) {
    const candidate = withCounter(base, n);
    if (isReservedFolderName(candidate)) continue;
    if (taken.has(clashKey(candidate))) continue;
    return candidate;
  }
  throw new Error(
    `No free folder name for "${base}" after ${maxAttempts} attempts.`,
  );
}
