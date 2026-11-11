import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryFileSystemAdapter, type FileSystemDirectoryAdapter } from './fs-adapter';
import { captureRevision } from './revision-service';
import { createHome, createHomeWorkspace, bringWorkspaceIntoHome, openHome } from './home-service';
import {
  createProject, importProject, createWorkspace, createManagedBranch, openWorkspace,
} from './workspace-service';
import {
  BLOCK_PATH_CHARS, CASE_ALLOWANCE, CRSWAP_CHARS, PROJECT_NAME_ALLOWANCE, WORKSPACE_NAME_ALLOWANCE, PathBudgetError, WARN_PATH_CHARS,
  addressSeparator, homeSetupWorstCase, internalReserve, joinAddress, longestRelativeFilePath, longestRelativePaths,
  projectWorstCase, projectWorstPath, workspaceWorstPath,
} from './path-budget';

const WIN_HOME = 'C:\\Users\\Mitesh\\Documents\\Cadtree';
const POSIX_HOME = '/Users/mitesh/Cadtree';
const notes = { problem: 'p', modification: 'm', observations: 'o' };

async function tree(dir: FileSystemDirectoryAdapter, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await dir.listEntries()).sort((a, b) => a.name.localeCompare(b.name))) {
    out.push(`${prefix}${entry.name}${entry.kind === 'directory' ? '/' : ''}`);
    if (entry.kind === 'directory') out.push(...(await tree(await dir.getDirectory([entry.name]), `${prefix}${entry.name}/`)));
  }
  return out;
}

/** An address under `base` padded so that `base\<pad>` plus `rest` characters reaches `target`. */
function addressFor(base: string, rest: number, target: number): string {
  const sep = addressSeparator(base);
  const padLength = target - rest - base.length - 1;
  assert.ok(padLength > 0, 'target too small for this base');
  return `${base}${sep}${'W'.repeat(padLength)}`;
}

// ---- pure helpers ----------------------------------------------------------------------------

test('joinAddress uses the address style without double separators', () => {
  assert.equal(joinAddress('C:\\Users\\Me\\Cadtree', 'Acme', 'projects/Gripper'), 'C:\\Users\\Me\\Cadtree\\Acme\\projects\\Gripper');
  assert.equal(joinAddress('C:\\Users\\Me\\Cadtree\\', 'Acme'), 'C:\\Users\\Me\\Cadtree\\Acme');
  assert.equal(joinAddress('C:\\', 'Acme'), 'C:\\Acme');
  assert.equal(joinAddress('\\\\server\\share\\Cadtree', 'Acme'), '\\\\server\\share\\Cadtree\\Acme');
  assert.equal(joinAddress('/Users/mitesh/Cadtree/', 'Acme', 'projects/Gripper'), '/Users/mitesh/Cadtree/Acme/projects/Gripper');
  assert.equal(joinAddress('/', 'Acme'), '/Acme');
  assert.equal(addressSeparator(POSIX_HOME), '/');
  assert.equal(addressSeparator(WIN_HOME), '\\');
});

test('projectWorstPath matches projectWorstCase and its own length on both address styles', () => {
  for (const address of [`${WIN_HOME}\\Acme\\projects\\Gripper`, `${POSIX_HOME}/Acme/projects/Gripper`]) {
    assert.equal(projectWorstPath({ projectAddress: address }).length, projectWorstCase({ projectPath: address }));
    assert.equal(projectWorstPath({ projectAddress: address }).length, address.length + 1 + internalReserve());
    for (const file of ['a.bin', `Parts/${'x'.repeat(150)}.SLDPRT`]) {
      const path = projectWorstPath({ projectAddress: address, longestUserFile: file });
      assert.equal(path.length, projectWorstCase({ projectPath: address, longestUserPath: file.length }));
      assert.ok(path.startsWith(address));
    }
  }
  assert.ok(!workspaceWorstPath(POSIX_HOME).includes('\\'));
  assert.equal(workspaceWorstPath(`${WIN_HOME}\\Acme`).length, WIN_HOME.length + 1 + 4 + 1 + 'projects'.length + 1 + PROJECT_NAME_ALLOWANCE + 1 + internalReserve());
});

