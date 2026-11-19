import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { InMemoryFileSystemAdapter, type FileSystemDirectoryAdapter } from './fs-adapter';
import { hashBytes } from './hash';
import { initializeProjectVault } from './vault-service';
import { captureRevision } from './revision-service';
import { enumerateWorkingFolder, knownHashesFromScan, scanBranchChanges } from './scanner';
import { MAIN_BRANCH_ID, type FileEntry } from './types';

const bytes = (text: string) => new TextEncoder().encode(text);

/** Counts reads of the root folder's files and lets a test pin their modification times. */
function instrument(dir: FileSystemDirectoryAdapter, dates: Map<string, number>) {
  const reads: string[] = [];
  const proxy = new Proxy(dir as object, {
    get(target, prop, receiver) {
      if (prop === 'readFileStream')
        return async (segments: string[]) => {
          reads.push(segments.join('/'));
          return (target as FileSystemDirectoryAdapter).readFileStream(segments);
        };
      if (prop === 'statFile')
        return async (segments: string[]) => {
          const stat = await (target as FileSystemDirectoryAdapter).statFile(segments);
          const pinned = dates.get(segments.join('/'));
          return pinned === undefined ? stat : { ...stat, lastModified: pinned };
        };
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as FileSystemDirectoryAdapter;
  return { proxy, reads };
}

const OLD = Date.now() - 60_000;

async function folder() {
  const root = new InMemoryFileSystemAdapter('root');
  const working = await root.getDirectory(['working'], { create: true });
  await working.writeFileBytes(['a.txt'], bytes('alpha'));
  await working.writeFileBytes(['b.txt'], bytes('bravo'));
  const dates = new Map<string, number>([['a.txt', OLD], ['b.txt', OLD]]);
  return { root, working, dates };
}

test('known hashes: a file with the same size and date is not read again', async () => {
  const { working, dates } = await folder();
  const { proxy, reads } = instrument(working, dates);
  const first = await scanBranchChanges(proxy, MAIN_BRANCH_ID, null);
  assert.deepEqual(reads.sort(), ['a.txt', 'b.txt']);
  reads.length = 0;
  const second = await scanBranchChanges(proxy, MAIN_BRANCH_ID, null, { knownHashes: knownHashesFromScan(first) });
  assert.deepEqual(reads, []);
  assert.deepEqual(second.added.map((f) => [f.path, f.sha256]), first.added.map((f) => [f.path, f.sha256]));
  assert.equal(second.changesSignature, first.changesSignature);
});

test('known hashes: a changed size or date forces a new hash; a new file is read', async () => {
  const { working, dates } = await folder();
  const { proxy, reads } = instrument(working, dates);
  const first = await scanBranchChanges(proxy, MAIN_BRANCH_ID, null);
  const known = knownHashesFromScan(first);
  reads.length = 0;
  // a.txt: different size, same date. b.txt: same size, different date.
  await working.writeFileBytes(['a.txt'], bytes('alpha longer'));
  dates.set('b.txt', OLD + 5000);
  await working.writeFileBytes(['c.txt'], bytes('charlie'));
  const next = await enumerateWorkingFolder(proxy, { knownHashes: known });
  assert.deepEqual(reads.sort(), ['a.txt', 'b.txt', 'c.txt']);
  assert.equal(next.files.find((f) => f.path === 'a.txt')!.sha256, hashBytes(bytes('alpha longer')));
});

test('known hashes: files modified just before the earlier scan are not trusted', async () => {
  const { working, dates } = await folder();
  const { proxy } = instrument(working, dates);
  const first = await scanBranchChanges(proxy, MAIN_BRANCH_ID, null);
  const scannedAt = Date.parse(first.scannedAt);
  const entry = (path: string, lastModified: number): FileEntry => ({ path, size: 1, sha256: 'x', lastModified });
  const known = knownHashesFromScan({
    ...first,
    added: [entry('recent', scannedAt - 500), entry('settled', scannedAt - 5000)],
    modified: [],
    unchanged: [],
  });
  assert.deepEqual([...known.keys()], ['settled']);
});

test('capture hashes every file itself and ignores the display cache', async () => {
  const { root, working, dates } = await folder();
  const vault = await root.getDirectory(['vault'], { create: true });
  await initializeProjectVault(working, vault, 'Cache test');
  const { proxy, reads } = instrument(working, dates);
  // A poisoned cache would change what a display scan shows ...
  const poisoned = new Map<string, FileEntry>([
    ['a.txt', { path: 'a.txt', size: 5, sha256: '0'.repeat(64), lastModified: OLD }],
  ]);
  const display = await scanBranchChanges(proxy, MAIN_BRANCH_ID, null, { knownHashes: poisoned });
  assert.equal(display.added.find((f) => f.path === 'a.txt')!.sha256, '0'.repeat(64));
  reads.length = 0;
  // ... but a saved revision is always built from the real bytes.
  const captured = await captureRevision(proxy, vault, {
    branchId: MAIN_BRANCH_ID,
    summary: 'first',
    notes: { problem: '', modification: '', observations: '' },
  });
  assert.ok(reads.includes('a.txt') && reads.includes('b.txt'));
  const saved = captured.revision.manifest.files.find((f) => f.path === 'a.txt')!;
  assert.equal(saved.sha256, hashBytes(bytes('alpha')));
  const source = fs.readFileSync(new URL('./revision-service.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('knownHashes'), false);
});
