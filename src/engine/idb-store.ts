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

import { normalizeWindowsWorkspacePath } from '../utils/windows-path';

const DB_NAME = 'cadtree_convenience_v1';
const DB_VERSION = 1;
const STORE_BINDINGS = 'project_bindings';
const STORE_PREFS = 'ui_preferences';

/** Per workspace, machine-local convenience text; not a portable filesystem binding. */
export async function saveWorkspaceWindowsPath(workspaceId: string, input: string): Promise<void> {
  const path = normalizeWindowsWorkspacePath(input);
  if (!isIndexedDbAvailable()) throw new Error('Browser convenience storage is unavailable. This location can only be used for this session.');
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PREFS, 'readwrite');
    tx.objectStore(STORE_PREFS).put(path, `windows-root:${workspaceId}`);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Could not remember the Windows workspace location.')); };
  });
}
export async function getWorkspaceWindowsPath(workspaceId: string): Promise<string> {
  if (!isIndexedDbAvailable()) return '';
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PREFS, 'readonly');
    const request = tx.objectStore(STORE_PREFS).get(`windows-root:${workspaceId}`);
    request.onsuccess = () => {
      db.close();
      try { resolve(typeof request.result === 'string' ? normalizeWindowsWorkspacePath(request.result) : ''); }
      catch { resolve(''); }
    };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

export interface RememberedWorkspace {
  workspaceId: string;
  name: string;
  rootHandle: FileSystemDirectoryHandle;
  projectPath?: string;
  activeBranchId?: string;
}
export async function rememberWorkspace(binding: RememberedWorkspace): Promise<void> {
  if (!isIndexedDbAvailable()) throw new Error('Browser convenience storage is unavailable. Reconnect the workspace root after reopening.');
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PREFS, 'readwrite');
    tx.objectStore(STORE_PREFS).put(binding, 'workspace');
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Could not remember workspace access.')); };
  });
}
export async function getRememberedWorkspace(): Promise<RememberedWorkspace | null> {
  if (!isIndexedDbAvailable()) return null;
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PREFS, 'readonly');
      const request = tx.objectStore(STORE_PREFS).get('workspace');
      request.onsuccess = () => { db.close(); resolve(request.result ?? null); };
      request.onerror = () => { db.close(); reject(request.error); };
    });
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
  if (!isIndexedDbAvailable()) return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BINDINGS, 'readwrite');
    const store = tx.objectStore(STORE_BINDINGS);
    store.put(binding);
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
  if (!isIndexedDbAvailable()) throw new Error('IndexedDB is unavailable; folder connections will last only for this session.');
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BINDINGS, 'readwrite');
    const store = tx.objectStore(STORE_BINDINGS);
    const request = store.get(project.projectId);
    request.onsuccess = () => {
      const previous = request.result as RememberedProjectBinding | undefined;
      store.put({ ...previous, ...project, activeBranchId: branchId, lastOpenedAt: new Date().toISOString(),
        branchWorkingHandles: { ...previous?.branchWorkingHandles, ...(workingHandle ? { [branchId]: workingHandle } : {}) },
        workingFolderNames: { ...previous?.workingFolderNames, ...(workingHandle ? { [branchId]: workingHandle.name } : {}) },
      } satisfies RememberedProjectBinding);
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Could not remember this branch connection.')); };
  });
}

export async function listRememberedProjectBindings(): Promise<RememberedProjectBinding[]> {
  if (!isIndexedDbAvailable()) return [];
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BINDINGS, 'readonly');
      const store = tx.objectStore(STORE_BINDINGS);
      const req = store.getAll();
      req.onsuccess = () => {
        db.close();
        const items = (req.result as RememberedProjectBinding[]) ?? [];
        items.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
        resolve(items);
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
  if (!isIndexedDbAvailable()) return null;
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BINDINGS, 'readonly');
      const store = tx.objectStore(STORE_BINDINGS);
      const req = store.get(projectId);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as RememberedProjectBinding) ?? null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
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

