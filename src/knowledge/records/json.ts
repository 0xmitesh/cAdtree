import { isRecordId } from '../../engine/ids';
import type { JsonObject } from './types';

export function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function shape(value: unknown, required: string[], optional: string[] = []): value is JsonObject {
  return object(value) && required.every(k => Object.hasOwn(value, k)) &&
    Object.keys(value).every(k => required.includes(k) || optional.includes(k));
}

export const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
export const checksum = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const recordIdIsValid = (value: unknown): value is string => isRecordId(value);

/** Sorted object keys, original strings/array order/numeric values, finite JSON only.
 * Reject lossy JS values rather than silently dropping fields or invoking toJSON/getters. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown, depth: number): string {
    if (depth > 64) throw new Error('Knowledge JSON exceeds maximum nesting depth (64).');
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return Object.is(item, -0) ? '-0' : JSON.stringify(item);
    const array = Array.isArray(item);
    if (array && Object.getPrototypeOf(item) !== Array.prototype) throw new Error('Knowledge arrays must have the ordinary Array prototype.');
    if (!array && !object(item)) throw new Error('Knowledge data must contain only finite, plain JSON values.');
    if (ancestors.has(item)) throw new Error('Knowledge JSON must not contain cycles.');
    ancestors.add(item);
    const keys = Object.keys(item);
    if (Object.getOwnPropertyNames(item).length !== keys.length + (array ? 1 : 0)) throw new Error('Knowledge JSON cannot contain hidden properties.');
    if (Object.getOwnPropertySymbols(item).length || keys.some(k => !('value' in Object.getOwnPropertyDescriptor(item, k)!))) throw new Error('Knowledge JSON cannot contain symbols or accessors.');
    let encoded: string;
    if (array) {
      const length = Object.getOwnPropertyDescriptor(item, 'length');
      if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0 || keys.length !== length.value) throw new Error('Knowledge arrays must be dense and have no extra properties.');
      const elements: string[] = [];
      for (let i = 0; i < length.value; i++) {
        const element = Object.getOwnPropertyDescriptor(item, String(i));
        if (!element || !element.enumerable || !('value' in element)) throw new Error('Knowledge arrays require enumerable own data elements.');
        elements.push(encode(element.value, depth + 1));
      }
      encoded = `[${elements.join(',')}]`;
    } else {
      encoded = `{${keys.sort().map(k => `${JSON.stringify(k)}:${encode(Object.getOwnPropertyDescriptor(item, k)!.value, depth + 1)}`).join(',')}}`;
    }
    ancestors.delete(item);
    return encoded;
  }
  return encode(value, 0);
}
