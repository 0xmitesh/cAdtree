/**
 * Real Chrome path limits and the "path too long" diagnosis (Item 2 P7). Leaf module (no engine
 * imports) so fs-adapter can use it without an import cycle; path-budget re-exports it.
 *
 * These are the REAL limits, used only to explain a failed create/write. The 200/240 budget that
 * is enforced at create time lives in path-budget.ts and is unchanged.
 */

export type PathSeparator = '\\' | '/';

/** Windows drive (`C:\...`, `C:/...`) and UNC (`\\server\...`) addresses use `\`; everything else uses `/`. */
export function addressSeparator(address: string): PathSeparator {
  return address.includes('\\') || /^[A-Za-z]:/.test(address) ? '\\' : '/';
}

/**
 * Joins an absolute address and relative segments with the address's own separator, without
 * double separators. A segment may itself contain "/" (cAdtree's relative paths); it is split.
 */
export function joinAddress(address: string, ...segments: string[]): string {
  const sep = addressSeparator(address);
  let base = address;
  while (base.length > 0 && (base.endsWith('/') || base.endsWith('\\'))) base = base.slice(0, -1);
  const parts = segments.flatMap((segment) => segment.split(/[\\/]+/)).filter((part) => part.length > 0);
  return [base, ...parts].join(sep);
}

export type PathOperation = 'folder' | 'file';

/** Measured with Chrome (full absolute path, UTF-16 units). A file write adds the 7-char `.crswap` sibling. */
export const REAL_LIMITS = {
  windows: { folder: 248, file: 252 },
  posix: { folder: 1024, file: 1017 },
} as const;

/** Thrown when a create or write failed opaquely and the real path is at or over the platform limit. */
export class PathTooLongError extends Error {
  constructor(
    readonly fullPath: string,
    readonly length: number,
    readonly limit: number,
    readonly operation: PathOperation,
    cause?: unknown,
  ) {
    super(
      `Path too long: ${fullPath} (${length} characters; this computer's limit is ${limit}). ` +
      `Shorten the folder or file names along this path, or move your Cadtree home closer to the drive ` +
      `(e.g. ${addressSeparator(fullPath) === '/' ? '/Users/<you>/Cadtree' : 'C:\\Cadtree'}).`,
      { cause },
    );
    this.name = 'PathTooLongError';
  }
}

/** True for the opaque DOMExceptions Chrome throws when a path is too long. */
function isOpaquePathFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { name?: unknown }).name === 'string' &&
    ((error as { name: string }).name === 'InvalidStateError' || (error as { name: string }).name === 'NotFoundError') &&
    (typeof DOMException === 'undefined' || error instanceof DOMException)
  );
}

/**
 * Returns a PathTooLongError when `error` is an opaque Chrome failure and `fullPath` (the item
 * being created or written, absolute) is at or over the real limit; otherwise returns `error`
 * unchanged. `address` unknown -> unchanged (never guess).
 */
export function diagnosePathFailure(
  error: unknown,
  fullPath: string | undefined,
  operation: PathOperation,
): unknown {
  if (!fullPath || !isOpaquePathFailure(error)) return error;
  const limits = addressSeparator(fullPath) === '\\' ? REAL_LIMITS.windows : REAL_LIMITS.posix;
  const limit = limits[operation];
  return fullPath.length >= limit ? new PathTooLongError(fullPath, fullPath.length, limit, operation, error) : error;
}