test('homeSetupWorstCase uses both allowances and classifies', () => {
  const short = homeSetupWorstCase('C:\\Cadtree');
  assert.equal(short.status, 'ok');
  assert.equal(short.requiredLength, short.worstPath.length);
  const long = homeSetupWorstCase(`C:\\${'h'.repeat(120)}`);
  assert.equal(long.status, 'block');
  assert.ok(homeSetupWorstCase(POSIX_HOME).requiredLength > POSIX_HOME.length + 2 * PROJECT_NAME_ALLOWANCE);
});

test('longestRelativeFilePath lists names only', async () => {
  const root = new InMemoryFileSystemAdapter('src');
  await root.writeFileText(['a.txt'], 'x');
  await root.writeFileText(['deep', 'er', 'file-long.txt'], 'x');
  await root.getDirectory(['empty', 'deeper-folder'], { create: true });
  assert.equal(await longestRelativeFilePath(root), 'deep/er/file-long.txt');
  assert.equal(await longestRelativeFilePath(new InMemoryFileSystemAdapter('none')), '');
});

// ---- 1. workspace ----------------------------------------------------------------------------

const workspaceRest = (name: string) => 1 + name.length + 1 + 'projects'.length + 1 + PROJECT_NAME_ALLOWANCE + 1 + internalReserve();

for (const [label, base] of [['Windows', WIN_HOME], ['POSIX', POSIX_HOME]] as const) {
  test(`workspace creation: ok, warn and block (${label} address)`, async () => {
    const name = 'Acme Rigs';
    const rest = workspaceRest(name);
    const ok = await createHomeWorkspace(await freshHome(), name, { budget: { homeAddress: base } });
    assert.equal(ok.pathBudget.status, 'ok');
    assert.equal(ok.pathBudget.requiredLength, base.length + rest);
    assert.equal(ok.pathBudget.worstPath.length, ok.pathBudget.requiredLength);

    const warnHome = addressFor(base, rest, WARN_PATH_CHARS + 5);
    const warned = await createHomeWorkspace(await freshHome(), name, { budget: { homeAddress: warnHome } });
    assert.equal(warned.pathBudget.status, 'warn');
    assert.equal(warned.pathBudget.requiredLength, WARN_PATH_CHARS + 5);
    assert.ok(warned.workspace.projects.length === 0 && warned.directory === name);

    const blockHome = await freshHome();
    const before = await tree(blockHome);
    const blockAddress = addressFor(base, rest, BLOCK_PATH_CHARS + 1);
    await assert.rejects(createHomeWorkspace(blockHome, name, { budget: { homeAddress: blockAddress } }), (error) => {
      assert.ok(error instanceof PathBudgetError);
      assert.equal(error.requiredLength, BLOCK_PATH_CHARS + 1);
      assert.equal(error.limit, BLOCK_PATH_CHARS);
      assert.equal(error.excess, 1);
      assert.equal(error.shorten, 'workspace');
      assert.equal(error.checkedName, name);
      assert.equal(error.worstPath.length, error.requiredLength);
      assert.ok(error.worstPath.startsWith(blockAddress));
      return true;
    });
    assert.deepEqual(await tree(blockHome), before);

    // The boundary: exactly 240 warns.
    const edge = await createHomeWorkspace(await freshHome(), name, { budget: { homeAddress: addressFor(base, rest, BLOCK_PATH_CHARS) } });
    assert.equal(edge.pathBudget.status, 'warn');
  });
}

async function freshHome() {
  const home = new InMemoryFileSystemAdapter('Cadtree');
  await createHome(home);
  return home;
}

