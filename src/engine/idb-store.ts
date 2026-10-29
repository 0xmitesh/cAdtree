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
}

const DB_NAME = 'cadtree_convenience_v1';
const DB_VERSION = 1;
const STORE_BINDINGS = 'project_bindings';
const STORE_PREFS = 'ui_preferences';

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
