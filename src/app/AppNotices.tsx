import type { Dispatch, SetStateAction } from "react";
import {
  IntegrityNotice,
  Notice,
  MessageLines,
  OperationProgress,
} from "../components/ui";
import { CopyFolderPathButton } from "../components/FilePathShortcuts";
import type { ProgressUpdate, VaultState } from "../engine/types";
import type { ManagedProject } from "../engine/workspace-service";
import type { ActiveTab, BannerScope, StatusBanner } from "./types";

export interface AppNoticesProps {
  progress: ProgressUpdate | null;
  isVerifyingAll: boolean;
  isScanning: boolean;
  activeTab: ActiveTab;
  statusBanner: StatusBanner | null;
  setStatusBanner: Dispatch<SetStateAction<StatusBanner | null>>;
  bannerScope: BannerScope;
  projectView: boolean;
  busy: boolean;
  vaultState: VaultState | null;
  managedProject: ManagedProject | null;
  managedBlockReason: string | undefined;
  missingConnections: string[];
  navigate: (tab: ActiveTab) => void;
  onCancelOperation: () => void;
  onReattachWorkingFolder: () => void;
}

/** Operation progress, the status banner and the project integrity notices at the top of main. */
export function AppNotices({
  progress,
  isVerifyingAll,
  isScanning,
  activeTab,
  statusBanner,
  setStatusBanner,
  bannerScope,
  projectView,
  busy,
  vaultState,
  managedProject,
  managedBlockReason,
  missingConnections,
  navigate,
  onCancelOperation,
  onReattachWorkingFolder,
}: AppNoticesProps) {
  return (
    <>
      {progress &&
      (isVerifyingAll || (isScanning && activeTab !== "changes")) ? (
        <div className="global-feedback">
          <OperationProgress
            progress={progress}
            onCancel={onCancelOperation}
          />
        </div>
      ) : null}
      {statusBanner && (projectView || bannerScope === "workspace") ? (
        <div className="global-feedback app-status-feedback">
          <Notice
            type={statusBanner.type}
            onDismiss={() => setStatusBanner(null)}
          >
            <MessageLines text={statusBanner.message} />
            {statusBanner.action && projectView ? (
              <>{" "}<button
                className="text-button"
                disabled={busy}
                onClick={() => {
                  const { run } = statusBanner.action!;
                  setStatusBanner(null);
                  run();
                }}
              >
                {statusBanner.action.label}
              </button></>
            ) : null}
            {statusBanner.copyFolder && projectView ? (
              <>{" "}<CopyFolderPathButton
                label={statusBanner.copyFolder.label}
                resolve={statusBanner.copyFolder.resolve}
                className="text-button"
              /></>
            ) : null}
            {statusBanner.type === "error" &&
            /permission|reconnect|access|notallowed/i.test(
              statusBanner.message,
            ) &&
            projectView ? (
              <button
                className="text-button"
                disabled={busy}
                onClick={onReattachWorkingFolder}
              >
                {managedProject
                  ? "Reconnect workspace"
                  : "Connect folder"}
              </button>
            ) : null}
          </Notice>
        </div>
      ) : null}
      {projectView && vaultState ? (
        <div className="global-integrity">
          <IntegrityNotice state={vaultState} />
          {vaultState.incompleteAttempts.length ? (
            <Notice>
              {vaultState.incompleteAttempts.length} unfinished
              operation(s) were kept. They are not saved versions.
              <button
                className="text-button"
                disabled={busy}
                onClick={() => navigate("diagnostics")}
              >
                Review in Settings
              </button>
            </Notice>
          ) : null}
          {managedBlockReason ? (
            <Notice type="error">{managedBlockReason}</Notice>
          ) : null}
          {missingConnections.length ? (
            <Notice>
              {managedProject
                ? "Reconnect the workspace to find these case folders: "
                : "Connect the working folders for "}
              {missingConnections.join(", ")} before saving or creating
              cases.{" "}
              {managedProject
                ? "Missing or moved folders stay disconnected until they are back where cAdtree expects them."
                : "Select each case, then Connect folder."}
              <button
                className="text-button"
                disabled={busy}
                onClick={onReattachWorkingFolder}
              >
                {managedProject
                  ? "Reconnect workspace"
                  : "Connect folder"}
              </button>
            </Notice>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
