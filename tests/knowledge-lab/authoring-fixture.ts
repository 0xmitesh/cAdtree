import { InMemoryFileSystemAdapter } from '../../src/engine/fs-adapter';
import { initializeProjectVault } from '../../src/engine/vault-service';
import { importReferenceAttachment, createReferenceReview } from '../../src/engine/references';
import { scanBranchChanges } from '../../src/engine/scanner';
import { getBranchBaseline } from '../../src/engine/branch-state';
import { captureRevision } from '../../src/engine/revision-service';

export async function disposableAuthoringFixture() {
  const container = new InMemoryFileSystemAdapter('Disposable project copy');
  const vault = await container.getDirectory(['vault'], { create: true });
  const working = new InMemoryFileSystemAdapter('CAD working folder');
  let state = await initializeProjectVault(working, vault, 'Disposable collar study');
  state = await importReferenceAttachment(vault, state.project.projectId, {
    name: 'synthetic-requirement.pdf', size: 3, type: 'application/pdf', stream: () => new Blob([new Uint8Array([1, 2, 3])]).stream(),
  }, { title: 'Synthetic load requirement', description: '', tags: [] });
  const reference = state.references!.library[0];
  await working.writeFileText(['collar.SLDPRT'], 'Disposable CAD geometry');
  const scan = await scanBranchChanges(working, 'branch-main', getBranchBaseline(state, 'branch-main'));
  state = (await captureRevision(working, vault, {
    branchId: 'branch-main', summary: 'Initial synthetic collar', notes: { problem: 'Axial bending', modification: '', observations: '' },
    referenceReview: createReferenceReview(state, scan, [{ referenceId: reference.referenceId, versionId: reference.versions[0].versionId, locator: 'Page 4, figure 3', explanation: 'Design context only.', component: { kind: 'pending', path: 'collar.SLDPRT' } }]),
  })).vaultState;
  return { container, vault, working, state, reference };
}
