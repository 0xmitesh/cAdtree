/**
 * Pure TypeScript incremental SHA-256 implementation (FIPS 180-4 / RFC 6234).
 * Processes arbitrarily large streams in bounded chunks without loading entire files into memory.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256Hasher {
  private state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private buffer = new Uint8Array(64);
  private bufferLength = 0;
  private bytesProcessed = 0;
  private W = new Uint32Array(64);
  private finished = false;

  update(chunk: Uint8Array): this {
    if (this.finished) {
      throw new Error('Cannot update a finalized Sha256Hasher instance.');
    }
    let offset = 0;
    let remaining = chunk.byteLength;
    this.bytesProcessed += remaining;

    if (this.bufferLength > 0) {
      const space = 64 - this.bufferLength;
      const toCopy = Math.min(remaining, space);
      this.buffer.set(chunk.subarray(offset, offset + toCopy), this.bufferLength);
      this.bufferLength += toCopy;
      offset += toCopy;
      remaining -= toCopy;

      if (this.bufferLength === 64) {
        this.compressBlock(this.buffer, 0);
        this.bufferLength = 0;
      }
    }

    while (remaining >= 64) {
      this.compressBlock(chunk, offset);
      offset += 64;
      remaining -= 64;
    }

    if (remaining > 0) {
      this.buffer.set(chunk.subarray(offset, offset + remaining), 0);
      this.bufferLength = remaining;
    }

    return this;
  }

  private compressBlock(block: Uint8Array, offset: number): void {
    const W = this.W;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      W[i] =
        ((block[j] << 24) |
          (block[j + 1] << 16) |
          (block[j + 2] << 8) |
          block[j + 3]) >>>
        0;
    }

    for (let i = 16; i < 64; i++) {
      const v1 = W[i - 15];
      const s0 = (((v1 >>> 7) | (v1 << 25)) ^ ((v1 >>> 18) | (v1 << 14)) ^ (v1 >>> 3)) >>> 0;
      const v2 = W[i - 2];
      const s1 = (((v2 >>> 17) | (v2 << 15)) ^ ((v2 >>> 19) | (v2 << 13)) ^ (v2 >>> 10)) >>> 0;
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }

    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];
    let f = this.state[5];
    let g = this.state[6];
    let h = this.state[7];

    for (let i = 0; i < 64; i++) {
      const S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }

  digestHex(): string {
    if (!this.finished) {
      this.finished = true;
      const bitLengthHigh = Math.floor(this.bytesProcessed / 0x20000000);
      const bitLengthLow = (this.bytesProcessed << 3) >>> 0;

      this.buffer[this.bufferLength++] = 0x80;

      if (this.bufferLength > 56) {
        this.buffer.fill(0, this.bufferLength, 64);
        this.compressBlock(this.buffer, 0);
        this.bufferLength = 0;
      }

      this.buffer.fill(0, this.bufferLength, 56);
      this.buffer[56] = (bitLengthHigh >>> 24) & 0xff;
      this.buffer[57] = (bitLengthHigh >>> 16) & 0xff;
      this.buffer[58] = (bitLengthHigh >>> 8) & 0xff;
      this.buffer[59] = bitLengthHigh & 0xff;
      this.buffer[60] = (bitLengthLow >>> 24) & 0xff;
      this.buffer[61] = (bitLengthLow >>> 16) & 0xff;
      this.buffer[62] = (bitLengthLow >>> 8) & 0xff;
      this.buffer[63] = bitLengthLow & 0xff;

      this.compressBlock(this.buffer, 0);
    }

    let hex = '';
    for (let i = 0; i < 8; i++) {
      hex += this.state[i].toString(16).padStart(8, '0');
    }
    return hex;
  }
}

export function hashBytes(bytes: Uint8Array): string {
  return new Sha256Hasher().update(bytes).digestHex();
}

export function hashString(text: string): string {
  return hashBytes(new TextEncoder().encode(text));
}

export async function hashStream(
  stream: ReadableStream<Uint8Array>,
  options?: {
    onChunk?: (chunkBytes: number, totalBytes: number) => void;
    signal?: AbortSignal;
  }
): Promise<{ sha256: string; size: number }> {
  const reader = stream.getReader();
  const hasher = new Sha256Hasher();
  let totalBytes = 0;

  try {
    while (true) {
      if (options?.signal?.aborted) {
        throw new DOMException('Operation cancelled by user.', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        hasher.update(value);
        totalBytes += value.byteLength;
        options?.onChunk?.(value.byteLength, totalBytes);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    sha256: hasher.digestHex(),
    size: totalBytes,
  };
}
