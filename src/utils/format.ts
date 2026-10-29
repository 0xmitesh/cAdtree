export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${val.toFixed(i === 0 ? 0 : val < 10 ? 2 : 1)} ${units[i]}`;
}

export function formatTimestamp(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  } catch {
    return isoString;
  }
}

export function shortHash(sha256: string, length = 12): string {
  if (!sha256) return '—';
  return sha256.slice(0, length);
}

export function getCadFileTypeLabel(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.sldasm')) return 'SolidWorks Assembly (.SLDASM)';
  if (lower.endsWith('.sldprt')) return 'SolidWorks Part (.SLDPRT)';
  if (lower.endsWith('.slddrw')) return 'SolidWorks Drawing (.SLDDRW)';
  if (lower.endsWith('.step') || lower.endsWith('.stp')) return 'STEP Exchange';
  if (lower.endsWith('.iges') || lower.endsWith('.igs')) return 'IGES Exchange';
  if (lower.endsWith('.stl')) return 'STL Mesh';
  if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'Engineering Document';
  const extMatch = filePath.match(/\.([^./]+)$/);
  return extMatch ? `.${extMatch[1].toUpperCase()} File` : 'Binary File';
}

export function isEmbeddedIframe(): boolean {
  try {
    return typeof window !== 'undefined' && window.self !== window.top;
  } catch {
    return true;
  }
}

export function supportsFileSystemAccessApi(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker ===
      'function'
  );
}
