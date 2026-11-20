import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeftRight,
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
  VaultState,
} from "../engine/types";
import {
  computeRevisionDiff,
  formatRevisionNumber,
} from "../engine/vault-service";
import { formatBytes, formatTimestamp } from "../utils/format";
import { fileHistory, fileHistoryEntries } from "../history/file-history";
import { FilePicker } from "./FilePicker";
import { layoutRevisions } from "../history/layout";
import {
  ApplyPreviewDialog,
  type ApplicationController,
} from "./ApplyPreviewDialog";
import { AppliedFrom, AppliedFromDetails } from "./ApplicationStatus";
import { caseLabel, caseLifecycle } from "../engine/case-lifecycle";
import { applyModeFor, type ApplyMode } from "../engine/apply-preview";
import { CompareRevisionsDialog } from "./CompareRevisionsDialog";
import { RevisionGraph } from "./RevisionGraph";
import {
  CreateBranchDialog,
  type CreateBranchParams,
} from "./CreateBranchDialog";
import { Notice, NotesText, StatusBadge } from "./ui";
import { ReviewExportDialog, type ExportReviewAction } from './ReviewExportDialog';
import { RevisionReferenceContext } from './RevisionReferenceContext';
import { GetVersionDialog } from "./GetVersionDialog";
import type { GetVersionController } from "../app/useGetVersionActions";
import { getBranchBaseline } from "../engine/branch-state";

