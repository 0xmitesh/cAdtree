/** Compatibility exports for existing callers; new code uses folder-path. */
export {
  normalizeFolderPath as normalizeWindowsWorkspacePath,
  composeFilePaths as composeWindowsFilePaths,
  validateWindowsSegments,
} from './folder-path';
export type { FilePathLocation, ResolveFilePath } from './folder-path';
