/**
 * Coordinates single-writer mutations per project ID across same-origin browser tabs
 * using the Web Locks API, with an in-process async mutex queue fallback for
 * deterministic serialization inside the same JavaScript context / Node test runner.
 */

const inProcessQueues = new Map<string, Promise<unknown>>();

/**
 * Proof that the caller is running inside `withProjectWriterLock` for `projectId`.
 * Only this module can create one (the class is not exported, and its private
 * field makes the type nominal), and it counts as held only until that lock's
 * callback settles.
 */
class HeldProjectWriterLock {
  readonly #brand = true;
  constructor(readonly projectId: string) {
    void this.#brand;
  }
}
export type ProjectWriterLock = HeldProjectWriterLock;

const heldLocks = new WeakSet<HeldProjectWriterLock>();

/** Throws unless `lock` is a currently held writer lock for `projectId`. */
export function assertHoldsProjectWriterLock(lock: ProjectWriterLock, projectId: string): void {
  if (!(lock instanceof HeldProjectWriterLock) || !heldLocks.has(lock) || lock.projectId !== projectId) {
    throw new Error('The project writer lock for this project is not held. Nothing was written.');
  }
}

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
  fn: (lock: ProjectWriterLock) => Promise<T>
): Promise<T> {
  if (!projectId || typeof projectId !== 'string') {
    throw new Error('Valid projectId is required to acquire writer lock.');
  }
  const lockName = `cadtree-writer-lock:${projectId}`;

  const holding = async (): Promise<T> => {
    const lock = new HeldProjectWriterLock(projectId);
    heldLocks.add(lock);
    try {
      return await fn(lock);
    } finally {
      heldLocks.delete(lock);
    }
  };

  return acquireInProcessLock(lockName, async () => {
    if (
      typeof navigator !== 'undefined' &&
      navigator.locks &&
      typeof navigator.locks.request === 'function'
    ) {
      return navigator.locks.request(lockName, { mode: 'exclusive' }, async () => {
        return holding();
      });
    }
    return holding();
  });
}
