import { test, expect } from '@playwright/test';

// These addresses simulate platform syntax. The browser runs on the host OS;
// OPFS and substituted pickers do not qualify native macOS/Linux directories.
for (const rootAddress of ['D:\\Cadtree', '\\\\server\\share\\Cadtree', '/Users/mitesh/Documents/Cadtree', '/home/mitesh/工程/Cadtree']) test(`folder setup and shortcuts: ${rootAddress}`, async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.evaluate(async () => {
    const storage = await navigator.storage.getDirectory();
    const home = await storage.getDirectoryHandle(`platform-${crypto.randomUUID()}`, { create: true });
    Object.assign(window, { platformHome: home, copiedPaths: [], showDirectoryPicker: async () => home });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (path: string) => (window as any).copiedPaths.push(path) } });
  });
  await page.getByRole('button', { name: 'Start my Cadtree home', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'Complete home setup' });
  await expect(setup).toContainText('cannot compare it with the selected folder');
  await setup.getByRole('textbox', { name: 'Cadtree home folder address' }).fill(rootAddress);
  await setup.getByRole('button', { name: 'Complete setup', exact: true }).click();
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.getByRole('textbox', { name: 'Workspace name' }).fill('Engineering');
  await page.getByRole('dialog').getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Actuator');
  await page.getByRole('dialog').getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  const original = 'Parts/工程/Bracket.SLDPRT';
  const renamed = 'Parts/工程/bracket-v2.SLDPRT';
  const initial = await page.evaluate(async file => {
    const fsPath = '/src/engine/fs-adapter.ts', homePath = '/src/engine/home-service.ts';
    const [{ RealFileSystemAdapter }, { openHome }] = await Promise.all([import(fsPath), import(homePath)]);
    const home = await openHome(new RealFileSystemAdapter((window as any).platformHome));
    const entry = home.workspaces[0], project = entry.workspace.projects[0].project;
    await project.workingFolders['branch-main'].writeFileText(file.split('/'), 'baseline bytes');
    Object.assign(window, { platformProject: project, platformWorkspace: entry.workspace.root });
    return { prefix: `${entry.directory}/${project.workingPaths['branch-main']}`, workspaceDirectory: entry.directory };
  }, original);
  const nav = (name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
  const save = async (summary: string) => {
    await page.getByRole('textbox', { name: /Revision summary/ }).fill(summary);
    await page.getByRole('button', { name: 'Save revision', exact: true }).click();
    await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('heading', { name: '0 changed files' })).toBeVisible();
  };
  const separator = rootAddress.startsWith('/') ? '/' : '\\';
  const folder = (relative: string) => rootAddress + separator + relative.split('/').join(separator);
  await nav('Changes');
  await page.getByRole('button', { name: 'Scan for changes', exact: true }).click();
  await save('Initial component');
  await page.getByRole('button', { name: /Show 1 unchanged files/ }).click();
  await page.getByLabel(/^File actions/).click();
  await page.getByRole('button', { name: /^Copy folder path/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).copiedPaths.at(-1))).toBe(folder(initial.prefix + '/Parts/工程'));
  await nav('History');
  await expect(page.getByRole('button', { name: /^Copy folder path/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create design case from this revision', exact: true }).click();
  await page.getByRole('textbox', { name: 'Case name' }).fill('Alternative');
  await page.getByRole('textbox', { name: 'Engineering reason' }).fill('Explore another fit');
  await page.getByRole('dialog').getByRole('button', { name: 'Create design case', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  const branchId = await page.locator('.project-context-header').getAttribute('data-branch-id');
  const branch = await page.evaluate(async ({ branchId, original, renamed }) => {
    const path = '/src/engine/workspace-service.ts';
    const { resolveManagedProject } = await import(path);
    const project = await resolveManagedProject((window as any).platformWorkspace, (window as any).platformProject.record.containerPath);
    const working = project.workingFolders[branchId!];
    await working.removeEntry(original.split('/'));
    await working.writeFileText(renamed.split('/'), 'changed bytes');
    return { relative: project.workingPaths[branchId!] };
  }, { branchId, original, renamed });
  await nav('Changes');
  await page.getByRole('button', { name: 'Scan for changes', exact: true }).click();
  await page.getByRole('combobox', { name: `New path for ${original}` }).selectOption(renamed);
  await page.getByRole('button', { name: 'Confirm rename', exact: true }).click();
  await save('Confirmed rename');
  const showUnchanged = page.getByRole('button', { name: /Show 1 unchanged files/ });
  if (await showUnchanged.isVisible()) await showUnchanged.click();
  await page.getByLabel(/^File actions/).click();
  await page.getByRole('button', { name: /^Copy folder path/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).copiedPaths.at(-1))).toBe(folder(`${initial.workspaceDirectory}/${branch.relative}/Parts/工程`));
  await page.reload();
  await page.getByRole('button', { name: /^Return to platform-/ }).click();
  await expect(setup).toHaveCount(0);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  // Native browser IDB must retain the address bound to its real OPFS handle.
  expect(await page.evaluate(async () => {
    const prefsPath = '/src/engine/idb-store.ts', homePath = '/src/engine/home-service.ts', fsPath = '/src/engine/fs-adapter.ts';
    const [{ getRememberedHome, getWorkspacePath }, { openHome }, { RealFileSystemAdapter }] = await Promise.all([import(prefsPath), import(homePath), import(fsPath)]);
    const remembered = await getRememberedHome();
    const home = await openHome(new RealFileSystemAdapter(remembered.rootHandle));
    const evidence = home.workspaces[0].workspace.projects[0].project.vaultState.components;
    if (evidence.status !== 'available') throw new Error(evidence.reason);
    return getWorkspacePath(home.identity.homeId, remembered.rootHandle);
  })).toBe(rootAddress);
  expect(branchId).not.toBe('branch-main');
  expect(errors).toEqual([]);
});

test('unsupported browser receives guidance without entering folder setup', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => Object.assign(window, { showDirectoryPicker: undefined }));
  await page.getByRole('button', { name: 'Start my Cadtree home', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('desktop Chrome or Edge');
  await expect(page.getByRole('alert')).toContainText('Safari and Firefox');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
