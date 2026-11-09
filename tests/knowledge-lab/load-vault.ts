import { RealFileSystemAdapter, type FileSystemDirectoryAdapter } from '../../src/engine/fs-adapter';
import { openExistingVault } from '../../src/engine/vault-service';

/** Capability guard, including child adapters. No write or permission escalation escapes. */
export function readOnlyDirectory(directory: FileSystemDirectoryAdapter): FileSystemDirectoryAdapter {
  const deny = () => { throw new Error('Knowledge Lab only permits read access.'); };
  const reads = new Set(['listEntries', 'hasDirectory', 'hasFile', 'statFile', 'readFileStream', 'readFileBytes', 'readFileText']);
  return new Proxy(directory, {
    get(target, key) {
      if (key === 'name' || key === 'kind') return target[key];
      if (key === 'getDirectory') return async (segments: string[], options?: { create?: boolean; exclusiveCreate?: boolean; exclusiveCheck?: boolean }) => {
        if (options?.create || options?.exclusiveCreate || options?.exclusiveCheck) deny();
        return readOnlyDirectory(await target.getDirectory(segments, { create: false }));
      };
      if (key === 'queryPermission' || key === 'requestPermission') return (mode: string) => {
        if (mode !== 'read') deny();
        return target[key]('read');
      };
      if (reads.has(String(key))) return Reflect.get(target, key).bind(target);
      if (['writeFileStream', 'writeFileBytes', 'writeFileText', 'removeEntry'].includes(String(key))) return deny;
      // Do not expose the real handle; unknown properties (including Promise.then) are absent.
      return undefined;
    },
    set: () => { deny(); return false; },
  });
}

/** Accept a vault itself or its managed project container; never create missing folders. */
export async function resolveVaultPath(directory: FileSystemDirectoryAdapter): Promise<string[]> {
  const root = readOnlyDirectory(directory);
  if (await root.hasFile(['project.json'])) return [];
  if (await root.hasDirectory(['vault'])) {
    const vault = await root.getDirectory(['vault']);
    if (await vault.hasFile(['project.json'])) return ['vault'];
  }
  throw new Error('Select a cAdtree vault containing project.json, or its project folder containing vault/project.json.');
}

export async function loadLocalVault(directory: FileSystemDirectoryAdapter) {
  return openExistingVault(await readOnlyDirectory(directory).getDirectory(await resolveVaultPath(directory)));
}

export async function pickVaultDirectory() {
  const picker = (window as unknown as {
    showDirectoryPicker?: (options: { mode: 'read'; id: string }) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  if (!picker) throw new Error('Folder access requires a supported Chrome or Edge browser on localhost.');
  const handle = await picker.call(window, { mode: 'read', id: 'cadtree-knowledge-lab' });
  return new RealFileSystemAdapter(handle);
}

export async function pickLocalVault() { return loadLocalVault(await pickVaultDirectory()); }
