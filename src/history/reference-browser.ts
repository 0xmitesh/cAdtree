import type { VaultState } from '../engine/types';
import type { ProjectReference, ReferenceVersion } from '../engine/references';
import { formatRevisionNumber } from '../engine/vault-service';

export interface ReferenceUse {
  revisionId: string; branchId: string; branchName: string; displayNumber: number;
  summary: string; partPath: string | null; locator: string; explanation: string;
  fileKeys: ReadonlySet<string>;
}
export interface BrowsableReference { reference: ProjectReference; version: ReferenceVersion; uses: ReferenceUse[] }
export interface ReferenceBrowser {
  files: { value: string; label: string }[]; entries: BrowsableReference[]; unavailable: boolean;
}

/** Read-only associations from saved contexts; current defaults never invent usage. */
export function buildReferenceBrowser(state: VaultState): ReferenceBrowser {
  const fileOptions = new Map<string, { paths: string[]; latestPath: string; firstRevision: number }>();
  const revisionFiles = new Map<string, Set<string>>();
  const revisions = [...state.revisions].sort((a, b) => a.manifest.displayNumber - b.manifest.displayNumber || a.manifest.revisionId.localeCompare(b.manifest.revisionId));
  for (const revision of revisions) {
    if (revision.integrityStatus === 'corrupted') continue;
    const mapping = state.components?.status === 'available' ? state.components.revisions[revision.manifest.revisionId]?.files ?? [] : [];
    const identities = new Map(mapping.map(file => [file.path, file.componentId]));
    const keys = new Set<string>();
    for (const file of revision.manifest.files) {
      const componentId = identities.get(file.path);
      const key = componentId ? `component:${componentId}` : `path:${file.path}`;
      keys.add(key);
      const option = fileOptions.get(key) ?? { paths: [], latestPath: file.path, firstRevision: revision.manifest.displayNumber };
      if (!option.paths.includes(file.path)) option.paths.push(file.path);
      option.latestPath = file.path;
      fileOptions.set(key, option);
    }
    revisionFiles.set(revision.manifest.revisionId, keys);
  }
  const names = new Map<string, number>();
  for (const option of fileOptions.values()) {
    const name = option.latestPath;
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  const files = [...fileOptions].map(([value, option]) => {
    const name = option.latestPath;
    const previous = option.paths.filter(path => path !== name);
    return { value, label: `${name}${previous.length ? ` (previously ${previous.join(', ')})` : ''}${names.get(name)! > 1 ? ` — from ${formatRevisionNumber(option.firstRevision)}` : ''}` };
  }).sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
  const evidence = state.references;
  if (evidence && !['available', 'legacy'].includes(evidence.status)) return { files, entries: [], unavailable: true };
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
        fileKeys: link.componentId ? new Set([`component:${link.componentId}`]) : revisionFiles.get(revision.manifest.revisionId) ?? new Set(),
      });
    }
  }
  return { files, unavailable: false, entries: [...entries.values()].sort((a, b) => b.version.importedAt.localeCompare(a.version.importedAt) || a.reference.title.localeCompare(b.reference.title) || a.version.versionId.localeCompare(b.version.versionId)) };
}

export function filterReferenceBrowser(browser: ReferenceBrowser, branchId = '', fileKey = '', query = ''): BrowsableReference[] {
  const term = query.trim().toLocaleLowerCase();
  return browser.entries.flatMap(entry => {
    const uses = entry.uses.filter(use => (!branchId || use.branchId === branchId) && (!fileKey || use.fileKeys.has(fileKey)));
    if ((branchId || fileKey) && !uses.length) return [];
    const sourceMatches = [entry.reference.title, entry.reference.description, ...entry.reference.tags, entry.version.originalFilename, entry.version.savedBy?.displayName ?? ''].join(' ').toLocaleLowerCase().includes(term);
    const matchingUses = sourceMatches ? uses : uses.filter(use => [use.branchName, formatRevisionNumber(use.displayNumber), use.summary, use.partPath ?? '', use.locator, use.explanation].join(' ').toLocaleLowerCase().includes(term));
    return sourceMatches || matchingUses.length ? [{ ...entry, uses: matchingUses }] : [];
  });
}
