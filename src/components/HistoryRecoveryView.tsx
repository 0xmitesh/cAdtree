import { useMemo, useState } from "react";
import {
  ArrowDownToLine,
  File,
  GitBranch,
  History,
  List,
  Network,
  ShieldCheck,
} from "lucide-react";
import type {
  FileEntry,
  ProgressUpdate,
  RestoreResult,
  VaultState,
} from "../engine/types";
import {
  computeRevisionDiff,
  formatRevisionNumber,
} from "../engine/vault-service";
import { formatBytes, formatTimestamp } from "../utils/format";
import { layoutRevisions } from "../history/layout";
import { RevisionGraph } from "./RevisionGraph";
import {
  CreateBranchDialog,
  type CreateBranchParams,
} from "./CreateBranchDialog";
import { Modal, Notice, NotesText, OperationProgress, StatusBadge } from "./ui";

export interface HistoryRecoveryViewProps {
  vaultState: VaultState;
  activeBranchId: string;
  isRestoring: boolean;
  progress: ProgressUpdate | null;
  lastRestoreReport: { result: RestoreResult } | null;
  statusBanner: { type: "success" | "error" | "info"; message: string } | null;
  onRestoreFullProject: (revisionId: string) => Promise<void>;
  onRestoreSelectedFiles: (
    revisionId: string,
    paths: string[],
  ) => Promise<void>;
  onVerifySingleRevisionObjects: (revisionId: string) => Promise<void>;
  onCancelOperation: () => void;
  onGoToChanges?: () => void;
  onCreateBranch?: (params: CreateBranchParams) => Promise<void>;
  isCreatingBranch?: boolean;
}
export function HistoryRecoveryView(props: HistoryRecoveryViewProps) {
  const {
    vaultState,
    activeBranchId,
    isRestoring,
    progress,
    lastRestoreReport,
    onRestoreFullProject,
    onRestoreSelectedFiles,
    onVerifySingleRevisionObjects,
    onCancelOperation,
  } = props;
  const graph = useMemo(
    () => layoutRevisions(vaultState, activeBranchId),
    [vaultState, activeBranchId],
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    () => graph.latestId ?? graph.nodes[0]?.id ?? null,
  );
  const [mode, setMode] = useState<"graph" | "list">("graph");
  const [tab, setTab] = useState<"changes" | "notes" | "technical">("changes");
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [restoreKind, setRestoreKind] = useState<"full" | "selected" | null>(
    null,
  );
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const [branchSource, setBranchSource] = useState<string | null>(null);
  const source = vaultState.revisions.find(
    (r) => r.manifest.revisionId === branchSource,
  );
  const activeBranch = vaultState.branches.find(
    (b) => b.branchId === activeBranchId,
  );
  const origin = vaultState.revisions.find(
    (r) => r.manifest.revisionId === activeBranch?.startingRevisionId,
  );
  const selected =
    graph.nodes.find((n) => n.id === selectedId) ??
    graph.nodes.find((n) => n.id === graph.latestId) ??
    graph.nodes[0];
  const rev = selected?.revision;
  const diff = useMemo(
    () => (rev ? computeRevisionDiff(rev, vaultState) : null),
    [rev, vaultState],
  );
  const choose = (id: string, preselect?: string) => {
    setSelectedId(id);
    setSelectedPaths(new Set(preselect ? [preselect] : []));
    setShowAll(Boolean(preselect));
    setRestoreKind(null);
  };
  const toggle = (path: string) =>
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  const rows: { file: FileEntry; status: string }[] =
    diff?.status === "unavailable"
      ? (rev?.manifest.files ?? []).map((file) => ({
          file,
          status: "Snapshot",
        }))
      : [
          ...(diff?.added ?? []).map((file) => ({
            file,
            status: diff?.status === "baseline" ? "Baseline" : "Added",
          })),
          ...(diff?.modified ?? []).map((m) => ({
            file: m.current,
            status: "Modified",
          })),
          ...(diff?.deleted ?? []).map((file) => ({ file, status: "Deleted" })),
          ...(showAll ? (diff?.unchanged ?? []) : []).map((file) => ({
            file,
            status: "Unchanged",
          })),
        ];
  const fileCount =
    restoreKind === "full"
      ? (rev?.manifest.files.length ?? 0)
      : selectedPaths.size;
  const damaged =
    rev?.integrityStatus === "corrupted" ||
    selected?.warnings.some((w) => /Duplicate/.test(w));
  return (
    <div className="page history-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">PROJECT WORKSPACE</p>
          <h1>
            History<span className="heading-dot">.</span>
          </h1>
          <p>A clear view of how your design evolved.</p>
        </div>
        <div className="segmented" aria-label="History display">
          <button
            className={mode === "graph" ? "active" : ""}
            aria-pressed={mode === "graph"}
            onClick={() => setMode("graph")}
          >
            <Network size={15} />
            Graph
          </button>
          <button
            className={mode === "list" ? "active" : ""}
            aria-pressed={mode === "list"}
            onClick={() => setMode("list")}
          >
            <List size={15} />
            List
          </button>
        </div>
      </div>
      {activeBranch && !activeBranch.isMain ? (
        <section className="branch-origin">
          <strong>{activeBranch.name}</strong>
          {origin ? (
            <button
              className="text-button"
              onClick={() => choose(origin.manifest.revisionId)}
            >
              Started from {formatRevisionNumber(origin.manifest.displayNumber)}{" "}
              on{" "}
              {vaultState.branches.find(
                (b) => b.branchId === origin.manifest.branchId,
              )?.name ?? "Unknown branch"}
            </button>
          ) : (
            <span>Starting revision is unavailable. Saving is blocked.</span>
          )}
          <p>{activeBranch.reason}</p>
        </section>
      ) : null}
      {graph.warnings.map((w) => (
        <Notice key={w} type="error">
          {w}
        </Notice>
      ))}
      {error ? <Notice type="error">{error}</Notice> : null}
      {isRestoring ? (
        <OperationProgress progress={progress} onCancel={onCancelOperation} />
      ) : null}
      {lastRestoreReport ? (
        <Notice type="success">
          <strong>
            {lastRestoreReport.result.kind === "selected_files"
              ? "Selected-file copy verified"
              : "Complete project copy verified"}
          </strong>{" "}
          · {formatRevisionNumber(lastRestoreReport.result.displayNumber)} ·{" "}
          {lastRestoreReport.result.restoredFilesCount} files in “
          {lastRestoreReport.result.destinationName}” ·{" "}
          {formatBytes(lastRestoreReport.result.verifiedBytes)} verified.{" "}
          {lastRestoreReport.result.kind === "selected_files"
            ? "This is a partial copy; CAD dependencies may be absent."
            : ""}
          <details>
            <summary>Recovery report</summary>
            <p>
              {lastRestoreReport.result.restoredDirectoriesCount} directories ·{" "}
              {formatTimestamp(lastRestoreReport.result.completedAt)}
            </p>
            {lastRestoreReport.result.selectedPaths?.map((p) => (
              <p key={p} className="file-path">
                {p}
              </p>
            ))}
          </details>
        </Notice>
      ) : null}
      {!graph.nodes.length ? (
        <div className="empty-state">
          <History size={32} />
          <h2>Your design history starts here</h2>
          <p>Save your first revision to preserve the complete project.</p>
          <button className="button primary" onClick={props.onGoToChanges}>
            Review changes
          </button>
        </div>
      ) : (
        <div className="history-layout">
          <RevisionGraph
            graph={graph}
            selectedId={selected?.id ?? null}
            onSelect={(id) => choose(id)}
            mode={mode}
          />
          {rev && diff ? (
            <aside className="revision-detail" aria-label="Revision details">
              <div className="detail-header">
                <div className="revision-eyebrow">
                  {formatRevisionNumber(rev.manifest.displayNumber)}{" "}
                  {selected.latest ? (
                    <span className="latest-label">
                      Latest on current branch
                    </span>
                  ) : null}
                </div>
                <h2>{rev.manifest.summary}</h2>
                <div className="detail-meta">
                  <span>
                    <GitBranch size={14} />
                    {vaultState.branches.find(
                      (b) => b.branchId === rev.manifest.branchId,
                    )?.name ?? "Unknown branch"}
                  </span>
                  <time dateTime={rev.manifest.captureCompletedAt}>
                    {formatTimestamp(rev.manifest.captureCompletedAt)}
                  </time>
                </div>
                <p className={damaged ? "integrity damaged" : "integrity"}>
                  <ShieldCheck size={14} />
                  {damaged
                    ? "Damaged revision · recovery blocked"
                    : rev.integrityStatus === "objects_verified"
                      ? "Metadata and file contents verified"
                      : "Metadata verified · contents not yet checked"}
                </p>
                {selected.warnings.length ? (
                  <Notice type="error">{selected.warnings.join(" · ")}</Notice>
                ) : null}
              </div>
              <div className="detail-tabs" aria-label="Revision sections">
                {(["changes", "notes", "technical"] as const).map((t) => (
                  <button
                    key={t}
                    aria-pressed={tab === t}
                    className={tab === t ? "active" : ""}
                    onClick={() => setTab(t)}
                  >
                    {t === "technical"
                      ? "Technical details"
                      : t === "notes"
                        ? "Notes"
                        : "Changes"}
                  </button>
                ))}
              </div>
              <div className="detail-body">
                {tab === "changes" ? (
                  <>
                    <div className="section-heading">
                      <h3>
                        {diff.status === "baseline"
                          ? "Initial baseline"
                          : diff.status === "unavailable"
                            ? "Snapshot files"
                            : "Changed files"}
                      </h3>
                      <span className="muted">
                        {rev.manifest.files.length} in snapshot
                      </span>
                    </div>
                    {diff.status === "baseline" ? (
                      <p className="muted small">
                        The first complete project state; no earlier revision to
                        compare.
                      </p>
                    ) : diff.status === "unavailable" ? (
                      <Notice type="error">
                        Comparison is unavailable because this revision or its
                        recorded parent is missing or damaged. Snapshot files
                        are listed below. See Technical details for the record
                        information.
                      </Notice>
                    ) : (
                      <p className="muted small">
                        Compared with{" "}
                        {diff.parentDisplayNumber
                          ? formatRevisionNumber(diff.parentDisplayNumber)
                          : "recorded parent"}{" "}
                        · {diff.added.length} added · {diff.modified.length}{" "}
                        modified · {diff.deleted.length} deleted
                      </p>
                    )}
                    <div className="file-selection-toolbar">
                      <button
                        className="text-button"
                        disabled={damaged}
                        onClick={() => {
                          setSelectedPaths(
                            new Set(rev.manifest.files.map((f) => f.path)),
                          );
                          setShowAll(true);
                        }}
                      >
                        Select all snapshot files
                      </button>
                      <button
                        className="text-button"
                        onClick={() => setSelectedPaths(new Set())}
                      >
                        Clear
                      </button>
                    </div>
                    <div className="detail-files">
                      {rows.map(({ file, status }) => (
                        <div className="detail-file" key={file.path}>
                          <label className="file-choice">
                            <input
                              type="checkbox"
                              aria-label={`Select ${file.path} for recovery`}
                              disabled={damaged || status === "Deleted"}
                              checked={selectedPaths.has(file.path)}
                              onChange={() => toggle(file.path)}
                            />
                            <File size={16} />
                            <span className="file-path" title={file.path}>
                              {file.path}
                            </span>
                          </label>
                          <div className="file-subline">
                            <StatusBadge status={status} />
                            <span>{formatBytes(file.size)}</span>
                            {rev.manifest.fileNotes?.some(
                              (n) => n.path === file.path,
                            ) ? (
                              <button
                                className="text-button"
                                onClick={() => setTab("notes")}
                              >
                                Note
                              </button>
                            ) : null}
                          </div>
                          {status === "Deleted" ? (
                            <div className="deleted-help">
                              Absent from this revision.{" "}
                              {diff.parentRevisionId &&
                              vaultState.revisions.some(
                                (r) =>
                                  r.manifest.revisionId ===
                                  diff.parentRevisionId,
                              ) ? (
                                <button
                                  className="text-button"
                                  onClick={() =>
                                    choose(diff.parentRevisionId!, file.path)
                                  }
                                >
                                  View in parent revision ↗
                                </button>
                              ) : (
                                "Earlier revision unavailable."
                              )}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                    {diff.unchanged.length > 0 ? (
                      <button
                        className="text-button unchanged-toggle"
                        aria-expanded={showAll}
                        onClick={() => setShowAll((v) => !v)}
                      >
                        {showAll ? "Hide" : "Show"} {diff.unchanged.length}{" "}
                        unchanged files
                      </button>
                    ) : null}
                    {diff.addedDirectories.length +
                      diff.deletedDirectories.length >
                    0 ? (
                      <details className="disclosure">
                        <summary>
                          Directory changes (
                          {diff.addedDirectories.length +
                            diff.deletedDirectories.length}
                          )
                        </summary>
                        {diff.addedDirectories.map((p) => (
                          <p key={"a" + p}>Added · {p}/</p>
                        ))}
                        {diff.deletedDirectories.map((p) => (
                          <p key={"d" + p}>Deleted · {p}/</p>
                        ))}
                      </details>
                    ) : null}
                  </>
                ) : tab === "notes" ? (
                  <>
                    <h3>Overall engineering notes</h3>
                    {Object.values(rev.manifest.notes).some((v) => v.trim()) ? (
                      <NotesText notes={rev.manifest.notes} />
                    ) : (
                      <p className="muted">No overall notes recorded.</p>
                    )}
                    <h3 className="section-spaced">File-specific notes</h3>
                    {rev.manifest.fileNotes?.length ? (
                      rev.manifest.fileNotes.map((note) => (
                        <section className="file-note-read" key={note.path}>
                          <strong className="file-path">{note.path}</strong>
                          <NotesText notes={note} />
                        </section>
                      ))
                    ) : (
                      <p className="muted">No file notes recorded.</p>
                    )}
                  </>
                ) : (
                  <>
                    <h3>Record information</h3>
                    {diff.status === "unavailable" ? (
                      <Notice type="error">{diff.unavailableReason}</Notice>
                    ) : null}
                    <dl className="technical-data">
                      {Object.entries({
                        Revision: rev.manifest.revisionId,
                        Parent:
                          rev.manifest.parentRevisionId ??
                          "None — initial baseline",
                        Branch: rev.manifest.branchId,
                        Project: rev.manifest.projectId,
                        Schema: rev.manifest.schemaVersion,
                        "Manifest SHA-256": rev.manifest.manifestPayloadSha256,
                        "Completion SHA-256": rev.completion.manifestSha256,
                        "Record path": `revisions/${rev.manifest.revisionId}.manifest.json`,
                        "Capture started (UTC)": rev.manifest.captureStartedAt,
                        "Capture completed (UTC)":
                          rev.manifest.captureCompletedAt,
                      }).map(([k, v]) => (
                        <div key={k}>
                          <dt>{k}</dt>
                          <dd>{v}</dd>
                        </div>
                      ))}
                    </dl>
                    {rev.integrityErrors.map((e) => (
                      <Notice key={e} type="error">
                        {e}
                      </Notice>
                    ))}
                    <button
                      className="button secondary"
                      disabled={verifying || isRestoring || damaged}
                      onClick={async () => {
                        setVerifying(true);
                        setError("");
                        try {
                          await onVerifySingleRevisionObjects(
                            rev.manifest.revisionId,
                          );
                        } catch (e) {
                          setError(e instanceof Error ? e.message : String(e));
                        } finally {
                          setVerifying(false);
                        }
                      }}
                    >
                      <ShieldCheck size={16} />
                      {verifying ? "Verifying…" : "Verify file contents"}
                    </button>
                    <details className="disclosure">
                      <summary>
                        File checksums ({rev.manifest.files.length})
                      </summary>
                      {rev.manifest.files.map((f) => (
                        <dl className="technical-data" key={f.path}>
                          <dt>{f.path}</dt>
                          <dd>{f.sha256}</dd>
                        </dl>
                      ))}
                    </details>
                  </>
                )}
              </div>
              <div className="recovery-bar">
                {props.onCreateBranch ? (
                  <button
                    className="button secondary"
                    disabled={
                      damaged ||
                      isRestoring ||
                      verifying ||
                      props.isCreatingBranch ||
                      Boolean(
                        vaultState.damagedBranchHeads[rev.manifest.branchId],
                      ) ||
                      Boolean(
                        vaultState.competingHeads[rev.manifest.branchId]
                          ?.length,
                      )
                    }
                    onClick={() => setBranchSource(rev.manifest.revisionId)}
                  >
                    <GitBranch size={16} /> Create branch from here
                  </button>
                ) : null}
                <button
                  className="button primary"
                  disabled={damaged || isRestoring || verifying}
                  onClick={() => setRestoreKind("full")}
                >
                  <ArrowDownToLine size={16} />
                  Restore project copy
                </button>
                <button
                  className="button secondary"
                  disabled={
                    damaged || isRestoring || verifying || !selectedPaths.size
                  }
                  onClick={() => setRestoreKind("selected")}
                >
                  Copy selected files ({selectedPaths.size})
                </button>
                <p>
                  Recovery creates a separate copy in a fresh, empty folder.
                </p>
              </div>
            </aside>
          ) : null}
        </div>
      )}
      {source && props.onCreateBranch ? (
        <CreateBranchDialog
          source={source.manifest}
          sourceBranchName={
            vaultState.branches.find(
              (b) => b.branchId === source.manifest.branchId,
            )?.name ?? "Unknown branch"
          }
          branchNames={vaultState.branches.map((b) => b.name)}
          busy={props.isCreatingBranch ?? false}
          progress={progress}
          onCreate={props.onCreateBranch}
          onClose={() => setBranchSource(null)}
          onCancel={onCancelOperation}
        />
      ) : null}
      {restoreKind && rev ? (
        <Modal
          title={
            restoreKind === "full"
              ? "Restore a complete project copy"
              : "Copy selected files"
          }
          onClose={() => setRestoreKind(null)}
          busy={isRestoring}
        >
          <p>
            <strong>
              {formatRevisionNumber(rev.manifest.displayNumber)} ·{" "}
              {rev.manifest.summary}
            </strong>
          </p>
          <p>
            {fileCount} file{fileCount === 1 ? "" : "s"} ·{" "}
            {restoreKind === "full"
              ? "Complete project snapshot"
              : "Selected-file copy"}
          </p>
          <p className="muted">
            Choose a fresh, empty folder outside your working folder and vault.
            The destination is verified and existing files are never
            overwritten.
          </p>
          {restoreKind === "selected" ? (
            <>
              <Notice>
                This copy contains only selected files. It may not contain all
                CAD assembly dependencies.
              </Notice>
              <details>
                <summary>Selected paths ({selectedPaths.size})</summary>
                {[...selectedPaths].map((p) => (
                  <p className="file-path" key={p}>
                    {p}
                  </p>
                ))}
              </details>
            </>
          ) : null}
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setRestoreKind(null)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              onClick={async () => {
                const kind = restoreKind;
                setRestoreKind(null);
                if (kind === "full")
                  await onRestoreFullProject(rev.manifest.revisionId);
                else
                  await onRestoreSelectedFiles(rev.manifest.revisionId, [
                    ...selectedPaths,
                  ]);
              }}
            >
              Choose destination
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
