/**
 * IndexedDB convenience storage for remembered FileSystemDirectoryHandles and UI preferences.
 * CRITICAL: Project identity, branches, revision history, and notes live in the vault files.
 * Clearing this IndexedDB store must never destroy project state or prevent reopening a vault.
 */

export interface RememberedProjectBinding {
  projectId: string;
  projectName: string;
  vaultHandle?: FileSystemDirectoryHandle;
  branchWorkingHandles: Record<string, FileSystemDirectoryHandle>;
  vaultFolderName: string;
  workingFolderNames: Record<string, string>;
  lastOpenedAt: string;
  activeBranchId?: string;
}

import { normalizeFolderPath } from '../utils/folder-path';

const DB_NAME = 'cadtree_convenience_v1';
const DB_VERSION = 1;
const STORE_BINDINGS = 'project_bindings';
const STORE_PREFS = 'ui_preferences';

let activeAccountScope: string | null = 'default';

/**
 * Scopes browser convenience storage to the active signed-in account UID,
 * or null when signed out / before initial session resolution.
 * Direct engine tests default to 'default'.
 */
export function setConvenienceAccountScope(accountId: string | null): void {
  activeAccountScope = accountId === null ? null : accountId.trim() || 'default';
}

export function getConvenienceAccountScope(): string | null {
  return activeAccountScope;
}

function isAccountAllowed(owner: unknown, scope: string): boolean {
  if (scope === 'default') return true;
  return owner === undefined || owner === scope;
}

