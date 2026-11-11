/**
 * User-facing path-budget text and live name-hint maths. Pure: no I/O, no React.
 * The engine (path-budget.ts) decides and blocks; this file only words it and
 * lets dialogs show the same numbers while the user is still typing.
 */
import { folderNameFor } from "../engine/folder-names";
import {
  BLOCK_PATH_CHARS,
  addressSeparator,
  caseWorstPath,
  joinAddress,
  longestOf,
  projectWorstPath,
  workspaceWorstPath,
  PathBudgetError,
  PathTooLongError,
  type PathBudgetReport,
  type PathBudgetShorten,
} from "../engine/path-budget";

/** Show "{n} characters left" only when fewer than this many remain. */
export const HINT_THRESHOLD = 30;

export interface PathBudgetBlock {
  requiredLength: number;
  excess: number;
  worstPath: string;
  shorten: PathBudgetShorten;
}

const SHORTEN_LABEL: Record<PathBudgetShorten, string> = {
  workspace: "workspace",
  project: "project",
  case: "design case",
};

/** Windows drive and UNC paths (and unknown addresses) use `\`; a POSIX path uses `/`. */
const isPosix = (worstPath: string) => addressSeparator(worstPath) === "/";

/** Example short home for the user's platform: POSIX addresses get `/Users/<you>/Cadtree`, others `C:\\Cadtree`. */
export function shortHomeExample(address: string): string {
  return isPosix(address) ? "/Users/<you>/Cadtree" : "C:\\Cadtree";
}

/** The one-sentence block text, without the measured path. Used inline in dialogs. */
export function pathBudgetBlockSentence(block: PathBudgetBlock): string {
  const posix = isPosix(block.worstPath);
  const example = shortHomeExample(block.worstPath);
  return (
    `This location would need a ${block.requiredLength}-character path; the limit is ${BLOCK_PATH_CHARS}. ` +
    `Shorten the ${SHORTEN_LABEL[block.shorten]} name by ${block.excess} ${block.excess === 1 ? "character" : "characters"}, ` +
    `or move your Cadtree home closer to the drive (e.g. ${example}).` +
    (posix ? " Windows can't open longer paths." : "")
  );
}

/** Full banner text: sentence, the deepest measured path on its own line, and the Home options hint. */
export function pathBudgetBlockMessage(block: PathBudgetBlock): string {
  return [
    pathBudgetBlockSentence(block),
    block.worstPath,
    "If your Cadtree home has moved, update its address in Home options.",
  ].join("\n");
}

/** Rewrites a PathBudgetError or PathTooLongError into a plain Error with the full banner text; the original stays as `cause`. */
export function presentPathBudgetError(error: unknown): unknown {
  if (error instanceof PathBudgetError) return new Error(pathBudgetBlockMessage(error), { cause: error });
  if (error instanceof PathTooLongError) return new Error(pathTooLongMessage(error), { cause: error });
  return error;
}

/** Text for a create/write that failed because the real path is too long (Item 2 P7). */
export function pathTooLongMessage(error: Pick<PathTooLongError, "fullPath" | "length" | "limit">): string {
  return (
    `Path too long: ${error.fullPath} (${error.length} characters; this computer's limit is ${error.limit}). ` +
    `Shorten the folder or file names along this path, or move your Cadtree home closer to the drive (e.g. ${shortHomeExample(error.fullPath)}).`
  );
}

/** One sentence appended to the success banner when status is 'warn'; "" otherwise. */
export function pathBudgetWarnSentence(report: PathBudgetReport | undefined): string {
  if (!report || report.status !== "warn") return "";
  return `This location uses ${report.requiredLength} of ${BLOCK_PATH_CHARS} characters. Shorter names leave room for design cases and deeper folders.`;
}

export interface NameHint {
  requiredLength: number;
  /** Characters left before the limit; negative when over. */
  remaining: number;
  /** Set only when over the limit. */
  block: PathBudgetBlock | null;
  /** "{n} characters left" when fewer than HINT_THRESHOLD remain (and not over), otherwise "". */
  text: string;
}

function hintFor(worstPath: string, shorten: PathBudgetShorten): NameHint {
  const requiredLength = worstPath.length;
  const remaining = BLOCK_PATH_CHARS - requiredLength;
  const block =
    remaining < 0 ? { requiredLength, excess: -remaining, worstPath, shorten } : null;
  const text =
    remaining >= 0 && remaining < HINT_THRESHOLD
      ? `${remaining} ${remaining === 1 ? "character" : "characters"} left`
      : "";
  return { requiredLength, remaining, block, text };
}

/** Undefined while the address is unknown or nothing is typed: the dialog shows nothing. */
export function workspaceNameHint(homeAddress: string | undefined, name: string): NameHint | undefined {
  if (!homeAddress || !name.trim()) return undefined;
  return hintFor(workspaceWorstPath(joinAddress(homeAddress, folderNameFor(name, "Workspace"))), "workspace");
}

export function projectNameHint(workspaceAddress: string | undefined, name: string): NameHint | undefined {
  if (!workspaceAddress || !name.trim()) return undefined;
  const projectAddress = joinAddress(workspaceAddress, "projects", folderNameFor(name, "Project"));
  return hintFor(projectWorstPath({ projectAddress }), "project");
}

export function caseNameHint(
  projectAddress: string | undefined,
  name: string,
  source: { files: { path: string }[]; directories: string[] },
): NameHint | undefined {
  if (!projectAddress || !name.trim()) return undefined;
  const folder = folderNameFor(name, "Design case");
  return hintFor(
    caseWorstPath(projectAddress, folder, longestOf(source.files.map((f) => f.path)), longestOf(source.directories)),
    "case",
  );
}

