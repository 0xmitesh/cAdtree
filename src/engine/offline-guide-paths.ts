/**
 * Paths and constants of the offline guide (pure, no imports from the services).
 * Kept apart from offline-guide.ts so path-budget.ts can list them without an import cycle
 * (offline-guide.ts needs workspace-service, which needs path-budget). offline-guide.ts re-exports them.
 */

/** Version of the guide text layout. Bump when the layout changes. */
export const OFFLINE_GUIDE_FORMAT_VERSION = 1;

/** File name of a project's Map, directly inside the project folder (the leading `_` sorts it first). */
export const PROJECT_MAP_FILENAME = '_MAP cAdtree.txt';

/** File names of the home-level guide files, directly inside the home folder. */
export const HOME_README_FILENAME = '_README cAdtree.txt';
export const HOME_INDEX_FILENAME = '_INDEX cAdtree.txt';

/** Relative to the home folder. These sit outside every project, so they are not part of the path-budget reserve. */
export const homeReadmePath = (): string[] => [HOME_README_FILENAME];
export const homeIndexPath = (): string[] => [HOME_INDEX_FILENAME];

/** Relative to the project folder. */
export const projectMapPath = (): string[] => [PROJECT_MAP_FILENAME];

/** Relative to the vault folder, next to `<revisionId>.manifest.json` (same style as revisionManifestPath). */
export const revisionListingPath = (revisionId: string): string[] => ['revisions', `${revisionId}.txt`];
