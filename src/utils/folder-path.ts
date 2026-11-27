import { splitAndValidatePath } from '../engine/fs-adapter';

export type PathSyntax = 'windows' | 'posix';
export interface AbsoluteFolderPath { path: string; syntax: PathSyntax }

/** Absolute address text is local convenience data, never a filesystem binding.
 * Its grammar is independent of the portable managed-relative-path grammar. */
export function parseAbsoluteFolderPath(input: string): AbsoluteFolderPath {
  if (/[\x00-\x1f\x7f]/.test(input)) throw new Error('The folder address contains control characters.');
  let path = input.trimStart();
  const wrapped = path.trimEnd();
  if ((wrapped.startsWith('"') && wrapped.endsWith('"')) || (wrapped.startsWith("'") && wrapped.endsWith("'"))) path = wrapped.slice(1, -1);
  if (path.startsWith('/') && !path.startsWith('//')) {
    path = path.replace(/\/+$/, '') || '/';
    const parts = path === '/' ? [] : path.slice(1).split('/');
    if (parts.some(p => !p || p === '.' || p === '..')) throw new Error('Use an absolute POSIX address without empty, . or .. segments.');
    // Backslashes, case and Unicode in a POSIX address remain literal.
    return { path, syntax: 'posix' };
  }
  if (path.startsWith('//')) throw new Error('Use a single leading / for a POSIX address, or Windows backslashes for a UNC address.');
  path = path.trimEnd().replaceAll('/', '\\');
  let prefix: string;
  let parts: string[];
  if (/^[a-z]:\\/i.test(path)) {
    prefix = path[0].toUpperCase() + ':\\';
    const rest = path.slice(3).replace(/\\+$/, '');
    parts = rest ? rest.split('\\') : [];
  } else if (path.startsWith('\\\\')) {
    const unc = path.slice(2).replace(/\\+$/, '').split('\\');
    if (unc.length < 2) throw new Error('A UNC address needs both a server and a share name.');
    validateWindowsSegments(unc);
    prefix = `\\\\${unc[0]}\\${unc[1]}`;
    parts = unc.slice(2);
  } else {
    throw new Error('Enter an absolute folder address, such as D:\\Cadtree, \\\\server\\share, /Users/you/Documents/Cadtree or /home/you/Documents/Cadtree. Use the full address; ~ and environment variables are not expanded.');
  }
  validateWindowsSegments(parts);
  return { path: prefix + (parts.length ? (prefix.endsWith('\\') ? '' : '\\') + parts.join('\\') : ''), syntax: 'windows' };
}

export function normalizeFolderPath(input: string): string {
  if (/[\x00-\x1f\x7f]/.test(input)) throw new Error('The folder address contains control characters.');
  return input.trim() ? parseAbsoluteFolderPath(input).path : '';
}

export function validateWindowsSegments(parts: string[]) {
  if (parts.some(p => !p || p === '.' || p === '..' || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(p) || /[ .]$/.test(p) || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(p))) {
    throw new Error('The path contains a name or character that Windows cannot use.');
  }
}

export interface FilePathLocation {
  workspaceId: string;
  relativeDirectory: string;
  filePath: string;
}
export type ResolveFilePath = () => Promise<FilePathLocation>;

export function composeFilePaths(rootInput: string, location: FilePathLocation) {
  if (!rootInput.trim()) throw new Error('Set the local folder address to enable path shortcuts.');
  const root = parseAbsoluteFolderPath(rootInput);
  const directory = splitAndValidatePath(location.relativeDirectory);
  const file = splitAndValidatePath(location.filePath);
  if (root.syntax === 'windows') validateWindowsSegments([...directory, ...file]);
  const separator = root.syntax === 'windows' ? '\\' : '/';
  const base = root.path.endsWith(separator) ? root.path : root.path + separator;
  return {
    file: base + [...directory, ...file].join(separator),
    folder: base + [...directory, ...file.slice(0, -1)].join(separator),
  };
}
