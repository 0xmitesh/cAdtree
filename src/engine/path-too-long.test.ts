import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter, RealFileSystemAdapter, FileConflictError } from './fs-adapter';
import { PathTooLongError, REAL_LIMITS, diagnosePathFailure } from './path-limits';
import { PathTooLongError as ReExported, joinAddress } from './path-budget';
import { captureRevision } from './revision-service';
import { createProject, createWorkspace, createManagedBranch } from './workspace-service';
import { pathTooLongMessage, presentPathBudgetError } from '../utils/path-budget-message';

const WIN = 'C:\\Users\\Me\\Cadtree';
const POSIX = '/Users/me/Cadtree';
const dom = (name: string) => new DOMException('simulated', name);
/** An address on `base`'s platform whose child path `rest` (relative, "/"-joined) has exactly `target` characters. */
function addressFor(base: string, rest: string, target: number): string {
  const sep = base.startsWith('/') ? '/' : '\\';
  const restLength = rest.split('/').join(sep).length + 1;
  const pad = target - restLength - base.length - 1;
  assert.ok(pad > 0);
  return `${base}${sep}${'W'.repeat(pad)}`;
}

// ---- Fake Chrome directory handle (only what RealFileSystemAdapter calls) ----------------------
type Rule = (op: 'dir' | 'file' | 'writable' | 'write' | 'close', path: string[]) => DOMException | undefined;
function fakeHandle(rule: Rule, path: string[] = [], files = new Set<string>(), dirs = new Set<string>(['']), key = ''): FileSystemDirectoryHandle {
  const handle = {
    kind: 'directory',
    name: path[path.length - 1] ?? 'root',
    async *[Symbol.asyncIterator]() { /* empty */ },
    async getDirectoryHandle(name: string, o?: { create?: boolean }) {
      const child = key ? `${key}/${name}` : name;
      if (!dirs.has(child)) {
        if (!o?.create) throw dom('NotFoundError');
        const err = rule('dir', [...path, name]);
        if (err) throw err;
        dirs.add(child);
      }
      return fakeHandle(rule, [...path, name], files, dirs, child);
    },
    async getFileHandle(name: string, o?: { create?: boolean }) {
      const full = [...path, name];
      const id = key ? `${key}/${name}` : name;
      if (!files.has(id)) {
        if (!o?.create) throw dom('NotFoundError');
        const err = rule('file', full);
        if (err) throw err;
        files.add(id);
      }
      return {
        async createWritable() {
          const e = rule('writable', full);
          if (e) throw e;
          return {
            async write() { const x = rule('write', full); if (x) throw x; },
            async close() { const x = rule('close', full); if (x) throw x; },
            async abort() { /* noop */ },
          };
        },
      };
    },
    async removeEntry() { /* noop */ },
  };
  return handle as unknown as FileSystemDirectoryHandle;
}
const failAbove = (name: string, minLength: number, joiner: string, base: string): Rule => (_op, path) => {
  const full = [base, ...path].join(joiner);
  return full.length >= minLength ? dom(name) : undefined;
};

test('PathTooLongError is exported from path-budget and carries the details', () => {
  assert.equal(ReExported, PathTooLongError);
  const cause = dom('InvalidStateError');
  const e = new PathTooLongError('C:\\x', 3, 2, 'folder', cause);
  assert.equal(e.cause, cause);
  assert.deepEqual([e.fullPath, e.length, e.maxAllowed, e.operation], ['C:\\x', 3, 2, 'folder']);
});

