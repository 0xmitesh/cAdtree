import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { InMemoryFileSystemAdapter } from '../src/engine/fs-adapter';
import { captureRevision } from '../src/engine/revision-service';
import { initializeProjectVault, openExistingVault } from '../src/engine/vault-service';
import type { VaultState } from '../src/engine/types';
import { buildKnowledgeIndex } from '../src/knowledge';
import { retrieveKnowledge } from '../src/knowledge/retrieval';

/** Real captures and reopening; checkpoints share one disposable synthetic history. */
export async function captureRetrievalHistory(checkpoints = [10, 50, 100]) {
  const working = new InMemoryFileSystemAdapter('Scaling CAD');
  const vault = new InMemoryFileSystemAdapter('Scaling Vault');
  await initializeProjectVault(working, vault, 'Retrieval scaling');
  const snapshots = new Map<number, VaultState>();
  for (let n = 1; n <= Math.max(...checkpoints); n++) {
    await working.writeFileText(['part.SLDPRT'], `Disposable geometry ${n}`);
    await captureRevision(working, vault, { branchId: 'branch-main', summary: `Snapshot ${n}`,
      notes: { problem: '', modification: '', observations: '' },
      fileNotes: [{ path: 'part.SLDPRT', problem: `Problem ${n}`, modification: `Change ${n}`, observations: `Observation ${n}` }],
    });
    if (checkpoints.includes(n)) snapshots.set(n, await openExistingVault(vault));
  }
  return snapshots;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const snapshots = await captureRetrievalHistory();
  const median = (f: () => unknown) => {
    const samples: number[] = [];
    for (let n = 0; n < 3; n++) { const start = performance.now(); f(); samples.push(performance.now() - start); }
    return Number(samples.sort((a, b) => a - b)[1].toFixed(2));
  };
  for (const [revisions, state] of snapshots) {
    const projectId = state.project.projectId;
    const componentId = Object.values(state.components!.revisions)[0].files[0].componentId;
    console.log(JSON.stringify({ revisions, projectionMs: median(() => buildKnowledgeIndex(state)),
      literalMs: median(() => retrieveKnowledge(state, { projectId, text: 'Problem' })),
      componentMs: median(() => retrieveKnowledge(state, { projectId, componentId })),
    }));
  }
}
