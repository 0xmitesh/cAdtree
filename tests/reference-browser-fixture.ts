import { InMemoryFileSystemAdapter } from '../src/engine/fs-adapter';
import { initializeProjectVault, openExistingVault } from '../src/engine/vault-service';
import { importReferenceAttachment, updateProjectReference, createReferenceReview, type ReferenceLinkInput } from '../src/engine/references';
import { captureRevision } from '../src/engine/revision-service';
import { scanBranchChanges } from '../src/engine/scanner';
import { getBranchBaseline } from '../src/engine/branch-state';
import { createDesignBranch } from '../src/engine/branch-service';
import { createIdentityReview } from '../src/engine/component-identity';

export async function referenceBrowserFixture() {
  const main = new InMemoryFileSystemAdapter('Main'), vault = new InMemoryFileSystemAdapter('Vault');
  const project = await initializeProjectVault(main, vault, 'Reference browser');
  const folders = { 'branch-main': main } as Record<string, InMemoryFileSystemAdapter>;
  const metadata = (title: string) => ({ title, description: `${title} description`, tags: ['requirements'] });
  const importFile = (title: string, filename: string, content: string, referenceId?: string) => importReferenceAttachment(vault, project.project.projectId, new File([content], filename), metadata(title), referenceId, { savedBy: { id: 'author-a', displayName: 'Asha' } });
  let state = await importFile('Alpha requirement', 'Alpha.txt', 'Alpha one');
  const alpha = state.references!.library[0];
  state = await importFile('Beta requirement', 'Beta.txt', 'Beta one');
  const beta = state.references!.library[1];
  state = await importFile('Project brief', 'Brief.txt', 'Whole version source');
  const brief = state.references!.library[2];
  await updateProjectReference(vault, project.project.projectId, brief.referenceId, { projectVersionId: brief.versions[0].versionId });
  for (const path of ['A.SLDPRT', 'B.SLDPRT', 'notes.txt']) await main.writeFileText([path], `Original ${path}`);
  const link = (reference: typeof alpha, path: string, versionId = reference.versions[0].versionId): ReferenceLinkInput => ({ referenceId: reference.referenceId, versionId, component: { kind: 'pending', path }, locator: 'section 2', explanation: 'Check fit' });
  const save = async (branchId: string, summary: string, explicit: ReferenceLinkInput[], rename?: { from: string; to: string }) => {
    const current = await openExistingVault(vault);
    const scan = await scanBranchChanges(folders[branchId], branchId, getBranchBaseline(current, branchId));
    return captureRevision(folders[branchId], vault, { branchId, summary, notes: { problem: '', modification: '', observations: '' }, workingFolders: folders,
      referenceReview: createReferenceReview(current, scan, explicit),
      ...(rename ? { identityReview: createIdentityReview(current, scan, [rename], []) } : {}),
    });
  };
  const first = await save('branch-main', 'Main baseline', [link(alpha, 'A.SLDPRT'), link(beta, 'B.SLDPRT')]);
  const branch = await createDesignBranch({ vaultDir: vault, destinationParent: new InMemoryFileSystemAdapter('Cases'), workingFolders: folders, sourceRevisionId: first.revision.manifest.revisionId, name: 'Alternative', reason: 'Explore B' });
  folders[branch.branch.branchId] = branch.workingDir as InMemoryFileSystemAdapter;
  await save(branch.branch.branchId, 'Alternative B choice', [link(alpha, 'B.SLDPRT')]);
  await main.writeFileText(['A-renamed.SLDPRT'], await main.readFileText(['A.SLDPRT']));
  await main.removeEntry(['A.SLDPRT']);
  await save('branch-main', 'Confirmed rename', [link(alpha, 'A-renamed.SLDPRT'), link(beta, 'B.SLDPRT')], { from: 'A.SLDPRT', to: 'A-renamed.SLDPRT' });
  state = await importFile('Alpha requirement', 'Alpha updated.txt', 'Alpha two', alpha.referenceId);
  const version2 = state.references!.library[0].versions[1];
  await save(branch.branch.branchId, 'Alternative updated source', [link(alpha, 'B.SLDPRT', version2.versionId)]);
  await importFile('Unassigned source', 'Unassigned.txt', 'Not linked yet');
  await updateProjectReference(vault, project.project.projectId, beta.referenceId, { removed: true });
  return { main, vault, folders, state: await openExistingVault(vault), alpha, beta, brief, version2, branchId: branch.branch.branchId, save, link };
}
