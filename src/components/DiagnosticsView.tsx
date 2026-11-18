import { useState } from "react";
import { HardDrive, ShieldCheck } from "lucide-react";
import type { VaultState } from "../engine/types";
import { formatRevisionNumber } from "../engine/vault-service";
import { Modal, Notice } from "./ui";
import { WorkspaceLocationSetting } from "./FilePathShortcuts";

export interface DiagnosticsViewProps {
  vaultState: VaultState;
  isVerifyingAll: boolean;
  onVerifyAllObjects: () => Promise<void>;
  onSimulateClearMetadataAndReopenVault: () => Promise<void>;
  workingFolderName?: string | null;
  vaultFolderName?: string;
  onReattachWorkingFolder?: () => Promise<void>;
  managed?: boolean;
  /** Names of cases whose working folder is not connected. */
  missingConnections?: string[];
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
  missingConnections = [],
}: DiagnosticsViewProps) {
  const [troubleshootingOpen, setTroubleshootingOpen] = useState(false);
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
  const needsFolderRepair = missingConnections.length > 0 || !workingFolderName;
  const hasRecordIssues =
    state.incompleteAttempts.length > 0 ||
    state.corruptedRecords.length > 0 ||
    state.revisions.some((r) => r.integrityStatus === "corrupted") ||
    Object.keys(state.damagedBranchHeads).length > 0 ||
    Object.values(state.competingHeads).some((heads) => heads.length > 0) ||
    Boolean(state.references?.reason);
  const connectionRows = (
    <>
      <div className="settings-row">
        <div>
          <strong>Working folder</strong>
          <p className="file-path">{workingFolderName ?? "Not connected"}</p>
          <p>
            Open this branch’s folder in your CAD application before editing or
            saving.
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
    </>
  );
  return (
    <div className="page settings-page">
      <div className="page-heading">
        <div>
          <h1>
            Settings<span className="heading-dot">.</span>
          </h1>
          <p>Connections and confidence in your saved work.</p>
        </div>
      </div>
      {error ? <Notice type="error">{error}</Notice> : null}
      <section className="panel">
        <div className="panel-heading">
          <h2>Folder connections</h2>
          <HardDrive size={18} />
        </div>
        {needsFolderRepair ? (
          connectionRows
        ) : (
          <div className="settings-row">
            <p>All folders are connected.</p>
          </div>
        )}
        {managed ? <WorkspaceLocationSetting /> : null}
      </section>
      {hasRecordIssues ? (
        <p className="settings-attention" role="status">
          Something needs attention —{" "}
          <button
            type="button"
            className="text-button"
            onClick={() => setTroubleshootingOpen(true)}
          >
            open Troubleshooting
          </button>
        </p>
      ) : null}
      <section className="panel">
        <details
          className="disclosure settings-troubleshooting"
          open={troubleshootingOpen}
          onToggle={(event) => setTroubleshootingOpen(event.currentTarget.open)}
        >
          <summary>Troubleshooting</summary>
          {!needsFolderRepair ? connectionRows : null}
          <div className="form-body">
            <p>
              Metadata checks validate revision records. File content checks
              read the stored files and compare their checksums.
            </p>
            <p className="muted">
              {checked} of {state.revisions.length} revisions have verified
              file contents in this session.
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
            </details>
            <details className="disclosure">
              <summary>Reset folder connections</summary>
              <p>
                Reset remembered folder connections and saved folder addresses for
                all accounts and workspaces in this browser. CAD files, saved
                revisions, reference attachments and accounts are not deleted.
              </p>
              <button
                className="button secondary"
                disabled={isVerifyingAll}
                onClick={() => setClear(true)}
              >
                Reset all remembered folder connections in this browser
              </button>
            </details>
          </div>
        </details>
      </section>
      {clear ? (
        <Modal
          title="Reset all remembered folder connections?"
          onClose={() => setClear(false)}
        >
          <p>
            This affects saved folder connections and addresses across all
            accounts and workspaces in this browser, not just this project.
            It does not delete CAD files, saved revisions, reference attachments
            or accounts.
          </p>
          <p>
            {managed
              ? "The current authorized workspace can still resolve its working folders during this session. Reconnect folders and re-enter their addresses when needed."
              : "The current vault is reread from its files. Reconnect working folders and re-enter their addresses when needed."}
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
              Reset all remembered folder connections
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