for (const errName of ['InvalidStateError', 'NotFoundError']) {
  test(`folder create at/over the real limit becomes PathTooLongError (${errName}, Windows)`, async () => {
    const address = addressFor(WIN, 'Acme/projects', REAL_LIMITS.windows.folder);
    const rule: Rule = (op, path) => (op === 'dir' && path.length === 2 ? dom(errName) : undefined);
    const root = new RealFileSystemAdapter(fakeHandle(rule), { address });
    await root.getDirectory(['Acme'], { create: true });
    await assert.rejects(root.getDirectory(['Acme', 'projects'], { create: true }), (error) => {
      assert.ok(error instanceof PathTooLongError);
      assert.equal(error.operation, 'folder');
      assert.equal(error.maxAllowed, 247);
      assert.equal(error.length, 248);
      assert.equal(error.fullPath, joinAddress(address, 'Acme', 'projects'));
      assert.ok((error.cause as DOMException).name === errName);
      return true;
    });
  });
}

test('folder create just under the limit rethrows the original error (short path stays NotFound/InvalidState)', async () => {
  const rule: Rule = (op) => (op === 'dir' ? dom('InvalidStateError') : undefined);
  const under = addressFor(WIN, 'Acme', REAL_LIMITS.windows.folder - 1);
  await assert.rejects(new RealFileSystemAdapter(fakeHandle(rule), { address: under }).getDirectory(['Acme'], { create: true }), (e) => e instanceof DOMException && e.name === 'InvalidStateError');
  const short = new RealFileSystemAdapter(fakeHandle(rule), { address: WIN });
  await assert.rejects(short.getDirectory(['Acme'], { create: true }), (e) => e instanceof DOMException && e.name === 'InvalidStateError');
  // A genuinely missing folder on a short path is still NotFoundError (and read-only lookups are never converted).
  const missing = new RealFileSystemAdapter(fakeHandle(() => undefined), { address: addressFor(WIN, 'a', 300) });
  await assert.rejects(missing.getDirectory(['a'], { create: false }), (e) => e instanceof DOMException && e.name === 'NotFoundError');
});

test('POSIX folder limit is 1024', async () => {
  const rule: Rule = (op) => (op === 'dir' ? dom('InvalidStateError') : undefined);
  const at = new RealFileSystemAdapter(fakeHandle(rule), { address: addressFor(POSIX, 'x', 1024) });
  await assert.rejects(at.getDirectory(['x'], { create: true }), (e) => e instanceof PathTooLongError && e.maxAllowed === 1023 && e.fullPath.includes('/'));
  const below = new RealFileSystemAdapter(fakeHandle(rule), { address: addressFor(POSIX, 'x', 1023) });
  await assert.rejects(below.getDirectory(['x'], { create: true }), (e) => e instanceof DOMException);
});

for (const op of ['file', 'writable', 'write', 'close'] as const) {
  test(`file ${op} failure at the real limit becomes PathTooLongError (Windows write and stream)`, async () => {
    const rule: Rule = (o) => (o === op ? dom('InvalidStateError') : undefined);
    const address = addressFor(WIN, 'Parts/Collar.SLDPRT', REAL_LIMITS.windows['file-write']);
    const root = new RealFileSystemAdapter(fakeHandle(rule), { address });
    const expected = joinAddress(address, 'Parts', 'Collar.SLDPRT');
    const check = (error: unknown) => {
      assert.ok(error instanceof PathTooLongError);
      assert.equal(error.operation, 'file');
      assert.equal(error.maxAllowed, 251);
      assert.equal(error.fullPath, expected);
      return true;
    };
    await assert.rejects(root.writeFileBytes(['Parts', 'Collar.SLDPRT'], new Uint8Array([1])), check);
    await assert.rejects(
      root.writeFileStream(['Parts', 'Collar.SLDPRT'], new Blob([new Uint8Array([1])]).stream() as ReadableStream<Uint8Array>),
      check,
    );
  });
}

