/**
 * Path budget (pure). Used by the engine checks before the first write
 * (workspace-service, home-service) and by the UI hints (src/utils/path-budget-message.ts).
 *
 * One standard on every platform: warn from 200 and block above 240 characters
 * of full absolute path (JavaScript string length, i.e. UTF-16 units). A single
 * name is limited to MAX_NAME_BYTES UTF-8 bytes (see folder-names.ts). Chrome
 * writes a file through a sibling `<name>.crswap`, so a written FILE path needs
 * CRSWAP_CHARS more characters than the file path itself.
 *
 * INTERNAL_PATH_TEMPLATES lists every path cAdtree itself writes below a project
 * folder, other than the user's working files. Lengths are measured from
 * today's real path builders and ID formats, using maximum-length sample IDs.
 * path-budget.test.ts drives a real workflow and fails if a path appears that is
 * not listed here, so a new builder cannot sneak in unnoticed.
 */
import { MAX_NAME_BYTES } from './folder-names';
import type { FileSystemDirectoryAdapter } from './fs-adapter';
import {
  applicationEventPath, applicationPlanPath, applicationStagedPath, applicationUnexpectedPath,
} from './application-records';
import { getObjectPathSegments, getStagingObjectPathSegments, getStagingSessionPathSegments } from './object-store';
import { lifecyclePath } from './case-lifecycle';
import { branchAttemptPath, branchReadyPath, branchRecordPath } from './branch-service';
import { revisionCompletionPath, revisionManifestPath } from './revision-service';
import { componentRecordPath } from './component-identity';
import {
  referenceCatalogMarkerPath, referenceCatalogPath, referenceContextPath, referenceEnrollmentMarkerPath,
  referenceEnrollmentRecordPath,
} from './references';
import { knowledgePublicationPath, knowledgeRecordPath } from '../knowledge/records/store';

export { MAX_NAME_BYTES };

export const WARN_PATH_CHARS = 200;
export const BLOCK_PATH_CHARS = 240;
/** Extra characters of the sibling `.crswap` file Chrome uses when writing a file. */
export const CRSWAP_CHARS = 7;
/** Future design-case folder name length reserved when sizing a project. */
export const CASE_ALLOWANCE = 32;
/** Future project name length reserved when creating a workspace. */
export const PROJECT_NAME_ALLOWANCE = 24;
/** Future workspace folder name length reserved when sizing a home. */
export const WORKSPACE_NAME_ALLOWANCE = 24;

export type PathLengthClass = 'ok' | 'warn' | 'block';