test('workspace counter name is the one checked', async () => {
  const home = await freshHome();
  const rest1 = workspaceRest('Acme Rigs');
  const address = addressFor(WIN_HOME, rest1, BLOCK_PATH_CHARS); // first: 240, second ' (2)': 244
  const first = await createHomeWorkspace(home, 'Acme Rigs', { budget: { homeAddress: address } });
  assert.equal(first.pathBudget.status, 'warn');
  const before = await tree(home);
  await assert.rejects(createHomeWorkspace(home, 'Acme Rigs', { budget: { homeAddress: address } }), (error) => {
    assert.ok(error instanceof PathBudgetError);
    assert.equal(error.checkedName, 'Acme Rigs (2)');
    assert.equal(error.requiredLength, BLOCK_PATH_CHARS + ' (2)'.length);
    return true;
  });
  assert.deepEqual(await tree(home), before);
});

test('unknown home address: unchecked and the action proceeds', async () => {
  const home = await freshHome();
  const created = await createHomeWorkspace(home, 'x'.repeat(200));
  assert.deepEqual(created.pathBudget, { status: 'unchecked', requiredLength: 0, worstPath: '' });
  const withEmptyBudget = await createHomeWorkspace(home, 'Other', { budget: {} });
  assert.equal(withEmptyBudget.pathBudget.status, 'unchecked');
});

async function sourceWorkspaceWithFile(file: string[]) {
  const source = new InMemoryFileSystemAdapter('Source');
  await createWorkspace(source);
  const project = await createProject(source, 'Gripper');
  await project.workingFolders['branch-main']!.writeFileText(file, 'cad');
  await captureRevision(project.workingFolders['branch-main']!, project.vaultDir, {
    branchId: 'branch-main', summary: 'Base', notes, workingFolders: project.workingFolders,
  });
  return { source, project };
}

test('bringing a workspace in checks each project with its real name and longest file', async () => {
  const { source } = await sourceWorkspaceWithFile(['Parts', `${'d'.repeat(132)}.SLDPRT`]);
  const home = await freshHome();
  const before = await tree(home);
  // The workspace name alone fits easily; the adopted project's deep file does not.
  await assert.rejects(bringWorkspaceIntoHome(home, source, { budget: { homeAddress: WIN_HOME } }), (error) => {
    assert.ok(error instanceof PathBudgetError);
    assert.equal(error.shorten, 'workspace');
    assert.ok(error.worstPath.includes('projects\\Gripper\\'));
    assert.ok(error.worstPath.endsWith('.SLDPRT.crswap'));
    return true;
  });
  assert.deepEqual(await tree(home), before);
  const shallow = await sourceWorkspaceWithFile(['Parts', 'Collar.SLDPRT']);
  const adopted = await bringWorkspaceIntoHome(home, shallow.source, { budget: { homeAddress: WIN_HOME } });
  assert.equal(adopted.pathBudget.status, 'ok');
  assert.equal((await openHome(home)).workspaces.length, 1);
});

// ---- 2. project ------------------------------------------------------------------------------

async function freshWorkspace() {
  const root = new InMemoryFileSystemAdapter('Acme');
  await createWorkspace(root);
  return root;
}
const projectRest = (leaf: string, file = '') =>
  Math.max(1 + 'projects'.length + 1 + leaf.length + 1 + internalReserve(),
    file ? 1 + 'projects'.length + 1 + leaf.length + 1 + 'working'.length + 1 + CASE_ALLOWANCE + 1 + file.length + CRSWAP_CHARS : 0);