test('POSIX file write limit is 1017; below it the original error is kept; unknown address never guesses', async () => {
  const rule: Rule = (o) => (o === 'close' ? dom('InvalidStateError') : undefined);
  const at = new RealFileSystemAdapter(fakeHandle(rule), { address: addressFor(POSIX, 'f.bin', 1017) });
  await assert.rejects(at.writeFileBytes(['f.bin'], new Uint8Array([1])), (e) => e instanceof PathTooLongError && e.maxAllowed === 1016);
  const below = new RealFileSystemAdapter(fakeHandle(rule), { address: addressFor(POSIX, 'f.bin', 1016) });
  await assert.rejects(below.writeFileBytes(['f.bin'], new Uint8Array([1])), (e) => e instanceof DOMException && e.name === 'InvalidStateError');
  const unknown = new RealFileSystemAdapter(fakeHandle(rule));
  await assert.rejects(unknown.writeFileBytes(['f.bin'], new Uint8Array([1])), (e) => e instanceof DOMException && e.name === 'InvalidStateError');
});

test('other errors are never converted, even on a long path', async () => {
  const address = addressFor(WIN, 'f.bin', 400);
  for (const name of ['NotAllowedError', 'QuotaExceededError', 'AbortError']) {
    const root = new RealFileSystemAdapter(fakeHandle((o) => (o === 'write' ? dom(name) : undefined)), { address });
    await assert.rejects(root.writeFileBytes(['f.bin'], new Uint8Array([1])), (e) => e instanceof DOMException && e.name === name);
  }
  assert.equal(diagnosePathFailure(new Error('x'), address, 'file-write') instanceof PathTooLongError, false);
});

test('address is inherited by child adapters, including ones created before setAddress', async () => {
  const rule: Rule = (o) => (o === 'file' ? dom('InvalidStateError') : undefined);
  const root = new RealFileSystemAdapter(fakeHandle(rule));
  const child = await root.getDirectory(['Acme', 'projects'], { create: true });
  assert.equal(root.address, undefined);
  assert.equal(child.address, undefined);
  root.setAddress(POSIX);
  assert.equal(child.address, `${POSIX}/Acme/projects`);
  const grand = await child.getDirectory(['P'], { create: true });
  assert.equal(grand.address, `${POSIX}/Acme/projects/P`);
  assert.equal(new RealFileSystemAdapter(fakeHandle(rule), { address: WIN }).address, WIN);
  const mem = new InMemoryFileSystemAdapter('root');
  mem.setAddress(WIN);
  assert.equal((await mem.getDirectory(['a', 'b'], { create: true })).address, `${WIN}\\a\\b`);
});

test('FileConflictError is unaffected by a long address', async () => {
  const address = addressFor(WIN, 'f.bin', 400);
  const rule: Rule = () => dom('InvalidStateError');
  const handle = fakeHandle(() => undefined);
  const root = new RealFileSystemAdapter(handle, { address });
  await root.writeFileBytes(['f.bin'], new Uint8Array([1]));
  (handle as unknown as { [Symbol.asyncIterator]: unknown })[Symbol.asyncIterator] = async function* () { yield ['f.bin', { kind: 'file' }]; };
  await assert.rejects(root.writeFileBytes(['f.bin'], new Uint8Array([2]), { exclusive: true }), FileConflictError);
  void rule;
  const mem = new InMemoryFileSystemAdapter('root');
  mem.setAddress(address);
  await mem.writeFileText(['a'], 'x');
  await assert.rejects(mem.writeFileText(['a'], 'y', { exclusive: true }), FileConflictError);
});

test('message helper words the failure for both platforms and keeps the cause', () => {
  const cause = dom('InvalidStateError');
  const win = new PathTooLongError('C:\\a\\b', 300, 247, 'folder', cause);
  assert.equal(
    pathTooLongMessage(win),
    "Path too long: C:\\a\\b (300 characters; this computer's limit is 247). Shorten the folder or file names along this path, or move your Cadtree home closer to the drive (e.g. C:\\Cadtree).",
  );
  assert.equal(pathTooLongMessage(win), win.message);
  const posix = new PathTooLongError('/a/b', 1100, 1023, 'folder', cause);
  assert.ok(pathTooLongMessage(posix).endsWith('(e.g. /Users/<you>/Cadtree).'));
  const shown = presentPathBudgetError(win) as Error;
  assert.equal(shown.message, pathTooLongMessage(win));
  assert.equal(shown.cause, win);
  assert.equal(presentPathBudgetError(cause), cause);
});

