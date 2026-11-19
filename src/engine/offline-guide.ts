/**
 * Offline guide (project parts): plain-text files that let a person find and recover their files with only a
 * file browser and a text editor, even without cAdtree.
 *
 *   _README cAdtree.txt                     (home root) how to find and recover files without cAdtree
 *   _INDEX cAdtree.txt                      (home root) the home's workspaces and projects and their folders
 *   projects/<P>/_MAP cAdtree.txt           the project's Map (branches, revisions, references, integrity)
 *   projects/<P>/_RESTORE cAdtree.html      a self-contained page that restores files or a whole revision (offline-restore-page.ts)
 *   projects/<P>/vault/revisions/<id>.txt   one revision in full (every file, size, SHA-256, object path)
 *
 * Derived, never authoritative: cAdtree never reads these files to decide anything, and they can be deleted
 * and rebuilt at any time. The builders are pure (no I/O, no clock): the same inputs give the same text.
 * refreshProjectGuide() and refreshHomeGuide() are the only writers. They are best-effort and never throw, so a failed guide write
 * can't fail an operation (CLAUDE.md §3: nothing here touches staging/, components/, references/,
 * case-lifecycle/ or applications/).
 *
 * Text format: UTF-8, no BOM, CRLF line endings, no trailing whitespace, ends with a single CRLF.
 * Never claims that geometry changed and never mentions format conversion.
 */
import type { FileSystemDirectoryAdapter } from './fs-adapter';
import { withProjectWriterLock } from './locks';
import { getObjectPathSegments } from './object-store';
import { caseLifecycle } from './case-lifecycle';
import { capturedReferenceLibrary, type ProjectReference, type ReferenceVersion } from './references';
import type { ReconstructedRevision, VaultState } from './types';
import { MAIN_BRANCH_ID } from './types';
import { formatRevisionNumber } from './vault-service';
import { openWorkspace, resolveManagedProject, type ManagedProject } from './workspace-service';
import { openHome, type HomeWorkspaceEntry } from './home-service';
import {
  OFFLINE_GUIDE_FORMAT_VERSION, PROJECT_MAP_FILENAME, PROJECT_RESTORE_PAGE_FILENAME, homeIndexPath, homeReadmePath, projectMapPath, restorePagePath,
  revisionListingPath,
} from './offline-guide-paths';
import { buildRestorePage, restorePageWithoutGenerated } from './offline-restore-page';

export { OFFLINE_GUIDE_FORMAT_VERSION, homeIndexPath, homeReadmePath, projectMapPath, restorePagePath, revisionListingPath };

const EOL = '\r\n';
const SUMMARY_LIMIT = 80;
/** Prose is wrapped at this many columns. */
const WRAP = 100;
const NONE = '(none)';