for (const [label, base] of [['Windows', WIN_HOME], ['POSIX', POSIX_HOME]] as const) {
  test(`project creation: ok, warn and block (${label} address)`, async () => {
    const leaf = 'Packaging Gripper';
    const rest = projectRest(leaf);
    const root = await freshWorkspace();
    const ok = await createProject(root, leaf, { budget: { workspaceAddress: joinAddress(base, 'Acme') } });
    assert.equal(ok.pathBudget!.status, 'ok');
    assert.equal(ok.pathBudget!.requiredLength, joinAddress(base, 'Acme').length + rest);

    const warned = await createProject(root, 'Warn Me', { budget: { workspaceAddress: addressFor(base, projectRest('Warn Me'), 215) } });
    assert.equal(warned.pathBudget!.status, 'warn');
    assert.equal(warned.pathBudget!.requiredLength, 215);

    const before = await tree(root);
    const blockAddress = addressFor(base, projectRest('Block Me'), BLOCK_PATH_CHARS + 3);
    await assert.rejects(createProject(root, 'Block Me', { budget: { workspaceAddress: blockAddress } }), (error) => {
      assert.ok(error instanceof PathBudgetError);
      assert.equal(error.shorten, 'project');
      assert.equal(error.checkedName, 'Block Me');
      assert.equal(error.excess, 3);
      return true;
    });
    assert.deepEqual(await tree(root), before);
    assert.equal((await openWorkspace(root)).projects.length, 2);
  });
}

test('project counter name is the one checked', async () => {
  const root = await freshWorkspace();
  const address = addressFor(WIN_HOME, projectRest('Gripper'), BLOCK_PATH_CHARS);
  // A leftover entry with the same name makes the final name "Gripper (2)".
  await root.writeFileText(['projects', 'Gripper'], 'leftover');
  const before = await tree(root);
  await assert.rejects(createProject(root, 'Gripper', { budget: { workspaceAddress: address } }), (error) => {
    assert.ok(error instanceof PathBudgetError);
    assert.equal(error.checkedName, 'Gripper (2)');
    assert.equal(error.requiredLength, BLOCK_PATH_CHARS + ' (2)'.length);
    return true;
  });
  assert.deepEqual(await tree(root), before);
});

test('import with a deep source file pushes the project to block; nothing is written', async () => {
  const root = await freshWorkspace();
  const source = new InMemoryFileSystemAdapter('CAD');
  const file = `Parts/${'x'.repeat(100)}.SLDPRT`;
  await source.writeFileText(file.split('/'), 'cad');
  const address = addressFor(WIN_HOME, projectRest('Imported', file), BLOCK_PATH_CHARS);
  // Create the unchecked-equivalent first: the same project with a short file is fine.
  const short = new InMemoryFileSystemAdapter('CAD2');
  await short.writeFileText(['a.SLDPRT'], 'cad');
  const fine = await importProject(root, short, 'Short', { budget: { workspaceAddress: addressFor(WIN_HOME, projectRest('Short', 'a.SLDPRT'), 175) } });
  assert.equal(fine.pathBudget!.status, 'ok');

  const before = await tree(root);
  const sourceBefore = await tree(source);
  const tooLong = `${address}W`;
  await assert.rejects(importProject(root, source, 'Imported', { budget: { workspaceAddress: tooLong } }), (error) => {
    assert.ok(error instanceof PathBudgetError);
    assert.equal(error.requiredLength, BLOCK_PATH_CHARS + 1);
    assert.ok(error.worstPath.endsWith('.SLDPRT.crswap'));
    return true;
  });
  assert.deepEqual(await tree(root), before);
  assert.deepEqual(await tree(source), sourceBefore);
  // Exactly at the limit it warns and imports.
  const warned = await importProject(root, source, 'Imported', { budget: { workspaceAddress: address } });
  assert.equal(warned.pathBudget!.status, 'warn');
  assert.equal(warned.pathBudget!.requiredLength, BLOCK_PATH_CHARS);
});

test('adopting a managed project checks its working folders', async () => {
  const { source: original, project } = await sourceWorkspaceWithFile(['Parts', `${'d'.repeat(100)}.SLDPRT`]);
  const sourceDir = await original.getDirectory(['projects', 'Gripper']);
  const root = await freshWorkspace();
  const before = await tree(root);
  await assert.rejects(importProject(root, sourceDir, 'ignored', { budget: { workspaceAddress: `${WIN_HOME}\\${'W'.repeat(60)}` } }), PathBudgetError);
  assert.deepEqual(await tree(root), before);
  void project;
  const adopted = await importProject(root, sourceDir, 'ignored', { budget: { workspaceAddress: WIN_HOME } });
  assert.notEqual(adopted.pathBudget!.status, 'unchecked');
});

