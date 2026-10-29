import { Sha256Hasher } from './hash';

interface WorkerCommand {
  id: string;
  type: 'init' | 'update' | 'digest' | 'hash_buffer';
  chunk?: Uint8Array;
}

const activeHashers = new Map<string, Sha256Hasher>();

self.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const { id, type, chunk } = event.data;
  try {
    if (type === 'init') {
      activeHashers.set(id, new Sha256Hasher());
      self.postMessage({ id, ok: true });
    } else if (type === 'update') {
      const hasher = activeHashers.get(id);
      if (!hasher) throw new Error(`Hasher session ${id} not initialized`);
      if (chunk) hasher.update(chunk);
      self.postMessage({ id, ok: true });
    } else if (type === 'digest') {
      const hasher = activeHashers.get(id);
      if (!hasher) throw new Error(`Hasher session ${id} not initialized`);
      const sha256 = hasher.digestHex();
      activeHashers.delete(id);
      self.postMessage({ id, ok: true, sha256 });
    } else if (type === 'hash_buffer') {
      const hasher = new Sha256Hasher();
      if (chunk) hasher.update(chunk);
      self.postMessage({ id, ok: true, sha256: hasher.digestHex() });
    }
  } catch (err) {
    activeHashers.delete(id);
    self.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