function assertLength(value: number, what: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid ${what}: expected a non-negative safe integer length, got ${String(value)}.`);
}

/** Throws on NaN, negative, fractional or non-safe-integer input; it never guesses 'ok'. */
export function classifyPathLength(length: number): PathLengthClass {
  assertLength(length, 'path length');
  if (length > BLOCK_PATH_CHARS) return 'block';
  if (length >= WARN_PATH_CHARS) return 'warn';
  return 'ok';
}

export interface InternalPathTemplate {
  label: string;
  kind: 'file' | 'dir';
  /** Maximum-length sample, relative to the project folder, built by the real builders. */
  segments: string[];
  /** Same path with `{token}` placeholders; the drift test matches real paths against it. */
  shape: string;
  /** Length of `segments` joined by "/", without the `.crswap` allowance. */
  relativeLength: number;
  /** relativeLength plus CRSWAP_CHARS for files. */
  reserveLength: number;
}

const SHA = 'a'.repeat(64);
/** New design cases: `YYYYMMDD-HHMMSS-xxxxxx` (22 chars). */
const CASE_ID = '20260101-000000-abcdef';
/** Longest event ID: `YYYYMMDD-HHMMSS-999`. */
const EVENT = '20260101-000000-999';
/** Revisions and knowledge records use the record ID format. */
const REV = CASE_ID;
const SEQ = 999999;
const V = 'vault';

/** Placeholders usable in `shape`, each with the regular expression a real value must match. */
export const PATH_TOKENS: Record<string, string> = {
  caseId: '[0-9]{8}-[0-9]{6}-[0-9a-z]{6}|branch-main',
  event: '[0-9]{8}-[0-9]{6}(?:-[0-9]{1,3})?',
  rev: '[0-9]{8}-[0-9]{6}-[0-9a-z]{6}',
  recordId: '[0-9]{8}-[0-9]{6}-[0-9a-z]{6}',
  sha: '[0-9a-f]{64}',
  sha2: '[0-9a-f]{2}',
  b64: '[A-Za-z0-9_-]{43}',
  b64uuid: '[A-Za-z0-9_-]{22}',
  seq: '[0-9]{6}',
  uuid: '[0-9a-f-]{36}',
  leaf: '[^/]+',
};

const below = (prefix: string, segments: string[]) => [prefix, ...segments];

function template(label: string, kind: 'file' | 'dir', segments: string[], shape: string): InternalPathTemplate {
  const relativeLength = segments.join('/').length;
  return { label, kind, segments, shape, relativeLength, reserveLength: relativeLength + (kind === 'file' ? CRSWAP_CHARS : 0) };
}

/** Written into the case folder when creation fails (same name as RECOVERY_MARKER_FILENAME in recovery-service). */
const CASE_INCOMPLETE_MARKER = '_CADTREE_RECOVERY_INCOMPLETE.txt';

const stagingSession = getStagingSessionPathSegments('sample-session');

/**
 * Current ID formats only (ids.ts record and event IDs). Old formats are not supported and not covered.
 */
export const INTERNAL_PATH_TEMPLATES: readonly InternalPathTemplate[] = [
  // Project folder, outside the vault.
  template('project record', 'file', ['.cadtree', 'project.json'], '.cadtree/project.json'),
  template('project ready marker', 'file', ['.cadtree', 'ready.json'], '.cadtree/ready.json'),
  template('project creation attempt', 'file', ['.cadtree', 'attempt.json'], '.cadtree/attempt.json'),
  template('branch location record', 'file', ['.cadtree', 'branches', `${CASE_ID}.json`], '.cadtree/branches/{caseId}.json'),
  template('main working folder', 'dir', ['working', 'main'], 'working/main'),
  template('design case working folder (name allowance)', 'dir', ['working', 'x'.repeat(CASE_ALLOWANCE)], 'working/{leaf}'),
  // Incomplete marker written into a design-case working folder when case creation fails.
  template('design case incomplete marker', 'file', ['working', 'x'.repeat(CASE_ALLOWANCE), CASE_INCOMPLETE_MARKER], 'working/{leaf}/_CADTREE_RECOVERY_INCOMPLETE.txt'),
  // Vault core.
  template('vault project record', 'file', [V, 'project.json'], 'vault/project.json'),
  template('vault main branch record', 'file', [V, 'branches', 'branch-main.json'], 'vault/branches/branch-main.json'),
  template('vault branch record', 'file', below(V, branchRecordPath(CASE_ID)), 'vault/branches/{caseId}.branch.json'),
  template('vault branch ready marker', 'file', below(V, branchReadyPath(CASE_ID)), 'vault/branches/{caseId}.ready.json'),
  template('vault revision manifest', 'file', below(V, revisionManifestPath(REV)), 'vault/revisions/{rev}.manifest.json'),
  template('vault revision completion marker', 'file', below(V, revisionCompletionPath(REV)), 'vault/completed/{recordId}.done.json'),
  template('vault cache index', 'file', [V, 'cache', 'index.json'], 'vault/cache/index.json'),
  template('vault content object', 'file', below(V, getObjectPathSegments(SHA)), 'vault/objects/{sha2}/{sha}.bin'),
  template('vault staged object', 'file', below(V, getStagingObjectPathSegments('sample-session', SHA)), 'vault/staging/{b64uuid}/{b64}.tmp'),
  template('vault staging session folder', 'dir', below(V, stagingSession), 'vault/staging/{b64uuid}'),
  template('vault branch attempt', 'file', below(V, branchAttemptPath(CASE_ID)), 'vault/staging/{caseId}.branch-attempt.json'),
  // Component identity.
  template('component boundary', 'file', [V, 'components', 'boundary.json'], 'vault/components/boundary.json'),
  template('component ready marker', 'file', [V, 'components', 'ready.json'], 'vault/components/ready.json'),
  template('component revision record', 'file', below(V, componentRecordPath(REV)), 'vault/components/revisions/{rev}.json'),
  // Case lifecycle.
  template('case lifecycle record', 'file', below(V, lifecyclePath(CASE_ID, SEQ)), 'vault/case-lifecycle/{caseId}.{seq}.json'),
  // References.
  template('reference enrollment record', 'file', below(V, referenceEnrollmentRecordPath(CASE_ID)), 'vault/references/enrollment/{recordId}.json'),
  template('reference enrollment marker', 'dir', below(V, referenceEnrollmentMarkerPath(CASE_ID, SHA)), 'vault/references/enrollment/{recordId}.{b64}.done'),
  template('reference catalog', 'file', below(V, referenceCatalogPath(CASE_ID)), 'vault/references/catalogs/{recordId}.json'),
  template('reference catalog marker', 'dir', below(V, referenceCatalogMarkerPath(CASE_ID, SHA)), 'vault/references/completed/{recordId}.{b64}.done'),
  template('reference context', 'file', below(V, referenceContextPath(REV)), 'vault/references/contexts/{rev}.json'),
  // Application (apply) evidence, keyed by event IDs.
  template('application plan', 'file', below(V, applicationPlanPath(CASE_ID, EVENT)), 'vault/applications/{caseId}/{event}/plan.json'),
  template('application event', 'file', below(V, applicationEventPath(CASE_ID, EVENT, SEQ)), 'vault/applications/{caseId}/{event}/events/{seq}.json'),
  template('application before-state copy', 'file', below(V, applicationStagedPath(CASE_ID, EVENT, 'before', SEQ)), 'vault/applications/{caseId}/{event}/before/{seq}.bin'),
  template('application source copy', 'file', below(V, applicationStagedPath(CASE_ID, EVENT, 'source', SEQ)), 'vault/applications/{caseId}/{event}/source/{seq}.bin'),
  template('application unexpected-recovery copy', 'file', below(V, applicationUnexpectedPath(CASE_ID, EVENT, EVENT, SEQ)), 'vault/applications/{caseId}/{event}/unexpected/{event}/{seq}.bin'),
  // Knowledge Lab.
  template('knowledge record', 'file', below(V, knowledgeRecordPath(CASE_ID)), 'vault/knowledge/records/{recordId}.json'),
  template('knowledge publication marker', 'dir', below(V, knowledgePublicationPath(CASE_ID, SHA)), 'vault/knowledge/completed/{recordId}.{b64}.done'),
];

const escapeLiteral = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regular expression source for a shape, with each `{token}` replaced by its pattern. */
export function shapePattern(shape: string): RegExp {
  let source = '';
  let rest = shape;
  while (rest.length) {
    const open = rest.indexOf('{');
    if (open < 0) { source += escapeLiteral(rest); break; }
    const close = rest.indexOf('}', open);
    const token = rest.slice(open + 1, close);
    const pattern = PATH_TOKENS[token];
    if (!pattern) throw new Error(`Unknown path token {${token}}.`);
    source += escapeLiteral(rest.slice(0, open)) + `(?:${pattern})`;
    rest = rest.slice(close + 1);
  }
  return new RegExp(`^${source}$`);
}

const compiled = INTERNAL_PATH_TEMPLATES.map((t) => ({ template: t, pattern: shapePattern(t.shape) }));
// Every parent folder of a template is itself a folder cAdtree creates.
const ancestorPatterns = (() => {
  const shapes = new Set<string>();
  for (const t of INTERNAL_PATH_TEMPLATES) {
    const parts = t.shape.split('/');
    for (let i = 1; i < parts.length; i++) shapes.add(parts.slice(0, i).join('/'));
  }
  return [...shapes].map((shape) => ({ shape, pattern: shapePattern(shape) }));
})();

/**
 * Finds the template a project-relative path ("/"-separated) belongs to, or the
 * folder shape when it is a parent folder of one. Returns undefined when unknown.
 */
export function matchInternalPath(relativePath: string, kind: 'file' | 'dir'): string | undefined {
  for (const { template: t, pattern } of compiled) if (t.kind === kind && pattern.test(relativePath)) return t.label;
  if (kind === 'dir') for (const { shape, pattern } of ancestorPatterns) if (pattern.test(relativePath)) return `folder ${shape}`;
  return undefined;
}

export function deepestInternalTemplate(): InternalPathTemplate {
  return INTERNAL_PATH_TEMPLATES.reduce((a, b) => (b.reserveLength > a.reserveLength ? b : a));
}

/**
 * Longest path cAdtree itself writes below a project folder, in characters, including `.crswap` for files.
 *
 * Covers the current ID formats only (ids.ts record and event IDs); see INTERNAL_PATH_TEMPLATES.
 */
export function internalReserve(): number {
  return deepestInternalTemplate().reserveLength;
}

export function internalReserveLabel(): string {
  return deepestInternalTemplate().label;
}

/**
 * Worst-case full path length for a project. A string `projectPath` must be the full ABSOLUTE
 * path of the project folder (its UTF-16 length is used); a number is that length already.
 * Invalid numeric input throws.
 */
export function projectWorstCase(input: { projectPath: string | number; longestUserPath?: number; caseAllowance?: number }): number {
  const projectLength = typeof input.projectPath === 'number' ? input.projectPath : input.projectPath.length;
  const longestUserPath = input.longestUserPath ?? 0;
  const requestedAllowance = input.caseAllowance ?? CASE_ALLOWANCE;
  assertLength(projectLength, 'project path length');
  assertLength(longestUserPath, 'longest user path length');
  assertLength(requestedAllowance, 'case allowance');
  const caseAllowance = Math.max(4, requestedAllowance);
  const internal = projectLength + 1 + internalReserve();
  // "/working/<case>/" before the user's relative path.
  const workingPrefix = '/working/'.length + caseAllowance + 1;
  const user = projectLength + workingPrefix + longestUserPath + CRSWAP_CHARS;
  return Math.max(internal, user);
}

// ---------------------------------------------------------------------------
// Address-aware worst cases and the creation-time check (Item 2 P5)
// ---------------------------------------------------------------------------

export { addressSeparator, joinAddress, PathTooLongError, type PathSeparator } from './path-limits';
import { joinAddress, addressSeparator } from './path-limits';

const withSwap = (path: string) => path + '.crswap';

/**
 * Worst full ABSOLUTE path (as a string; its length is the worst-case length) below a project
 * folder: the longest of cAdtree's own internal path, and, when `longestUserFile` (relative,
 * "/"-separated) is given, that file under a design-case folder. Files carry
 * the `.crswap` allowance. With no user file this equals projectWorstCase().
 */
export function projectWorstPath(input: { projectAddress: string; longestUserFile?: string; longestUserDir?: string; caseAllowance?: number }): string {
  assertLength(input.caseAllowance ?? 0, 'case allowance');
  const caseAllowance = Math.max(4, input.caseAllowance ?? CASE_ALLOWANCE);
  const deepest = deepestInternalTemplate();
  const candidates = [joinAddress(input.projectAddress, ...deepest.segments) + (deepest.kind === 'file' ? '.crswap' : '')];
  if (input.longestUserFile) {
    candidates.push(withSwap(joinAddress(input.projectAddress, 'working', 'x'.repeat(caseAllowance), input.longestUserFile)));
  }
  // Folders get no `.crswap`.
  if (input.longestUserDir) {
    candidates.push(joinAddress(input.projectAddress, 'working', 'x'.repeat(caseAllowance), input.longestUserDir));
  }
  return candidates.reduce((a, b) => (b.length > a.length ? b : a));
}

/** Worst path for a new workspace: workspace address + projects + a project-name allowance + the project worst case. */
export function workspaceWorstPath(workspaceAddress: string): string {
  return projectWorstPath({ projectAddress: joinAddress(workspaceAddress, 'projects', 'p'.repeat(PROJECT_NAME_ALLOWANCE)) });
}

/**
 * Worst path for a new design case: project + working/<final case folder>/<longest of the source files and the
 * incomplete marker written if creation fails> + `.crswap` (the marker is written like any file).
 */
export function caseWorstPath(projectAddress: string, caseFolder: string, longestSourceFile: string, longestSourceDir = ''): string {
  const fileTerm = longestSourceFile.length > CASE_INCOMPLETE_MARKER.length ? longestSourceFile : CASE_INCOMPLETE_MARKER;
  const file = withSwap(joinAddress(projectAddress, 'working', caseFolder, fileTerm));
  const dir = joinAddress(projectAddress, 'working', caseFolder, longestSourceDir);
  return dir.length > file.length ? dir : file;
}

export interface HomeSetupWorstCase {
  worstPath: string;
  requiredLength: number;
  status: PathLengthClass;
}

/**
 * Pure helper for the home setup warning (UI only; the engine never blocks home setup). Uses both
 * Counts: home + a workspace folder of WORKSPACE_NAME_ALLOWANCE + `projects` + a project folder of
 * PROJECT_NAME_ALLOWANCE + the project worst case with no user files, which is cAdtree's own
 * deepest internal path (internalReserve()). The design-case allowance is not a separate term:
 * its `working/<case>/` prefix is shorter than the internal reserve and only matters with user files.
 */
export function homeSetupWorstCase(homeAddress: string): HomeSetupWorstCase {
  const worstPath = workspaceWorstPath(joinAddress(homeAddress, 'w'.repeat(WORKSPACE_NAME_ALLOWANCE)));
  return { worstPath, requiredLength: worstPath.length, status: classifyPathLength(worstPath.length) };
}

/** Which name the user can shorten to get under the limit. */
export type PathBudgetShorten = 'workspace' | 'project' | 'case';

/** What the UI shows after a creation that went ahead. */
export interface PathBudgetReport {
  /** 'unchecked': the home address is unknown, so nothing was measured (never the same as 'ok'). */
  status: 'ok' | 'warn' | 'unchecked';
  /** Worst-case absolute length, 0 when unchecked. */
  requiredLength: number;
  /** The worst absolute path, '' when unchecked. */
  worstPath: string;
}

/** Engine option: the absolute addresses the user told cAdtree about. Both are optional. */
export interface PathBudgetInput {
  /** Absolute address of the Cadtree home (used when creating or bringing in a workspace). */
  homeAddress?: string;
  /** Absolute address of the workspace folder (used for projects and design cases). */
  workspaceAddress?: string;
}

export const UNCHECKED_PATH_BUDGET: PathBudgetReport = Object.freeze({ status: 'unchecked', requiredLength: 0, worstPath: '' });

export class PathBudgetError extends Error {
  readonly limit = BLOCK_PATH_CHARS;
  readonly excess: number;
  constructor(
    readonly requiredLength: number,
    readonly worstPath: string,
    readonly shorten: PathBudgetShorten,
    /** The final folder name that was checked (counter included). */
    readonly checkedName: string,
  ) {
    super(
      `The full path would reach ${requiredLength} characters, ${requiredLength - BLOCK_PATH_CHARS} over the ${BLOCK_PATH_CHARS} limit. ` +
      `Shorten the ${shorten} name "${checkedName}". Nothing was created.`,
    );
    this.name = 'PathBudgetError';
    this.excess = requiredLength - BLOCK_PATH_CHARS;
  }
}

/** Classifies the worst path: throws PathBudgetError above the limit, otherwise reports ok or warn. */
export function checkWorstPath(worstPath: string, shorten: PathBudgetShorten, name: string): PathBudgetReport {
  const requiredLength = worstPath.length;
  const cls = classifyPathLength(requiredLength);
  if (cls === 'block') throw new PathBudgetError(requiredLength, worstPath, shorten, name);
  return { status: cls, requiredLength, worstPath };
}

/** The longest of several worst paths (first wins a tie); undefined for none. */
export function longestPath(paths: string[]): string | undefined {
  return paths.reduce<string | undefined>((a, b) => (a === undefined || b.length > a.length ? b : a), undefined);
}

/** Longest relative file and folder paths ("/"-separated, no `.crswap`); '' when none. */
export interface LongestPaths { file: string; dir: string }

/** Names only: nothing is read or hashed. Skips nothing. */
export async function longestRelativePaths(dir: FileSystemDirectoryAdapter): Promise<LongestPaths> {
  const longest: LongestPaths = { file: '', dir: '' };
  const walk = async (current: FileSystemDirectoryAdapter, prefix: string): Promise<void> => {
    for (const entry of await current.listEntries()) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'file') {
        if (relative.length > longest.file.length) longest.file = relative;
      } else {
        if (relative.length > longest.dir.length) longest.dir = relative;
        await walk(await current.getDirectory([entry.name], { create: false }), relative);
      }
    }
  };
  await walk(dir, '');
  return longest;
}

/** Longest relative FILE path below a folder; '' when it has no files. */
export async function longestRelativeFilePath(dir: FileSystemDirectoryAdapter): Promise<string> {
  return (await longestRelativePaths(dir)).file;
}

/** The longest string of a list ('' for none). */
export const longestOf = (paths: string[]): string => paths.reduce((a, b) => (b.length > a.length ? b : a), '');
