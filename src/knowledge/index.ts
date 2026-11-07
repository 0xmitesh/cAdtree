import type { ReconstructedRevision, VaultState } from '../engine/types';
import { MAIN_BRANCH_ID } from '../engine/types';
import { ancestryOf, layoutRevisions } from '../history/layout';
import type { KnowledgeAttachment, KnowledgeAvailability, KnowledgeIndex, KnowledgeRecord } from './types';
export type * from './types';

const available = (): KnowledgeAvailability => ({ status: 'available' });
const unavailable = (reason: string): KnowledgeAvailability => ({ status: 'unavailable', reason });
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function componentFor(state: VaultState, revisionId: string, path: string) {
  const evidence = state.components;
  if (!evidence) return { availability: unavailable('Component evidence was not reconstructed.') };
  if (evidence.status === 'legacy') return {
    availability: { status: 'not_recorded', reason: 'No committed component mapping for this history.' } as KnowledgeAvailability,
  };
  if (evidence.status !== 'available') return {
    availability: { status: evidence.status, reason: evidence.reason ?? 'Component evidence is unavailable.' } as KnowledgeAvailability,
  };
  const mapping = evidence.revisions[revisionId];
  if (!mapping) return { availability: unavailable('This revision has no verified component mapping.') };
  const entry = mapping.files.find(f => f.path === path);
  // Deleted-file notes may describe a path absent from this snapshot. Do not
  // borrow identity from a parent or a later revision with the same filename.
  return entry ? { availability: available(), componentId: entry.componentId }
    : { availability: unavailable('The note path has no component in the committed snapshot.') };
}

function referencesFor(state: VaultState, revision: ReconstructedRevision): {
  availability: KnowledgeAvailability; attachments: KnowledgeAttachment[];
} {
  const evidence = state.references;
  if (!evidence) return { availability: unavailable('Reference evidence was not reconstructed.'), attachments: [] };
  // Reconstruction may retain partial contexts after a global failure. Never
  // promote those to usable evidence, even if an individual context says available.
  if (evidence.status === 'unavailable' || evidence.status === 'unsupported') return {
    availability: { status: evidence.status, reason: evidence.reason ?? 'Reference evidence is unavailable.' }, attachments: [],
  };
  const context = evidence.contexts[revision.manifest.revisionId];
  if (context?.status === 'legacy' && !revision.completion.referenceContext) return {
    availability: { status: 'not_recorded', reason: 'This revision predates reference-context capture.' }, attachments: [],
  };
  if (context?.status !== 'available' || !context.record || !revision.completion.referenceContext) return {
    availability: unavailable(context?.reason ?? 'Committed reference context is missing.'), attachments: [],
  };
  const record = context.record;
  const catalog = record.catalogId === null ? undefined : evidence.catalogs[record.catalogId];
  const attachments: KnowledgeAttachment[] = [];
  for (const [index, link] of record.links.entries()) {
    const version = catalog?.record.references.find(r => r.referenceId === link.referenceId)
      ?.versions.find(v => v.versionId === link.versionId);
    if (!version || !catalog || !record.catalogId || catalog.sha256 !== record.catalogSha256) return {
      availability: unavailable('The context attachment version or pinned catalog is unavailable.'), attachments: [],
    };
    attachments.push({
      ...link, sha256: version.sha256, size: version.size,
      originalFilename: version.originalFilename, fileType: version.fileType,
      scope: link.componentId !== null ? 'component' : link.origin === 'project' ? 'project' : 'revision',
      source: {
        recordPath: `references/contexts/${record.revisionId}.json`, jsonPointer: `/links/${index}`,
        contextSha256: revision.completion.referenceContext.contextSha256,
        contextPayloadSha256: record.payloadSha256, boundarySha256: record.boundarySha256,
        catalogId: record.catalogId, catalogSha256: catalog.sha256,
      },
      metadata: { status: 'available' },
      content: { status: 'unavailable', reason: 'Attachment bytes are not verified by VaultState. Use retrieveReferenceAttachment to verify before use.' },
    });
  }
  return { availability: available(), attachments };
}

/** Pure, deterministic projection of reconstructed/validated VaultState. No I/O,
 * allocation of engineering identities, revalidation of disk bytes or persistence.
 * Metadata integrity establishes provenance, not engineering correctness.
 */