export interface HistoryRecoveryViewProps {
  /** The Design cases panel; it gets the "Show hidden cases" switch's value. */
  caseControls?: ReactNode | ((showHidden: boolean) => ReactNode);
  onRetrieveReference?: (referenceId: string, versionId: string) => Promise<void>;
  onExportForReview?: ExportReviewAction;
  isExporting?: boolean;
  application?: ApplicationController;
  /** Get this version (one file into the active case's working folder); absent when it is not available. */
  getVersion?: GetVersionController;
  /** Opens Bring back for one revision (the Undo link after a save); a new `nonce` opens it again. */
  bringBackRequest?: { revisionId: string; nonce: number };
  vaultState: VaultState;
  activeBranchId: string;
  progress: ProgressUpdate | null;
  statusBanner: { type: "success" | "error" | "info"; message: string } | null;
  onVerifySingleRevisionObjects: (revisionId: string) => Promise<void>;
  onCancelOperation: () => void;
  onGoToChanges?: () => void;
  onCreateBranch?: (params: CreateBranchParams) => Promise<void>;
  isCreatingBranch?: boolean;
  /** Managed project folder; design cases can only be created in a managed project, so the create-case button and dialog need it. */
  managedDestination?: string;
  /** Absolute address of the managed project folder, when known (name hint in the create-case dialog). */
  projectAddress?: string;
  operationsBlockedReason?: string;
  onPrepareWrite?: () => Promise<void>;
}
export function HistoryRecoveryView(props: HistoryRecoveryViewProps) {
  return (
    <ProjectHistoryRecoveryView
      key={props.vaultState.project.projectId}
      {...props}
    />
  );
}
function ProjectHistoryRecoveryView(props: HistoryRecoveryViewProps) {
  const {
    vaultState,
    activeBranchId,
    progress,
    onVerifySingleRevisionObjects,
    onCancelOperation,
  } = props;
  const [showHidden, setShowHidden] = useState(false);
  const hasHiddenCases = vaultState.branches.some(
    (branch) =>
      !branch.isMain && caseLifecycle(vaultState, branch.branchId).status === "archived",
  );
  // The switch disappears with the last hidden case; start from "off" when one is hidden again.
  useEffect(() => {
    if (!hasHiddenCases) setShowHidden(false);
  }, [hasHiddenCases]);
  const fullGraph = useMemo(
    () =>
      layoutRevisions(vaultState, activeBranchId, {
        hideHiddenCases: !showHidden,
      }),
    [vaultState, activeBranchId, showHidden],
  );
  const [filePath, setFilePath] = useState("");
  const componentId = filePath.startsWith('component:') ? filePath.slice(10) : null;
  const [highlightBranchId, setHighlightBranchId] = useState<string | null>(
    null,
  );
  const [contextId, setContextId] = useState<string | null>(null);
  const fileEntries = useMemo(() => fileHistoryEntries(vaultState), [vaultState]);
  const projection = useMemo(
    () =>
      filePath
        ? fileHistory(
            vaultState,
            fullGraph,
            filePath,
            highlightBranchId,
            contextId,
            componentId,
          )
        : null,
    [vaultState, fullGraph, filePath, highlightBranchId, contextId, componentId],
  );
  const graph = projection?.graph ?? fullGraph;
  const [selectedId, setSelectedId] = useState<string | null>(
    () => graph.latestId ?? graph.nodes[0]?.id ?? null,
  );
  const [mode, setMode] = useState<"graph" | "list">("graph");
  const [tab, setTab] = useState<"changes" | "references" | "notes">("changes");
  const [showAll, setShowAll] = useState(false);
  const [comparison, setComparison] = useState<{
    inspectedId: string;
    initialPath: string;
  } | null>(null);
  const [previewSourceId, setPreviewSourceId] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<ApplyMode>("merge");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const [branchSource, setBranchSource] = useState<string | null>(null);
  const [exportRevisionId, setExportRevisionId] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [getVersionTarget, setGetVersionTarget] = useState<{
    revisionId: string;
    path: string;
  } | null>(null);
  const bringBackNonce = props.bringBackRequest?.nonce;
  // A request made before this view mounted (e.g. before switching cases) is not replayed.
  const handledNonce = useRef(bringBackNonce);
  useEffect(() => {
    const request = props.bringBackRequest;
    if (!request || handledNonce.current === request.nonce) return;
    handledNonce.current = request.nonce;
    setSelectedId(request.revisionId);
    setPreviewMode("revert");
    setPreviewSourceId(request.revisionId);
    // Only a new request (nonce) opens the dialog again.
  }, [bringBackNonce]);
  const prepareWrite = async (action: () => void) => {
    if (!props.onPrepareWrite) {
      action();
      return;
    }
    setPreparing(true);
    setError("");
    try {
      await props.onPrepareWrite();
      action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparing(false);
    }
  };
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
  const fileRecord = selected && projection?.records.get(selected.id);
  const historicalPath = componentId ? fileRecord?.file?.path ?? '' : filePath;
  const fileNotes =
    rev?.manifest.fileNotes?.filter(
      (note) => !filePath || note.path === historicalPath || note.path === fileRecord?.previousPath,
    ) ?? [];
  const changeFile = (path: string) => {
    setFilePath(path);
    setSelectedId(null);
    setContextId(null);
    setShowAll(false);
  };
  const changeHighlight = (id: string | null) => {
    setHighlightBranchId(id);
    if (filePath) {
      setSelectedId(null);
      setContextId(null);
    }
  };
  const diff = useMemo(
    () => (rev ? computeRevisionDiff(rev, vaultState) : null),
    [rev, vaultState],
  );
  const choose = (id: string, showUnchanged?: boolean) => {
    setSelectedId(id);
    if (filePath && !graph.nodes.some((n) => n.id === id)) setContextId(id);
    setShowAll(Boolean(showUnchanged));
  };
  const projectRows: { file: FileEntry; status: string }[] =
    diff?.status === "unavailable"
      ? (rev?.manifest.files ?? []).map((file) => ({
          file,
          status: "In this version",
        }))
      : [
          ...(diff?.added ?? []).map((file) => ({
            file,
            status: diff?.status === "baseline" ? "First version" : "Added",
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
  const rows = filePath
    ? fileRecord?.file
      ? [
          {
            file: fileRecord.file,
            status:
              fileRecord.kind === "unavailable"
                ? "In this version"
                : fileRecord.status === "Inherited state"
                  ? "Unchanged"
                  : fileRecord.status,
          },
        ]
      : []
    : projectRows;
  const applyMode = rev
    ? applyModeFor(vaultState, rev.manifest.revisionId, activeBranchId)
    : "merge";
  const damaged =
    rev?.integrityStatus === "corrupted" ||
    selected?.warnings.some((w) => /Duplicate/.test(w));
  // The case's latest saved revision; null when it has none, undefined when its history is damaged (nothing can be written then).
  const activeHeadId = useMemo(() => {
    if (!props.getVersion) return undefined;
    try {
      return getBranchBaseline(vaultState, activeBranchId)?.revisionId ?? null;
    } catch {
      return undefined;
    }
  }, [props.getVersion, vaultState, activeBranchId]);
  /** Get this version is offered for every saved file except the one already in the working folder unchanged. */
  const offersGetVersion = (file: FileEntry, status: string) => {
    if (!props.getVersion || !rev || damaged || status === "Deleted" || activeHeadId === undefined) return false;
    if (rev.manifest.revisionId !== activeHeadId) return true;
    const current = props.getVersion.workingFile(file.path);
    return !(current && current.sha256 === file.sha256 && current.size === file.size);
  };
  return (
    <div className="page history-page">
      <div className="page-heading">
        <div>
          <h1>
            History<span className="heading-dot">.</span>
          </h1>
          <div className="history-description">
            <span>A clear view of how your design evolved.</span>
            <FilePicker entries={fileEntries} value={filePath} onChange={changeFile} />
          </div>
        </div>
        <div className="project-heading-controls">
          {hasHiddenCases ? (
            <label className="history-hidden-toggle">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(event) => setShowHidden(event.target.checked)}
              />
              Show hidden cases
            </label>
          ) : null}
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
      </div>
      {props.caseControls ? (
        <details className="disclosure history-design-cases">
          <summary>Design cases</summary>
          {typeof props.caseControls === "function"
            ? props.caseControls(showHidden)
            : props.caseControls}
        </details>
      ) : null}
      {vaultState.components?.reason ? <Notice type="error">{vaultState.components.reason} Files are listed by path and comparing versions still works.</Notice> : null}
      {filePath && !componentId ? <p className="muted small">Renames are not followed for this file.</p> : null}
      {componentId ? <p className="muted small">Follows this file across renames. Versions saved before it was tracked show as history unavailable.</p> : null}
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
              )?.name ?? "Unknown case"}
            </button>
          ) : (
            <span>Starting version is unavailable. Saving is blocked.</span>
          )}
          <p>{activeBranch.reason}</p>
        </section>
      ) : null}
      {props.operationsBlockedReason ? (
        <Notice type="error">{props.operationsBlockedReason}</Notice>
      ) : null}
      {graph.warnings.map((w) => (
        <Notice key={w} type="error">
          {w}
        </Notice>
      ))}
      {error ? <Notice type="error">{error}</Notice> : null}
      {!fullGraph.nodes.length ? (
        <div className="empty-state">
          <History size={32} />
          <h2>Your design history starts here</h2>
          <p>Save your first version to preserve the complete project.</p>
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
            highlightBranchId={highlightBranchId}
            onHighlightBranch={changeHighlight}
            fileRecords={projection?.records}
          />
          {rev && diff ? (
            <aside className="revision-detail" aria-label="Version details">
              <div className="detail-header">
                <div className="detail-revision-row">
                  <div className="revision-eyebrow">
                    {formatRevisionNumber(rev.manifest.displayNumber)}{" "}
                    {selected.latest ? (
                      <span className="latest-label">
                        {filePath
                          ? "Working case file state"
                          : "Latest on working case"}
                      </span>
                    ) : null}
                  </div>
                  <button
                    className="button secondary revision-compare-action"
                    onClick={() =>
                      setComparison({
                        inspectedId: rev.manifest.revisionId,
                        initialPath: historicalPath,
                      })
                    }
                  >
                    <ArrowLeftRight size={14} /> Compare
                  </button>
                </div>
                <h2>{rev.manifest.summary}</h2>
                {filePath && fileRecord ? (
                  <section
                    className="selected-file-context"
                    aria-label="Selected file history"
                  >
                    <strong className="file-path" title={historicalPath}>
                      {historicalPath || 'File absent'}
                    </strong>
                    {fileRecord.previousPath ? <p className="file-path">Confirmed rename: {fileRecord.previousPath} → {historicalPath}</p> : null}
                    <p>
                      <StatusBadge status={fileRecord.status} />
                      {fileRecord.origins.length
                        ? ` · Origin of ${fileRecord.origins.join(", ")}`
                        : ""}
                    </p>
                    {fileRecord.kind === "context" ? (
                      <p className="muted small">
                        Context only; this version did not change the file.{" "}
                        {fileRecord.file
                          ? "The case inherits this saved file state."
                          : "The file is absent at this origin."}
                      </p>
                    ) : null}
                    {fileRecord.kind === "unavailable" ? (
                      <Notice type="error">
                        The version or the one before it is missing or damaged. A file change cannot be established.
                      </Notice>
                    ) : null}
                    {fileNotes.length ? (
                      fileNotes.map((note) => (
                        <NotesText key={note.path} notes={note} />
                      ))
                    ) : (
                      <p className="muted small">
                        No per-file notes recorded in this version.
                      </p>
                    )}
                  </section>
                ) : null}
                <div className="detail-meta">
                  <span>
                    <GitBranch size={14} />
                    {caseLabel(vaultState, rev.manifest.branchId)}
                  </span>
                  <time dateTime={rev.manifest.captureCompletedAt}>
                    {formatTimestamp(rev.manifest.captureCompletedAt)}
                  </time>
                </div>
                {damaged ? (
                  <p className="damaged">
                    <ShieldCheck size={14} />
                    Damaged version · export blocked
                  </p>
                ) : null}
                {selected.warnings.length ? (
                  <Notice type="error">{selected.warnings.join(" · ")}</Notice>
                ) : null}
              </div>
              <div className="detail-preview-action">
                {applyMode === "latest" ? null : (
                  <button
                    className="button secondary revision-compare-action"
                    onClick={() => {
                      setPreviewMode(applyMode === "revert" ? "revert" : "merge");
                      setPreviewSourceId(rev.manifest.revisionId);
                    }}
                  >
                    {applyMode === "revert"
                      ? `Bring back onto ${caseLabel(vaultState, activeBranchId)}…`
                      : `Copy files from ${caseLabel(vaultState, rev.manifest.branchId)}…`}
                  </button>
                )}
              </div>
              <AppliedFrom
                state={vaultState}
                revisionId={rev.manifest.revisionId}
              />
              <div className="detail-tabs" aria-label="Version sections">
                {(["changes", "references", "notes"] as const).map((t) => (
                  <button
                    key={t}
                    aria-pressed={tab === t}
                    className={tab === t ? "active" : ""}
                    onClick={() => setTab(t)}
                  >
                    {t === "notes"
                      ? "Notes"
                      : t === "references" ? "Saved references" : "Changed files"}
                  </button>
                ))}
              </div>
              <div className="detail-body">
                {tab === "changes" ? (
                  <>
                    <div className="section-heading">
                      <h3>
                        {filePath
                          ? "Selected file"
                          : diff.status === "baseline"
                            ? "First version"
                            : diff.status === "unavailable"
                              ? "Files in this version"
                              : "Changed files"}
                      </h3>
                      <span className="muted">
                        {rev.manifest.files.length} in this version
                      </span>
                    </div>
                    {filePath ? (
                      fileRecord?.kind !== "unavailable" ? (
                        <p className="muted small">
                          {rev.manifest.parentRevisionId
                            ? `Compared with the version before it · ${fileRecord?.status}`
                            : "This file was added in the first version."}{" "}
                          Byte changes do not necessarily indicate geometry
                          changes.
                        </p>
                      ) : null
                    ) : diff.status === "baseline" ? (
                      <p className="muted small">
                        The first complete project state; no earlier version to
                        compare.
                      </p>
                    ) : diff.status === "unavailable" ? (
                      <Notice type="error">
                        Comparison is unavailable because this version or its
                        recorded parent is missing or damaged. The files in this version are listed below. See Troubleshooting below for the record
                        information.
                      </Notice>
                    ) : (
                      <p className="muted small">
                        Compared with{" "}
                        {diff.parentDisplayNumber
                          ? formatRevisionNumber(diff.parentDisplayNumber)
                          : "the version before it"}{" "}
                        · {diff.added.length} added · {diff.modified.length}{" "}
                        modified · {diff.deleted.length} deleted
                      </p>
                    )}
                    <div className="detail-files">
                      {rows.map(({ file, status }) => (
                        <div className="detail-file" key={file.path}>
                          <div className="file-choice">
                            <File size={16} />
                            <span className="file-path" title={file.path}>
                              {file.path}
                            </span>
                          </div>
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
                            {offersGetVersion(file, status) ? (
                              <button
                                className="text-button"
                                disabled={Boolean(props.getVersion?.blockedReason)}
                                title={props.getVersion?.blockedReason}
                                onClick={() =>
                                  setGetVersionTarget({
                                    revisionId: rev.manifest.revisionId,
                                    path: file.path,
                                  })
                                }
                              >
                                Get this version
                              </button>
                            ) : null}
                          </div>
                          {status === "Deleted" ? (
                            <div className="deleted-help">
                              {componentId ? 'This file is not in this version; a different file may use its old path.' : 'Absent from this version.'}{" "}
                              {diff.parentRevisionId &&
                              vaultState.revisions.some(
                                (r) =>
                                  r.manifest.revisionId ===
                                  diff.parentRevisionId,
                              ) ? (
                                <button
                                  className="text-button"
                                  onClick={() =>
                                    choose(diff.parentRevisionId!, true)
                                  }
                                >
                                  View in the version before ↗
                                </button>
                              ) : (
                                "Earlier version unavailable."
                              )}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                    {!filePath && diff.unchanged.length > 0 ? (
                      <button
                        className="text-button unchanged-toggle"
                        aria-expanded={showAll}
                        onClick={() => setShowAll((v) => !v)}
                      >
                        {showAll ? "Hide" : "Show"} {diff.unchanged.length}{" "}
                        unchanged files
                      </button>
                    ) : null}
                    {!filePath &&
                    diff.addedDirectories.length +
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
                ) : tab === "references" ? (
                  <RevisionReferenceContext key={rev.manifest.revisionId} state={vaultState} revisionId={rev.manifest.revisionId} onRetrieve={props.onRetrieveReference} />
                ) : tab === "notes" ? (
                  <>
                    <h3>Overall notes</h3>
                    {Object.values(rev.manifest.notes).some((v) => v.trim()) ? (
                      <NotesText notes={rev.manifest.notes} />
                    ) : (
                      <p className="muted">No overall notes recorded.</p>
                    )}
                    <h3 className="section-spaced">File-specific notes</h3>
                    {fileNotes.length ? (
                      fileNotes.map((note) => (
                        <section className="file-note-read" key={note.path}>
                          <strong className="file-path">{note.path}</strong>
                          <NotesText notes={note} />
                        </section>
                      ))
                    ) : (
                      <p className="muted">No file notes recorded.</p>
                    )}
                  </>
                ) : null}
              </div>
              <div className="recovery-bar">
                {props.onCreateBranch && props.managedDestination ? (
                  <button
                    className="button secondary"
                    disabled={
                      damaged ||
                      preparing ||
                      Boolean(props.operationsBlockedReason) ||
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
                    onClick={() =>
                      void prepareWrite(() =>
                        setBranchSource(rev.manifest.revisionId),
                      )
                    }
                  >
                    <GitBranch size={16} /> Create design case from this version
                  </button>
                ) : null}
                {props.onExportForReview ? <button className="button secondary" disabled={damaged || verifying || preparing || props.isExporting || Boolean(props.operationsBlockedReason)} onClick={() => setExportRevisionId(rev.manifest.revisionId)}>Export a copy</button> : null}
              </div>
              <details
                className="disclosure revision-troubleshooting"
                key={rev.manifest.revisionId}
                open={Boolean(damaged || diff.status === "unavailable")}
              >
                <summary>Troubleshooting</summary>
                <AppliedFromDetails
                  state={vaultState}
                  revisionId={rev.manifest.revisionId}
                />
                <h3>Record information</h3>
                {diff.status === "unavailable" ? (
                  <Notice type="error">{diff.unavailableReason}</Notice>
                ) : null}
                <dl className="technical-data">
                  {Object.entries({
                    Version: rev.manifest.revisionId,
                    Parent:
                      rev.manifest.parentRevisionId ??
                      "None — first version",
                    Case: rev.manifest.branchId,
                    Project: rev.manifest.projectId,
                    Schema: rev.manifest.schemaVersion,
                    "Version record checksum (SHA-256)": rev.manifest.manifestPayloadSha256,
                    "Completion checksum (SHA-256)": rev.completion.manifestSha256,
                    "Record path": `revisions/${rev.manifest.revisionId}.manifest.json`,
                    "Save started (UTC)": rev.manifest.captureStartedAt,
                    "Save finished (UTC)": rev.manifest.captureCompletedAt,
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
                {rev.integrityStatus === "objects_verified" ? (
                  <p className="integrity">
                    <ShieldCheck size={14} />
                    Records and file contents checked
                  </p>
                ) : null}
                <button
                  className="button secondary"
                  disabled={verifying || damaged}
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
                  <summary>File checksums ({rev.manifest.files.length})</summary>
                  {rev.manifest.files.map((f) => (
                    <dl className="technical-data" key={f.path}>
                      <dt>{f.path}</dt>
                      <dd>{f.sha256}</dd>
                    </dl>
                  ))}
                </details>
              </details>
            </aside>
          ) : null}
        </div>
      )}
      {exportRevisionId && props.onExportForReview ? <ReviewExportDialog key={exportRevisionId} state={vaultState} revisionId={exportRevisionId} initialPaths={filePath && historicalPath ? [historicalPath] : []} busy={props.isExporting ?? false} progress={progress} onExport={props.onExportForReview} onClose={() => setExportRevisionId(null)} onCancel={onCancelOperation} /> : null}
      {previewSourceId ? (
        <ApplyPreviewDialog
          application={props.application}
          state={vaultState}
          sourceId={previewSourceId}
          mode={previewMode}
          destinationBranchId={activeBranchId}
          onClose={() => setPreviewSourceId(null)}
        />
      ) : null}
      {getVersionTarget && props.getVersion ? (
        <GetVersionDialog
          key={`${getVersionTarget.revisionId}:${getVersionTarget.path}`}
          controller={props.getVersion}
          {...getVersionTarget}
          progress={progress}
          onCancel={onCancelOperation}
          onClose={() => setGetVersionTarget(null)}
        />
      ) : null}
      {comparison ? (
        <CompareRevisionsDialog
          state={vaultState}
          {...comparison}
          onClose={() => setComparison(null)}
        />
      ) : null}
      {source && props.onCreateBranch && props.managedDestination ? (
        <CreateBranchDialog
          source={source.manifest}
          sourceBranchName={
            vaultState.branches.find(
              (b) => b.branchId === source.manifest.branchId,
            )?.name ?? "Unknown case"
          }
          branchNames={vaultState.branches.map((b) => b.name)}
          busy={props.isCreatingBranch ?? false}
          progress={progress}
          onCreate={props.onCreateBranch}
          onClose={() => setBranchSource(null)}
          onCancel={onCancelOperation}
          managedDestination={`${props.managedDestination}/working`}
          projectAddress={props.projectAddress}
        />
      ) : null}
    </div>
  );
}