test('unknown workspace address: project creation is unchecked and proceeds', async () => {
  const root = await freshWorkspace();
  const project = await createProject(root, 'y'.repeat(120));
  assert.equal(project.pathBudget!.status, 'unchecked');
});

// ---- 3. design case ----------------------------------------------------------

async function projectWithRevision(file = 'Parts/Collar.SLDPRT') {
  const root = await freshWorkspace();
  const project = await createProject(root, 'Gripper');
  const main = project.workingFolders['branch-main']!;
  await main.writeFileText(file.split('/'), 'cad');
  const first = await captureRevision(main, project.vaultDir, {
    branchId: 'branch-main', summary: 'Base', notes, workingFolders: project.workingFolders,
  });
  return { root, project, revisionId: first.revision.manifest.revisionId, containerPath: project.record.containerPath, file };
}
const caseRest = (containerPath: string, folder: string, file: string) =>
  1 + containerPath.length + 1 + 'working'.length + 1 + folder.length + 1 + file.length + CRSWAP_CHARS;

for (const [label, base] of [['Windows', WIN_HOME], ['POSIX', POSIX_HOME]] as const) {
  test(`design case: ok, warn and block (${label} address)`, async () => {
    const { root, revisionId, containerPath, file } = await projectWithRevision();
    const make = (name: string, target: number, id: string) =>
      createManagedBranch(root, containerPath, {
        sourceRevisionId: revisionId, name, reason: 'try', newBranchId: () => id,
        budget: { workspaceAddress: addressFor(base, caseRest(containerPath, name, file), target) },
      });
    const ok = await make('Lighter collar', 150, '20260101-000000-aaaaaa');
    assert.equal(ok.pathBudget.status, 'ok');
    assert.equal(ok.pathBudget.requiredLength, 150);
    assert.ok(ok.pathBudget.worstPath.endsWith('Collar.SLDPRT.crswap'));
    const warned = await make('Thicker collar', 220, '20260101-000000-bbbbbb');
    assert.equal(warned.pathBudget.status, 'warn');

    const before = await tree(root);
    await assert.rejects(make('Stiffer collar', BLOCK_PATH_CHARS + 2, '20260101-000000-cccccc'), (error) => {
      assert.ok(error instanceof PathBudgetError);
      assert.equal(error.shorten, 'case');
      assert.equal(error.checkedName, 'Stiffer collar');
      assert.equal(error.excess, 2);
      assert.ok(error.worstPath.includes(`working${base.startsWith('/') ? '/' : '\\'}Stiffer collar`));
      return true;
    });
    assert.deepEqual(await tree(root), before);
  });
}

test('design case counter name is the one checked', async () => {
  const { root, revisionId, containerPath, file } = await projectWithRevision();
  const address = addressFor(WIN_HOME, caseRest(containerPath, 'Lighter collar', file), 237);
  await (await root.getDirectory([...containerPath.split('/'), 'working'])).getDirectory(['Lighter collar'], { create: true });
  const before = await tree(root);
  await assert.rejects(
    createManagedBranch(root, containerPath, { sourceRevisionId: revisionId, name: 'Lighter collar', reason: 'try', budget: { workspaceAddress: address } }),
    (error) => {
      assert.ok(error instanceof PathBudgetError);
      assert.equal(error.checkedName, 'Lighter collar (2)');
      assert.equal(error.requiredLength, 237 + ' (2)'.length);
      return true;
    },
  );
  assert.deepEqual(await tree(root), before);
});

