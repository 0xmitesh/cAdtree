export interface DirectoryEntryInfo {
  name: string;
  kind: 'file' | 'directory';
}

export interface FileStat {
  size: number;
  lastModified: number;
}

export interface WriteOptions {
  signal?: AbortSignal;
  exclusive?: boolean;
}

export interface FileSystemDirectoryAdapter {
  readonly name: string;
  readonly kind: 'real' | 'memory';
  queryPermission(mode: 'read' | 'readwrite'): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission(mode: 'read' | 'readwrite'): Promise<'granted' | 'denied' | 'prompt'>;
  isSameEntry(other: FileSystemDirectoryAdapter): Promise<boolean>;
  resolveRelativePath(possibleDescendant: FileSystemDirectoryAdapter): Promise<string[] | null>;
  listEntries(): Promise<DirectoryEntryInfo[]>;
  getDirectory(
    pathSegments: string[],
    options?: { create?: boolean; exclusiveCheck?: boolean; exclusiveCreate?: boolean }
  ): Promise<FileSystemDirectoryAdapter>;
  hasDirectory(pathSegments: string[]): Promise<boolean>;
  hasFile(pathSegments: string[]): Promise<boolean>;
  statFile(pathSegments: string[]): Promise<FileStat>;
  readFileStream(pathSegments: string[]): Promise<ReadableStream<Uint8Array>>;
  readFileBytes(pathSegments: string[]): Promise<Uint8Array>;
  readFileText(pathSegments: string[]): Promise<string>;
  writeFileStream(
    pathSegments: string[],
    stream: ReadableStream<Uint8Array>,
    signalOrOptions?: AbortSignal | WriteOptions
  ): Promise<{ bytesWritten: number }>;
  writeFileBytes(
    pathSegments: string[],
    data: Uint8Array,
    options?: { exclusive?: boolean }
  ): Promise<void>;
  writeFileText(
    pathSegments: string[],
    text: string,
    options?: { exclusive?: boolean }
  ): Promise<void>;
  removeEntry(pathSegments: string[], options?: { recursive?: boolean }): Promise<void>;
}

const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export function splitAndValidatePath(relativePath: string): string[] {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Invalid path: path must be a non-empty string.');
  }
  if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
    throw new Error(`Unsafe path "${relativePath}": absolute paths are forbidden.`);
  }
  if (relativePath.includes('\\')) {
    throw new Error(`Unsafe path "${relativePath}": backslashes are forbidden; use forward slashes.`);
  }
  if (/^[a-zA-Z]:/.test(relativePath)) {
    throw new Error(`Unsafe path "${relativePath}": Windows drive prefixes are forbidden.`);
  }
  if (relativePath.includes('\0') || /[\x00-\x1f]/.test(relativePath)) {
    throw new Error(`Unsafe path "${relativePath}": control characters are forbidden.`);
  }

  const segments = relativePath.split('/');
  for (const segment of segments) {
    if (!segment || segment.length === 0) {
      throw new Error(`Unsafe path "${relativePath}": empty path segments are forbidden.`);
    }
    if (segment === '.' || segment === '..') {
      throw new Error(`Unsafe path "${relativePath}": directory traversal segments are forbidden.`);
    }
    if (segment.endsWith(' ') || segment.endsWith('.')) {
      throw new Error(
        `Unsafe path "${relativePath}": segment "${segment}" ends with space or period (invalid on Windows).`
      );
    }
    const baseUpper = segment.split('.')[0].toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(baseUpper)) {
      throw new Error(
        `Unsafe path "${relativePath}": "${segment}" is a reserved Windows device name.`
      );
    }
  }

  return segments;
}

export function normalizeRelativePath(segments: string[]): string {
  const joined = segments.join('/');
  splitAndValidatePath(joined);
  return joined;
}

export function checkCaseInsensitiveCollisions(paths: string[]): string[] {
  const seen = new Map<string, string>();
  const collisions: string[] = [];

  for (const p of paths) {
    splitAndValidatePath(p);
    const lower = p.toLowerCase();
    const existing = seen.get(lower);
    if (existing && existing !== p) {
      collisions.push(`Case-insensitive path collision between "${existing}" and "${p}"`);
    } else if (existing === p) {
      collisions.push(`Duplicate path "${p}"`);
    } else {
      seen.set(lower, p);
    }
  }

  return collisions;
}

