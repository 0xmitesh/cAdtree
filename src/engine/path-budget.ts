/**
 * Path budget foundation (pure; nothing in the app calls it yet).
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
  /** True for shapes new code no longer writes; old records with these shapes can still exist. */
  legacy: boolean;
}

const UUID = '00000000-0000-4000-8000-000000000000';
const SHA = 'a'.repeat(64);
const BRANCH = `branch-${UUID}`;
/** New design cases: `YYYYMMDD-HHMMSS-xxxxxx` (22 chars). */
const CASE_ID = '20260101-000000-abcdef';
const APPLY = `apply-${UUID}`;
const RECOVERY = `recovery-${UUID}`;
/** Longest event ID: `YYYYMMDD-HHMMSS-999`. */
const EVENT = '20260101-000000-999';
const REV = `rev-${UUID}`;
const REFERENCE_CATALOG = `reference-catalog-${UUID}`;
const REFERENCE_ENROLLMENT = `reference-enrollment-${UUID}`;
const KNOWLEDGE = `knowledge-${UUID}`;
const SEQ = 999999;
const V = 'vault';

/** Placeholders usable in `shape`, each with the regular expression a real value must match. */
export const PATH_TOKENS: Record<string, string> = {
  branch: 'branch-[0-9a-f-]{36}',
  anyBranch: '[0-9]{8}-[0-9]{6}-[0-9a-z]{6}|branch-[0-9a-f-]{36}|branch-main',
  caseId: '[0-9]{8}-[0-9]{6}-[0-9a-z]{6}|branch-main',
  apply: 'apply-[0-9a-f-]{36}',
  recovery: 'recovery-[0-9a-f-]{36}',
  event: '[0-9]{8}-[0-9]{6}(?:-[0-9]{1,3})?',
  rev: 'rev-[0-9a-f-]{36}',
  referenceCatalog: 'reference-catalog-[0-9a-f-]{36}',
  referenceEnrollment: 'reference-enrollment-[0-9a-f-]{36}',
  knowledge: 'knowledge-[0-9a-f-]{36}',
  sha: '[0-9a-f]{64}',
  sha2: '[0-9a-f]{2}',
  b64: '[A-Za-z0-9_-]{43}',
  b64uuid: '[A-Za-z0-9_-]{22}',
  seq: '[0-9]{6}',
  uuid: '[0-9a-f-]{36}',
  leaf: '[^/]+',
};

const below = (prefix: string, segments: string[]) => [prefix, ...segments];

function template(label: string, kind: 'file' | 'dir', segments: string[], shape: string, legacy = false): InternalPathTemplate {
  const relativeLength = segments.join('/').length;
  return { label, kind, segments, shape, relativeLength, reserveLength: relativeLength + (kind === 'file' ? CRSWAP_CHARS : 0), legacy };
}

const stagingSession = getStagingSessionPathSegments('sample-session');

/**
 * Maximum lengths assume the CURRENT ID formats (new cases and events use the ids.ts formats;
 * UUID-based case IDs, apply-<uuid> and recovery-<uuid> remain as legacy shapes). Legacy or non-UUID IDs accepted by lenient `safeId` validators may be longer and are
 * not covered.
 */
