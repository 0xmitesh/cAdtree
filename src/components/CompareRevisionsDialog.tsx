import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import type {
  FileEntry,
  ReconstructedRevision,
  VaultState,
} from "../engine/types";
import {
  compareSavedRevisions,
  comparisonEndpoint,
} from "../engine/snapshot-comparison";
import { formatRevisionNumber } from "../engine/vault-service";
import { formatBytes } from "../utils/format";
import { caseLabel } from "../engine/case-lifecycle";
import { Modal, Notice, NotesText, StatusBadge } from "./ui";

export function CompareRevisionsDialog({
  state,
  inspectedId,
  initialPath,
  initialFromId,
  onClose,
}: {
  state: VaultState;
  inspectedId: string;
  initialPath: string;
  initialFromId?: string;
  onClose: () => void;
}) {
  const [toId, setToId] = useState(inspectedId);
  const [fromId, setFromId] = useState(() => {
    if (initialFromId !== undefined) return initialFromId;
    const endpoint = comparisonEndpoint(state, inspectedId);
    if (endpoint.status !== "available") return "";
    const parentId = endpoint.revision.manifest.parentRevisionId;
    return parentId &&
      comparisonEndpoint(state, parentId).status === "available"
      ? parentId
      : "";
  });
  const [scopePath, setScopePath] = useState(initialPath);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const fromSelect = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    fromSelect.current?.focus();
  }, []);
  const comparison = useMemo(
    () => compareSavedRevisions(state, fromId, toId),
    [state, fromId, toId],
  );
  const label = (revision: ReconstructedRevision) =>
    `${formatRevisionNumber(revision.manifest.displayNumber)} · ${caseLabel(state, revision.manifest.branchId)} · ${revision.manifest.summary}`;
  const options = useMemo(() => {
    const revisions = new Map<string, ReconstructedRevision | undefined>();
    for (const revision of [...state.revisions].sort(
      (a, b) =>
        b.manifest.displayNumber - a.manifest.displayNumber ||
        a.manifest.revisionId.localeCompare(b.manifest.revisionId),
    ))
      if (!revisions.has(revision.manifest.revisionId))
        revisions.set(revision.manifest.revisionId, revision);
    for (const record of state.corruptedRecords)
      if (record.revisionId && !revisions.has(record.revisionId))
        revisions.set(record.revisionId, undefined);
    return [...revisions].map(([id, revision]) => ({
      id,
      text: revision ? label(revision) : `Unavailable version · ${id}`,
    }));
  }, [state]);
  const endpointControls = (
    side: "From" | "To",
    id: string,
    setId: (id: string) => void,
  ) => {
    const endpoint = comparisonEndpoint(state, id);
    return (
      <label className="comparison-endpoint">
        <span>
          <strong>{side}</strong> ·{" "}
          {side === "From" ? "starting point" : "compared state"}
        </span>
        <select
          ref={side === "From" ? fromSelect : undefined}
          aria-label={`${side} version`}
          value={id}
          title={
            endpoint.status === "available"
              ? label(endpoint.revision)
              : undefined
          }
          onChange={(event) => {
            setId(event.target.value);
            setShowUnchanged(false);
          }}
        >
          <option value="">Choose {side} version</option>
          {id && !options.some((o) => o.id === id) ? (
            <option value={id}>Unavailable version · {id}</option>
          ) : null}
          {options.map((option) => (
            <option value={option.id} key={option.id}>
              {option.text}
            </option>
          ))}
        </select>
        {id && endpoint.status === "unavailable" ? (
          <span className="comparison-endpoint-error" role="alert">
            {side} version unavailable. {endpoint.reason}
          </span>
        ) : null}
        {endpoint.status === "available" ? (
          <>
            <span className="comparison-endpoint-summary">
              {label(endpoint.revision)}
            </span>
            <span className="muted small">
              {endpoint.revision.manifest.files.length} files ·{" "}
              {endpoint.revision.integrityStatus === "objects_verified"
                ? "Records and file contents checked"
                : "Records checked · file contents not checked yet"}
            </span>
          </>
        ) : null}
      </label>
    );
  };
  const result = comparison.status === "compared" ? comparison : null;
  const diff = result?.diff;
  const fromComponents = state.components?.revisions[fromId];
  const toComponents = state.components?.revisions[toId];
  const identityChanges = fromComponents && toComponents ? [
    ...fromComponents.files.flatMap(file => {
      const next = toComponents.files.find(f => f.componentId === file.componentId);
      return next && next.path !== file.path ? [`Same file: ${file.path} → ${next.path}`] : [];
    }),
    ...fromComponents.files.flatMap(file => toComponents.files.some(f => f.path === file.path && f.componentId !== file.componentId) ? [`Different files at ${file.path}`] : []),
  ] : [];
  type Row = {
    path: string;
    status: "Added" | "Deleted" | "Modified" | "Unchanged";
    before?: FileEntry;
    after?: FileEntry;
  };
  const changed: Row[] = diff
    ? [
        ...diff.added.map((file) => ({
          path: file.path,
          status: "Added" as const,
          after: file,
        })),
        ...diff.deleted.map((file) => ({
          path: file.path,
          status: "Deleted" as const,
          before: file,
        })),
        ...diff.modified.map((change) => ({
          path: change.current.path,
          status: "Modified" as const,
          before: change.previous,
          after: change.current,
        })),
      ]
        .filter((row) => !scopePath || row.path === scopePath)
        .sort((a, b) => a.path.localeCompare(b.path))
    : [];
  const beforeFiles = new Map(
    result?.from.manifest.files.map((file) => [file.path, file]),
  );
  const unchanged: Row[] =
    diff?.unchanged
      .filter((file) => !scopePath || file.path === scopePath)
      .map((file) => ({
        path: file.path,
        status: "Unchanged",
        before: beforeFiles.get(file.path),
        after: file,
      })) ?? [];
  const rowView = (row: Row) => (
    <article
      className="comparison-file"
      key={row.path}
      aria-label={`${row.status}: ${row.path}`}
    >
      <div className="comparison-file-heading">
        <strong className="file-path">{row.path}</strong>
        <StatusBadge status={row.status} />
      </div>
      <div className="comparison-file-endpoints">
        {[
          { side: "From", revision: result!.from, file: row.before },
          { side: "To", revision: result!.to, file: row.after },
        ].map(({ side, revision, file }) => {
          const notes =
            revision.manifest.fileNotes?.filter(
              (note) => note.path === row.path,
            ) ?? [];
          return (
            <section
              key={side}
              aria-label={`${side} ${formatRevisionNumber(revision.manifest.displayNumber)}: ${row.path}`}
            >
              <h4>
                {side} · {formatRevisionNumber(revision.manifest.displayNumber)}
              </h4>
              <p className="small">
                {file
                  ? `${formatBytes(file.size)} · present`
                  : "Not present in this version"}
              </p>
              {notes.length ? (
                <div className="comparison-file-notes">
                  <strong className="small">
                    File notes at{" "}
                    {formatRevisionNumber(revision.manifest.displayNumber)}
                  </strong>
                  {notes.map((note) => (
                    <NotesText key={note.path} notes={note} />
                  ))}
                </div>
              ) : (
                <p className="muted small">
                  No per-file notes for this version.
                </p>
              )}
            </section>
          );
        })}
      </div>
    </article>
  );
  const checksumRows = [
    ...changed,
    ...(scopePath || showUnchanged ? unchanged : []),
  ];
  const directoryCount =
    (diff?.addedDirectories.length ?? 0) +
    (diff?.deletedDirectories.length ?? 0);
  return (
    <Modal title="Compare saved versions" onClose={onClose}>
      <div className="revision-comparison">
        <p className="muted">
          From → To compares the saved files by their checksums. It does not
          look inside the files or check that they fit together.
        </p>
        <div className="comparison-selectors">
          {endpointControls("From", fromId, setFromId)}
          <button
            className="button secondary comparison-swap"
            disabled={!fromId || !toId}
            onClick={() => {
              setFromId(toId);
              setToId(fromId);
              setShowUnchanged(false);
            }}
          >
            <ArrowLeftRight size={15} /> Swap
          </button>
          {endpointControls("To", toId, setToId)}
        </div>
        <div
          className="comparison-scope"
          role="group"
          aria-label="Comparison scope"
        >
          <span>
            {scopePath ? (
              <>
                Scope: File · <strong className="file-path">{scopePath}</strong>
              </>
            ) : (
              "Scope: All project files"
            )}
          </span>
          {initialPath ? (
            <button
              className="text-button"
              onClick={() => {
                setScopePath(scopePath ? "" : initialPath);
                setShowUnchanged(false);
              }}
            >
              {scopePath ? "Show all files" : "Focus on selected file"}
            </button>
          ) : null}
        </div>
        {!fromId || !toId ? (
          <Notice>
            {!fromId
              ? "Choose a From version to start the comparison."
              : "Choose a To version."}
          </Notice>
        ) : null}
        {comparison.status === "unavailable" && fromId && toId ? (
          <Notice type="error">
            Comparison unavailable. {comparison.reason}
          </Notice>
        ) : null}
        {result ? (
          <>
            <p className="small muted">
              Notes are shown for the two chosen versions only, not for the
              versions in between. This comparison does not re-check the stored
              file contents.
            </p>
            <div
              className="comparison-counts"
              role="status"
              aria-label="Comparison counts"
            >
              {(["Added", "Deleted", "Modified", "Unchanged"] as const).map(
                (status) => (
                  <span key={status}>
                    <strong>
                      {status === "Unchanged"
                        ? unchanged.length
                        : changed.filter((row) => row.status === status).length}
                    </strong>{" "}
                    {status.toLowerCase()}
                  </span>
                ),
              )}
            </div>
            {scopePath && !changed.length && !unchanged.length ? (
              <Notice>The selected path is absent in both versions.</Notice>
            ) : !changed.length ? (
              <Notice>
                {scopePath
                  ? "No byte differences for this file."
                  : directoryCount
                    ? "No file differences. Project directory changes are listed below."
                    : "No file or folder differences between these versions."}
              </Notice>
            ) : null}
            <section aria-label="Overall notes">
              <details className="disclosure comparison-overall-notes" open>
                <summary>Overall notes</summary>
                <p className="muted small">
                  These notes describe the complete project version, including
                  when comparing a single file.
                </p>
                <div className="comparison-file-endpoints">
                  {[
                    { side: "From", revision: result.from },
                    { side: "To", revision: result.to },
                  ].map(({ side, revision }) => (
                    <section
                      key={side}
                      aria-label={`${side} overall notes at ${formatRevisionNumber(revision.manifest.displayNumber)}`}
                    >
                      <h4>
                        {side} ·{" "}
                        {formatRevisionNumber(revision.manifest.displayNumber)}
                      </h4>
                      {Object.values(revision.manifest.notes).some((value) =>
                        value.trim(),
                      ) ? (
                        <NotesText notes={revision.manifest.notes} />
                      ) : (
                        <p className="muted small">
                          No overall notes for this version.
                        </p>
                      )}
                    </section>
                  ))}
                </div>
              </details>
            </section>
            <section aria-label="Changed files comparison">
              {changed.map(rowView)}
            </section>
            {unchanged.length ? (
              <>
                {!scopePath ? (
                  <button
                    className="text-button comparison-unchanged"
                    aria-expanded={showUnchanged}
                    onClick={() => setShowUnchanged(!showUnchanged)}
                  >
                    {showUnchanged ? "Hide" : "Show"} {unchanged.length}{" "}
                    unchanged files
                  </button>
                ) : null}
                {scopePath || showUnchanged ? (
                  <section aria-label="Unchanged files comparison">
                    {unchanged.map(rowView)}
                  </section>
                ) : null}
              </>
            ) : null}
            <details className="disclosure comparison-technical">
              <summary>Technical details</summary>
              {identityChanges.length ? (
                <section aria-label="File identity between the two versions">
                  <h4>File identity between the two versions</h4>
                  {identityChanges.map((message) => (
                    <p className="file-path" key={message}>
                      {message}
                    </p>
                  ))}
                  <p className="muted small">
                    Byte differences above remain grouped by saved path.
                  </p>
                </section>
              ) : null}
              {!fromComponents || !toComponents ? (
                <p className="muted small">
                  Renames could not be followed for one or both versions.
                  This comparison uses saved paths and file checksums.
                </p>
              ) : null}
              <section aria-label="File checksums">
                <h4>File checksums (SHA-256)</h4>
                {checksumRows.length ? (
                  checksumRows.map((row) => (
                    <dl className="technical-data" key={row.path}>
                      <dt>{row.path}</dt>
                      {[
                        { side: "From", revision: result.from, file: row.before },
                        { side: "To", revision: result.to, file: row.after },
                      ].map(({ side, revision, file }) => (
                        <dd key={side}>
                          {side} ·{" "}
                          {formatRevisionNumber(revision.manifest.displayNumber)}
                          :{" "}
                          {file ? <code>{file.sha256}</code> : "Not present"}
                        </dd>
                      ))}
                    </dl>
                  ))
                ) : (
                  <p className="muted small">No files in this comparison.</p>
                )}
              </section>
            </details>
            <details className="disclosure comparison-directories">
              <summary>Project directory changes ({directoryCount})</summary>
              <p className="muted small">
                All project directories, including empty folders; independent of
                file scope.
              </p>
              {diff!.addedDirectories.map((path) => (
                <p className="file-path" key={`added:${path}`}>
                  Added · {path}/
                </p>
              ))}
              {diff!.deletedDirectories.map((path) => (
                <p className="file-path" key={`deleted:${path}`}>
                  Deleted · {path}/
                </p>
              ))}
              {!directoryCount ? (
                <p>No directory additions or deletions.</p>
              ) : null}
            </details>
          </>
        ) : null}
        <div className="modal-actions">
          <button className="button secondary" onClick={onClose}>
            Close comparison
          </button>
        </div>
      </div>
    </Modal>
  );
}