// ---- end to end: case creation writing a deep user file ----------------------------------------
test('design case creation surfaces the real path when a deep user file cannot be written', async () => {
  const root = new InMemoryFileSystemAdapter('Acme');
  await createWorkspace(root);
  const project = await createProject(root, 'Gripper');
  const main = project.workingFolders['branch-main']!;
  await main.writeFileText(['Parts', 'Collar.SLDPRT'], 'cad');
  const first = await captureRevision(main, project.vaultDir, {
    branchId: 'branch-main', summary: 'Base', notes: { problem: 'p', modification: 'm', observations: 'o' }, workingFolders: project.workingFolders,
  });
  const containerPath = project.record.containerPath;
  const rest = `${containerPath}/working/Lighter collar/Parts/Collar.SLDPRT`;
  const address = addressFor(WIN, rest, REAL_LIMITS.windows['file-write'] + 3);
  root.setAddress(address);
  const failing = joinAddress(address, ...rest.split('/'));
  root.simulateFailureAt(failing, dom('InvalidStateError'));
  await assert.rejects(
    createManagedBranch(root, containerPath, { sourceRevisionId: first.revision.manifest.revisionId, name: 'Lighter collar', reason: 'try' }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`Path too long: ${failing} (${failing.length} characters; this computer's limit is 251)`), error.message);
      return true;
    },
  );
});

test('POSIX file create fails at 1024, not 1017; the message shows the maximum allowed', async () => {
  const rule: Rule = (o) => (o === 'file' ? dom('InvalidStateError') : undefined);
  const at = new RealFileSystemAdapter(fakeHandle(rule), { address: addressFor(POSIX, 'f.bin', 1024) });
  await assert.rejects(at.writeFileBytes(['f.bin'], new Uint8Array([1])), (e) => e instanceof PathTooLongError && e.maxAllowed === 1023 && /limit is 1023\)/.test(e.message));
  const mid = new RealFileSystemAdapter(fakeHandle(rule), { address: addressFor(POSIX, 'f.bin', 1020) });
  await assert.rejects(mid.writeFileBytes(['f.bin'], new Uint8Array([1])), (e) => e instanceof DOMException);
});

// ---- RealFileSystemAdapter.getDirectory exclusiveCheck: conflict class vs swallowed probe errors ----

function probeHandle(onFile: () => never | void) {
  const calls: string[] = [];
  const child = {} as FileSystemDirectoryHandle;
  const handle = {
    getFileHandle: async () => {
      calls.push('getFileHandle');
      onFile();
      return {} as FileSystemFileHandle;
    },
    getDirectoryHandle: async () => {
      calls.push('getDirectoryHandle');
      return child;
    },
  };
  return { handle: handle as unknown as FileSystemDirectoryHandle, calls };
}

test('RealFileSystemAdapter exclusiveCheck: an existing file at the segment rejects with FileConflictError', async () => {
  const { handle, calls } = probeHandle(() => {});
  await assert.rejects(
    new RealFileSystemAdapter(handle).getDirectory(['x'], { create: true, exclusiveCheck: true }),
    (e) => e instanceof FileConflictError && /Destination conflict/.test(e.message),
  );
  assert.deepEqual(calls, ['getFileHandle']);
});

test('RealFileSystemAdapter exclusiveCheck: NotFoundError and TypeMismatchError from the file probe are swallowed', async () => {
  for (const name of ['NotFoundError', 'TypeMismatchError']) {
    const { handle, calls } = probeHandle(() => {
      throw new DOMException('probe', name);
    });
    const dir = await new RealFileSystemAdapter(handle).getDirectory(['x'], { create: true, exclusiveCheck: true });
    assert.ok(dir instanceof RealFileSystemAdapter);
    assert.deepEqual(calls, ['getFileHandle', 'getDirectoryHandle']);
  }
});
