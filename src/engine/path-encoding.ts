/** Lossless, filename-safe encoding for UUID and checksum bytes. */
export function compactHex(hex: string): string {
  if (!/^(?:[a-f0-9]{2})+$/.test(hex)) throw new Error('Invalid hexadecimal path identity.');
  return btoa(String.fromCharCode(...hex.match(/../g)!.map(byte => parseInt(byte, 16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function expandHex(encoded: string): string {
  const hex = Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4)), char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  if (compactHex(hex) !== encoded) throw new Error('Invalid reference publication encoding.');
  return hex;
}
