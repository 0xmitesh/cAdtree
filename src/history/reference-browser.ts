import type { VaultState } from '../engine/types';
import type { ProjectReference, ReferenceVersion } from '../engine/references';
import { formatRevisionNumber } from '../engine/vault-service';

export interface ReferenceUse {
  revisionId: string; branchId: string; branchName: string; displayNumber: number;
  summary: string; partPath: string | null; locator: string; explanation: string;
}
export interface BrowsableReference { reference: ProjectReference; version: ReferenceVersion; uses: ReferenceUse[] }
export interface ReferenceBrowser { entries: BrowsableReference[]; unavailable: boolean }

/** Read-only associations from saved contexts; current defaults never invent usage. */
export function buildReferenceBrowser(state: VaultState): ReferenceBrowser {
  const revisions = [...state.revisions].sort((a, b) => a.manifest.displayNumber - b.manifest.displayNumber || a.manifest.revisionId.localeCompare(b.manifest.revisionId));
  const evidence = state.references;
  if (evidence && !['available', 'legacy'].includes(evidence.status)) return { entries: [], unavailable: true };
  const entries = new Map<string, BrowsableReference>();
  for (const reference of evidence?.library ?? []) for (const version of reference.versions) {
    entries.set(`${reference.referenceId}:${version.versionId}`, { reference, version, uses: [] });
  }
  for (const revision of revisions) {
    if (revision.integrityStatus === 'corrupted') continue;
    const context = evidence?.contexts[revision.manifest.revisionId];
    if (context?.status !== 'available' || !context.record) continue;
    for (const link of context.record.links) {
      const entry = entries.get(`${link.referenceId}:${link.versionId}`);
      if (!entry) continue;
      entry.uses.push({
        revisionId: revision.manifest.revisionId, branchId: revision.manifest.branchId,
        branchName: state.branches.find(branch => branch.branchId === revision.manifest.branchId)?.name ?? 'Unknown branch',
        displayNumber: revision.manifest.displayNumber, summary: revision.manifest.summary,
        partPath: link.componentPath, locator: link.locator, explanation: link.explanation,
      });
    }
  }
  return { unavailable: false, entries: [...entries.values()].sort((a, b) => b.version.importedAt.localeCompare(a.version.importedAt) || a.reference.title.localeCompare(b.reference.title) || a.version.versionId.localeCompare(b.version.versionId)) };
}

/**
 * The one search box. A reference matches when its name, note, tags, file name or who saved it matches (it then keeps
 * all its uses), or else only the uses whose branch, revision, summary, the file it applies to, location or
 * explanation match.
 */
export function filterReferenceBrowser(browser: ReferenceBrowser, query = ''): BrowsableReference[] {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return browser.entries;
  return browser.entries.flatMap(entry => {
    const sourceMatches = [entry.reference.title, entry.reference.description, ...entry.reference.tags, entry.version.originalFilename, entry.version.savedBy?.displayName ?? ''].join(' ').toLocaleLowerCase().includes(term);
    if (sourceMatches) return [entry];
    const matchingUses = entry.uses.filter(use => [use.branchName, formatRevisionNumber(use.displayNumber), use.summary, use.partPath ?? '', use.locator, use.explanation].join(' ').toLocaleLowerCase().includes(term));
    return matchingUses.length ? [{ ...entry, uses: matchingUses }] : [];
  });
}
