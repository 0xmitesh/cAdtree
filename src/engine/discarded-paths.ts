/**
 * Names and paths of the readable copies Discard keeps (pure, no imports), shared
 * with path-budget.ts. Layout, relative to the project folder:
 *
 *   Discarded/<YYYY-MM-DD HH.MM>[ (n)]/<original path>   the replaced bytes
 *   Discarded/<YYYY-MM-DD HH.MM>[ (n)]/_DISCARDED cAdtree.txt   what, when, how to put back (written last)
 *
 * cAdtree never deletes anything under Discarded/.
 */

export const DISCARDED_FOLDER = 'Discarded';
export const DISCARDED_NOTE_FILENAME = '_DISCARDED cAdtree.txt';
/** Used only when a discarded file at the top level already has the note's name. */
export const DISCARDED_NOTE_FALLBACK = '_DISCARDED cAdtree (2).txt';
/**
 * Highest clash counter: "Discarded/YYYY-MM-DD HH.MM (9)" is 30 characters, so the
 * prefix before a user path ("Discarded/<name>/", 31) stays shorter than
 * "working/<case allowance>/" (41) and the path-budget reserve is unchanged.
 * A tenth discard within the same minute stops before any change.
 */
export const DISCARDED_MAX_COUNTER = 9;

const two = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD HH.MM" in the computer's local time (readable, sorts by time, legal on every platform). */
export function discardedFolderBase(at: Date): string {
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}.${two(at.getMinutes())}`;
}

/** Relative to the project folder. */
export const discardedFolderPath = (name: string): string[] => [DISCARDED_FOLDER, name];
export const discardedNotePath = (name: string, noteName = DISCARDED_NOTE_FILENAME): string[] => [
  DISCARDED_FOLDER,
  name,
  noteName,
];
