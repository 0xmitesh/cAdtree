import type { FileSystemDirectoryAdapter } from "../src/engine/fs-adapter";

// Browsers structured-clone native directory handles. Node cannot clone this
// facade's methods, so retain known test handles while cloning ordinary data.
const nativeClone = globalThis.structuredClone;
const testHandles = new WeakSet<object>();
function cloneWithHandles<T>(value: T, seen = new Map<object, unknown>()): T {
  if (!value || typeof value !== 'object') return nativeClone(value);
  if (testHandles.has(value)) return value;
  if (seen.has(value)) return seen.get(value) as T;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return nativeClone(value);
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) (copy as Record<string, unknown>)[key] = cloneWithHandles(item, seen);
  return copy as T;
}
globalThis.structuredClone = <T>(value: T, options?: StructuredSerializeOptions): T => options?.transfer?.length ? nativeClone(value, options) : cloneWithHandles(value);

/** Test-only native-handle facade: production adapters/services still perform all I/O. */
export function nativeDirectory(
  dir: FileSystemDirectoryAdapter,
): FileSystemDirectoryHandle {
  const handle = {
    kind: "directory",
    name: dir.name,
    adapter: dir,
    queryPermission: (options: { mode: "read" | "readwrite" }) =>
      dir.queryPermission(options.mode),
    requestPermission: (options: { mode: "read" | "readwrite" }) =>
      dir.requestPermission(options.mode),
    isSameEntry: (other: { adapter: FileSystemDirectoryAdapter }) =>
      dir.isSameEntry(other.adapter),
    resolve: (other: { adapter: FileSystemDirectoryAdapter }) =>
      dir.resolveRelativePath(other.adapter),
    getDirectoryHandle: async (name: string, options?: { create?: boolean }) =>
      nativeDirectory(await dir.getDirectory([name], options)),
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!(await dir.hasFile([name]))) {
        if (!options?.create) throw new Error("File not found");
        await dir.writeFileBytes([name], new Uint8Array());
      }
      return {
        kind: "file",
        name,
        getFile: async () => ({
          ...(await dir.statFile([name])),
          stream: () =>
            new ReadableStream({
              async start(controller) {
                controller.enqueue(await dir.readFileBytes([name]));
                controller.close();
              },
            }),
          arrayBuffer: async () => (await dir.readFileBytes([name])).buffer,
          text: () => dir.readFileText([name]),
        }),
        createWritable: async () => {
          const chunks: Uint8Array[] = [];
          return {
            write: async (data: Uint8Array) => {
              chunks.push(new Uint8Array(data));
            },
            close: async () => {
              const result = new Uint8Array(
                chunks.reduce((size, chunk) => size + chunk.length, 0),
              );
              let offset = 0;
              for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
              }
              await dir.writeFileBytes([name], result);
            },
            abort: async () => {},
          };
        },
      };
    },
    removeEntry: (name: string, options?: { recursive?: boolean }) =>
      dir.removeEntry([name], options),
    async *[Symbol.asyncIterator]() {
      for (const entry of await dir.listEntries()) {
        yield [
          entry.name,
          entry.kind === "directory"
            ? nativeDirectory(await dir.getDirectory([entry.name]))
            : { name: entry.name, kind: "file" },
        ];
      }
    },
  };
  testHandles.add(handle);
  return handle as unknown as FileSystemDirectoryHandle;
}
