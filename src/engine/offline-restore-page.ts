/**
 * Offline restore page: `projects/<P>/_RESTORE cAdtree.html`, one self-contained HTML page per project.
 *
 * Opened straight from the disk (file://) in a browser, with no internet and no install, it gets files back out of
 * the vault in two ways:
 *   Mode 1  single files: drop a vault `.bin` file on the page; it hashes it, looks the checksum up in the table
 *           embedded below and saves a copy under the original name.
 *   Mode 2  a whole revision (Chrome or Edge): choose the vault folder (read-only) and an empty folder; the page
 *           rebuilds every folder and file of one revision and checks every checksum before and after writing.
 *
 * Derived, never authoritative, like the Map: cAdtree never reads it back, and the vault always wins. The builder
 * is pure (no I/O, no clock): the same inputs give the same page. The script is in offline-restore-page-script.ts.
 *
 * Safety: inline CSS and JS only; a Content-Security-Policy that allows no network; the data is JSON in a
 * `<script type="application/json">` block with every `<`, `>`, `&`, U+2028 and U+2029 escaped, so no name can end
 * the block; the script shows data only through textContent. Never claims that a checksum proves the design.
 */
import type { ReferenceVersion } from './references';
import type { VaultState } from './types';
import { OFFLINE_GUIDE_FORMAT_VERSION } from './offline-guide-paths';
import { hashBytes } from './hash';
import { RESTORE_PAGE_SCRIPT } from './offline-restore-page-script';

/** Where a saved file's bytes appear, for the page's Mode 1 result. */
export interface RestoreOccurrence {
  kind: 'file' | 'reference';
  /** Original file name (the last part of a path, or a reference's original file name). */
  name: string;
  /** Relative path inside the revision (files only). */
  path?: string;
  revisionNumber?: number;
  revisionId?: string;
  branchName?: string;
  /** Reference title and version number (references only). */
  title?: string;
  version?: number;
}

export interface RestoreEntry {
  size: number;
  /** Every distinct original name the bytes were saved under (capped), sorted. */
  names: string[];
  /** At most OCCURRENCE_CAP places, oldest first. */
  occurrences: RestoreOccurrence[];
  /** How many more places there are beyond `occurrences`. */
  more: number;
}

export interface RestoreData {
  /** First key, so the generated time can be found and ignored when comparing pages. */
  generatedAt: string;
  format: number;
  projectName: string;
  projectId: string;
  /** Unique SHA-256 to what it holds. */
  files: Record<string, RestoreEntry>;
}

export interface RestorePageInput {
  generatedAt: string;
  projectName: string;
  state: VaultState;
}

export const OCCURRENCE_CAP = 20;
export const NAME_CAP = 50;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const baseName = (path: string): string => path.split('/').pop() ?? path;

interface Candidate {
  occurrence: RestoreOccurrence;
  size: number;
  sortKey: [number, number, string, string];
}

