import { FileSystemDirectoryAdapter } from './fs-adapter';
import { hashStream, hashString } from './hash';
import { compactHex } from './path-encoding';

export function getObjectPathSegments(sha256: string): string[] {
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`Invalid SHA-256 digest: "${sha256}"`);
  }
  const prefix = sha256.slice(0, 2);
  return ['objects', prefix, `${sha256}.bin`];
}

/** First 22 characters of the compact session hash: 132 bits, collision risk negligible, same safe charset. */
export const STAGING_SESSION_FOLDER_CHARS = 22;

export function getStagingSessionPathSegments(sessionId: string): string[] {
  return ['staging', compactHex(hashString(sessionId)).slice(0, STAGING_SESSION_FOLDER_CHARS)];
}

/**
 * Best-effort cleanup of a staging session folder after a successful write, mirroring the revision
 * capture path: a failed removal is ignored. The folder is removed only when it is empty (a surviving
 * .tmp from a failed attempt is kept and still reported); nothing else is ever deleted.
 */
export async function removeEmptyStagingSession(vaultDir: FileSystemDirectoryAdapter, sessionId: string): Promise<void> {
  try {
    const sessionPath = getStagingSessionPathSegments(sessionId);
    if (!(await vaultDir.hasDirectory(sessionPath))) return;
    if ((await (await vaultDir.getDirectory(sessionPath)).listEntries()).length > 0) return;
    await vaultDir.removeEntry(sessionPath);
  } catch {
    // Ignore staging cleanup failure
  }
}

export function getStagingObjectPathSegments(sessionId: string, sha256: string): string[] {
  // Bound temporary path length for both CAD captures and reference imports,
  // including the extra sibling filename used by browser writable streams.
  return [...getStagingSessionPathSegments(sessionId), `${compactHex(sha256)}.tmp`];
}

/**
 * Verifies a stored content object in the vault by streaming its actual bytes
 * and confirming both exact byte size and SHA-256 digest.
 * Existence or filename alone is never trusted.
 */
export async function verifyStoredObject(
  vaultDir: FileSystemDirectoryAdapter,
  sha256: string,
  expectedSize: number,
  signal?: AbortSignal
): Promise<{ valid: boolean; reason?: string }> {
  const objectSegments = getObjectPathSegments(sha256);
  const exists = await vaultDir.hasFile(objectSegments);
  if (!exists) {
    return {
      valid: false,
      reason: `Missing content object ${sha256.slice(0, 12)}... at ${objectSegments.join('/')}`,
    };
  }

  try {
    const stream = await vaultDir.readFileStream(objectSegments);
    const { sha256: actualHash, size: actualSize } = await hashStream(stream, { signal });

    if (actualSize !== expectedSize) {
      return {
        valid: false,
        reason: `Object ${sha256.slice(0, 12)}... size mismatch: expected ${expectedSize} bytes, found ${actualSize} bytes.`,
      };
    }

    if (actualHash !== sha256) {
      return {
        valid: false,
        reason: `Object ${sha256.slice(0, 12)}... hash mismatch: expected ${sha256}, computed ${actualHash}.`,
      };
    }

    return { valid: true };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return {
      valid: false,
      reason: `Failed to read/verify object ${sha256.slice(0, 12)}...: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * Stores a content-addressed binary object using staging + readback verification.
 * If the object already exists in the vault, it is verified by reading back all bytes
 * before reusing it. If an existing object in the vault is corrupt, capture aborts
 * unless overwritten cleanly or reported.
 */
export async function writeAndVerifyObject(
  vaultDir: FileSystemDirectoryAdapter,
  sessionId: string,
  expectedSha256: string,
  expectedSize: number,
  openSourceStream: () => Promise<ReadableStream<Uint8Array>>,
  signal?: AbortSignal
): Promise<{ reused: boolean; bytesProcessed: number }> {
  const objectSegments = getObjectPathSegments(expectedSha256);
  const alreadyExists = await vaultDir.hasFile(objectSegments);

  if (alreadyExists) {
    const verification = await verifyStoredObject(vaultDir, expectedSha256, expectedSize, signal);
    if (!verification.valid) {
      throw new Error(
        `Vault integrity error on reused object ${expectedSha256}: ${verification.reason}`
      );
    }
    return { reused: true, bytesProcessed: expectedSize };
  }

  const stagingSegments = getStagingObjectPathSegments(sessionId, expectedSha256);

  // 1. Stream from source into staging
  const sourceStream = await openSourceStream();
  const { bytesWritten } = await vaultDir.writeFileStream(stagingSegments, sourceStream, signal);
  if (bytesWritten !== expectedSize) {
    throw new Error(
      `Source instability while staging object ${expectedSha256.slice(0, 12)}...: expected ${expectedSize} bytes, wrote ${bytesWritten} bytes.`
    );
  }

  // 2. Reopen staged bytes and verify size and SHA-256
  const stagedStreamForVerify = await vaultDir.readFileStream(stagingSegments);
  const stagedVerify = await hashStream(stagedStreamForVerify, { signal });
  if (stagedVerify.size !== expectedSize || stagedVerify.sha256 !== expectedSha256) {
    throw new Error(
      `Staged object verification failed for ${expectedSha256.slice(0, 12)}...: expected (${expectedSize}B, ${expectedSha256}), got (${stagedVerify.size}B, ${stagedVerify.sha256}).`
    );
  }

  // 3. Stream verified staged bytes into canonical object path
  const stagedStreamForCommit = await vaultDir.readFileStream(stagingSegments);
  await vaultDir.writeFileStream(objectSegments, stagedStreamForCommit, signal);

  // 4. Reopen final stored object and verify size and SHA-256
  const finalVerification = await verifyStoredObject(vaultDir, expectedSha256, expectedSize, signal);
  if (!finalVerification.valid) {
    throw new Error(`Published object verification failed: ${finalVerification.reason}`);
  }

  // 5. Remove staged temporary file
  try {
    await vaultDir.removeEntry(stagingSegments);
  } catch {
    // Non-fatal staging cleanup
  }

  return { reused: false, bytesProcessed: expectedSize };
}