/** Per workspace, machine-local convenience text; not a portable filesystem binding. */
export async function saveWorkspacePath(workspaceId: string, input: string, rootHandle?: FileSystemDirectoryHandle): Promise<void> {
  const path = normalizeFolderPath(input);
  const scope = activeAccountScope;
  if (scope === null) return;
  if (!isIndexedDbAvailable()) throw new Error('Browser convenience storage is unavailable. This location can only be used for this session.');
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PREFS, 'readwrite');
    try {
      const store = tx.objectStore(STORE_PREFS);
      store.put(path, `windows-root:${workspaceId}`);
      // Retain the original preference keys for compatibility, including Windows paths.
      if (rootHandle) store.put(rootHandle, `windows-handle:${workspaceId}`);
      else store.delete(`windows-handle:${workspaceId}`);
      if (scope !== 'default') {
        store.put(scope, `account-owner:windows:${workspaceId}`);
        store.put(path, `account:${scope}:windows-root:${workspaceId}`);
        if (rootHandle) store.put(rootHandle, `account:${scope}:windows-handle:${workspaceId}`);
        else store.delete(`account:${scope}:windows-handle:${workspaceId}`);
      }
    } catch (error) {
      tx.abort();
      db.close();
      reject(error);
      return;
    }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Could not remember the local folder address.')); };
  });
}
/** Associates a retained pre-home path setting with its actual original location. */
export async function bindWorkspacePathToRoot(workspaceId: string, rootHandle: FileSystemDirectoryHandle): Promise<void> {
  const scope = activeAccountScope;
  if (scope === null || !isIndexedDbAvailable()) return;
  // Never attach an unbound old address to whichever copy happens to be selected.
  // A saved matching handle (or the original remembered access binding) is required.
  if (!await getWorkspacePath(workspaceId, rootHandle)) return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PREFS, 'readwrite');
    const store = tx.objectStore(STORE_PREFS);
    store.put(rootHandle, `windows-handle:${workspaceId}`);
    if (scope !== 'default') {
      store.put(scope, `account-owner:windows:${workspaceId}`);
      store.put(rootHandle, `account:${scope}:windows-handle:${workspaceId}`);
    }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Could not remember the original path location.')); };
  });
}
export async function getWorkspacePath(workspaceId: string, rootHandle?: FileSystemDirectoryHandle): Promise<string> {
  const scope = activeAccountScope;
  if (scope === null || !isIndexedDbAvailable()) return '';
  const db = await openDatabase();
  const saved = await new Promise<{ path: unknown; handle?: FileSystemDirectoryHandle; claim?: boolean }>((resolve, reject) => {
    const tx = db.transaction(STORE_PREFS, 'readonly');
    const store = tx.objectStore(STORE_PREFS);
    const request = store.get(`windows-root:${workspaceId}`);
    const handle = store.get(`windows-handle:${workspaceId}`);
    const workspace = store.get(`workspace:${workspaceId}`);
    const home = store.get('home');
    const ownerReq = scope !== 'default' ? store.get(`account-owner:windows:${workspaceId}`) : undefined;
    const wsOwnerReq = scope !== 'default' ? store.get(`account-owner:workspace:${workspaceId}`) : undefined;
    const homeOwnerReq = scope !== 'default' ? store.get('account-owner:home') : undefined;
    const acctPathReq = scope !== 'default' ? store.get(`account:${scope}:windows-root:${workspaceId}`) : undefined;
    const acctHandleReq = scope !== 'default' ? store.get(`account:${scope}:windows-handle:${workspaceId}`) : undefined;
    const acctWsReq = scope !== 'default' ? store.get(`account:${scope}:workspace:${workspaceId}`) : undefined;
    const acctHomeReq = scope !== 'default' ? store.get(`account:${scope}:home`) : undefined;
    tx.oncomplete = () => {
      db.close();
      if (scope !== 'default') {
        if (acctPathReq?.result !== undefined) {
          const acctRemembered =
            acctWsReq?.result?.workspaceId === workspaceId
              ? acctWsReq.result.rootHandle
              : acctHomeReq?.result?.homeId === workspaceId
                ? acctHomeReq.result.rootHandle
                : undefined;
          resolve({
            path: acctPathReq.result,
            handle: acctHandleReq?.result ?? acctRemembered,
          });
          return;
        }
        if (!isAccountAllowed(ownerReq?.result, scope)) {
          resolve({ path: '' });
          return;
        }
      }
      const wsAllowed = scope === 'default' || isAccountAllowed(wsOwnerReq?.result, scope);
      const homeAllowed = scope === 'default' || isAccountAllowed(homeOwnerReq?.result, scope);
      const remembered =
        wsAllowed && workspace.result?.workspaceId === workspaceId
          ? workspace.result.rootHandle
          : homeAllowed && home.result?.homeId === workspaceId
            ? home.result.rootHandle
            : undefined;
      resolve({
        path: request.result,
        handle: handle.result ?? remembered,
        claim: scope !== 'default' && ownerReq?.result === undefined && typeof request.result === 'string',
      });
    };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
  });
  if (saved.claim && scope !== 'default') {
    try {
      const claimDb = await openDatabase();
      await new Promise<void>((resolve) => {
        const tx = claimDb.transaction(STORE_PREFS, 'readwrite');
        const store = tx.objectStore(STORE_PREFS);
        store.put(scope, `account-owner:windows:${workspaceId}`);
        store.put(saved.path, `account:${scope}:windows-root:${workspaceId}`);
        if (saved.handle) store.put(saved.handle, `account:${scope}:windows-handle:${workspaceId}`);
        tx.oncomplete = tx.onabort = tx.onerror = () => { claimDb.close(); resolve(); };
      });
    } catch {
      /* Ignore claim errors */
    }
  }
  if (rootHandle) {
    if (!saved.handle) return '';
    try { if (!(await rootHandle.isSameEntry(saved.handle))) return ''; } catch { return ''; }
  }
  try { return typeof saved.path === 'string' ? normalizeFolderPath(saved.path) : ''; } catch { return ''; }
}

/** Deprecated names keep existing local Windows preference callers compatible. */
export const saveWorkspaceWindowsPath = saveWorkspacePath;
export const getWorkspaceWindowsPath = getWorkspacePath;
export const bindWorkspaceWindowsPathToRoot = bindWorkspacePathToRoot;

