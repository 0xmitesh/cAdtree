import { splitAndValidatePath } from "../engine/fs-adapter";

/** Machine-specific text for shortcuts only. Never pass it to filesystem operations. */
export function normalizeWindowsWorkspacePath(input: string): string {
  if (/[\x00-\x1f\x7f]/.test(input))
    throw new Error("The path contains control characters.");
  let path = input.trim();
  if (!path) return "";
  if (
    (path.startsWith('"') && path.endsWith('"')) ||
    (path.startsWith("'") && path.endsWith("'"))
  ) {
    path = path.slice(1, -1);
  }
  if (/[\x00-\x1f\x7f]/.test(path) || /:\/\//.test(path))
    throw new Error("Enter a full Windows folder path, not a URL.");
  if (path.startsWith("//"))
    throw new Error(
      "Use Windows backslashes for a UNC path, not a URL-style address.",
    );
  path = path.replaceAll("/", "\\");
  let prefix: string;
  let parts: string[];
  if (/^[a-z]:\\/i.test(path)) {
    prefix = path[0].toUpperCase() + ":\\";
    parts = path.slice(3).replace(/\\+$/, "").split("\\");
    if (parts.length === 1 && parts[0] === "") parts = [];
  } else if (path.startsWith("\\\\")) {
    const unc = path.slice(2).replace(/\\+$/, "").split("\\");
    if (unc.length < 2)
      throw new Error("A UNC path needs both a server and a share name.");
    validateWindowsSegments(unc);
    prefix = `\\\\${unc[0]}\\${unc[1]}`;
    parts = unc.slice(2);
  } else {
    throw new Error(
      "Enter an absolute Windows path, such as D:\\CAD Workspace or \\\\server\\share.",
    );
  }
  validateWindowsSegments(parts);
  return (
    prefix +
    (parts.length ? (prefix.endsWith("\\") ? "" : "\\") + parts.join("\\") : "")
  );
}

export function validateWindowsSegments(parts: string[]) {
  if (!parts.length) return;
  splitAndValidatePath(parts.join("/"));
  if (
    parts.some(
      (part) =>
        /[:*?"<>|\x7f]/.test(part) ||
        /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part),
    )
  ) {
    throw new Error(
      "The path contains a name or character that Windows cannot use.",
    );
  }
}

export interface FilePathLocation {
  workspaceId: string;
  relativeDirectory: string;
  filePath: string;
}
export type ResolveFilePath = () => Promise<FilePathLocation>;

export function composeWindowsFilePaths(
  rootInput: string,
  location: FilePathLocation,
) {
  const root = normalizeWindowsWorkspacePath(rootInput);
  if (!root)
    throw new Error(
      "Set the Windows workspace location to enable path shortcuts.",
    );
  const directory = splitAndValidatePath(location.relativeDirectory);
  const file = splitAndValidatePath(location.filePath);
  validateWindowsSegments([...directory, ...file]);
  const base = root.endsWith("\\") ? root : root + "\\";
  return {
    file: base + [...directory, ...file].join("\\"),
    folder: base + [...directory, ...file.slice(0, -1)].join("\\"),
  };
}