/** The embedded table: every file of every complete revision and every reference version, keyed by checksum. */
export function buildRestoreData(input: RestorePageInput): RestoreData {
  const { state } = input;
  const branchName = (branchId: string): string => state.branches.find((branch) => branch.branchId === branchId)?.name ?? 'Unknown case';
  const bySha = new Map<string, Candidate[]>();
  const add = (sha256: string, candidate: Candidate): void => {
    const list = bySha.get(sha256);
    if (list) list.push(candidate);
    else bySha.set(sha256, [candidate]);
  };

  const revisions = state.revisions
    .filter((revision) => revision.integrityStatus !== 'corrupted')
    .sort((a, b) => compare(a.manifest.captureCompletedAt, b.manifest.captureCompletedAt) || compare(a.manifest.revisionId, b.manifest.revisionId));
  const seenFiles = new Set<string>();
  revisions.forEach((revision, order) => {
    const manifest = revision.manifest;
    for (const file of manifest.files) {
      // The same path on the same branch with the same bytes is one place, shown at its first revision.
      const key = `${file.sha256}\u0000${manifest.branchId}\u0000${file.path}`;
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
      add(file.sha256, {
        size: file.size,
        sortKey: [0, order, file.path, ''],
        occurrence: {
          kind: 'file',
          name: baseName(file.path),
          path: file.path,
          revisionNumber: manifest.displayNumber,
          revisionId: manifest.revisionId,
          branchName: branchName(manifest.branchId),
        },
      });
    }
  });

  const evidence = state.references;
  if (evidence && ['available', 'legacy'].includes(evidence.status)) {
    const titles = new Map<string, string>();
    const versions = new Map<string, { referenceId: string; version: ReferenceVersion; number: number }>();
    const collect = (references: { referenceId: string; title: string; versions: ReferenceVersion[] }[]): void => {
      for (const reference of references) {
        titles.set(reference.referenceId, reference.title);
        reference.versions.forEach((version, index) => {
          const key = `${reference.referenceId}\u0000${version.versionId}`;
          if (!versions.has(key)) versions.set(key, { referenceId: reference.referenceId, version, number: index + 1 });
        });
      }
    };
    // Older catalogs first, so the current library's title wins when a reference was renamed.
    collect(Object.values(evidence.catalogs).map((entry) => entry.record).flatMap((record) => record.references));
    collect(evidence.library);
    for (const { referenceId, version, number } of versions.values()) {
      add(version.sha256, {
        size: version.size,
        sortKey: [1, 0, titles.get(referenceId) ?? '', String(number).padStart(6, '0')],
        occurrence: { kind: 'reference', name: version.originalFilename, title: titles.get(referenceId) ?? '', version: number },
      });
    }
  }

  const files: Record<string, RestoreEntry> = {};
  for (const sha256 of [...bySha.keys()].sort(compare)) {
    const candidates = bySha.get(sha256)!.sort(
      (a, b) =>
        a.sortKey[0] - b.sortKey[0] || a.sortKey[1] - b.sortKey[1] || compare(a.sortKey[2], b.sortKey[2]) || compare(a.sortKey[3], b.sortKey[3]),
    );
    const names = [...new Set(candidates.map((candidate) => candidate.occurrence.name))].sort(compare).slice(0, NAME_CAP);
    files[sha256] = {
      size: candidates[0]!.size,
      names,
      occurrences: candidates.slice(0, OCCURRENCE_CAP).map((candidate) => candidate.occurrence),
      more: Math.max(0, candidates.length - OCCURRENCE_CAP),
    };
  }
  return { generatedAt: input.generatedAt, format: OFFLINE_GUIDE_FORMAT_VERSION, projectName: input.projectName, projectId: state.project.projectId, files };
}

