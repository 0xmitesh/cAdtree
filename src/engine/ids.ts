/**
 * ID standards for FUTURE records (not yet used by the app).
 *
 * Record ID: `YYYYMMDD-HHMMSS-xxxxxx`, UTC date/time plus six random characters
 * from [0-9a-z]. 22 ASCII characters.
 * Event ID: `YYYYMMDD-HHMMSS`, and on a clash in the same parent `-2`, `-3`, ...
 */

export const RECORD_ID_LENGTH = 22;
export const EVENT_ID_LENGTH = 15;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const RANDOM_CHARS = 6;
/** Largest multiple of 36 that fits in a byte; bytes at or above it are rejected. */
const ACCEPT_BELOW = 252;

const RECORD_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-z]{6}$/;
/** Clash counter is limited to 2..999 so an event ID can never look like a record ID. */
const MAX_EVENT_ATTEMPT = 999;
const EVENT_ID_PATTERN = /^\d{8}-\d{6}(?:-[2-9]|-[1-9][0-9]{1,2})?$/;

export type RandomSource = (count: number) => Uint8Array;

const defaultRandomSource: RandomSource = (count) => crypto.getRandomValues(new Uint8Array(count));
const pad = (value: number, width: number) => String(value).padStart(width, '0');

function utcStamp(now: Date): string {
  if (Number.isNaN(now.getTime())) throw new Error('Invalid date for ID.');
  return (
    `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}` +
    `-${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}`
  );
}

/** Random [0-9a-z] characters via rejection sampling, so no character is favoured. */
function randomChars(count: number, source: RandomSource): string {
  let out = '';
  for (let rounds = 0; out.length < count; rounds++) {
    if (rounds > 1000) throw new Error('Random source did not produce usable bytes.');
    const bytes = source(Math.max(count - out.length, 1) * 2);
    for (const byte of bytes) {
      if (byte >= ACCEPT_BELOW) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === count) break;
    }
  }
  return out;
}

export function newRecordId(now: Date = new Date(), randomSource: RandomSource = defaultRandomSource): string {
  return `${utcStamp(now)}-${randomChars(RANDOM_CHARS, randomSource)}`;
}

export function eventIdBase(now: Date = new Date()): string {
  return utcStamp(now);
}

/** Attempt 1 is the base ID; attempt N (>= 2) is `${base}-N`. */
export function eventIdCandidate(base: string, attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAX_EVENT_ATTEMPT)
    throw new Error(`Event ID attempt must be a positive integer up to ${MAX_EVENT_ATTEMPT}.`);
  return attempt === 1 ? base : `${base}-${attempt}`;
}

export const isRecordId = (value: unknown): value is string => typeof value === 'string' && RECORD_ID_PATTERN.test(value);
export const isEventId = (value: unknown): value is string => typeof value === 'string' && EVENT_ID_PATTERN.test(value);
