// Offline guide files (CLAUDE.md §2) that browser fixtures must not count as changes to the user's data.
// The app writes the home Readme and Index when a writable home is opened, and a project's Map and revision
// listings after a successful write to that project. They are derived and never read back.
export const isHomeGuideFile = (path: string): boolean => path === "_README cAdtree.txt" || path === "_INDEX cAdtree.txt";
// Paths are relative to the home: <workspace>/projects/<project>/_MAP cAdtree.txt and .../vault/revisions/<id>.txt.
// Anchored so a file with these names inside working/… is still counted as the user's data.
export const isProjectGuideFile = (path: string): boolean =>
  /^[^/]+\/projects\/[^/]+\/(_MAP cAdtree\.txt|vault\/revisions\/[^/]+\.txt)$/.test(path);