export interface RememberedWorkspace {
  workspaceId: string;
  name: string;
  rootHandle: FileSystemDirectoryHandle;
  /** Informational only; the project is recognised by `projectId`. */
  projectPath?: string;
  projectId?: string;
  activeBranchId?: string;
}
export async function rememberWorkspace(binding: RememberedWorkspace): Promise<void> {
  const scope = activeAccountScope;
  if (scope === null) return;
  if (!isIndexedDbAvailable()) throw new Error('Browser convenience storage is unavailable. Reconnect the workspace root after reopening.');
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PREFS, 'readwrite');
    const store = tx.objectStore(STORE_PREFS);
    store.put(binding, 'workspace');
    store.put(binding, `workspace:${binding.workspaceId}`);
    if (scope !== 'default') {
      store.put(scope, 'account-owner:workspace');
      store.put(scope, `account-owner:workspace:${binding.workspaceId}`);
      store.put(binding, `account:${scope}:workspace`);
      store.put(binding, `account:${scope}:workspace:${binding.workspaceId}`);
    }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Could not remember workspace access.')); };
  });
}
export interface RememberedHome {
  homeId: string;
  name: string;
  rootHandle: FileSystemDirectoryHandle;
  workspaceId?: string;
  /** Informational only; the project is recognised by `projectId`. */
  projectPath?: string;
  projectId?: string;
  activeBranchId?: string;
}
export async function rememberHome(binding: RememberedHome): Promise<void> {
  const scope = activeAccountScope;
  if (scope === null) return;
  if (!isIndexedDbAvailable())
    throw new Error(
      "Browser convenience storage is unavailable. Select the Cadtree home again after reopening.",
    );
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PREFS, "readwrite");
    const store = tx.objectStore(STORE_PREFS);
    store.put(binding, "home");
    if (scope !== "default") {
      store.put(scope, "account-owner:home");
      store.put(binding, `account:${scope}:home`);
    }
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Could not remember home access."));
    };
  });
}
export async function getRememberedHome(): Promise<RememberedHome | null> {
  const scope = activeAccountScope;
  if (scope === null || !isIndexedDbAvailable()) return null;
  const db = await openDatabase();
  const outcome = await new Promise<{ result: RememberedHome | null; claim?: boolean }>((resolve, reject) => {
    const tx = db.transaction(STORE_PREFS, "readonly");
    const store = tx.objectStore(STORE_PREFS);
    const request = store.get("home");
    const ownerReq = scope !== "default" ? store.get("account-owner:home") : undefined;
    const acctReq = scope !== "default" ? store.get(`account:${scope}:home`) : undefined;
    tx.oncomplete = () => {
      db.close();
      if (scope !== "default") {
        if (acctReq?.result) {
          resolve({ result: acctReq.result as RememberedHome });
          return;
        }
        if (!isAccountAllowed(ownerReq?.result, scope)) {
          resolve({ result: null });
          return;
        }
      }
      const value = (request.result as RememberedHome | undefined) ?? null;
      resolve({
        result: value,
        claim: scope !== "default" && ownerReq?.result === undefined && value !== null,
      });
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
  if (outcome.claim && outcome.result && scope !== "default") {
    try {
      const claimDb = await openDatabase();
      await new Promise<void>((resolve) => {
        const tx = claimDb.transaction(STORE_PREFS, "readwrite");
        const store = tx.objectStore(STORE_PREFS);
        store.put(scope, "account-owner:home");
        store.put(outcome.result, `account:${scope}:home`);
        tx.oncomplete = tx.onabort = tx.onerror = () => { claimDb.close(); resolve(); };
      });
    } catch {
      /* Ignore claim errors */
    }
  }
  return outcome.result;
}
export async function getRememberedWorkspace(): Promise<RememberedWorkspace | null> {
  const scope = activeAccountScope;
  if (scope === null || !isIndexedDbAvailable()) return null;
  try {
    const db = await openDatabase();
    const outcome = await new Promise<{ result: RememberedWorkspace | null; claim?: boolean }>((resolve, reject) => {
      const tx = db.transaction(STORE_PREFS, 'readonly');
      const store = tx.objectStore(STORE_PREFS);
      const request = store.get('workspace');
      const ownerReq = scope !== 'default' ? store.get('account-owner:workspace') : undefined;
      const acctReq = scope !== 'default' ? store.get(`account:${scope}:workspace`) : undefined;
      tx.oncomplete = () => {
        db.close();
        if (scope !== 'default') {
          if (acctReq?.result) {
            resolve({ result: acctReq.result as RememberedWorkspace });
            return;
          }
          if (!isAccountAllowed(ownerReq?.result, scope)) {
            resolve({ result: null });
            return;
          }
        }
        const value = (request.result as RememberedWorkspace | undefined) ?? null;
        resolve({
          result: value,
          claim: scope !== 'default' && ownerReq?.result === undefined && value !== null,
        });
      };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
    });
    if (outcome.claim && outcome.result && scope !== 'default') {
      try {
        const claimDb = await openDatabase();
        await new Promise<void>((resolve) => {
          const tx = claimDb.transaction(STORE_PREFS, 'readwrite');
          const store = tx.objectStore(STORE_PREFS);
          store.put(scope, 'account-owner:workspace');
          store.put(outcome.result, `account:${scope}:workspace`);
          tx.oncomplete = tx.onabort = tx.onerror = () => { claimDb.close(); resolve(); };
        });
      } catch {
        /* Ignore claim errors */
      }
    }
    return outcome.result;
  } catch { return null; }
}

function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isIndexedDbAvailable()) {
      reject(new Error('IndexedDB is not available in this environment.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BINDINGS)) {
        db.createObjectStore(STORE_BINDINGS, { keyPath: 'projectId' });
      }
      if (!db.objectStoreNames.contains(STORE_PREFS)) {
        db.createObjectStore(STORE_PREFS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB.'));
  });
}

export async function saveRememberedProjectBinding(
  binding: RememberedProjectBinding
): Promise<void> {
  const scope = activeAccountScope;
  if (scope === null || !isIndexedDbAvailable()) return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_BINDINGS, STORE_PREFS], 'readwrite');
    const store = tx.objectStore(STORE_BINDINGS);
    const prefs = tx.objectStore(STORE_PREFS);
    store.put(binding);
    if (scope !== 'default') {
      prefs.put(scope, `account-owner:binding:${binding.projectId}`);
      prefs.put(binding, `account:${scope}:binding:${binding.projectId}`);
    }
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error('Failed to save project binding in IndexedDB.'));
    };
  });
}

