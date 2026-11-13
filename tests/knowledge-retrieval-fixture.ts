import { InMemoryFileSystemAdapter, type FileSystemDirectoryAdapter } from '../src/engine/fs-adapter';
import { initializeProjectVault, openExistingVault } from '../src/engine/vault-service';
import { captureRevision } from '../src/engine/revision-service';
import { createDesignBranch } from '../src/engine/branch-service';
import { createIdentityReview } from '../src/engine/component-identity';
import { getBranchBaseline } from '../src/engine/branch-state';
import { scanBranchChanges } from '../src/engine/scanner';
import { importReferenceAttachment, createReferenceReview, type ReferenceLinkInput } from '../src/engine/references';
import { buildKnowledgeIndex } from '../src/knowledge';
import { createKnowledgeRecord, type KnowledgeRelationshipInput } from '../src/knowledge/records';

/** Real disposable vault publications/reconstruction; no hand-invented retrieval records. */
export async function knowledgeRetrievalFixture() {
  const vault = new InMemoryFileSystemAdapter('Retrieval Vault'), main = new InMemoryFileSystemAdapter('Main');
  const folders: Record<string, FileSystemDirectoryAdapter> = { 'branch-main': main };
  let state = await initializeProjectVault(main, vault, 'Synthetic collar history');
  const projectId = state.project.projectId;
  const attachment = (value: number) => ({ name: 'loads.pdf', type: 'application/pdf', size: 1, stream: () => new Blob([new Uint8Array([value])]).stream() });
  state = await importReferenceAttachment(vault, projectId, attachment(1), { title: 'Load requirement', description: '', tags: [] });
  const ref = state.references!.library[0], v1 = ref.versions[0];
  const fileNotes = (path: string) => [{ path, problem: 'Collar bends under load.', modification: 'Increase thickness from 6 to 8 mm.', observations: 'Prototype [A].* pending.' }];
  const notes = { problem: 'Project-only assembly envelope', modification: 'Project-only review', observations: 'Project-only planning' };
  await main.writeFileText(['collar.SLDPRT'], 'geometry A');
  let scan = await scanBranchChanges(main, 'branch-main', getBranchBaseline(state, 'branch-main'));
  const first = await captureRevision(main, vault, { branchId: 'branch-main', workingFolders: folders, summary: 'Initial collar', notes, fileNotes: fileNotes('collar.SLDPRT'),
    referenceReview: createReferenceReview(state, scan, [{ referenceId: ref.referenceId, versionId: v1.versionId, locator: 'Page 4, figure 2', explanation: 'Initial load context.', component: { kind: 'pending', path: 'collar.SLDPRT' } }]),
  });
  state = first.vaultState;
  const componentId = state.components!.revisions[first.revision.manifest.revisionId].files[0].componentId;
  await main.removeEntry(['collar.SLDPRT']); await main.writeFileText(['collar_plate.SLDPRT'], 'geometry A renamed');
  scan = await scanBranchChanges(main, 'branch-main', getBranchBaseline(state, 'branch-main'));
  const renamed = await captureRevision(main, vault, { branchId: 'branch-main', workingFolders: folders, summary: 'Confirmed collar rename', notes, fileNotes: fileNotes('collar_plate.SLDPRT'),
    identityReview: createIdentityReview(state, scan, [{ from: 'collar.SLDPRT', to: 'collar_plate.SLDPRT' }], []),
  });
  const branch = await createDesignBranch({ vaultDir: vault, destinationParent: new InMemoryFileSystemAdapter('Cases'), workingFolders: folders,
    sourceRevisionId: first.revision.manifest.revisionId, name: 'Thicker alternative', reason: 'Explore stiffness' });
  folders[branch.branch.branchId] = branch.workingDir;
  state = await importReferenceAttachment(vault, projectId, attachment(2), { title: 'Updated load requirement', description: '', tags: [] }, ref.referenceId);
  const v2 = state.references!.library[0].versions[1];
  await branch.workingDir.writeFileText(['collar.SLDPRT'], 'geometry A alternative');
  scan = await scanBranchChanges(branch.workingDir, branch.branch.branchId, getBranchBaseline(state, branch.branch.branchId));
  const links: ReferenceLinkInput[] = [{ referenceId: ref.referenceId, versionId: v2.versionId, locator: 'Page 7, figure 1', explanation: 'Alternative load context.', component: { kind: 'existing', componentId } }];
  const alternative = await captureRevision(branch.workingDir, vault, { branchId: branch.branch.branchId, workingFolders: folders, summary: 'Thicker alternative', notes,
    fileNotes: fileNotes('collar.SLDPRT'), referenceReview: createReferenceReview(state, scan, links) });
  state = await openExistingVault(vault);
  scan = await scanBranchChanges(main, 'branch-main', getBranchBaseline(state, 'branch-main'));
  const referenceOnly = await captureRevision(main, vault, { branchId: 'branch-main', workingFolders: folders, summary: 'Reference context only', notes,
    referenceReview: createReferenceReview(state, scan, links) });
  await main.writeFileText(['collar.SLDPRT'], 'Independent unrelated component B');
  const unrelated = await captureRevision(main, vault, { branchId: 'branch-main', workingFolders: folders, summary: 'Add unrelated same-name component', notes,
    fileNotes: [{ path: 'collar.SLDPRT', problem: 'Unrelated fixture component', modification: 'Independent design', observations: '' }] });
  state = unrelated.vaultState;
  const unrelatedComponentId = state.components!.revisions[unrelated.revision.manifest.revisionId].files.find(f => f.path === 'collar.SLDPRT')!.componentId;
  const componentLink = (revisionId: string): KnowledgeRelationshipInput => ({ relation: 'related', target: { kind: 'component', projectId, revisionId, componentId } });
  const revisionLink = (revisionId: string): KnowledgeRelationshipInput => ({ relation: 'context', target: { kind: 'revision', projectId, revisionId } });
  const referenceLink = (revisionId: string): KnowledgeRelationshipInput => {
    const a = buildKnowledgeIndex(state).revisions.find(r => r.revisionId === revisionId)!.referenceContext.attachments[0];
    return { relation: 'evidence', target: { kind: 'reference-version', projectId, revisionId, referenceId: a.referenceId, versionId: a.versionId, associationPointer: a.source.jsonPointer } };
  };
  const design = await createKnowledgeRecord(vault, { projectId, recordType: 'cad.design-change', schemaVersion: 1,
    payload: { problem: 'Collar bends', change: { status: 'proposed', description: 'Use an 8 mm collar' }, rationale: 'Recorded stiffness rationale; not validation.' },
    relationships: [componentLink(renamed.revision.manifest.revisionId), referenceLink(renamed.revision.manifest.revisionId)], provenance: { kind: 'user-entered' } });
  const generic = (description: string, relationships: KnowledgeRelationshipInput[]) => createKnowledgeRecord(vault, { projectId, recordType: 'generic.observation', schemaVersion: 1,
    payload: { description, attributes: { sample: 3, unit: 'mm' } }, relationships, provenance: { kind: 'user-entered' } });
  const observation = await generic('Alternative collar observation', [componentLink(alternative.revision.manifest.revisionId), referenceLink(alternative.revision.manifest.revisionId)]);
  const revisionOnly = await generic('Revision-only project checklist', [revisionLink(unrelated.revision.manifest.revisionId)]);
  const projectOnly = await generic('Project-wide meeting log', []);
  const linked = await generic('Follow-up note linked to a record', [{ relation: 'related', target: { kind: 'record', projectId, recordId: design.record.recordId } }]);
  const mixed = await generic('Two separate explicit contexts', [componentLink(renamed.revision.manifest.revisionId), revisionLink(alternative.revision.manifest.revisionId)]);
  const referenceRecord = await generic('Reference-only assertion', [referenceLink(referenceOnly.revision.manifest.revisionId)]);
  return { vault, main, folders, projectId, state: await openExistingVault(vault), componentId, unrelatedComponentId, branchId: branch.branch.branchId,
    firstId: first.revision.manifest.revisionId, renamedId: renamed.revision.manifest.revisionId, alternativeId: alternative.revision.manifest.revisionId,
    referenceOnlyId: referenceOnly.revision.manifest.revisionId, unrelatedId: unrelated.revision.manifest.revisionId,
    ref, v1, v2, design, observation, revisionOnly, projectOnly, linked, mixed, referenceRecord };
}
