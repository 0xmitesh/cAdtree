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
      text: revision ? label(revision) : `Unavailable revision · ${id}`,
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
          {side === "From" ? "comparison baseline" : "compared state"}
        </span>
        <select
          ref={side === "From" ? fromSelect : undefined}
          aria-label={`${side} revision`}
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
          <option value="">Choose {side} revision</option>
          {id && !options.some((o) => o.id === id) ? (
            <option value={id}>Unavailable revision · {id}</option>
          ) : null}
          {options.map((option) => (
            <option value={option.id} key={option.id}>
              {option.text}
            </option>
          ))}
        </select>
        {id && endpoint.status === "unavailable" ? (
          <span className="comparison-endpoint-error" role="alert">
            {side} revision unavailable. {endpoint.reason}
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
                ? "Metadata and file contents previously verified"
                : "Metadata verified · file contents not checked"}
            </span>
          </>
        ) : null}
      </label>
    );
  };
  const result = comparison.status === "compared" ? comparison : null;
  const diff = result?.diff;
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
                  : "Not present in this revision"}
              </p>
              {file ? (
                <details className="comparison-hash">
                  <summary>Content hash</summary>
                  <code>{file.sha256}</code>
                </details>
              ) : null}
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
                  No per-file notes at this endpoint.
                </p>
              )}
            </section>
          );
        })}
      </div>
    </article>
  );
  const directoryCount =
    (diff?.addedDirectories.length ?? 0) +
    (diff?.deletedDirectories.length ?? 0);
  return (
    <Modal title="Compare saved revisions" onClose={onClose}>
      <div className="revision-comparison">
        <p className="muted">
          From → To compares saved file bytes using manifest hashes. This does
          not analyze geometry or CAD compatibility.
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
              ? "Choose a From revision to set the comparison baseline."
              : "Choose a To revision."}
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
              Notes are recorded at the selected endpoints only; they do not
              summarize intervening revisions. This comparison does not verify
              stored binary contents.
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
              <Notice>The selected path is absent in both revisions.</Notice>
            ) : !changed.length ? (
              <Notice>
                {scopePath
                  ? "No byte differences for this file."
                  : directoryCount
                    ? "No file differences. Project directory changes are listed below."
                    : "No file or directory differences between these saved snapshots."}
              </Notice>
            ) : null}
            <section aria-label="Overall engineering notes">
              <details className="disclosure comparison-overall-notes" open>
                <summary>Overall engineering notes</summary>
                <p className="muted small">
                  These notes describe the complete project revision, including
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
                          No overall engineering notes at this endpoint.
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
