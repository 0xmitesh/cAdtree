/**
 * IndexedDB convenience storage for remembered FileSystemDirectoryHandles and UI preferences.
 * One browser scope: everything is stored under plain keys, whether or not the user is signed in.
 * Signing in or out never changes what is remembered. CRITICAL: Project identity, branches, revision history, and notes live in the vault files.
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

/** Per workspace, machine-local convenience text; not a portable filesystem binding. */
export async function saveWorkspacePath(workspaceId: string, input: string, rootHandle?: FileSystemDirectoryHandle): Promise<void> {
  const path = normalizeFolderPath(input);
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
  if (!isIndexedDbAvailable()) return;
  // Never attach an unbound old address to whichever copy happens to be selected.
  // A saved matching handle (or the original remembered access binding) is required.
  if (!await getWorkspacePath(workspaceId, rootHandle)) return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PREFS, 'readwrite');
    tx.objectStore(STORE_PREFS).put(rootHandle, `windows-handle:${workspaceId}`);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Could not remember the original path location.')); };
  });
}
export async function getWorkspacePath(workspaceId: string, rootHandle?: FileSystemDirectoryHandle): Promise<string> {
  if (!isIndexedDbAvailable()) return '';
  const db = await openDatabase();
  const saved = await new Promise<{ path: unknown; handle?: FileSystemDirectoryHandle }>((resolve, reject) => {
    const tx = db.transaction(STORE_PREFS, 'readonly');
    const store = tx.objectStore(STORE_PREFS);
    const request = store.get(`windows-root:${workspaceId}`);
    const handle = store.get(`windows-handle:${workspaceId}`);
    const workspace = store.get(`workspace:${workspaceId}`);
    const home = store.get('home');
    tx.oncomplete = () => {
      db.close();
      const remembered =
        workspace.result?.workspaceId === workspaceId
          ? workspace.result.rootHandle
          : home.result?.homeId === workspaceId
            ? home.result.rootHandle
            : undefined;
      resolve({ path: request.result, handle: handle.result ?? remembered });
    };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
  });
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
  if (!isIndexedDbAvailable()) throw new Error('Browser convenience storage is unavailable. Reconnect the workspace root after reopening.');
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PREFS, 'readwrite');
    const store = tx.objectStore(STORE_PREFS);
    store.put(binding, 'workspace');
    store.put(binding, `workspace:${binding.workspaceId}`);
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
  if (!isIndexedDbAvailable())
    throw new Error(
      "Browser convenience storage is unavailable. Select the Cadtree home again after reopening.",
    );
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PREFS, "readwrite");
    tx.objectStore(STORE_PREFS).put(binding, "home");
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
async function readPref<T>(key: string): Promise<T | null> {
  if (!isIndexedDbAvailable()) return null;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PREFS, "readonly");
    const request = tx.objectStore(STORE_PREFS).get(key);
    tx.oncomplete = () => {
      db.close();
      resolve((request.result as T | undefined) ?? null);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
export async function getRememberedHome(): Promise<RememberedHome | null> {
  return readPref<RememberedHome>("home");
}
export async function getRememberedWorkspace(): Promise<RememberedWorkspace | null> {
  try { return await readPref<RememberedWorkspace>("workspace"); } catch { return null; }
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
    tx.objectStore(STORE_BINDINGS).put(binding);
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
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Could not remember this branch connection.')); };
    request.onsuccess = () => {
      const previous = request.result as RememberedProjectBinding | undefined;
      const updated = { ...previous, ...project, activeBranchId: branchId, lastOpenedAt: new Date().toISOString(),
        branchWorkingHandles: { ...previous?.branchWorkingHandles, ...(workingHandle ? { [branchId]: workingHandle } : {}) },
        workingFolderNames: { ...previous?.workingFolderNames, ...(workingHandle ? { [branchId]: workingHandle.name } : {}) },
      } satisfies RememberedProjectBinding;
      store.put(updated);
    };
  });
}

export async function listRememberedProjectBindings(): Promise<RememberedProjectBinding[]> {
  if (!isIndexedDbAvailable()) return [];
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BINDINGS, 'readonly');
      const req = tx.objectStore(STORE_BINDINGS).getAll();
      tx.oncomplete = () => {
        db.close();
        const items = (req.result as RememberedProjectBinding[]) ?? [];
        items.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
        resolve(items);
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(tx.error);
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
      const req = tx.objectStore(STORE_BINDINGS).get(projectId);
      tx.oncomplete = () => {
        db.close();
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