/** JSON that is safe inside a `<script>` element: nothing in it can close the element or open a comment. */
export function escapeJsonForScript(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const escapeHtml = (text: string): string =>
  text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** The page's own script is allowed by its SHA-256 hash, not by 'unsafe-inline'. */
export function restorePageScriptHash(script: string = RESTORE_PAGE_SCRIPT): string {
  const hex = hashBytes(new TextEncoder().encode(script));
  return `sha256-${btoa(String.fromCharCode(...(hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16))))}`;
}

export const restorePageCsp = (script: string = RESTORE_PAGE_SCRIPT): string =>
  `default-src 'none'; script-src '${restorePageScriptHash(script)}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`;

const STYLE = `
:root { color-scheme: light dark; --bg: #f7f7f4; --card: #ffffff; --text: #1f2933; --muted: #5f6b76; --line: #d8dbd5; --accent: #0f6b5f; --accent-text: #ffffff; --good: #14633f; --warn: #8a5a00; --bad: #a12323; }
@media (prefers-color-scheme: dark) { :root { --bg: #161b1d; --card: #1f2629; --text: #e6e9e8; --muted: #a1abb0; --line: #364146; --accent: #3fb59f; --accent-text: #0b1512; --good: #6fd1a0; --warn: #e3b25a; --bad: #f08a8a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 780px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 19px; margin: 0 0 8px; }
p { margin: 0 0 12px; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin: 20px 0; }
.lead { color: var(--muted); }
.fine, .label { color: var(--muted); font-size: 14px; }
.label { margin: 12px 0 4px; font-weight: 600; }
.step { margin: 16px 0 6px; font-weight: 600; }
.drop { display: block; border: 2px dashed var(--line); border-radius: 12px; padding: 28px 16px; text-align: center; cursor: pointer; }
.drop.over { border-color: var(--accent); background: rgba(15, 107, 95, 0.08); }
.drop input { display: block; margin: 12px auto 0; max-width: 100%; }
button { font: inherit; border: 1px solid var(--line); background: var(--card); color: var(--text); border-radius: 8px; padding: 8px 14px; cursor: pointer; }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
.card { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 12px 0 0; word-break: break-word; }
.card-title { font-weight: 600; }
.status { margin: 8px 0; padding: 0; }
.status.good { color: var(--good); }
.status.warn { color: var(--warn); }
.status.bad { color: var(--bad); }
.choice { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; margin: 6px 0; cursor: pointer; }
.choice-text { display: block; word-break: break-word; }
.summary { display: block; color: var(--muted); font-size: 14px; }
ul.plain { margin: 4px 0 8px; padding-left: 20px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; margin: 8px 0; }
th, td { border-bottom: 1px solid var(--line); padding: 4px 8px; text-align: left; vertical-align: top; word-break: break-word; }
.state-written { color: var(--good); }
.state-missing, .state-damaged, .state-failed { color: var(--bad); font-weight: 600; }
footer { color: var(--muted); font-size: 14px; }
code { font-family: ui-monospace, Consolas, monospace; font-size: 14px; word-break: break-all; }
`;

const BODY = `
<main>
<h1>Your files without cAdtree</h1>
<p class="lead">Project <strong id="project-name"></strong></p>
<p>This page gets files back out of this project's saved history (the <code>vault</code> folder) with only a web browser. It runs on your computer: it loads nothing from the internet and sends nothing anywhere. It only reads the vault.</p>
<p>A matching checksum shows that a file holds exactly the bytes that were saved. It does not show that the design is right. An assembly or a drawing needs the whole version, with its folders and names, so use the second option below for those and open the result in your CAD program to check it.</p>
<p class="fine">A web page cannot open a file or folder from a typed path. Drag files onto the page, or use the buttons to choose them. Each file is loaded into memory to check it, so a file larger than about 2 GB cannot be handled by this page: use the manual steps in the <code>_MAP cAdtree.txt</code> file for those.</p>

<section id="mode1">
<h2>1. Restore single files</h2>
<p>Open the project folder, then <code>vault</code>, then <code>objects</code>, then a folder with a two-character name. Drag the <code>.bin</code> file you need onto the box below, or choose it. The page finds out what it is from its checksum and saves a copy under its original name. Any modern browser works.</p>
<label id="drop-zone" class="drop">Drop one or more <code>.bin</code> files here, or choose them
<input id="file-picker" type="file" multiple></label>
<div id="results1" aria-live="polite"></div>
</section>

<section id="mode2">
<h2>2. Rebuild a whole version</h2>
<div id="mode2-body">
<p>Rebuilds every folder and file of one saved version under its original names, then checks every file. Needs Google Chrome or Microsoft Edge on a computer.</p>
<p class="step">Step 1. Choose the project's vault folder</p>
<p class="fine">The folder named <code>vault</code> inside the project folder. The page opens it read-only.</p>
<button type="button" id="choose-vault">Choose vault folder...</button>
<p id="vault-status" class="status" aria-live="polite"></p>
<p class="step">Step 2. Pick a version</p>
<div id="revision-list"></div>
<p class="step">Step 3. Choose an empty folder to rebuild into</p>
<p class="fine">Make a new empty folder outside the vault first. A folder that is not empty, or that is inside the vault, is refused.</p>
<button type="button" id="choose-dest" disabled>Choose empty folder...</button>
<p id="dest-status" class="status" aria-live="polite"></p>
<p class="step">Step 4. Rebuild</p>
<button type="button" id="rebuild" class="primary" disabled>Rebuild this version</button>
<p id="progress2" class="fine" aria-live="polite"></p>
<div id="report" aria-live="polite"></div>
</div>
</section>

<footer>
<p>Generated <span id="generated-at"></span> for project <code id="project-id"></code>. The single-file lookup lists what was saved up to that time; the version list in option 2 is read from the vault itself, so it is always current. This page is a guide generated by cAdtree: if it disagrees with the vault, the vault is correct. Never edit anything in the vault by hand.</p>
</footer>
<noscript><p>This page needs JavaScript. Without it, use the steps in the <code>_MAP cAdtree.txt</code> file next to this page.</p></noscript>
</main>
`;

/** Text of `_RESTORE cAdtree.html`. Pure and deterministic. */
export function buildRestorePage(input: RestorePageInput): string {
  const data = escapeJsonForScript(JSON.stringify(buildRestoreData(input)));
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${restorePageCsp()}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Your files without cAdtree: ${escapeHtml(input.projectName)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    BODY.trim(),
    `<script type="application/json" id="cadtree-restore-data">${data}</script>`,
    `<script>${RESTORE_PAGE_SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** The page without its generated time, so an unchanged page is never rewritten just for a new time. */
export const restorePageWithoutGenerated = (html: string): string => html.replace(/"generatedAt":"[^"]*"/, '"generatedAt":""');