/** Merge one branch binding in a single IDB transaction, retaining all other handles. */
export async function rememberBranchConnection(
  project: { projectId: string; projectName: string; vaultHandle: FileSystemDirectoryHandle; vaultFolderName: string },
  branchId: string,
  workingHandle?: FileSystemDirectoryHandle,
): Promise<void> {
  const scope = activeAccountScope;
  if (scope === null || !isIndexedDbAvailable()) throw new Error('IndexedDB is unavailable; folder connections will last only for this session.');
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_BINDINGS, STORE_PREFS], 'readwrite');
    const store = tx.objectStore(STORE_BINDINGS);
    const prefs = tx.objectStore(STORE_PREFS);
    const request = store.get(project.projectId);
    const acctReq = scope !== 'default' ? prefs.get(`account:${scope}:binding:${project.projectId}`) : undefined;
    const ownerReq = scope !== 'default' ? prefs.get(`account-owner:binding:${project.projectId}`) : undefined;
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Could not remember this branch connection.')); };
    request.onsuccess = () => {
      const finalize = () => {
        const previous = scope !== 'default'
          ? ((acctReq?.result as RememberedProjectBinding | undefined) ??
             (isAccountAllowed(ownerReq?.result, scope) ? (request.result as RememberedProjectBinding | undefined) : undefined))
          : (request.result as RememberedProjectBinding | undefined);
        const updated = { ...previous, ...project, activeBranchId: branchId, lastOpenedAt: new Date().toISOString(),
          branchWorkingHandles: { ...previous?.branchWorkingHandles, ...(workingHandle ? { [branchId]: workingHandle } : {}) },
          workingFolderNames: { ...previous?.workingFolderNames, ...(workingHandle ? { [branchId]: workingHandle.name } : {}) },
        } satisfies RememberedProjectBinding;
        store.put(updated);
        if (scope !== 'default') {
          prefs.put(scope, `account-owner:binding:${project.projectId}`);
          prefs.put(updated, `account:${scope}:binding:${project.projectId}`);
        }
      };
      if (scope !== 'default' && acctReq && ownerReq) {
        let pending = 2;
        const done = () => { if (--pending === 0) finalize(); };
        acctReq.onsuccess = acctReq.onerror = done;
        ownerReq.onsuccess = ownerReq.onerror = done;
      } else {
        finalize();
      }
    };
  });
}

