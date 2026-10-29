/**
 * Coordinates single-writer mutations per project ID across same-origin browser tabs
 * using the Web Locks API, with an in-process async mutex queue fallback for
 * deterministic serialization inside the same JavaScript context / Node test runner.
 */

const inProcessQueues = new Map<string, Promise<unknown>>();

async function acquireInProcessLock<T>(lockName: string, fn: () => Promise<T>): Promise<T> {
  const previous = inProcessQueues.get(lockName) ?? Promise.resolve();
  let release!: () => void;
  const currentGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const chained = previous.then(() => currentGate);
  inProcessQueues.set(lockName, chained);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (inProcessQueues.get(lockName) === chained) {
      inProcessQueues.delete(lockName);
    }
  }
}

export async function withProjectWriterLock<T>(
  projectId: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!projectId || typeof projectId !== 'string') {
    throw new Error('Valid projectId is required to acquire writer lock.');
  }
  const lockName = `cadtree-writer-lock:${projectId}`;

  return acquireInProcessLock(lockName, async () => {
    if (
      typeof navigator !== 'undefined' &&
      navigator.locks &&
      typeof navigator.locks.request === 'function'
    ) {
      return navigator.locks.request(lockName, { mode: 'exclusive' }, async () => {
        return fn();
      });
    }
    return fn();
  });
}