export function buildKnowledgeIndex(state: VaultState): KnowledgeIndex {
  const graph = layoutRevisions(state, MAIN_BRANCH_ID);
  const parent = new Map(graph.edges.map(edge => [edge.child, edge.parent]));
  const records: KnowledgeRecord[] = [];
  const revisions: KnowledgeIndex['revisions'] = [];
  const usable = new Set<string>();
  for (const node of [...graph.nodes].sort((a, b) => compare(a.id, b.id))) {
    const revision = node.revision, manifest = revision.manifest;
    const invalid = manifest.schemaVersion !== 1 || manifest.projectId !== state.project.projectId ||
      revision.integrityStatus === 'corrupted' || node.warnings.some(w => w.startsWith('Duplicate'));
    const notes: KnowledgeAvailability = manifest.schemaVersion !== 1
      ? { status: 'unsupported', reason: 'Unsupported revision manifest schema.' }
      : invalid ? unavailable([...revision.integrityErrors, ...node.warnings, 'Revision metadata is not trustworthy.'].join(' ')) : available();
    const references = invalid ? { availability: { ...notes }, attachments: [] } : referencesFor(state, revision);
    revisions.push({
      revisionId: node.id, branchId: manifest.branchId, notes,
      fileNotes: invalid ? { ...notes } : manifest.fileNotes === undefined
        ? { status: 'not_recorded', reason: 'The optional fileNotes field was not recorded.' } : available(),
      referenceContext: { availability: { ...references.availability }, attachments: structuredClone(references.attachments) },
      history: {
        recordedParentRevisionId: manifest.parentRevisionId,
        validatedParentRevisionId: parent.get(node.id) ?? null,
        ancestry: [...ancestryOf(graph, node.id)], warnings: [...node.warnings],
      },
    });
    if (invalid) continue;
    usable.add(node.id);
    const add = (kind: KnowledgeRecord['kind'], text: string, jsonPointer: string, filePath?: string) => {
      const component = filePath === undefined ? undefined : componentFor(state, node.id, filePath);
      records.push({
        id: JSON.stringify([state.project.projectId, node.id, jsonPointer]),
        projectId: state.project.projectId, revisionId: node.id, branchId: manifest.branchId,
        scope: filePath === undefined ? 'project' : 'file', kind, text,
        status: text.trim() ? 'recorded' : 'empty',
        source: { recordPath: `revisions/${node.id}.manifest.json`, jsonPointer,
          manifestSha256: revision.completion.manifestSha256, manifestPayloadSha256: manifest.manifestPayloadSha256 },
        ...(filePath === undefined ? {} : { filePath, componentId: component?.componentId, component: component!.availability }),
        references: { ...references.availability },
        attachments: structuredClone(references.attachments.filter(a => a.scope !== 'component' ||
          (component?.componentId !== undefined && a.componentId === component.componentId))),
      });
    };
    add('summary', manifest.summary, '/summary');
    for (const kind of ['problem', 'modification', 'observations'] as const) add(kind, manifest.notes[kind], `/notes/${kind}`);
    for (const [index, note] of (manifest.fileNotes ?? []).entries()) {
      for (const kind of ['problem', 'modification', 'observations'] as const) add(kind, note[kind], `/fileNotes/${index}/${kind}`, note.path);
    }
  }
  return {
    projectId: state.project.projectId, records, revisions,
    branches: [...state.branches].sort((a, b) => compare(a.branchId, b.branchId)).map(branch => ({
      branchId: branch.branchId, startingRevisionId: branch.startingRevisionId,
      origin: branch.startingRevisionId === null ? available() : usable.has(branch.startingRevisionId)
        ? available() : unavailable('The branch starting revision is unavailable.'),
    })),
    diagnostics: [
      ...graph.warnings.map(reason => ({ source: 'history', reason })),
      ...state.corruptedRecords.map(r => ({ source: r.recordPath, reason: r.reason })),
      ...state.incompleteAttempts.map(r => ({ source: r.path, reason: r.detail })),
      ...Object.entries(state.damagedBranchHeads).map(([source, reason]) => ({ source, reason })),
    ].sort((a, b) => compare(a.source, b.source) || compare(a.reason, b.reason)),
  };
}