export async function listRememberedProjectBindings(): Promise<RememberedProjectBinding[]> {
  const scope = activeAccountScope;
  if (scope === null || !isIndexedDbAvailable()) return [];
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_BINDINGS, STORE_PREFS], 'readonly');
      const store = tx.objectStore(STORE_BINDINGS);
      const prefs = tx.objectStore(STORE_PREFS);
      const req = store.getAll();
      req.onsuccess = () => {
        const rawItems = (req.result as RememberedProjectBinding[]) ?? [];
        if (scope === 'default' || rawItems.length === 0) {
          db.close();
          rawItems.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
          resolve(rawItems);
          return;
        }
        const filtered: RememberedProjectBinding[] = [];
        let pending = rawItems.length;
        for (const item of rawItems) {
          const acctReq = prefs.get(`account:${scope}:binding:${item.projectId}`);
          const ownerReq = prefs.get(`account-owner:binding:${item.projectId}`);
          let pair = 2;
          const finishItem = () => {
            if (--pair > 0) return;
            if (acctReq.result) {
              filtered.push(acctReq.result as RememberedProjectBinding);
            } else if (isAccountAllowed(ownerReq.result, scope)) {
              filtered.push(item);
            }
            if (--pending === 0) {
              db.close();
              filtered.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
              resolve(filtered);
            }
          };
          acctReq.onsuccess = acctReq.onerror = finishItem;
          ownerReq.onsuccess = ownerReq.onerror = finishItem;
        }
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return [];
  }
}

export async function getRememberedProjectBinding(
  projectId: string
): Promise<RememberedProjectBinding | null> {
  const scope = activeAccountScope;
  if (scope === null || !isIndexedDbAvailable()) return null;
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_BINDINGS, STORE_PREFS], 'readonly');
      const store = tx.objectStore(STORE_BINDINGS);
      const prefs = tx.objectStore(STORE_PREFS);
      const req = store.get(projectId);
      const acctReq = scope !== 'default' ? prefs.get(`account:${scope}:binding:${projectId}`) : undefined;
      const ownerReq = scope !== 'default' ? prefs.get(`account-owner:binding:${projectId}`) : undefined;
      tx.oncomplete = () => {
        db.close();
        if (scope !== 'default') {
          if (acctReq?.result) {
            resolve(acctReq.result as RememberedProjectBinding);
            return;
          }
          if (!isAccountAllowed(ownerReq?.result, scope)) {
            resolve(null);
            return;
          }
        }
        resolve((req.result as RememberedProjectBinding) ?? null);
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    return null;
  }
}

export async function removeRememberedProjectBinding(projectId: string): Promise<void> {
  if (!isIndexedDbAvailable()) return;
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_BINDINGS, 'readwrite');
      const store = tx.objectStore(STORE_BINDINGS);
      store.delete(projectId);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // Ignore
  }
}

export async function clearAllConvenienceMetadata(): Promise<void> {
  if (!isIndexedDbAvailable()) return;
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_BINDINGS, STORE_PREFS], 'readwrite');
      tx.objectStore(STORE_BINDINGS).clear();
      tx.objectStore(STORE_PREFS).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // Ignore
  }
}