export async function validateDirectoryIsolation(
  dirA: FileSystemDirectoryAdapter,
  dirB: FileSystemDirectoryAdapter,
  labelA = 'Working folder',
  labelB = 'Vault folder'
): Promise<void> {
  if (dirA.kind !== dirB.kind) {
    throw new Error(`Cannot mix ${dirA.kind} and ${dirB.kind} directory adapters.`);
  }

  let same = false;
  let aContainsB: string[] | null = null;
  let bContainsA: string[] | null = null;

  try {
    same = await dirA.isSameEntry(dirB);
    if (!same) {
      aContainsB = await dirA.resolveRelativePath(dirB);
      bContainsA = await dirB.resolveRelativePath(dirA);
    }
  } catch (err) {
    throw new Error(
      `Failed to verify folder isolation between ${labelA} and ${labelB}: ${
        err instanceof Error ? err.message : String(err)
      }. Operation blocked for safety.`
    );
  }

  if (same) {
    throw new Error(
      `Isolation violation: ${labelA} ("${dirA.name}") and ${labelB} ("${dirB.name}") refer to the exact same directory.`
    );
  }

  if (aContainsB !== null) {
    throw new Error(
      `Isolation violation: ${labelB} ("${dirB.name}") is nested inside ${labelA} ("${dirA.name}" at "${aContainsB.join('/')}"). Select two separate directories.`
    );
  }

  if (bContainsA !== null) {
    throw new Error(
      `Isolation violation: ${labelA} ("${dirA.name}") is nested inside ${labelB} ("${dirB.name}" at "${bContainsA.join('/')}"). Select two separate directories.`
    );
  }
}

function normalizeWriteOptions(signalOrOptions?: AbortSignal | WriteOptions): WriteOptions {
  if (!signalOrOptions) return {};
  if ('aborted' in signalOrOptions) {
    return { signal: signalOrOptions };
  }
  return signalOrOptions;
}

/**
 * Browser File System Access API implementation of FileSystemDirectoryAdapter.
 * Note on exclusive writes: the WHATWG File System Access API does not expose an OS-kernel
 * atomic O_CREAT|O_EXCL flag on getFileHandle(). When exclusive=true is requested,
 * RealFileSystemAdapter checks for existing file/directory entries immediately prior to
 * creating the file handle, eliminating in-app overwrites and narrowing external races.
 */
export class RealFileSystemAdapter implements FileSystemDirectoryAdapter {
  readonly kind = 'real' as const;
  readonly handle: FileSystemDirectoryHandle;

  constructor(handle: FileSystemDirectoryHandle) {
    this.handle = handle;
  }

  get name(): string {
    return this.handle.name;
  }

  async queryPermission(mode: 'read' | 'readwrite'): Promise<'granted' | 'denied' | 'prompt'> {
    const h = this.handle as unknown as {
      queryPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>;
    };
    if (typeof h.queryPermission === 'function') {
      return h.queryPermission({ mode });
    }
    return 'granted';
  }

  async requestPermission(mode: 'read' | 'readwrite'): Promise<'granted' | 'denied' | 'prompt'> {
    const h = this.handle as unknown as {
      requestPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>;
    };
    if (typeof h.requestPermission === 'function') {
      return h.requestPermission({ mode });
    }
    return 'granted';
  }

  async isSameEntry(other: FileSystemDirectoryAdapter): Promise<boolean> {
    if (!(other instanceof RealFileSystemAdapter)) return false;
    return this.handle.isSameEntry(other.handle);
  }

  async resolveRelativePath(possibleDescendant: FileSystemDirectoryAdapter): Promise<string[] | null> {
    if (!(possibleDescendant instanceof RealFileSystemAdapter)) {
      throw new Error('Cannot resolve path across different adapter types.');
    }
    return this.handle.resolve(possibleDescendant.handle);
  }

