import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter, RealFileSystemAdapter } from './fs-adapter';
import { nativeDirectory } from '../../tests/native-fs';
import { initializeProjectVault, openExistingVault } from './vault-service';
import { captureRevision } from './revision-service';
import { hashString } from './hash';
import { importReferenceAttachment, retrieveReferenceAttachment, updateProjectReference, referenceChecksum } from './references';

const notes = { problem: '', modification: '', observations: '' };
const metadata = { title: 'Requirement', description: '', tags: [] };
const bytes = new Uint8Array([0, 255, 13, 10, 128]);
const source = () => new File([bytes], 'requirement.pdf', { type: 'application/pdf' });

/** The real adapter creates the file through getFileHandle before createWritable.
 * Keep that empty native file when opening/writing/closing the stream fails. */
function faultingNative(handle: FileSystemDirectoryHandle, fault: { match?: (path: string) => boolean; beforeDirectory?: (path: string) => boolean; phase: 'open' | 'write' | 'close'; created?: string; absoluteRoot?: string }, parent: string[] = []): FileSystemDirectoryHandle {
  return new Proxy(handle, { get(target, key) {
    if (key === 'getDirectoryHandle') return async (name: string, options?: FileSystemGetDirectoryOptions) => {
      const path = [...parent, name];
      if (options?.create && fault.absoluteRoot && `${fault.absoluteRoot}\\${path.join('\\')}`.length > 248) throw new DOMException('A requested file or directory could not be found at the time an operation was processed.', 'NotFoundError');
      if (options?.create && fault.beforeDirectory?.(path.join('/'))) { fault.beforeDirectory = undefined; throw new Error('Injected interruption before enrollment directory creation'); }
      return faultingNative(await target.getDirectoryHandle(name, options), fault, path);
    };
    if (key === 'getFileHandle') return async (name: string, options?: FileSystemGetFileOptions) => {
      const path = [...parent, name].join('/');
      // Chromium's writable stream also needs room for its .crswap sibling.
      if (options?.create && fault.absoluteRoot && `${fault.absoluteRoot}\\${[...parent, name].join('\\')}`.length + '.crswap'.length > 259) throw new DOMException('A requested file or directory could not be found at the time an operation was processed.', 'NotFoundError');
      const file = await target.getFileHandle(name, options);
      if (!options?.create || !fault.match?.(path)) return file;
      fault.match = undefined; fault.created = path;
      return new Proxy(file, { get(fileTarget, fileKey) {
        if (fileKey === 'createWritable') return async () => {
          if (fault.phase === 'open') throw new Error('Injected failure after native file creation');
          const writable = await fileTarget.createWritable();
          return new Proxy(writable, { get(stream, method) {
            if (method === fault.phase) return async () => { throw new Error('Injected failure after native file creation'); };
            const value = Reflect.get(stream, method); return typeof value === 'function' ? value.bind(stream) : value;
          } });
        };
        const value = Reflect.get(fileTarget, fileKey); return typeof value === 'function' ? value.bind(fileTarget) : value;
      } });
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
async function fixture() {
  const disk = new InMemoryFileSystemAdapter('Vault');
  const working = new RealFileSystemAdapter(nativeDirectory(new InMemoryFileSystemAdapter('Main')));
  const fault: Parameters<typeof faultingNative>[1] = { phase: 'open' };
  const vault = new RealFileSystemAdapter(faultingNative(nativeDirectory(disk), fault));
  const state = await initializeProjectVault(working, vault, 'Publication regression');
  const folders = { 'branch-main': working };
  const save = () => captureRevision(working, vault, { branchId: 'branch-main', summary: 'CAD still capturable', notes, workingFolders: folders });
  return { disk, vault, working, fault, save, projectId: state.project.projectId };
}

test('baseline capture and reference publication fit the Windows directory limit in a managed project and recover interrupted enrollment', async () => {
  const f = await fixture();
  f.fault.absoluteRoot = 'C:\\Users\\1\\Documents\\cadtree home 8.11\\solidworks-59ab5028-797d-47b5-b011-d99fcdfd14e6\\projects\\shaft-56c180be-4c6b-4fac-868f-16f05de36aa9\\vault';
  for (let attempt = 0; attempt < 3; attempt++) {
    await f.disk.writeFileText(['references', 'enrollment', `reference-enrollment-${crypto.randomUUID()}.json`], '{"interrupted":');
  }
  await f.working.writeFileText(['bush.SLDPRT'], 'bush geometry');
  await f.working.writeFileText(['shaft.SLDPRT'], 'shaft geometry');
  const saved = await f.save();
  assert.equal(saved.revision.manifest.displayNumber, 1);
  assert.equal(saved.revision.manifest.parentRevisionId, null);
  assert.equal(saved.vaultState.references!.status, 'available');
  assert.equal(saved.vaultState.incompleteAttempts.filter(a => a.kind === 'uncompleted_reference').length, 3);
  const imported = await importReferenceAttachment(f.vault, f.projectId, source(), metadata);
  const ref = imported.references!.library[0];
  assert.deepEqual((await retrieveReferenceAttachment(f.vault, f.projectId, ref.referenceId, ref.versions[0].versionId)).bytes, bytes);
  await updateProjectReference(f.vault, f.projectId, ref.referenceId, { projectVersionId: ref.versions[0].versionId });
  await f.working.writeFileText(['shaft.SLDPRT'], 'revised shaft geometry');
  const next = await f.save();
  assert.equal(next.vaultState.revisions.length, 2);
  assert.equal(next.revision.manifest.parentRevisionId, saved.revision.manifest.revisionId);
  assert.equal(next.vaultState.references!.contexts[next.revision.manifest.revisionId].record!.links[0].versionId, ref.versions[0].versionId);
});

// The original-name readability test moved to reference-record-ids.test.ts: new references have record IDs, so
// a full-hex marker can only be built from legacy-ID fixtures.

for (const phase of ['open', 'write', 'close'] as const) for (const first of [true, false]) {
  test(`native ${phase} failure after ${first ? 'first enrollment' : 'subsequent catalog'} file creation leaves diagnostics, retrieval, retry and CAD capture usable`, async () => {
    const f = await fixture();
    const original = first ? undefined : await importReferenceAttachment(f.vault, f.projectId, source(), metadata);
    const ref = original?.references!.library[0];
    if (ref) await updateProjectReference(f.vault, f.projectId, ref.referenceId, { projectVersionId: ref.versions[0].versionId });
    f.fault.phase = phase;
    f.fault.match = path => first ? path === 'reference-context.json' || path.startsWith('references/enrollment/') : path.startsWith('references/catalogs/');
    await assert.rejects(importReferenceAttachment(f.vault, f.projectId, source(), metadata), /after native file creation/);
    assert.ok(f.fault.created); assert.equal((await f.disk.statFile(f.fault.created!.split('/'))).size, 0, 'the real adapter left a created but unwritten file');
    const failed = await openExistingVault(f.vault);
    assert.equal(failed.references!.status, first ? 'legacy' : 'available');
    assert.equal(failed.references!.library.length, first ? 0 : 1);
    assert.ok(failed.incompleteAttempts.some(a => a.path === f.fault.created && a.kind === 'uncompleted_reference'));
    assert.equal(failed.revisions.length, 0);
    if (ref) assert.deepEqual((await retrieveReferenceAttachment(f.vault, f.projectId, ref.referenceId, ref.versions[0].versionId)).bytes, bytes);
    // Capturing remains possible even before another reference import is tried.
    await f.working.writeFileText(['part.SLDPRT'], 'new CAD geometry');
    const saved = await f.save(); assert.equal(saved.vaultState.revisions.length, 1);
    if (ref) assert.equal(saved.vaultState.references!.contexts[saved.revision.manifest.revisionId].record!.links[0].versionId, ref.versions[0].versionId);
    const retry = await importReferenceAttachment(f.vault, f.projectId, source(), metadata);
    assert.equal(retry.references!.library.length, first ? 1 : 2);
    assert.equal(retry.references!.status, 'available');
    assert.deepEqual((await retrieveReferenceAttachment(f.vault, f.projectId, retry.references!.library.at(-1)!.referenceId, retry.references!.library.at(-1)!.versions[0].versionId)).bytes, bytes);
  });
}

test('the former completion-marker file creation failure cannot poison the existing library', async () => {
  const f = await fixture(), first = await importReferenceAttachment(f.vault, f.projectId, source(), metadata), ref = first.references!.library[0];
  // ff80553 creates an empty *.done.json here, then fails opening its stream.
  // The corrected writer has no completion-marker file stream to fail.
  f.fault.match = path => path.startsWith('references/completed/');
  let interrupted = false;
  try { await importReferenceAttachment(f.vault, f.projectId, source(), metadata); }
  catch (error) { assert.match(String(error), /after native file creation/); interrupted = true; }
  const reopened = await openExistingVault(f.vault);
  assert.equal(reopened.references!.status, 'available');
  assert.deepEqual((await retrieveReferenceAttachment(f.vault, f.projectId, ref.referenceId, ref.versions[0].versionId)).bytes, bytes);
  if (interrupted) assert.ok(reopened.incompleteAttempts.some(a => a.kind === 'uncompleted_reference'));
  const retry = await importReferenceAttachment(f.vault, f.projectId, source(), metadata);
  assert.equal(retry.references!.library.length, interrupted ? 2 : 3);
  await f.working.writeFileText(['part'], 'CAD'); assert.equal((await f.save()).vaultState.revisions.length, 1);
  assert.ok((await (await f.disk.getDirectory(['references', 'completed'])).listEntries()).every(e => e.kind === 'directory'), 'final publication does not create a marker file before writing its contents');
});

for (const after of [false, true]) for (const first of [true, false]) test(`failure ${after ? 'after' : 'before'} final ${first ? 'enrollment' : 'catalog'} directory creation reconstructs the exact publication boundary`, async () => {
  const f = await fixture();
  if (!first) await importReferenceAttachment(f.vault, f.projectId, source(), metadata);
  const getDirectory = f.vault.getDirectory.bind(f.vault); let inject = true;
  f.vault.getDirectory = async (path, options) => {
    if (inject && options?.exclusiveCreate && path[0] === 'references' && path[1] === (first ? 'enrollment' : 'completed')) {
      inject = false;
      if (after) await getDirectory(path, options);
      throw new Error('Interrupted final directory publication');
    }
    return getDirectory(path, options);
  };
  await assert.rejects(importReferenceAttachment(f.vault, f.projectId, source(), metadata), /Interrupted final/);
  const failed = await openExistingVault(f.vault);
  assert.equal(failed.references!.status, first && !after ? 'legacy' : 'available');
  assert.equal(failed.references!.library.length, first ? 0 : after ? 2 : 1);
  if (!after) assert.ok(failed.incompleteAttempts.some(a => a.kind === 'uncompleted_reference'));
  const retry = await importReferenceAttachment(f.vault, f.projectId, source(), metadata);
  assert.equal(retry.references!.status, 'available');
  await f.working.writeFileText(['part'], 'CAD'); assert.equal((await f.save()).vaultState.revisions.length, 1);
});

for (const damage of ['record', 'marker', 'enrollment'] as const) test(`damaged committed ${damage} evidence remains unavailable rather than becoming an incomplete import`, async () => {
  const f = await fixture(), state = await importReferenceAttachment(f.vault, f.projectId, source(), metadata);
  if (damage === 'record') await f.disk.writeFileText(['references', 'catalogs', `${state.references!.catalogId}.json`], '');
  else if (damage === 'enrollment') {
    const dir = await f.disk.getDirectory(['references', 'enrollment']), record = (await dir.listEntries()).find(e => e.kind === 'file')!;
    await dir.writeFileText([record.name], '');
  } else {
    const completed = await f.disk.getDirectory(['references', 'completed']), marker = (await completed.listEntries())[0];
    await (await completed.getDirectory([marker.name])).writeFileText(['unexpected'], 'damage');
  }
  const failed = await openExistingVault(f.vault); assert.equal(failed.references!.status, 'unavailable');
  await assert.rejects(importReferenceAttachment(f.vault, f.projectId, source(), metadata), /Reference evidence unavailable/);
  await f.working.writeFileText(['part'], 'CAD'); await assert.rejects(f.save(), /Reference evidence unavailable/);
  assert.equal((await openExistingVault(f.vault)).revisions.length, 0);
});

test('existing file marker/boundary evidence opens unchanged, and damaged committed file markers remain strict', async () => {
  const f = await fixture(), state = await importReferenceAttachment(f.vault, f.projectId, source(), metadata), evidence = state.references!;
  // Model ff80553's already-published on-disk format, without changing any identity.
  await f.disk.writeFileText(['reference-context.json'], JSON.stringify(evidence.boundary, null, 2));
  await f.disk.removeEntry(['references', 'enrollment'], { recursive: true });
  const completed = await f.disk.getDirectory(['references', 'completed']);
  for (const entry of await completed.listEntries()) await completed.removeEntry([entry.name], { recursive: true });
  const marker = { schemaVersion: 1, projectId: f.projectId, catalogId: evidence.catalogId, recordSha256: evidence.catalogSha256, payloadSha256: '' };
  marker.payloadSha256 = referenceChecksum(marker);
  const markerPath = ['references', 'completed', `${marker.catalogId}.done.json`];
  await f.disk.writeFileText(markerPath, JSON.stringify(marker, null, 2));
  const boundaryText = await f.disk.readFileText(['reference-context.json']), markerText = await f.disk.readFileText(markerPath);
  assert.equal((await openExistingVault(f.vault)).references!.catalogId, evidence.catalogId);
  // A new attempt must preserve this healthy original library after a native failure.
  f.fault.match = path => path.startsWith('references/catalogs/');
  await assert.rejects(importReferenceAttachment(f.vault, f.projectId, source(), metadata), /after native file creation/);
  const ref = evidence.library[0];
  assert.deepEqual((await retrieveReferenceAttachment(f.vault, f.projectId, ref.referenceId, ref.versions[0].versionId)).bytes, bytes);
  await importReferenceAttachment(f.vault, f.projectId, source(), metadata);
  assert.equal(await f.disk.readFileText(['reference-context.json']), boundaryText); assert.equal(await f.disk.readFileText(markerPath), markerText);
  assert.equal(hashString(await f.disk.readFileText(['references', 'catalogs', `${evidence.catalogId}.json`])), evidence.catalogSha256);
  await f.disk.writeFileText(markerPath, '');
  const damaged = await openExistingVault(f.vault); assert.equal(damaged.references!.status, 'unavailable');
  await assert.rejects(importReferenceAttachment(f.vault, f.projectId, source(), metadata), /Reference evidence unavailable/);
});

test('first reference enrollment interrupted after file creation preserves an existing legacy revision and can capture before retry', async () => {
  const f = await fixture(); await f.working.writeFileText(['part'], 'legacy CAD'); const first = await f.save();
  const id = first.revision.manifest.revisionId, completionPath = ['completed', `${id}.done.json`];
  const completion = JSON.parse(await f.disk.readFileText(completionPath)); delete completion.referenceContext;
  await f.disk.writeFileText(completionPath, JSON.stringify(completion, null, 2));
  await f.disk.removeEntry(['references'], { recursive: true });
  const manifest = await f.disk.readFileText(['revisions', `${id}.manifest.json`]);
  f.fault.match = path => path.startsWith('references/enrollment/');
  await assert.rejects(importReferenceAttachment(f.vault, f.projectId, source(), metadata), /after native file creation/);
  // A truncated, nonempty preparation is just as uncommitted as an empty one.
  await f.disk.writeFileText(f.fault.created!.split('/'), '{"schemaVersion":');
  const failed = await openExistingVault(f.vault);
  assert.equal(failed.references!.status, 'legacy'); assert.equal(failed.references!.contexts[id].status, 'legacy');
  assert.ok(failed.incompleteAttempts.some(a => a.path === f.fault.created));
  await f.working.writeFileText(['part'], 'newer CAD'); const next = await f.save();
  assert.equal(next.vaultState.revisions.length, 2); assert.equal(next.vaultState.references!.contexts[id].status, 'legacy');
  assert.deepEqual(next.vaultState.references!.contexts[next.revision.manifest.revisionId].record!.links, []);
  assert.equal(await f.disk.readFileText(['revisions', `${id}.manifest.json`]), manifest);
  assert.equal((await importReferenceAttachment(f.vault, f.projectId, source(), metadata)).references!.library.length, 1);
});

for (const nextAction of ['import', 'capture'] as const) test(`empty references parent after native interruption permits ${nextAction} first and records an incomplete setup diagnostic`, async () => {
  const f = await fixture();
  f.fault.beforeDirectory = path => path === 'references/enrollment';
  await assert.rejects(importReferenceAttachment(f.vault, f.projectId, source(), metadata), /before enrollment directory creation/);
  assert.equal(await f.disk.hasDirectory(['references']), true);
  assert.equal(await f.disk.hasDirectory(['references', 'enrollment']), false);
  assert.deepEqual(await (await f.disk.getDirectory(['references'])).listEntries(), []);
  const reopened = await openExistingVault(f.vault);
  assert.equal(reopened.references!.status, 'legacy');
  assert.equal(reopened.references!.enrollmentIncomplete, true);
  assert.deepEqual(reopened.references!.library, []);
  assert.equal(reopened.revisions.length, 0);
  assert.ok(reopened.incompleteAttempts.some(a => a.kind === 'uncompleted_reference' && a.path === 'references'));
  if (nextAction === 'import') {
    const retry = await importReferenceAttachment(f.vault, f.projectId, source(), metadata);
    assert.equal(retry.references!.status, 'available'); assert.equal(retry.references!.library.length, 1);
    const ref = retry.references!.library[0];
    assert.deepEqual((await retrieveReferenceAttachment(f.vault, f.projectId, ref.referenceId, ref.versions[0].versionId)).bytes, bytes);
  }
  await f.working.writeFileText(['part'], 'CAD after interrupted parent setup');
  const saved = await f.save(); assert.equal(saved.vaultState.revisions.length, 1);
  assert.equal(saved.vaultState.references!.status, 'available');
  if (nextAction === 'capture') assert.equal((await importReferenceAttachment(f.vault, f.projectId, source(), metadata)).references!.library.length, 1);
});

test('an empty references parent cannot replace enrollment required by a committed revision', async () => {
  const f = await fixture(); await f.working.writeFileText(['part'], 'saved CAD'); const saved = await f.save();
  await f.disk.removeEntry(['references'], { recursive: true });
  await f.disk.getDirectory(['references'], { create: true });
  const reopened = await openExistingVault(f.vault);
  assert.equal(reopened.references!.status, 'unavailable');
  assert.equal(reopened.references!.enrollmentIncomplete, undefined);
  assert.equal(reopened.references!.contexts[saved.revision.manifest.revisionId].status, 'unavailable');
  await assert.rejects(importReferenceAttachment(f.vault, f.projectId, source(), metadata), /Committed reference enrollment evidence is missing/);
  await f.working.writeFileText(['part'], 'new CAD'); await assert.rejects(f.save(), /Committed reference enrollment evidence is missing/);
  assert.equal((await openExistingVault(f.vault)).revisions.length, 1);
  assert.deepEqual(await (await f.disk.getDirectory(['references'])).listEntries(), []);
});

test('nonempty reference storage requiring a missing enrollment remains unavailable without revision links', async () => {
  const f = await fixture(); await importReferenceAttachment(f.vault, f.projectId, source(), metadata);
  await f.disk.removeEntry(['references', 'enrollment'], { recursive: true });
  const reopened = await openExistingVault(f.vault);
  assert.equal(reopened.revisions.length, 0); assert.equal(reopened.references!.status, 'unavailable');
  await assert.rejects(importReferenceAttachment(f.vault, f.projectId, source(), metadata), /existing storage cannot be regenerated/);
  await f.working.writeFileText(['part'], 'CAD'); await assert.rejects(f.save(), /existing storage cannot be regenerated/);
  assert.equal(await f.disk.hasDirectory(['references', 'enrollment']), false);
});