/** Writes the non-empty note fields; the main text is "Description" overall and "Note" per file. */
function noteFields(doc: Doc, notes: { problem: string; modification: string; observations: string }, indent: number, mainLabel: string): void {
  const fields: [string, string][] = [[mainLabel, notes.modification], ['Why', notes.problem], ['What you noticed', notes.observations]];
  const present = fields.filter(([, value]) => value?.trim());
  if (!present.length) { doc.line(NONE, indent); return; }
  for (const [label, value] of present) doc.kv(label, value, indent);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Removes what a UTF-8 text file can't round-trip: BOM, lone surrogates and control characters (except tab and line breaks). */
function clean(value: string): string {
  return String(value ?? '')
    .replace(/﻿/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

const splitLines = (value: string): string[] => clean(value).split(/\r\n|\r|\n/);

/** One line: runs of whitespace collapse to a single space. */
const oneLine = (value: string): string => clean(value).replace(/\s+/g, ' ').trim();

/** At most `limit` characters (counted in code points), ending in an ellipsis when cut. */
function truncate(value: string, limit: number): string {
  const chars = Array.from(oneLine(value));
  return chars.length <= limit ? chars.join('') : `${chars.slice(0, limit - 1).join('')}…`;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

class Doc {
  private readonly lines: string[] = [];

  line(text = '', indent = 0): this {
    this.lines.push(`${' '.repeat(indent)}${clean(text)}`);
    return this;
  }

  /** `key: value`; a multi-line value continues on indented lines; an empty value reads "(none)". */
  kv(key: string, value: string, indent = 0): this {
    const parts = splitLines(value);
    const empty = parts.every((part) => !part.trim());
    const [first, ...rest] = empty ? [NONE] : parts;
    this.line(`${key}: ${first}`, indent);
    for (const part of rest) this.line(part, indent + 4);
    return this;
  }

  /** Prose wrapped at WRAP columns. `marker` (e.g. "1. ") starts the first line; later lines align under the text. */
  para(text: string, indent = 0, marker = ''): this {
    const pad = ' '.repeat(marker.length);
    let current = '';
    let first = true;
    const flush = () => {
      this.line(`${first ? marker : pad}${current}`, indent);
      first = false;
      current = '';
    };
    for (const word of oneLine(text).split(' ').filter(Boolean)) {
      if (current && indent + marker.length + current.length + 1 + word.length > WRAP) flush();
      current = current ? `${current} ${word}` : word;
    }
    if (current) flush();
    return this;
  }

  /** A blank line, the title, then an underline of `rule` characters. */
  heading(title: string, rule = '='): this {
    return this.line().line(title).line(rule.repeat(title.length));
  }

  /** Lines with a trailing blank line before the next section. */
  section(title: string): this {
    return this.line('').line(title);
  }

  text(): string {
    // Trailing whitespace is removed per line, then the document ends with exactly one CRLF.
    const out = this.lines.map((line) => line.replace(/[ \t]+$/g, ''));
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join(EOL) + EOL;
  }
}

/** Shared header. The home Readme passes no time line: it is stable text that changes only with the guide format. */
function header(kind: string, timeLine?: string): Doc {
  const doc = new Doc().line(`cAdtree offline guide — ${kind}`);
  if (timeLine !== undefined) doc.line(timeLine);
  return doc
    .line(`Guide format: ${OFFLINE_GUIDE_FORMAT_VERSION}`)
    .line()
    .line('This file is a guide generated by cAdtree. If it disagrees with the vault records, the vault is correct.')
    .line('Do not edit files inside the vault folder. Copy them elsewhere first.');
}

/** Object file of a content hash, relative to the project folder ("/"-separated). */
const objectPath = (sha256: string): string => ['vault', ...getObjectPathSegments(sha256)].join('/');

const listingPathText = (revisionId: string): string => ['vault', ...revisionListingPath(revisionId)].join('/');

function checkInstructions(doc: Doc, indent = 0): void {
  doc.line('Check a file against its listed SHA-256 (the result must be identical):', indent);
  doc.line('Windows:  certutil -hashfile "<file>" SHA256', indent + 4);
  doc.line('Mac:      shasum -a 256 "<file>"', indent + 4);
}

const byTimeThenId = (a: ReconstructedRevision, b: ReconstructedRevision): number =>
  compare(a.manifest.captureCompletedAt, b.manifest.captureCompletedAt) || compare(a.manifest.revisionId, b.manifest.revisionId);

/** Completed revisions, oldest first (completion time, then ID). */
function orderedRevisions(state: VaultState): ReconstructedRevision[] {
  return [...state.revisions].sort(byTimeThenId);
}

const branchName = (state: VaultState, branchId: string): string =>
  state.branches.find((branch) => branch.branchId === branchId)?.name ?? 'Unknown branch';

function revisionLabel(state: VaultState, revisionId: string): string {
  const found = state.revisions.find((revision) => revision.manifest.revisionId === revisionId);
  return found
    ? `${formatRevisionNumber(found.manifest.displayNumber)} (${revisionId})`
    : `${revisionId} (not found in the vault)`;
}

function versionNumber(reference: ProjectReference, version: ReferenceVersion): number {
  return reference.versions.findIndex((candidate) => candidate.versionId === version.versionId) + 1;
}

// ---------------------------------------------------------------------------
// Revision listing
// ---------------------------------------------------------------------------

export interface RevisionListingInput {
  /** Written into the header as "Describes revision saved at". cAdtree passes the revision's own captureCompletedAt so a listing never changes. */
  generatedAt: string;
  projectName: string;
  state: VaultState;
  revision: ReconstructedRevision;
}

/** Text of `vault/revisions/<revisionId>.txt`. Pure and deterministic. */
export function buildRevisionListing(input: RevisionListingInput): string {
  const { state, revision } = input;
  const manifest = revision.manifest;
  const doc = header('revision listing', `Describes revision saved at: ${input.generatedAt}`);
  doc.line().kv('Project', input.projectName).kv('Revision', formatRevisionNumber(manifest.displayNumber)).kv('Revision ID', manifest.revisionId);
  doc.kv('Branch', `${branchName(state, manifest.branchId)} (branch ID: ${manifest.branchId})`);
  doc.kv('Parent revision', manifest.parentRevisionId ? revisionLabel(state, manifest.parentRevisionId) : 'none');
  doc.kv('Saved', manifest.captureCompletedAt).kv('Summary', manifest.summary);

  doc.section('NOTES');
  noteFields(doc, manifest.notes, 4, 'Description');

  doc.section('NOTES ON INDIVIDUAL FILES');
  const fileNotes = manifest.fileNotes ?? [];
  if (!fileNotes.length) doc.line(NONE, 4);
  for (const note of fileNotes) {
    doc.line(note.path, 4);
    noteFields(doc, note, 8, 'Note');
  }

  doc.section(`FOLDERS (${manifest.directories.length})`);
  if (!manifest.directories.length) doc.line(NONE, 4);
  for (const directory of manifest.directories) doc.line(directory, 4);

  doc.section(`FILES (${manifest.files.length})`);
  if (!manifest.files.length) doc.line(NONE, 4);
  for (const file of manifest.files) {
    doc.line(file.path, 4);
    doc.kv('Size', `${file.size} bytes`, 8).kv('SHA-256', file.sha256, 8).kv('Object file', objectPath(file.sha256), 8);
  }

  referenceLines(doc, state, manifest.revisionId);

  doc.section('HOW TO REBUILD THIS REVISION');
  doc.line(`Easiest: open ${PROJECT_RESTORE_PAGE_FILENAME} in the project folder (the folder that contains "vault") in Google`, 4);
  doc.line('Chrome or Microsoft Edge, choose "Rebuild a whole revision" and pick this revision. It rebuilds every', 4);
  doc.line('folder and file and checks each one.', 4);
  doc.line();
  doc.line('By hand (without the page): object file paths above are relative to the project folder.', 4);
  doc.line('1. On Windows, turn on View → Show → File name extensions first; the renamed copy must not end in .bin.', 4);
  doc.line('2. Make an empty folder somewhere outside the vault.', 4);
  doc.line('3. Inside it, create every folder listed under FOLDERS.', 4);
  doc.line('4. For each file under FILES, copy its object file to the listed relative path in your new folder,', 4);
  doc.line('   then rename the copy to the file name in that path.', 4);
  doc.line('5. Check each file:', 4);
  checkInstructions(doc, 7);
  doc.line('   If a result differs from the listed SHA-256, do not use that file.', 4);
  doc.line('6. Rebuild the whole folder tree, not single files: assemblies and drawings find their parts by name', 4);
  doc.line('   and relative path.', 4);
  return doc.text();
}

function referenceLines(doc: Doc, state: VaultState, revisionId: string): void {
  const context = state.references?.contexts[revisionId];
  doc.section('REFERENCES CAPTURED WITH THIS REVISION');
  if (context?.status === 'unavailable') {
    doc.line('Reference records could not be read when this file was written.', 4);
    return;
  }
  const links = context?.status === 'available' && context.record ? context.record.links : [];
  if (!links.length) {
    doc.line(NONE, 4);
    return;
  }
  const captured = capturedReferenceLibrary(state, revisionId);
  const library = state.references?.library ?? [];
  links.forEach((link, index) => {
    const reference = captured.find((item) => item.referenceId === link.referenceId) ?? library.find((item) => item.referenceId === link.referenceId);
    const version = reference?.versions.find((item) => item.versionId === link.versionId);
    if (!reference || !version) {
      doc.line(`${index + 1}. Reference ${link.referenceId}, version ${link.versionId} (details not available)`, 4);
    } else {
      doc.line(`${index + 1}. ${oneLine(reference.title)}`, 4);
      doc.kv('Original file', version.originalFilename, 8).kv('Object file', objectPath(version.sha256), 8);
      doc.kv('Version', `${versionNumber(reference, version)} (imported ${version.importedAt})`, 8);
    }
    doc.kv('Added', link.origin === 'project' ? 'as a project-wide reference' : 'for this revision', 8);
    if (link.componentPath) doc.kv('Applies to', link.componentPath, 8);
    if (link.locator.trim()) doc.kv('Where in the document', link.locator, 8);
    if (link.explanation.trim()) doc.kv('Explanation', link.explanation, 8);
  });
}

// ---------------------------------------------------------------------------
// Project map
// ---------------------------------------------------------------------------

export interface ProjectMapInput {
  generatedAt: string;
  projectName: string;
  /** Leaf name of the project folder, e.g. "Packaging Gripper". */
  projectFolder: string;
  state: VaultState;
  /** Branch ID to the leaf name of its folder under `working/`. A missing branch reads "not found". */
  workingLeaves: Record<string, string>;
  /** Revisions whose listing could not be written during this refresh; the Map says so next to their listing path. */
  failedListings?: readonly string[];
}

/** Text of `projects/<P>/_MAP cAdtree.txt`. Pure and deterministic. */
export function buildProjectMap(input: ProjectMapInput): string {
  const { state } = input;
  const revisions = orderedRevisions(state);
  const latest = revisions.at(-1);
  const doc = header('project map', `Generated: ${input.generatedAt}`);
  doc.line();
  doc.kv('Project', input.projectName).kv('Project ID', state.project.projectId).kv('Project folder', input.projectFolder);
  doc.kv(
    'Covers up to',
    latest
      ? `${formatRevisionNumber(latest.manifest.displayNumber)} (${latest.manifest.revisionId}), saved ${latest.manifest.captureCompletedAt}`
      : 'no saved revisions yet',
  );
  doc.line('Paths in this file are relative to the project folder (the folder that contains this file).');

  const branches = [...state.branches].sort(
    (a, b) => Number(b.isMain) - Number(a.isMain) || compare(a.createdAt, b.createdAt) || compare(a.branchId, b.branchId),
  );
  const workingPath = (branchId: string): string => {
    const leaf = input.workingLeaves[branchId] ?? (branchId === MAIN_BRANCH_ID ? 'main' : undefined);
    return leaf ? `working/${leaf}` : 'not found';
  };

  doc.section('YOUR LATEST FILES');
  doc.line('The newest files are ordinary folders. Open them in Explorer or Finder and copy what you need.');
  for (const branch of branches) doc.line(`${oneLine(branch.name)}${branch.isMain ? ' (Main)' : ''}: ${workingPath(branch.branchId)}`, 4);

  doc.section('BRANCHES AND DESIGN CASES');
  for (const branch of branches) {
    const lifecycle = caseLifecycle(state, branch.branchId);
    doc.line(`${oneLine(branch.name)}${branch.isMain ? ' (Main)' : ''}`);
    doc.kv('Branch ID', branch.branchId, 4).kv('Working folder', workingPath(branch.branchId), 4);
    doc.kv('Status', lifecycle.status === 'unavailable' ? 'unavailable (its lifecycle records could not be read)' : lifecycle.status === 'archived' ? 'hidden' : lifecycle.status, 4);
    doc.kv('Started from', branch.startingRevisionId ? revisionLabel(state, branch.startingRevisionId) : 'the start of the project', 4);
    doc.kv('Created', branch.createdAt, 4).kv('Reason', branch.reason, 4);
  }

  doc.section(`REVISIONS (${revisions.length}), oldest first`);
  if (!revisions.length) doc.line(NONE, 4);
  for (const revision of revisions) {
    const manifest = revision.manifest;
    doc.line(
      `${formatRevisionNumber(manifest.displayNumber)}   ${manifest.revisionId}   ${manifest.captureCompletedAt}   ${oneLine(branchName(state, manifest.branchId))}`,
    );
    doc.kv('Summary', truncate(manifest.summary, SUMMARY_LIMIT), 4);
    doc.kv('Parent', manifest.parentRevisionId ?? 'none', 4);
    const listed = listingPathText(manifest.revisionId);
    doc.kv(
      'Listing',
      revision.integrityStatus === 'corrupted'
        ? 'none (this revision record is damaged)'
        : input.failedListings?.includes(manifest.revisionId)
          ? `${listed} (listing could not be written; see the manifest)`
          : listed,
      4,
    );
  }

  doc.section('REFERENCES');
  const evidence = state.references;
  if (evidence && !['available', 'legacy'].includes(evidence.status)) {
    doc.line('Reference records could not be read when this file was written.', 4);
  } else if (!evidence?.library.length) {
    doc.line(NONE, 4);
  } else {
    for (const reference of evidence.library) {
      doc.line(`${oneLine(reference.title)}${reference.removed ? ' (removed from the reference list; its files are kept)' : ''}`, 4);
      for (const version of reference.versions) {
        doc.line(`Version ${versionNumber(reference, version)}, imported ${version.importedAt}`, 8);
        doc.kv('Original file', version.originalFilename, 12).kv('Object file', objectPath(version.sha256), 12);
      }
    }
  }

  // Damaged or read-only projects are never written, so only leftovers of interrupted attempts can appear here.
  doc.section('INTEGRITY');
  if (!state.incompleteAttempts.length) doc.line('None found when this file was written.', 4);
  for (const attempt of state.incompleteAttempts) {
    doc.line(`Incomplete attempt: ${attempt.path}`, 4).kv('Detail', attempt.detail, 8);
  }

  doc.section('HOW TO RECOVER WITHOUT cAdtree');
  doc.line(`Easiest: open ${PROJECT_RESTORE_PAGE_FILENAME} (next to this file) in Google Chrome or Microsoft Edge. It rebuilds a`, 4);
  doc.line('whole revision into an empty folder, or saves single files from the vault under their original names,', 4);
  doc.line('with every checksum checked. It works offline.', 4);
  doc.line();
  doc.line('By hand:', 4);
  doc.line('Latest files: copy the working folders listed under YOUR LATEST FILES.', 4);
  doc.line('An older revision: open its listing (path under REVISIONS). It lists every folder and file with the', 4);
  doc.line('object file to copy and the SHA-256 to check, and explains how to rebuild it. On Windows, turn on', 4);
  doc.line('View → Show → File name extensions first; the renamed copy must not end in .bin.', 4);
  checkInstructions(doc, 4);
  doc.line('Always rebuild the whole folder tree of a revision, not single files: assemblies and drawings find their', 4);
  doc.line('parts by name and relative path.', 4);
  return doc.text();
}

// ---------------------------------------------------------------------------
// Home Readme
// ---------------------------------------------------------------------------

export interface HomeReadmeInput {
  /** The home's name from its identity record (fixed when the home is created). */
  homeName: string;
}

/** One line of the folder-layout diagram: the path, then its one-line explanation in a fixed column. */
const treeLine = (path: string, what: string): string => `${path.padEnd(42)}${what}`;

/** A numbered step; `lines` are literal lines (such as commands) printed under it. */
type Step = string | { text: string; lines: string[] };

const steps = (doc: Doc, title: string, items: Step[]): void => {
  doc.line().line(title).line('-'.repeat(title.length));
  items.forEach((item, index) => {
    const step = typeof item === 'string' ? { text: item, lines: [] } : item;
    doc.para(step.text, 0, `${index + 1}. `);
    for (const line of step.lines) doc.line(line, 3);
  });
};

/**
 * Text of `_README cAdtree.txt` at the home root. Pure and deterministic. It has no Generated line: it depends
 * only on the home's name and the guide format version, so cAdtree rewrites it only when it is missing or the
 * format text changes. Written for an engineer who has never seen cAdtree and has no internet.
 */
export function buildHomeReadme(input: HomeReadmeInput): string {
  const doc = header('home Readme');

  doc.heading('1. What cAdtree is');
  doc.para(
    'cAdtree is a local-first tool for keeping the history of CAD work. It saves complete, recoverable snapshots of a ' +
      'project (called revisions) together with the engineering notes about what changed and why, and it lets you try ' +
      'design alternatives (called design cases) without disturbing your main design. It runs in a web browser, so ' +
      'nothing has to be installed, and your files stay on your own disk, in the folders described in this file. It ' +
      'is not tied to one CAD program because it stores your files exactly as they are: it does not open or ' +
      'interpret them.',
  );
  doc.line().para(
    `This folder is the Cadtree home "${oneLine(input.homeName)}". It holds everything cAdtree knows about your ` +
      'projects. You do not need cAdtree, an account or an internet connection to read this file or to get your files back.',
  );

  doc.heading('2. If cAdtree is unavailable');
  doc.para(
    'Your files are safe. Everything is stored as ordinary files and folders on this disk, in the layout described ' +
      'in section 3. If cAdtree cannot be opened (no internet, the website is down, or cAdtree itself is gone), you ' +
      'can still do all of this with only a file browser (File Explorer or Finder) and a text editor:',
  );
  doc.para('copy your latest files (section 4);', 4, '- ');
  doc.para('rebuild any older revision, or get single files back, with the restore page or by hand (section 5);', 4, '- ');
  doc.para('read the engineering notes and find the reference documents (section 6).', 4, '- ');
  doc.line().para(
    'Before you try anything, copy this whole home folder to a safe place, so that every step below works on a copy. ' +
      'Read section 7 first: it lists what must never be changed.',
  );

  doc.heading('3. Folder layout of a Cadtree home');
  doc.para('Open _INDEX cAdtree.txt (next to this file) to find your workspaces and projects and their folders.');
  doc.line();
  const tree: [string, string][] = [
    ['<home>/', 'this folder, a Cadtree home'],
    ['  _README cAdtree.txt', 'this file'],
    ['  _INDEX cAdtree.txt', 'your workspaces and projects, and where they are'],
    ['  .cadtree-home.json', "the home's identity record (leave alone)"],
    ['  .cadtree-home/workspaces/', 'records of the workspaces in this home (leave alone)'],
    ['  <Workspace>/', 'one workspace, for example a client or a CAD tool'],
    ['    .cadtree-workspace.json', "the workspace's identity record (leave alone)"],
    ['    projects/', ''],
    ['      <Project>/', 'one project'],
    ['        _MAP cAdtree.txt', "the project's Map: branches, revisions, references"],
    ['        _RESTORE cAdtree.html', 'restores files or a revision (use Chrome or Edge)'],
    ['        working/', ''],
    ['          main/', "Main's latest files: ordinary CAD folders and files"],
    ['          <Design case>/', "one design case's latest files, apart from Main"],
    ['        vault/', 'the saved history (never change anything in here)'],
    ['          objects/<xx>/<sha256>.bin', 'every saved file, stored under its SHA-256 checksum'],
    ['          revisions/<id>.txt', 'one revision in full: files, sizes, checksums, notes'],
    ['          revisions/<id>.manifest.json', 'the same revision as a record'],
    ['        .cadtree/', 'records tying the project and its cases to folders'],
  ];
  for (const [path, what] of tree) doc.line(treeLine(path, what), 2);
  doc.line().para(
    'Folder names are the readable names chosen in cAdtree. cAdtree identifies workspaces and projects by IDs stored ' +
      'in their records, not by their folder names. Each project also has its own short guide: the Map (_MAP ' +
      'cAdtree.txt) lists its branches, every revision and its references, and repeats how to recover without cAdtree. ' +
      'The restore page (_RESTORE cAdtree.html) does the recovery for you in a web browser.',
  );

  doc.heading('4. Get your latest files');
  steps(doc, 'Copy the working folders', [
    "Find the project's folder in _INDEX cAdtree.txt and open it.",
    "Copy the folder working/main (Main's latest files) to a safe place outside this home. A design case has its " +
      'own folder under working/ with its own latest files: copy the ones you need as well.',
    'Open the copy in your CAD program. These are normal CAD files and folders.',
  ]);
  doc.line().para(
    'The working folders hold the files as you last left them, including edits that were not yet saved as a ' +
      'revision. Copy the whole folder, not single files: assemblies and drawings find their parts by name and ' +
      'relative path. To get the exact state of a saved revision instead, or if the working folders are damaged or ' +
      'gone, use the restore page described in section 5.',
  );

  doc.heading('5. Get an older revision, or single files back');
  doc.para(
    'The easiest way is the restore page. Open the project folder and double-click _RESTORE cAdtree.html: it opens in ' +
      'your web browser, needs no internet and installs nothing. It has two parts. "Rebuild a whole revision" (Google ' +
      "Chrome or Microsoft Edge on a computer) asks for the project's vault folder, lists the saved revisions, asks for " +
      'a new empty folder outside the vault and rebuilds every folder and file under its original name, checking every ' +
      'checksum. "Restore single files" works in any modern browser: drag a file from vault/objects onto the page and it ' +
      'saves a copy under its original name. A web page cannot open a folder from a typed path, so choose or drag the ' +
      'folder or file instead. If the page disagrees with the vault, the vault is correct.',
  );
  steps(doc, 'Rebuild a revision by hand (if the restore page is not available)', [
    'On Windows, turn on View → Show → File name extensions in File Explorer first; the renamed copy must not end in .bin.',
    "Open the project's Map, _MAP cAdtree.txt. Under REVISIONS, find the revision by its number, date and summary. " +
      "Revision numbers count across the whole project and all of its design cases, so one branch's revisions can skip numbers. Each " +
      'revision names its branch (Main or a design case).',
    'Open the listing named under that revision: vault/revisions/<revision ID>.txt. It lists every folder and ' +
      'every file of the revision with its path, size, SHA-256 checksum and the object file that holds its bytes ' +
      '(vault/objects/<first two characters of the checksum>/<checksum>.bin).',
    'Make a new, empty folder outside the vault. Create every folder in the listing, including empty ones. For each ' +
      'file, copy its object file into the right folder and rename the copy to the file name in the listing. Work on ' +
      'copies only: never rename or move anything inside the vault.',
    'Rebuild the whole folder tree of the revision, not single files: assemblies and drawings find their parts by ' +
      'name and relative path.',
    {
      text: 'Check each file against its listed checksum. The two results must be identical:',
      lines: ['Windows:  certutil -hashfile "<file>" SHA256', 'Mac:      shasum -a 256 "<file>"'],
    },
    'If a result differs from the listed checksum, do not use that file. A matching checksum shows that the file ' +
      'holds exactly the bytes that were saved. It does not show that the design is correct, or that your CAD ' +
      'program will find every reference: open the assembly and check it.',
  ]);
  doc.line().para(
    'If a listing is missing, the same information is in vault/revisions/<revision ID>.manifest.json (see section 9). ' +
      'Only a revision that also has vault/completed/<revision ID>.done.json is complete.',
  );

  doc.heading('6. Notes and references');
  doc.para(
    "Engineering notes: each revision's listing shows its summary, then its NOTES (Problem, Modification, " +
      'Observations) and NOTES ON INDIVIDUAL FILES. The Map shows a one-line summary of every revision.',
  );
  doc.line().para(
    "Reference documents: the Map's REFERENCES section lists every reference document with its original file name " +
      'and the object file that holds it. Each revision listing has a section REFERENCES CAPTURED WITH THIS REVISION ' +
      'with the explanation that was written for it. Reference files are stored under their checksum like every ' +
      'other saved file, so drag the object file onto the restore page, or copy it and rename the copy to its recorded ' +
      'original file name (with Windows file name extensions turned on). A checksum ' +
      'shows that a reference file is the one that was saved; it does not show that what the document says is right.',
  );

  doc.heading('7. Rules');
  doc.para(
    'Never edit, move, rename or delete anything inside a vault folder or a .cadtree folder (or .cadtree-home). Copy ' +
      'out first and work on the copy.',
    0,
    '- ',
  );
  doc.para(
    'The guide files (_README, _INDEX, _MAP, _RESTORE and the revision listings) are generated by cAdtree. If one disagrees with ' +
      'the records in the vault, the vault is correct. Edits you make to a guide file are overwritten.',
    0,
    '- ',
  );
  doc.para(
    'Deleting guide files is harmless: cAdtree writes them again the next time it updates this home or project. ' +
      'cAdtree never uses them to make decisions.',
    0,
    '- ',
  );
  doc.para(
    'The date at the top of a guide file shows when it was written. A guide file can be out of date if cAdtree could ' +
      'not write it, for example when the disk was full.',
    0,
    '- ',
  );

  doc.heading('8. Short tutorials (when cAdtree is available)');
  doc.para(
    'Open cAdtree in Google Chrome or Microsoft Edge and open your Cadtree home, then the workspace and the project. ' +
      'Button names are shown as they appear on screen.',
  );
  steps(doc, 'Save a revision', [
    'Close your CAD documents, then choose Changes on the left. cAdtree checks your files by itself and lists what changed.',
    'Check the changed files. Enter a Revision summary (required). Optionally choose + Add a description ' +
      '(with More detail for Why and What you noticed) or + Attach reference files.',
    'Choose Save revision. The new revision appears in History.',
  ]);
  steps(doc, 'Create a design case', [
    'Choose History and select the saved revision to start from.',
    'Choose Create design case from this revision.',
    'Enter a Case name and an Engineering reason, then choose Create design case.',
    'cAdtree makes a new folder for the case under working/ with every file of that revision. Open that folder in ' +
      'your CAD program. To work on the case, select it under the project in the Explorer.',
  ]);
  steps(doc, 'Bring an older revision back onto a branch (Bring back)', [
    'Save any unsaved working changes as a revision first (they block Bring back). Select the branch in the Explorer ' +
      'so that it is the active branch.',
    "In History, select an earlier revision from that branch's history (for a design case this includes the Main revisions " +
      'before the case started) and choose Bring back onto <branch>… (for example ' +
      '"Bring back onto Main…").',
    'The dialog "Make <branch> match <revision>" lists every difference, all selected. Deselect any you do not ' +
      'want, enter the Engineering reason for bringing this back, and choose Prepare bring-back.',
    'Close your CAD documents, tick the confirmation, and choose Bring back confirmed changes.',
    'Only the working files change. Check them in your CAD program, then choose Changes and Save ' +
      'revision. History shows the revision as brought back.',
  ]);
  steps(doc, 'Merge a design case (Apply)', [
    'Select the branch that should receive the changes (for example Main) in the Explorer, so it is the active branch.',
    'In History, select a revision of the design case and choose Review changes to apply.',
    'Nothing is selected at first: choose the changes to apply. For a file changed on both sides, choose Keep ' +
      'destination, Use source state or Leave unresolved. Enter the Engineering reason for proposed application.',
    'Choose Prepare application, tick the confirmation checkbox (it confirms that your CAD documents are closed and the ' +
      'destination is right), and choose Apply confirmed changes.',
    'Only the working files change. Check them in your CAD program, then choose Changes and Save revision. The design ' +
      'case is not deleted.',
  ]);
  steps(doc, 'Export a copy', [
    'In History, select the revision you want to look at or share.',
    'Choose Export a copy, then Complete project or Selected files.',
    'Choose Choose folder… and pick the folder that will hold the copy. Leave Include references ticked to also copy ' +
      'the revision\'s reference attachments.',
    'Choose Export a copy. cAdtree writes a verified copy of the saved files into a new folder named ' +
      '<Project> - <Branch> - R<nn>; reference attachments go into a References folder inside it. Nothing in your ' +
      'project changes.',
  ]);
  steps(doc, 'Hide a design case', [
    'Choose History. The Design cases panel lists each case.',
    'Choose Hide case next to the case. Main cannot be hidden. If you are working on that case, cAdtree switches you ' +
      'to Main. If the case has unsaved changes, cAdtree tells you how many; they stay in its folder.',
    'Choose Hide case to confirm. The working folder and all saved history stay in place. To use the case again, ' +
      'turn on Show hidden cases and choose Unhide.',
  ]);

  doc.heading('9. Storage format reference (for anyone writing a recovery tool)');
  doc.para(
    'All records are UTF-8 JSON files. Paths are relative to the folder named in each heading. Fields that are not ' +
      'listed can be ignored. Most records carry a checksum field (payloadSha256, checksum or similar): a tool that ' +
      'only reads can ignore it, but must never write to these records.',
  );
  doc.line().para(
    'IDs of revisions, design cases (every branch except Main), references and reference versions look like ' +
      'YYYYMMDD-HHMMSS-xxxxxx: the UTC time, then six random lowercase letters or digits. Never infer order from an ID: ' +
      'the order of revisions comes from parentRevisionId links and the recorded times. Main is always branch-main. ' +
      'Home, workspace, registration, project and component IDs are UUIDs with a prefix (home-, workspace-, ' +
      'registration-, proj-, component-). Apply operations are named YYYYMMDD-HHMMSS.',
  );

  const record = (path: string, intro: string, fields: string[] = []): void => {
    doc.line().line(path);
    doc.para(intro, 4);
    for (const field of fields) doc.para(field, 8, '- ');
  };

  doc.heading('Home folder', '-');
  record('.cadtree-home.json', 'The home.', ['homeId, name, createdAt']);
  record(
    '.cadtree-home/workspaces/<registrationId>.json',
    'One workspace registered in this home. It counts only when <registrationId>.ready.json exists next to it.',
    [
      'registrationId, workspaceId, homeId, name, createdAt',
      'directory: the workspace folder, directly inside the home',
      'operation: "create", or "adoption" for a workspace brought in from elsewhere',
      '.ready.json: registrationId and recordSha256 (the SHA-256 of the registration file)',
    ],
  );

  doc.heading('Workspace folder (<Workspace>/)', '-');
  record('.cadtree-workspace.json', 'The workspace.', ['workspaceId, name, createdAt']);
  record('projects/<Project>/.cadtree/project.json', 'The project and where it lives.', [
    'projectId, workspaceId, name, createdAt',
    'containerPath and vaultPath: informational; the folders are found by the IDs inside the records',
    'origin: "create", "import" or "adoption"',
    'ready.json (same folder): marks the project as published',
  ]);
  record('projects/<Project>/.cadtree/branches/<branchId>.json', 'Where one branch keeps its working files.', [
    'branchId, projectId, workspaceId, createdAt',
    'workingPath: only its last part, the folder name under working/, is used',
  ]);

  doc.heading('Vault folder (projects/<Project>/vault/)', '-');
  record('project.json', 'The project.', ['projectId, name, createdAt']);
  record(
    'branches/branch-main.json and branches/<branchId>.branch.json',
    'One branch: Main, or a design case. A design case counts only when <branchId>.ready.json exists too; Main has no marker.',
    [
      'branchId, projectId, name, reason, createdAt, isMain',
      'older design cases may instead be stored as <branchId>.json with no ready marker, like Main',
      'startingRevisionId: the revision a design case started from (null for Main)',
      '.ready.json: branchId, projectId and recordSha256 (the SHA-256 of the branch record)',
    ],
  );
  record('revisions/<revisionId>.manifest.json', 'One saved revision.', [
    'revisionId, projectId, branchId, displayNumber (the project-wide revision number)',
    'parentRevisionId: the revision it follows (null for the first one); this link, not the ID, gives the order',
    'captureStartedAt, captureCompletedAt, summary',
    'notes: problem, modification, observations',
    'fileNotes: a list of path, problem, modification, observations',
    "directories: every folder of the revision, relative to the revision's top folder (this includes empty folders)",
    'files: a list of path, size, sha256, lastModified; the bytes are in objects/<first two characters of sha256>/<sha256>.bin',
  ]);
  record('completed/<revisionId>.done.json', 'Proof that the revision was saved completely.', [
    'revisionId, branchId, displayNumber, projectId, completedAt, manifestSha256',
    'A revision counts only when this file exists; a manifest without one is an unfinished save and must be ignored.',
  ]);
  record('objects/<xx>/<sha256>.bin', 'The exact bytes of one saved file or reference document.', [
    'xx is the first two hexadecimal characters of the SHA-256 of the bytes, which is also the file name',
    'content-addressed: one object serves every revision and reference that has the same bytes',
  ]);
  record('references/catalogs/<catalogId>.json', 'The reference documents known at some point.', [
    'A catalog counts only once its publication marker exists: a folder named <catalogId>.<code>.done in ' +
      'references/completed/ (the code is a short form of the catalog file\'s checksum).',
    'catalogId, parent: {catalogId, sha256} of the previous catalog, or null for the first catalog',
    'The current catalog is the last one in the chain of parents (no other catalog names it as its parent).',
    'references: a list of referenceId, title, description, tags, removed, projectVersionId and versions',
    'each version: versionId, originalFilename, fileType, size, sha256 (its object), importedAt',
  ]);
  record('references/contexts/<revisionId>.json', 'Which references applied to one revision, and why.', [
    'revisionId, branchId, catalogId and catalogSha256 (the catalog in force for it; null when there is none)',
    'links: a list of referenceId, versionId, origin ("project" for a project-wide reference, "revision" for one ' +
      'added for this revision), locator, explanation, componentPath',
  ]);
  record('case-lifecycle/<branchId>.<sequence>.json', 'The history of a design case being hidden or unhidden.', [
    'branchId, sequence (1, 2, ...; the file name carries it as six digits: <branchId>.000001.json), status ("active", ' +
      'or "archived", which means hidden), changedAt, previousSha256, unsavedAtHide (hide records: how many unsaved ' +
      'changes stayed in the case\'s folder)',
    'The record with the highest sequence is current. A case without records is active.',
  ]);
  record('applications/<branchId>/<operationId>/', 'One Apply operation (a merge, or Bring back) onto a branch.', [
    'plan.json: operationId, createdAt, sourceBranchId, review (mode "merge" or "revert", where "revert" is Bring ' +
      'back; sourceRevisionId, destinationBranchId, reason), plan (the file actions)',
    'events/<number>.json: what happened, in order (kind, at); before/ and source/ hold numbered backups of files',
  ]);
  record('components/ and references/enrollment/', 'Bookkeeping about file identity across renames and about the reference library.', [
    'components/revisions/<revisionId>.json: files, a list of path and componentId (a stable ID for each file)',
    'A recovery tool can ignore these, cache/index.json (a convenience summary) and staging/ (unfinished work).',
  ]);
  return doc.text();
}

// ---------------------------------------------------------------------------
// Home Index
// ---------------------------------------------------------------------------

export interface HomeIndexInput {
  generatedAt: string;
  /** The home's name from its identity record. */
  homeName: string;
  /** Workspaces as `openHome` reports them. */
  workspaces: HomeWorkspaceEntry[];
}

const byNameThenFolder = (a: { name: string; folder: string }, b: { name: string; folder: string }): number =>
  compare(a.name.toLowerCase(), b.name.toLowerCase()) || compare(a.name, b.name) || compare(a.folder, b.folder);

/**
 * Text of `_INDEX cAdtree.txt` at the home root. Pure and deterministic. Lists workspaces and projects only (no
 * revisions), so it changes only when a workspace or project is added or changes state.
 */
export function buildHomeIndex(input: HomeIndexInput): string {
  const doc = header('home index', `Generated: ${input.generatedAt}`);
  doc.line();
  doc.kv('Home', input.homeName);
  doc.line('Paths in this file are relative to the home folder (the folder that contains this file).');
  doc.line('How to recover files without cAdtree: see "_README cAdtree.txt" in this folder.');

  const workspaces = input.workspaces
    .map((entry) => ({ entry, name: oneLine(entry.name), folder: entry.directory ?? '' }))
    .sort((a, b) => byNameThenFolder(a, b) || compare(a.entry.key, b.entry.key));
  doc.section(`WORKSPACES (${workspaces.length})`);
  if (!workspaces.length) doc.line('No workspaces yet.', 4);
  for (const { entry, name, folder } of workspaces) {
    doc.line();
    doc.line(name, 4);
    doc.kv('Folder', entry.directory ?? 'not found', 8);
    if (entry.workspaceId) doc.kv('Workspace ID', entry.workspaceId, 8);
    if (entry.recordedDirectory && entry.recordedDirectory !== entry.directory) {
      doc.kv('Registered as', `${entry.recordedDirectory} (the folder was renamed or moved)`, 8);
    }
    if (entry.status !== 'ready') {
      doc.kv('Status', entry.status, 8);
      for (const issue of entry.issues) doc.line(issue, 12);
    }
    const state = entry.workspace;
    if (!state) {
      doc.kv('Projects', 'not listed (this workspace could not be opened)', 8);
      continue;
    }
    const projects = state.projects
      .map((project) => ({
        project,
        name: oneLine(project.name),
        folder: `${folder}/projects/${project.containerPath.split('/').pop() ?? ''}`,
      }))
      .sort((a, b) => byNameThenFolder(a, b) || compare(a.project.containerPath, b.project.containerPath));
    doc.kv('Projects', projects.length ? String(projects.length) : 'none', 8);
    for (const { project, name: projectName, folder: projectFolder } of projects) {
      doc.line(projectName, 12);
      doc.kv('Folder', projectFolder, 16);
      doc.kv('Map', `${projectFolder}/${PROJECT_MAP_FILENAME}`, 16);
      if (project.projectId) doc.kv('Project ID', project.projectId, 16);
      if (project.status !== 'ready') {
        doc.kv('Status', `${project.status} (the Map may be missing or out of date)`, 16);
        for (const issue of project.issues) doc.line(issue, 20);
      }
    }
  }
  return doc.text();
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface GuideRefreshResult {
  status: 'written' | 'partial' | 'skipped';
  /** Why nothing was written (status 'skipped' only). */
  reason?: string;
  /** Paths relative to the folder that was refreshed (the project folder, or the home folder) that were written and read back correctly. */
  written: string[];
  failed: { path: string; error: string }[];
}

export interface GuideRefreshOptions {
  /** Test seam for the Map's Generated time. */
  now?: () => Date;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function skip(containerPath: string, reason: string): GuideRefreshResult {
  console.warn(`cAdtree offline guide: skipped ${containerPath}: ${reason}`);
  return { status: 'skipped', reason, written: [], failed: [] };
}

/**
 * Why a project must not be written to, or undefined when it may be. This is the app's own rule: the workspace
 * scan decides (openWorkspace marks copies that share a project ID, and only those that open cleanly, as
 * 'duplicate'), and only a 'ready' project with no issues is writable.
 */
async function unwritableReason(root: FileSystemDirectoryAdapter, containerPath: string): Promise<string | undefined> {
  const entry = (await openWorkspace(root)).projects.find((candidate) => candidate.containerPath === containerPath);
  if (!entry) return 'The project folder was not found in the workspace.';
  if (entry.status !== 'ready') return `The project is read-only (${entry.status}). ${entry.issues.join(' ')}`.trim();
  return undefined;
}

async function writeChecked(dir: FileSystemDirectoryAdapter, path: string[], text: string): Promise<void> {
  await dir.writeFileText(path, text);
  if ((await dir.readFileText(path)) !== text) throw new Error('Read-back did not match what was written.');
}

/**
 * Brings a project's Map and revision listings up to date. Call it after an operation has finished and released
 * its locks (it takes the project writer lock itself). Never throws: problems are returned and logged with
 * console.warn. Skips projects that are read-only, duplicated or damaged. Listings are written only when
 * missing or different, so a correct listing is never rewritten; the Map is rewritten every time.
 */
export async function refreshProjectGuide(
  workspaceRoot: FileSystemDirectoryAdapter,
  containerPath: string,
  options: GuideRefreshOptions = {},
): Promise<GuideRefreshResult> {
  try {
    if ((await workspaceRoot.queryPermission('readwrite')) !== 'granted') return skip(containerPath, 'The workspace is not writable.');
    const blocked = await unwritableReason(workspaceRoot, containerPath);
    if (blocked) return skip(containerPath, blocked);
    const lockedId = (await resolveManagedProject(workspaceRoot, containerPath)).record.projectId;
    return await withProjectWriterLock(lockedId, async () => {
      // Read again under the lock: an operation that held it may have changed the project meanwhile.
      const project = await resolveManagedProject(workspaceRoot, containerPath);
      if (project.record.projectId !== lockedId) return skip(containerPath, 'The folder now holds a different project.');
      if (!project.ready || project.issues.length) {
        return skip(containerPath, `The project is read-only. ${project.issues.join(' ') || 'It is not published.'}`.trim());
      }
      return writeGuide(workspaceRoot, containerPath, project, (options.now?.() ?? new Date()).toISOString());
    });
  } catch (error) {
    const reason = errorText(error);
    console.warn(`cAdtree offline guide: could not refresh ${containerPath}: ${reason}`);
    return { status: 'skipped', reason: `The project could not be read: ${reason}`, written: [], failed: [] };
  }
}

async function writeGuide(
  root: FileSystemDirectoryAdapter,
  containerPath: string,
  project: ManagedProject,
  generatedAt: string,
): Promise<GuideRefreshResult> {
  const result: GuideRefreshResult = { status: 'written', written: [], failed: [] };
  const failedListings: string[] = [];
  const record = (path: string, error: unknown) => {
    result.failed.push({ path, error: errorText(error) });
    console.warn(`cAdtree offline guide: could not write ${path} in ${containerPath}: ${errorText(error)}`);
  };
  try {
    const state = project.vaultState;
    const container = await root.getDirectory(containerPath.split('/'), { create: false });
    for (const revision of orderedRevisions(state)) {
      if (revision.integrityStatus === 'corrupted') continue; // A damaged record can't be described truthfully.
      const path = revisionListingPath(revision.manifest.revisionId);
      const shown = ['vault', ...path].join('/');
      try {
        const text = buildRevisionListing({
          generatedAt: revision.manifest.captureCompletedAt,
          projectName: project.record.name,
          state,
          revision,
        });
        let current: string | undefined;
        try {
          current = (await project.vaultDir.hasFile(path)) ? await project.vaultDir.readFileText(path) : undefined;
        } catch {
          current = undefined;
        }
        if (current === text) continue;
        await writeChecked(project.vaultDir, path, text);
        result.written.push(shown);
      } catch (error) {
        failedListings.push(revision.manifest.revisionId);
        record(shown, error);
      }
    }
    const mapPath = projectMapPath();
    try {
      const leaves = Object.fromEntries(
        Object.entries(project.workingPaths).map(([branchId, path]) => [branchId, path.split('/').pop() ?? '']),
      );
      const text = buildProjectMap({
        generatedAt,
        projectName: project.record.name,
        projectFolder: containerPath.split('/').pop() ?? containerPath,
        state,
        workingLeaves: leaves,
        failedListings,
      });
      await writeChecked(container, mapPath, text);
      result.written.push(mapPath.join('/'));
    } catch (error) {
      record(mapPath.join('/'), error);
    }
    // The restore page sits next to the Map. Like the Index it is rewritten only when it differs apart from its generated time.
    const restorePath = restorePagePath();
    try {
      const html = buildRestorePage({ generatedAt, projectName: project.record.name, state });
      const current = await readIfPresent(container, restorePath);
      if (current === undefined || restorePageWithoutGenerated(current) !== restorePageWithoutGenerated(html)) {
        await writeChecked(container, restorePath, html);
        result.written.push(restorePath.join('/'));
      }
    } catch (error) {
      record(restorePath.join('/'), error);
    }
  } catch (error) {
    record('(offline guide)', error);
  }
  if (result.failed.length) result.status = 'partial';
  return result;
}

// ---------------------------------------------------------------------------
// Home writer
// ---------------------------------------------------------------------------

/** The Index is compared without its Generated line, so an unchanged Index is never rewritten just for a new time. */
const withoutGenerated = (text: string): string => text.replace(/^Generated: .*$/m, '');

async function readIfPresent(dir: FileSystemDirectoryAdapter, path: string[]): Promise<string | undefined> {
  try {
    return (await dir.hasFile(path)) ? await dir.readFileText(path) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Brings the home's Readme and Index up to date. Call it after an operation has finished and released its locks
 * (it takes the home writer lock itself). Never throws: problems are returned and logged with console.warn.
 * Skips (no writes) when the home can't be written or opened, or its identity is invalid. Writes only at the home
 * root, and only when needed: the Readme when it is missing or different, the Index when it is missing or
 * different apart from its Generated line.
 */
export async function refreshHomeGuide(
  homeRoot: FileSystemDirectoryAdapter,
  options: GuideRefreshOptions = {},
): Promise<GuideRefreshResult> {
  try {
    if ((await homeRoot.queryPermission('readwrite')) !== 'granted') return skip('home', 'The home is not writable.');
    // Only the ID is needed to take the lock; openHome below validates the whole identity record under it.
    const homeId: unknown = JSON.parse(await homeRoot.readFileText(['.cadtree-home.json']))?.homeId;
    if (typeof homeId !== 'string' || !homeId.trim()) return skip('home', 'The home identity is not valid.');
    return await withProjectWriterLock(`home:${homeId}`, async () => {
      const home = await openHome(homeRoot);
      if (home.identity.homeId !== homeId) return skip('home', 'The home identity changed while waiting.');
      return writeHomeGuide(homeRoot, home.identity.name, home.workspaces, (options.now?.() ?? new Date()).toISOString());
    });
  } catch (error) {
    const reason = errorText(error);
    console.warn(`cAdtree offline guide: could not refresh the home guide: ${reason}`);
    return { status: 'skipped', reason: `The home could not be read: ${reason}`, written: [], failed: [] };
  }
}

async function writeHomeGuide(
  root: FileSystemDirectoryAdapter,
  homeName: string,
  workspaces: HomeWorkspaceEntry[],
  generatedAt: string,
): Promise<GuideRefreshResult> {
  const result: GuideRefreshResult = { status: 'written', written: [], failed: [] };
  const files: { path: string[]; text: string; same: (current: string, text: string) => boolean }[] = [
    { path: homeReadmePath(), text: buildHomeReadme({ homeName }), same: (current, text) => current === text },
    {
      path: homeIndexPath(),
      text: buildHomeIndex({ generatedAt, homeName, workspaces }),
      same: (current, text) => withoutGenerated(current) === withoutGenerated(text),
    },
  ];
  for (const file of files) {
    const shown = file.path.join('/');
    try {
      const current = await readIfPresent(root, file.path);
      if (current !== undefined && file.same(current, file.text)) continue;
      await writeChecked(root, file.path, file.text);
      result.written.push(shown);
    } catch (error) {
      result.failed.push({ path: shown, error: errorText(error) });
      console.warn(`cAdtree offline guide: could not write ${shown} in the home folder: ${errorText(error)}`);
    }
  }
  if (result.failed.length) result.status = 'partial';
  return result;
}