test('design case is unchecked without an address and proceeds', async () => {
  const { root, revisionId, containerPath } = await projectWithRevision();
  const created = await createManagedBranch(root, containerPath, { sourceRevisionId: revisionId, name: 'Lighter collar', reason: 'try' });
  assert.equal(created.pathBudget.status, 'unchecked');
});

test('design case checks the deepest file of the source revision', async () => {
  const deep = `Parts/${'x'.repeat(120)}.SLDPRT`;
  const { root, revisionId, containerPath } = await projectWithRevision(deep);
  const before = await tree(root);
  await assert.rejects(
    createManagedBranch(root, containerPath, {
      sourceRevisionId: revisionId, name: 'Lighter collar', reason: 'try',
      budget: { workspaceAddress: addressFor(WIN_HOME, caseRest(containerPath, 'Lighter collar', deep), BLOCK_PATH_CHARS + 1) },
    }),
    PathBudgetError,
  );
  assert.deepEqual(await tree(root), before);
});

// ---- existing projects are never blocked -----------------------------------------------------

test('an existing over-limit project still opens and saves', async () => {
  const root = await freshWorkspace();
  // Created while the address was unknown, so no check ran.
  const project = await createProject(root, 'Gripper');
  const deep = ['Parts', `${'x'.repeat(200)}.SLDPRT`];
  const main = project.workingFolders['branch-main']!;
  await main.writeFileText(deep, 'cad');
  const reopened = await openWorkspace(root);
  assert.equal(reopened.projects[0].status, 'ready');
  const saved = await captureRevision(main, project.vaultDir, {
    branchId: 'branch-main', summary: 'Deep', notes, workingFolders: project.workingFolders,
  });
  assert.equal(saved.revision.manifest.displayNumber, 1);
  // Constants stay what the approved rules say.
  assert.equal(CASE_ALLOWANCE, 32);
});

test('workspace name allowance is its own constant and home setup counts it', () => {
  assert.equal(WORKSPACE_NAME_ALLOWANCE, 24);
  const home = homeSetupWorstCase(WIN_HOME);
  assert.equal(home.requiredLength, WIN_HOME.length + 1 + WORKSPACE_NAME_ALLOWANCE + 1 + 'projects'.length + 1 + PROJECT_NAME_ALLOWANCE + 1 + internalReserve());
});

test('an import whose deepest item is an empty folder blocks; folders get no .crswap', async () => {
  const root = await freshWorkspace();
  const source = new InMemoryFileSystemAdapter('CAD');
  await source.writeFileText(['a.SLDPRT'], 'cad');
  const deepDir = `Deep/${'x'.repeat(110)}`;
  await source.getDirectory(deepDir.split('/'), { create: true });
  const rest = 1 + 'projects'.length + 1 + 'Imported'.length + 1 + 'working'.length + 1 + CASE_ALLOWANCE + 1 + deepDir.length; // no .crswap
  const atLimit = addressFor(WIN_HOME, rest, BLOCK_PATH_CHARS);
  const before = await tree(root);
  await assert.rejects(importProject(root, source, 'Imported', { budget: { workspaceAddress: `${atLimit}W` } }), (error) => {
    assert.ok(error instanceof PathBudgetError);
    assert.equal(error.requiredLength, BLOCK_PATH_CHARS + 1);
    assert.ok(error.worstPath.endsWith('x'.repeat(110)));
    return true;
  });
  assert.deepEqual(await tree(root), before);
  const ok = await importProject(root, source, 'Imported', { budget: { workspaceAddress: atLimit } });
  assert.equal(ok.pathBudget!.requiredLength, BLOCK_PATH_CHARS);
});

test('longestRelativePaths tracks the deepest folder separately', async () => {
  const root = new InMemoryFileSystemAdapter('src');
  await root.writeFileText(['a.txt'], 'x');
  await root.getDirectory(['empty', 'deeper-folder'], { create: true });
  const found = await longestRelativePaths(root);
  assert.deepEqual(found, { file: 'a.txt', dir: 'empty/deeper-folder' });
});