export const INTERNAL_PATH_TEMPLATES: readonly InternalPathTemplate[] = [
  // Project folder, outside the vault.
  template('project record', 'file', ['.cadtree', 'project.json'], '.cadtree/project.json'),
  template('project ready marker', 'file', ['.cadtree', 'ready.json'], '.cadtree/ready.json'),
  template('project creation attempt', 'file', ['.cadtree', 'attempt.json'], '.cadtree/attempt.json'),
  template('branch location record', 'file', ['.cadtree', 'branches', `${CASE_ID}.json`], '.cadtree/branches/{caseId}.json'),
  template('branch location record (legacy case ID)', 'file', ['.cadtree', 'branches', `${BRANCH}.json`], '.cadtree/branches/{branch}.json', true),
  template('main working folder', 'dir', ['working', 'main'], 'working/main'),
  template('design case working folder (name allowance)', 'dir', ['working', 'x'.repeat(CASE_ALLOWANCE)], 'working/{leaf}'),
  template('recovery copy folder', 'dir', ['recoveries', `copy-${UUID}`], 'recoveries/copy-{uuid}'),
  template('recovery incomplete marker', 'file', ['recoveries', `copy-${UUID}`, '_CADTREE_RECOVERY_INCOMPLETE.txt'], 'recoveries/copy-{uuid}/_CADTREE_RECOVERY_INCOMPLETE.txt'),
  // Vault core.
  template('vault project record', 'file', [V, 'project.json'], 'vault/project.json'),
  template('vault main branch record', 'file', [V, 'branches', 'branch-main.json'], 'vault/branches/branch-main.json'),
  template('vault branch record', 'file', below(V, branchRecordPath(CASE_ID)), 'vault/branches/{caseId}.branch.json'),
  template('vault branch ready marker', 'file', below(V, branchReadyPath(CASE_ID)), 'vault/branches/{caseId}.ready.json'),
  template('vault branch record (legacy case ID)', 'file', below(V, branchRecordPath(BRANCH)), 'vault/branches/{branch}.branch.json', true),
  template('vault branch ready marker (legacy case ID)', 'file', below(V, branchReadyPath(BRANCH)), 'vault/branches/{branch}.ready.json', true),
  template('vault revision manifest', 'file', below(V, revisionManifestPath(REV)), 'vault/revisions/{rev}.manifest.json'),
  template('vault revision completion marker', 'file', below(V, revisionCompletionPath(REV)), 'vault/completed/{rev}.done.json'),
  template('vault cache index', 'file', [V, 'cache', 'index.json'], 'vault/cache/index.json'),
  template('vault content object', 'file', below(V, getObjectPathSegments(SHA)), 'vault/objects/{sha2}/{sha}.bin'),
  template('vault staged object', 'file', below(V, getStagingObjectPathSegments('sample-session', SHA)), 'vault/staging/{b64}/{b64}.tmp'),
  template('vault staging session folder', 'dir', below(V, stagingSession), 'vault/staging/{b64}'),
  template('vault branch attempt', 'file', below(V, branchAttemptPath(CASE_ID)), 'vault/staging/{caseId}.branch-attempt.json'),
  template('vault branch attempt (legacy case ID)', 'file', below(V, branchAttemptPath(BRANCH)), 'vault/staging/{branch}.branch-attempt.json', true),
  // Component identity.
  template('component boundary', 'file', [V, 'components', 'boundary.json'], 'vault/components/boundary.json'),
  template('component ready marker', 'file', [V, 'components', 'ready.json'], 'vault/components/ready.json'),
  template('component revision record', 'file', below(V, componentRecordPath(REV)), 'vault/components/revisions/{rev}.json'),
  // Case lifecycle.
  template('case lifecycle record', 'file', below(V, lifecyclePath(CASE_ID, SEQ)), 'vault/case-lifecycle/{caseId}.{seq}.json'),
  template('case lifecycle record (legacy case ID)', 'file', below(V, lifecyclePath(BRANCH, SEQ)), 'vault/case-lifecycle/{branch}.{seq}.json', true),
  // References.
  template('reference enrollment record', 'file', below(V, referenceEnrollmentRecordPath(REFERENCE_ENROLLMENT)), 'vault/references/enrollment/{referenceEnrollment}.json'),
  template('reference enrollment marker', 'dir', below(V, referenceEnrollmentMarkerPath(REFERENCE_ENROLLMENT, SHA)), 'vault/references/enrollment/{b64uuid}.{b64}.done'),
  template('reference catalog', 'file', below(V, referenceCatalogPath(REFERENCE_CATALOG)), 'vault/references/catalogs/{referenceCatalog}.json'),
  template('reference catalog marker', 'dir', below(V, referenceCatalogMarkerPath(REFERENCE_CATALOG, SHA)), 'vault/references/completed/{b64uuid}.{b64}.done'),
  template('reference context', 'file', below(V, referenceContextPath(REV)), 'vault/references/contexts/{rev}.json'),
  // Application (apply) evidence. New operations use event IDs; apply-<uuid> / recovery-<uuid> remain for old records.
  template('application plan', 'file', below(V, applicationPlanPath(CASE_ID, EVENT)), 'vault/applications/{caseId}/{event}/plan.json'),
  template('application plan (legacy case ID)', 'file', below(V, applicationPlanPath(BRANCH, EVENT)), 'vault/applications/{branch}/{event}/plan.json', true),
  template('application event', 'file', below(V, applicationEventPath(CASE_ID, EVENT, SEQ)), 'vault/applications/{caseId}/{event}/events/{seq}.json'),
  template('application event (legacy case ID)', 'file', below(V, applicationEventPath(BRANCH, EVENT, SEQ)), 'vault/applications/{branch}/{event}/events/{seq}.json', true),
  template('application before-state copy', 'file', below(V, applicationStagedPath(CASE_ID, EVENT, 'before', SEQ)), 'vault/applications/{caseId}/{event}/before/{seq}.bin'),
  template('application before-state copy (legacy case ID)', 'file', below(V, applicationStagedPath(BRANCH, EVENT, 'before', SEQ)), 'vault/applications/{branch}/{event}/before/{seq}.bin', true),
  template('application source copy', 'file', below(V, applicationStagedPath(CASE_ID, EVENT, 'source', SEQ)), 'vault/applications/{caseId}/{event}/source/{seq}.bin'),
  template('application source copy (legacy case ID)', 'file', below(V, applicationStagedPath(BRANCH, EVENT, 'source', SEQ)), 'vault/applications/{branch}/{event}/source/{seq}.bin', true),
  template('application unexpected-recovery copy', 'file', below(V, applicationUnexpectedPath(CASE_ID, EVENT, EVENT, SEQ)), 'vault/applications/{caseId}/{event}/unexpected/{event}/{seq}.bin'),
  template('application unexpected-recovery copy (legacy case ID)', 'file', below(V, applicationUnexpectedPath(BRANCH, EVENT, EVENT, SEQ)), 'vault/applications/{branch}/{event}/unexpected/{event}/{seq}.bin', true),
  template('application plan (legacy)', 'file', below(V, applicationPlanPath(BRANCH, APPLY)), 'vault/applications/{anyBranch}/{apply}/plan.json', true),
  template('application event (legacy)', 'file', below(V, applicationEventPath(BRANCH, APPLY, SEQ)), 'vault/applications/{anyBranch}/{apply}/events/{seq}.json', true),
  template('application before-state copy (legacy)', 'file', below(V, applicationStagedPath(BRANCH, APPLY, 'before', SEQ)), 'vault/applications/{anyBranch}/{apply}/before/{seq}.bin', true),
  template('application source copy (legacy)', 'file', below(V, applicationStagedPath(BRANCH, APPLY, 'source', SEQ)), 'vault/applications/{anyBranch}/{apply}/source/{seq}.bin', true),
  template('application unexpected-recovery copy (legacy)', 'file', below(V, applicationUnexpectedPath(BRANCH, APPLY, RECOVERY, SEQ)), 'vault/applications/{anyBranch}/{apply}/unexpected/{recovery}/{seq}.bin', true),
  template('application unexpected-recovery copy (legacy apply, event recovery)', 'file', below(V, applicationUnexpectedPath(BRANCH, APPLY, EVENT, SEQ)), 'vault/applications/{anyBranch}/{apply}/unexpected/{event}/{seq}.bin', true),
  // Knowledge Lab.
  template('knowledge record', 'file', below(V, knowledgeRecordPath(KNOWLEDGE)), 'vault/knowledge/records/{knowledge}.json'),
  template('knowledge publication marker', 'dir', below(V, knowledgePublicationPath(KNOWLEDGE, SHA)), 'vault/knowledge/completed/{knowledge}.{sha}.done'),
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

const RECOVERY_COPY_TEMPLATE = INTERNAL_PATH_TEMPLATES.find((t) => t.label === 'recovery copy folder')!;

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
 * The reserve covers the CURRENT ID formats: UUID-based IDs (`branch-<uuid>`, `apply-<uuid>`, ...)
 * plus the new ids.ts formats once they are wired. Legacy or non-UUID IDs accepted by the lenient
 * `safeId` validators may be longer and are NOT covered by INTERNAL_PATH_TEMPLATES or this value.
 */
export function internalReserve(): number {
  return deepestInternalTemplate().reserveLength;
}

/**
 * Longest path that NEW records can produce: like internalReserve() but without legacy-only
 * shapes (old apply-<uuid> / recovery-<uuid> records). Old records may still exceed it.
 */
export function newRecordsReserve(): number {
  return deepestNewRecordsTemplate().reserveLength;
}

export function deepestNewRecordsTemplate(): InternalPathTemplate {
  return INTERNAL_PATH_TEMPLATES.filter((t) => !t.legacy).reduce((a, b) => (b.reserveLength > a.reserveLength ? b : a));
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
  // "/recoveries/copy-<uuid>/" for user files restored into a recovery copy. This term goes away
  // when Item 4 removes "Restore copy". Built from the same template constants as the reserve.
  const recoveryPrefix = 1 + RECOVERY_COPY_TEMPLATE.relativeLength + 1;
  const user = projectLength + Math.max(workingPrefix, recoveryPrefix) + longestUserPath + CRSWAP_CHARS;
  return Math.max(internal, user);
}
