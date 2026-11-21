export function folderAccessBlock(): string | undefined {
  if (typeof window === 'undefined') return 'Local folder access requires a supported desktop browser.';
  if (window.isSecureContext === false) return 'Local folder access requires HTTPS or localhost. Open cAdtree at a secure address in a desktop browser.';
  try {
    if (window.self !== window.top) return 'Open cAdtree in its own desktop Chrome or Edge tab to connect local folders.';
  } catch {
    return 'Open cAdtree in its own desktop Chrome or Edge tab to connect local folders.';
  }
  if (typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker !== 'function') {
    return 'This browser cannot connect local folders. Open cAdtree in a current desktop Chrome or Edge browser on Windows, macOS or Linux. Safari and Firefox do not provide the folder access this workflow needs.';
  }
}

export function assertFolderAccess() {
  const reason = folderAccessBlock();
  if (reason) throw new Error(reason);
}

import { FolderAccessError, isFolderAccessError, isPermissionDomError } from '../engine/fs-adapter';

export { FolderAccessError, isFolderAccessError };

export function folderPermissionError(error: unknown): unknown {
  if (isPermissionDomError(error)) return new FolderAccessError('Folder access was denied or revoked. Allow local folder access in your browser site settings, then reconnect the Cadtree home or choose the folder again.', { cause: error });
  return error;
}

/** Must be called directly from a user gesture, before unrelated awaits. */
export async function pickDirectory(mode: 'read' | 'readwrite'): Promise<FileSystemDirectoryHandle> {
  assertFolderAccess();
  try {
    return await (window as unknown as { showDirectoryPicker: (options: { mode: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode });
  } catch (error) {
    if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') throw new DOMException('Folder selection was cancelled. Choose a folder when you are ready.', 'AbortError');
    throw folderPermissionError(error);
  }
}
