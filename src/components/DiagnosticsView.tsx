import type { ReactNode } from "react";
import { useState } from "react";
import { HardDrive, ShieldCheck } from "lucide-react";
import type { VaultState } from "../engine/types";
import { formatRevisionNumber } from "../engine/vault-service";
import { Modal, Notice } from "./ui";
import { WorkspaceLocationSetting } from "./FilePathShortcuts";

export interface DiagnosticsViewProps {
  branchControl?: ReactNode;
  vaultState: VaultState;
  isVerifyingAll: boolean;
  onVerifyAllObjects: () => Promise<void>;
  onSimulateClearMetadataAndReopenVault: () => Promise<void>;
  workingFolderName?: string | null;
  vaultFolderName?: string;
  onReattachWorkingFolder?: () => Promise<void>;
  managed?: boolean;
}
export function DiagnosticsView({
  vaultState: state,
  isVerifyingAll,
  onVerifyAllObjects,
  onSimulateClearMetadataAndReopenVault,
  workingFolderName,
  vaultFolderName,
  onReattachWorkingFolder,
  managed,
  branchControl,
}: DiagnosticsViewProps) {
  const [error, setError] = useState("");
  const [clear, setClear] = useState(false);
  const checked = state.revisions.filter(
    (r) => r.integrityStatus === "objects_verified",
  ).length;
  const run = async (fn: () => Promise<void>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="page settings-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{state.project.name}</p>
          <h1>
            Settings<span className="heading-dot">.</span>
          </h1>
          <p>Connections and confidence in your saved work.</p>
        </div>
        <div className="project-heading-controls">{branchControl}</div>
      </div>
      {error ? <Notice type="error">{error}</Notice> : null}
      <section className="panel">
        <div className="panel-heading">
          <h2>Folder connections</h2>
          <HardDrive size={18} />
        </div>
        <div className="settings-row">
          <div>
            <strong>Working folder</strong>
            <p className="file-path">{workingFolderName ?? "Not connected"}</p>
            <p>
              Open this branch’s folder in your CAD application before editing
              or saving.
            </p>
          </div>
          <button
            className="button secondary"
            disabled={isVerifyingAll}
            onClick={onReattachWorkingFolder}
          >
            {managed
              ? "Reconnect workspace"
              : workingFolderName
                ? "Change folder"
                : "Connect folder"}
          </button>
        </div>
        <div className="settings-row">
          <div>
            <strong>Revision vault</strong>
            <p>{vaultFolderName ?? "Connected vault"}</p>
          </div>
          <span className="connection-dot">Connected</span>
        </div>
        {managed ? <WorkspaceLocationSetting /> : null}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Storage and verification</h2>
          <ShieldCheck size={18} />
        </div>
        <div className="form-body">
          <p>
            Metadata checks validate revision records. File content checks read
            the stored files and compare their checksums.
          </p>
          <p className="muted">
            {checked} of {state.revisions.length} revisions have verified file
            contents in this session.
          </p>
          <button
            className="button primary"
            disabled={isVerifyingAll}
            onClick={() => run(onVerifyAllObjects)}
          >
            <ShieldCheck size={16} />
            {isVerifyingAll
              ? "Verifying file contents…"
              : "Verify all file contents"}
          </button>
          {state.references?.reason ? <Notice type="error">{state.references.reason} Reference retrieval and new captures require valid reference evidence. CAD verification and recovery use their own required evidence.</Notice> : null}
          {Object.entries(state.damagedBranchHeads).map(([id, reason]) => (
            <Notice type="error" key={id}>
              <strong>Damaged branch baseline</strong>
              <p>{reason}</p>
            </Notice>
          ))}
          {Object.entries(state.competingHeads)
            .filter(([, heads]) => heads.length)
            .map(([id, heads]) => (
              <Notice type="error" key={id}>
                <strong>
                  {state.branches.find((b) => b.branchId === id)?.name ?? id}:
                  competing heads
                </strong>
                <p>
                  Saving is blocked. The vault contains {heads.length} competing
                  heads.
                </p>
                <details>
                  <summary>Revision identities</summary>
                  {heads.map((h) => (
                    <p className="file-path" key={h}>
                      {h}
                    </p>
                  ))}
                </details>
              </Notice>
            ))}
          {state.corruptedRecords.length ||
          state.revisions.some((r) => r.integrityStatus === "corrupted") ? (
            <div className="damaged-records">
              <h3>Damaged records</h3>
              {state.corruptedRecords.map((r, i) => (
                <Notice type="error" key={i}>
                  <strong className="file-path">{r.recordPath}</strong>
                  <p>{r.reason}</p>
                  {r.revisionId ? (
                    <p className="file-path">Revision: {r.revisionId}</p>
                  ) : null}
                </Notice>
              ))}
              {state.revisions
                .filter((r) => r.integrityStatus === "corrupted")
                .map((r) => (
                  <Notice type="error" key={r.manifest.revisionId}>
                    <strong>
                      {formatRevisionNumber(r.manifest.displayNumber)} ·{" "}
                      {r.manifest.summary}
                    </strong>
                    {r.integrityErrors.map((e) => (
                      <p key={e}>{e}</p>
                    ))}
                  </Notice>
                ))}
            </div>
          ) : null}
          <details className="disclosure">
            <summary>
              Incomplete or interrupted attempts (
              {state.incompleteAttempts.length})
            </summary>
            <p>
              These attempts are not committed revisions or published references and are excluded from
              history and the reference library.
            </p>
            {state.incompleteAttempts.map((r) => (
              <div key={r.path} className="record-row">
                <strong className="file-path">{r.path}</strong>
                <p>{r.detail}</p>
              </div>
            ))}
          </details>
          <details className="disclosure">
            <summary>Advanced record information</summary>
            <dl className="technical-data">
              <dt>Project identity</dt>
              <dd>{state.project.projectId}</dd>
              <dt>Schema</dt>
              <dd>{state.project.schemaVersion}</dd>
              <dt>Project SHA-256</dt>
              <dd>{state.project.payloadSha256}</dd>
            </dl>
            <h3>Branch records</h3>
            {state.branches.map((b) => (
              <dl className="technical-data" key={b.branchId}>
                <dt>{b.name}</dt>
                <dd>{b.branchId}</dd>
                <dt>Head</dt>
                <dd>{state.branchHeads[b.branchId] ?? "No revision"}</dd>
                <dt>Starting revision</dt>
                <dd>{b.startingRevisionId ?? "None"}</dd>
                <dt>Reason</dt>
                <dd>{b.reason || "—"}</dd>
                <dt>Record SHA-256</dt>
                <dd>{b.payloadSha256}</dd>
              </dl>
            ))}
            <button
              className="button secondary"
              disabled={isVerifyingAll}
              onClick={() => setClear(true)}
            >
              {managed
                ? "Clear remembered access and reread workspace"
                : "Clear remembered connections and reopen vault"}
            </button>
            <p className="muted small">
              {managed
                ? "This clears browser convenience preferences. Project and branch locations remain in the workspace records."
                : "This clears browser convenience data and detaches the working folder. Your vault history stays in its folder."}
            </p>
          </details>
        </div>
      </section>
      {clear ? (
        <Modal
          title="Clear remembered connections?"
          onClose={() => setClear(false)}
        >
          <p>
            {managed
              ? "This removes remembered browser access and rereads portable workspace records. The current authorized root can still resolve your branches during this session. After a browser restart, select the workspace once."
              : "This removes this browser’s saved project connections and reopens the current vault from its files. Your working folder will need to be connected again."}
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setClear(false)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              onClick={() => {
                setClear(false);
                run(onSimulateClearMetadataAndReopenVault);
              }}
            >
              Clear connections and reopen
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
