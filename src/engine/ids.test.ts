import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_ID_LENGTH, RECORD_ID_LENGTH, eventIdBase, eventIdCandidate, isEventId, isRecordId, newRecordId,
} from './ids';

const fixed = new Date(Date.UTC(2026, 10, 9, 23, 59, 59));
const constant = (byte: number) => (n: number) => new Uint8Array(n).fill(byte);

test('record ID has the fixed 22-character UTC format', () => {
  const id = newRecordId(fixed);
  assert.equal(id.length, RECORD_ID_LENGTH);
  assert.match(id, /^20261109-235959-[0-9a-z]{6}$/);
  assert.ok(isRecordId(id));
  assert.match(newRecordId(), /^[0-9a-z-]+$/);
});

test('timestamps are UTC regardless of the local zone', () => {
  // 23:59:59 at +05:30 is 18:29:59 UTC on the same day.
  const local = new Date('2026-11-09T23:59:59+05:30');
  assert.equal(eventIdBase(local), '20261109-182959');
  assert.equal(newRecordId(local, constant(0)).slice(0, 15), '20261109-182959');
  assert.equal(eventIdBase(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), '20260102-030405');
});

test('random characters are lowercase [0-9a-z] only, even from a real source', () => {
  for (let i = 0; i < 200; i++) assert.match(newRecordId().slice(16), /^[0-9a-z]{6}$/);
});

test('random source is injectable and maps bytes without modulo bias', () => {
  assert.equal(newRecordId(fixed, constant(0)).slice(16), '000000');
  assert.equal(newRecordId(fixed, (n) => Uint8Array.from({ length: n }, (_, i) => i + 10)).slice(16), 'abcdef');
  // Bytes 252..255 would favour the first four characters: they are skipped.
  const seq = [255, 254, 253, 252, 35, 36, 71, 0, 1, 2];
  let calls = 0;
  const id = newRecordId(fixed, (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = seq[(calls++) % seq.length];
    return out;
  });
  assert.equal(id.slice(16), 'z0z012');
});

test('each of the 36 characters is reachable and equally mapped from accepted bytes', () => {
  const counts = new Map<string, number>();
  for (let byte = 0; byte < 252; byte++) {
    const ch = newRecordId(fixed, constant(byte)).slice(16, 17);
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  assert.equal(counts.size, 36);
  assert.ok([...counts.values()].every((n) => n === 7));
  // A byte that is rejected never appears: an all-rejected source fails instead of looping forever.
  assert.throws(() => newRecordId(fixed, constant(255)), /usable bytes/);
});

test('event ID candidates follow base, -2, -3 ...', () => {
  const base = eventIdBase(fixed);
  assert.equal(base.length, EVENT_ID_LENGTH);
  assert.deepEqual([1, 2, 3, 10].map((n) => eventIdCandidate(base, n)), [
    '20261109-235959', '20261109-235959-2', '20261109-235959-3', '20261109-235959-10',
  ]);
  for (const n of [1, 2, 3, 10, 99]) assert.ok(isEventId(eventIdCandidate(base, n)));
  assert.throws(() => eventIdCandidate(base, 0), /positive/);
  assert.throws(() => eventIdCandidate(base, 1.5), /positive/);
  assert.throws(() => eventIdCandidate(base, 1000), /up to 999/);
  assert.ok(isEventId(eventIdCandidate(base, 999)));
  assert.equal(isEventId('20261109-235959-1000'), false);
});

test('validators accept exact formats and reject near misses', () => {
  assert.ok(isRecordId('20261109-235959-a1b2c3'));
  for (const bad of [
    '', '20261109-235959-A1b2c3', '20261109-235959-a1b2c', '20261109-235959-a1b2c3d', '20261109235959-a1b2c3',
    '20261109-235959', '20261109-235959-a1b2c3\n', ' 20261109-235959-a1b2c3', '20261109-235959-a1b2c-', '２0261109-235959-a1b2c3',
  ]) assert.equal(isRecordId(bad), false, JSON.stringify(bad));
  assert.equal(isRecordId(undefined), false);

  assert.ok(isEventId('20261109-235959'));
  assert.ok(isEventId('20261109-235959-2'));
  assert.ok(isEventId('20261109-235959-17'));
  for (const bad of [
    '', '20261109-235959-', '20261109-235959-0', '20261109-235959-1', '20261109-235959-02', '20261109-235959-a1b2c3',
    '20261109-23595', '20261109-235959\n', '20261109-235959-2-3', 'apply-20261109-235959',
  ]) assert.equal(isEventId(bad), false, JSON.stringify(bad));
  assert.equal(isEventId(null), false);
});

test('event and record ID namespaces are disjoint', () => {
  const base = eventIdBase(fixed);
  for (let n = 1; n <= 999; n++) {
    assert.equal(isRecordId(eventIdCandidate(base, n)), false, String(n));
    assert.ok(isEventId(eventIdCandidate(base, n)), String(n));
  }
  for (let i = 0; i < 200; i++) assert.equal(isEventId(newRecordId()), false);
  assert.equal(isEventId(newRecordId(fixed, (n) => new Uint8Array(n).fill(0))), false);
});