  async listEntries(): Promise<DirectoryEntryInfo[]> {
    const entries: DirectoryEntryInfo[] = [];
    const iterable = this.handle as unknown as AsyncIterable<[string, FileSystemHandle]>;
    for await (const [name, entry] of iterable) {
      entries.push({
        name,
        kind: entry.kind,
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  private async resolveParentDir(
    pathSegments: string[],
    create: boolean
  ): Promise<{ dir: FileSystemDirectoryHandle; leafName: string }> {
    if (pathSegments.length === 0) {
      throw new Error('Path segments cannot be empty.');
    }
    splitAndValidatePath(pathSegments.join('/'));
    let curr = this.handle;
    for (let i = 0; i < pathSegments.length - 1; i++) {
      curr = await curr.getDirectoryHandle(pathSegments[i], { create });
    }
    return { dir: curr, leafName: pathSegments[pathSegments.length - 1] };
  }

  async getDirectory(
    pathSegments: string[],
    options?: { create?: boolean; exclusiveCheck?: boolean; exclusiveCreate?: boolean }
  ): Promise<FileSystemDirectoryAdapter> {
    if (pathSegments.length === 0) return this;
    splitAndValidatePath(pathSegments.join('/'));
    let curr = this.handle;
    for (let i = 0; i < pathSegments.length; i++) {
      const seg = pathSegments[i];
      if (options?.exclusiveCreate && options.create && i === pathSegments.length - 1) {
        await this.assertNoExistingEntry(curr, seg, pathSegments.join('/'));
      }
      if (options?.exclusiveCheck && options?.create) {
        // Ensure a file does not already occupy this path segment
        try {
          await curr.getFileHandle(seg, { create: false });
          throw new Error(
            `Destination conflict: a file already exists at directory path "${pathSegments
              .slice(0, i + 1)
              .join('/')}"`
          );
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('Destination conflict:')) {
            throw err;
          }
        }
      }
      curr = await curr.getDirectoryHandle(seg, { create: Boolean(options?.create) });
    }
    return new RealFileSystemAdapter(curr);
  }

  async hasDirectory(pathSegments: string[]): Promise<boolean> {
    try {
      await this.getDirectory(pathSegments, { create: false });
      return true;
    } catch {
      return false;
    }
  }

  async hasFile(pathSegments: string[]): Promise<boolean> {
    try {
      const { dir, leafName } = await this.resolveParentDir(pathSegments, false);
      await dir.getFileHandle(leafName, { create: false });
      return true;
    } catch {
      return false;
    }
  }

  async statFile(pathSegments: string[]): Promise<FileStat> {
    const { dir, leafName } = await this.resolveParentDir(pathSegments, false);
    const fileHandle = await dir.getFileHandle(leafName, { create: false });
    const file = await fileHandle.getFile();
    return {
      size: file.size,
      lastModified: file.lastModified,
    };
  }

  async readFileStream(pathSegments: string[]): Promise<ReadableStream<Uint8Array>> {
    const { dir, leafName } = await this.resolveParentDir(pathSegments, false);
    const fileHandle = await dir.getFileHandle(leafName, { create: false });
    const file = await fileHandle.getFile();
    return file.stream() as ReadableStream<Uint8Array>;
  }

  async readFileBytes(pathSegments: string[]): Promise<Uint8Array> {
    const { dir, leafName } = await this.resolveParentDir(pathSegments, false);
    const fileHandle = await dir.getFileHandle(leafName, { create: false });
    const file = await fileHandle.getFile();
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  async readFileText(pathSegments: string[]): Promise<string> {
    const { dir, leafName } = await this.resolveParentDir(pathSegments, false);
    const fileHandle = await dir.getFileHandle(leafName, { create: false });
    const file = await fileHandle.getFile();
    return file.text();
  }

  private async assertNoExistingEntry(
    dir: FileSystemDirectoryHandle,
    leafName: string,
    relPath: string
  ): Promise<void> {
    // Check exact match or case-insensitive collision in parent directory
    const iterable = dir as unknown as AsyncIterable<[string, FileSystemHandle]>;
    const targetLower = leafName.toLowerCase();
    for await (const [existingName] of iterable) {
      if (existingName === leafName || existingName.toLowerCase() === targetLower) {
        throw new Error(
          `Destination conflict: "${relPath}" already exists (collides with "${existingName}"). Recovery refuses to overwrite existing files.`
        );
      }
    }
  }

  async writeFileStream(
    pathSegments: string[],
    stream: ReadableStream<Uint8Array>,
    signalOrOptions?: AbortSignal | WriteOptions
  ): Promise<{ bytesWritten: number }> {
    const { signal, exclusive } = normalizeWriteOptions(signalOrOptions);
    const { dir, leafName } = await this.resolveParentDir(pathSegments, true);
    if (exclusive) {
      await this.assertNoExistingEntry(dir, leafName, pathSegments.join('/'));
    }
    const fileHandle = await dir.getFileHandle(leafName, { create: true });
    const writable = await fileHandle.createWritable();
    const reader = stream.getReader();
    let bytesWritten = 0;

    try {
      while (true) {
        if (signal?.aborted) {
          await writable.abort();
          throw new DOMException('Write cancelled by user.', 'AbortError');
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          await writable.write(value as unknown as BufferSource);
          bytesWritten += value.byteLength;
        }
      }
      await writable.close();
      return { bytesWritten };
    } catch (err) {
      try {
        await writable.abort();
      } catch {
        // Ignore abort cleanup error
      }
      throw err;
    } finally {
      reader.releaseLock();
    }
  }

  async writeFileBytes(
    pathSegments: string[],
    data: Uint8Array,
    options?: { exclusive?: boolean }
  ): Promise<void> {
    const { dir, leafName } = await this.resolveParentDir(pathSegments, true);
    if (options?.exclusive) {
      await this.assertNoExistingEntry(dir, leafName, pathSegments.join('/'));
    }
    const fileHandle = await dir.getFileHandle(leafName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(data as unknown as BufferSource);
      await writable.close();
    } catch (err) {
      try {
        await writable.abort();
      } catch {
        // Ignore
      }
      throw err;
    }
  }

  async writeFileText(
    pathSegments: string[],
    text: string,
    options?: { exclusive?: boolean }
  ): Promise<void> {
    await this.writeFileBytes(pathSegments, new TextEncoder().encode(text), options);
  }

  async removeEntry(pathSegments: string[], options?: { recursive?: boolean }): Promise<void> {
    const { dir, leafName } = await this.resolveParentDir(pathSegments, false);
    await dir.removeEntry(leafName, { recursive: Boolean(options?.recursive) });
  }
}

/**
 * Deterministic in-memory filesystem adapter for automated engine tests.
 * Supports fault injection, permission states, exclusive write checks, and streaming chunk reads/writes.
 */
interface MemoryFileNode {
  kind: 'file';
  name: string;
  data: Uint8Array;
  lastModified: number;
  unreadableReason?: string;
}

interface MemoryDirNode {
  kind: 'directory';
  id: string;
  name: string;
  parent: MemoryDirNode | null;
  children: Map<string, MemoryDirNode | MemoryFileNode>;
}

export interface MemoryFaultHooks {
  onBeforeListEntries?: (fullPath: string) => void | Promise<void>;
  onBeforeRead?: (fullPath: string) => void | Promise<void>;
  onBeforeWrite?: (fullPath: string) => void | Promise<void>;
  onAfterWrite?: (fullPath: string) => void | Promise<void>;
  readPermission?: 'granted' | 'denied' | 'prompt';
  writePermission?: 'granted' | 'denied' | 'prompt';
  chunkSize?: number;
}

let memoryDirIdCounter = 1;

export class InMemoryFileSystemAdapter implements FileSystemDirectoryAdapter {
  readonly kind = 'memory' as const;
  private readonly node: MemoryDirNode;
  private readonly hooks: MemoryFaultHooks;

  constructor(
    name = 'root',
    parent: MemoryDirNode | null = null,
    hooks?: MemoryFaultHooks,
    existingNode?: MemoryDirNode
  ) {
    this.hooks = hooks ?? {};
    this.node =
      existingNode ?? {
        kind: 'directory',
        id: `memdir-${memoryDirIdCounter++}`,
        name,
        parent,
        children: new Map(),
      };
  }

  get name(): string {
    return this.node.name;
  }

  setHooks(hooks: Partial<MemoryFaultHooks>): void {
    Object.assign(this.hooks, hooks);
  }

  markFileUnreadable(
    pathSegments: string[],
    reason = 'Simulated permission/lock read failure'
  ): void {
    const { dir, leafName } = this.resolveParentNode(pathSegments, false);
    const entry = dir.children.get(leafName);
    if (!entry || entry.kind !== 'file') {
      throw new Error(`File not found at ${pathSegments.join('/')}`);
    }
    entry.unreadableReason = reason;
  }

  private assertReadPermission(): void {
    if (this.hooks.readPermission && this.hooks.readPermission !== 'granted') {
      throw new Error(
        `Permission denied: read access is ${this.hooks.readPermission} on "${this.name}".`
      );
    }
  }

  private assertWritePermission(): void {
    if (this.hooks.writePermission && this.hooks.writePermission !== 'granted') {
      throw new Error(
        `Permission denied: write access is ${this.hooks.writePermission} on "${this.name}".`
      );
    }
  }

  async queryPermission(mode: 'read' | 'readwrite'): Promise<'granted' | 'denied' | 'prompt'> {
    if (mode === 'readwrite') {
      return this.hooks.writePermission ?? 'granted';
    }
    return this.hooks.readPermission ?? 'granted';
  }

  async requestPermission(mode: 'read' | 'readwrite'): Promise<'granted' | 'denied' | 'prompt'> {
    return this.queryPermission(mode);
  }

  async isSameEntry(other: FileSystemDirectoryAdapter): Promise<boolean> {
    if (!(other instanceof InMemoryFileSystemAdapter)) return false;
    return this.node.id === other.node.id;
  }

  async resolveRelativePath(
    possibleDescendant: FileSystemDirectoryAdapter
  ): Promise<string[] | null> {
    if (!(possibleDescendant instanceof InMemoryFileSystemAdapter)) {
      throw new Error('Cannot resolve path across different adapter types.');
    }
    if (this.node.id === possibleDescendant.node.id) {
      return [];
    }
    const segments: string[] = [];
    let curr: MemoryDirNode | null = possibleDescendant.node;
    while (curr !== null) {
      if (curr.id === this.node.id) {
        return segments.reverse();
      }
      segments.push(curr.name);
      curr = curr.parent;
    }
    return null;
  }

  private getFullPath(segments: string[]): string {
    const lineage: string[] = [];
    let curr: MemoryDirNode | null = this.node;
    while (curr) {
      lineage.unshift(curr.name);
      curr = curr.parent;
    }
    return [...lineage, ...segments].join('/');
  }

  private resolveParentNode(
    pathSegments: string[],
    create: boolean
  ): { dir: MemoryDirNode; leafName: string } {
    if (pathSegments.length === 0) {
      throw new Error('Path segments cannot be empty.');
    }
    splitAndValidatePath(pathSegments.join('/'));
    let curr = this.node;
    for (let i = 0; i < pathSegments.length - 1; i++) {
      const seg = pathSegments[i];
      let next = curr.children.get(seg);
      if (!next) {
        if (!create) {
          throw new Error(`Directory "${seg}" does not exist in "${curr.name}".`);
        }
        next = {
          kind: 'directory',
          id: `memdir-${memoryDirIdCounter++}`,
          name: seg,
          parent: curr,
          children: new Map(),
        };
        curr.children.set(seg, next);
      } else if (next.kind !== 'directory') {
        throw new Error(`Cannot traverse through file "${seg}" as a directory.`);
      }
      curr = next;
    }
    return { dir: curr, leafName: pathSegments[pathSegments.length - 1] };
  }

  private assertExclusiveInDir(dir: MemoryDirNode, leafName: string, relPath: string): void {
    const targetLower = leafName.toLowerCase();
    for (const [existingName] of dir.children.entries()) {
      if (existingName === leafName || existingName.toLowerCase() === targetLower) {
        throw new Error(
          `Destination conflict: "${relPath}" already exists (collides with "${existingName}"). Recovery refuses to overwrite existing files.`
        );
      }
    }
  }

  async listEntries(): Promise<DirectoryEntryInfo[]> {
    this.assertReadPermission();
    await this.hooks.onBeforeListEntries?.(this.getFullPath([]));
    const list: DirectoryEntryInfo[] = [];
    for (const [name, child] of this.node.children.entries()) {
      list.push({ name, kind: child.kind });
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }

  async getDirectory(
    pathSegments: string[],
    options?: { create?: boolean; exclusiveCheck?: boolean; exclusiveCreate?: boolean }
  ): Promise<FileSystemDirectoryAdapter> {
    this.assertReadPermission();
    if (options?.create) {
      this.assertWritePermission();
    }
    if (pathSegments.length === 0) return this;
    splitAndValidatePath(pathSegments.join('/'));
    let curr = this.node;
    for (let i = 0; i < pathSegments.length; i++) {
      const seg = pathSegments[i];
      let next = curr.children.get(seg);
      if (options?.exclusiveCreate && options.create && i === pathSegments.length - 1) {
        for (const existingName of curr.children.keys()) {
          if (existingName.toLowerCase() === seg.toLowerCase()) {
            throw new Error(`Destination conflict: "${existingName}" already exists.`);
          }
        }
      }
      if (!next) {
        if (!options?.create) {
          throw new Error(`Directory "${seg}" not found.`);
        }
        // Check case-insensitive collision with a file when exclusiveCheck is enabled
        if (options?.exclusiveCheck) {
          const segLower = seg.toLowerCase();
          for (const [existingName, existingNode] of curr.children.entries()) {
            if (existingName.toLowerCase() === segLower && existingNode.kind === 'file') {
              throw new Error(
                `Destination conflict: a file "${existingName}" already exists at directory path "${pathSegments
                  .slice(0, i + 1)
                  .join('/')}"`
              );
            }
          }
        }
        next = {
          kind: 'directory',
          id: `memdir-${memoryDirIdCounter++}`,
          name: seg,
          parent: curr,
          children: new Map(),
        };
        curr.children.set(seg, next);
      } else if (next.kind !== 'directory') {
        throw new Error(
          `Destination conflict: "${pathSegments
            .slice(0, i + 1)
            .join('/')}" is a file, not a directory.`
        );
      }
      curr = next;
    }
    return new InMemoryFileSystemAdapter(curr.name, curr.parent, this.hooks, curr);
  }

  async hasDirectory(pathSegments: string[]): Promise<boolean> {
    try {
      await this.getDirectory(pathSegments, { create: false });
      return true;
    } catch {
      return false;
    }
  }

  async hasFile(pathSegments: string[]): Promise<boolean> {
    try {
      const { dir, leafName } = this.resolveParentNode(pathSegments, false);
      const child = dir.children.get(leafName);
      return Boolean(child && child.kind === 'file');
    } catch {
      return false;
    }
  }

  async statFile(pathSegments: string[]): Promise<FileStat> {
    this.assertReadPermission();
    const { dir, leafName } = this.resolveParentNode(pathSegments, false);
    const child = dir.children.get(leafName);
    if (!child || child.kind !== 'file') {
      throw new Error(`File "${pathSegments.join('/')}" not found.`);
    }
    if (child.unreadableReason) {
      throw new Error(child.unreadableReason);
    }
    return {
      size: child.data.byteLength,
      lastModified: child.lastModified,
    };
  }

  async readFileStream(pathSegments: string[]): Promise<ReadableStream<Uint8Array>> {
    this.assertReadPermission();
    const fullPath = this.getFullPath(pathSegments);
    await this.hooks.onBeforeRead?.(fullPath);

    const { dir, leafName } = this.resolveParentNode(pathSegments, false);
    const child = dir.children.get(leafName);
    if (!child || child.kind !== 'file') {
      throw new Error(`File "${pathSegments.join('/')}" not found.`);
    }
    if (child.unreadableReason) {
      throw new Error(child.unreadableReason);
    }

    const snapshot = child.data.slice();
    const chunkSize = this.hooks.chunkSize ?? 64 * 1024;
    let offset = 0;

    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= snapshot.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkSize, snapshot.byteLength);
        controller.enqueue(snapshot.subarray(offset, end));
        offset = end;
      },
    });
  }

  async readFileBytes(pathSegments: string[]): Promise<Uint8Array> {
    this.assertReadPermission();
    const fullPath = this.getFullPath(pathSegments);
    await this.hooks.onBeforeRead?.(fullPath);

    const { dir, leafName } = this.resolveParentNode(pathSegments, false);
    const child = dir.children.get(leafName);
    if (!child || child.kind !== 'file') {
      throw new Error(`File "${pathSegments.join('/')}" not found.`);
    }
    if (child.unreadableReason) {
      throw new Error(child.unreadableReason);
    }
    return child.data.slice();
  }

  async readFileText(pathSegments: string[]): Promise<string> {
    const bytes = await this.readFileBytes(pathSegments);
    return new TextDecoder().decode(bytes);
  }

  async writeFileStream(
    pathSegments: string[],
    stream: ReadableStream<Uint8Array>,
    signalOrOptions?: AbortSignal | WriteOptions
  ): Promise<{ bytesWritten: number }> {
    this.assertWritePermission();
    const { signal, exclusive } = normalizeWriteOptions(signalOrOptions);
    const fullPath = this.getFullPath(pathSegments);
    await this.hooks.onBeforeWrite?.(fullPath);

    const { dir, leafName } = this.resolveParentNode(pathSegments, true);
    if (exclusive) {
      this.assertExclusiveInDir(dir, leafName, pathSegments.join('/'));
    } else {
      const existing = dir.children.get(leafName);
      if (existing && existing.kind === 'directory') {
        throw new Error(`Cannot overwrite directory "${leafName}" with a file.`);
      }
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = stream.getReader();

    try {
      while (true) {
        if (signal?.aborted) {
          throw new DOMException('Write cancelled by user.', 'AbortError');
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          const copy = value.slice();
          chunks.push(copy);
          total += copy.byteLength;
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Re-check exclusive right before committing to map in case onBeforeWrite or stream pull mutated target
    if (exclusive) {
      this.assertExclusiveInDir(dir, leafName, pathSegments.join('/'));
    }

    const combined = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.byteLength;
    }

    dir.children.set(leafName, {
      kind: 'file',
      name: leafName,
      data: combined,
      lastModified: Date.now(),
    });

    await this.hooks.onAfterWrite?.(fullPath);
    return { bytesWritten: total };
  }

  async writeFileBytes(
    pathSegments: string[],
    data: Uint8Array,
    options?: { exclusive?: boolean }
  ): Promise<void> {
    this.assertWritePermission();
    const fullPath = this.getFullPath(pathSegments);
    await this.hooks.onBeforeWrite?.(fullPath);

    const { dir, leafName } = this.resolveParentNode(pathSegments, true);
    if (options?.exclusive) {
      this.assertExclusiveInDir(dir, leafName, pathSegments.join('/'));
    } else {
      const existing = dir.children.get(leafName);
      if (existing && existing.kind === 'directory') {
        throw new Error(`Cannot overwrite directory "${leafName}" with a file.`);
      }
    }

    dir.children.set(leafName, {
      kind: 'file',
      name: leafName,
      data: data.slice(),
      lastModified: Date.now(),
    });

    await this.hooks.onAfterWrite?.(fullPath);
  }

  async writeFileText(
    pathSegments: string[],
    text: string,
    options?: { exclusive?: boolean }
  ): Promise<void> {
    await this.writeFileBytes(pathSegments, new TextEncoder().encode(text), options);
  }

  async removeEntry(pathSegments: string[], options?: { recursive?: boolean }): Promise<void> {
    this.assertWritePermission();
    const { dir, leafName } = this.resolveParentNode(pathSegments, false);
    const target = dir.children.get(leafName);
    if (!target) {
      throw new Error(`Entry "${pathSegments.join('/')}" does not exist.`);
    }
    if (target.kind === 'directory' && target.children.size > 0 && !options?.recursive) {
      throw new Error(`Directory "${leafName}" is not empty.`);
    }
    dir.children.delete(leafName);
  }
}

