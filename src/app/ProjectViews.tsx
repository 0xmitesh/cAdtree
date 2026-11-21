import { useEffect, useRef } from "react";
import { ApplicationStatus } from "../components/ApplicationStatus";
import { ChangesCaptureView, type CaptureDraft } from "../components/ChangesCaptureView";
import { DesignCases } from "../components/DesignCases";
import { DiagnosticsView } from "../components/DiagnosticsView";
import { HistoryRecoveryView } from "../components/HistoryRecoveryView";
import { ProjectContextHeader } from "../components/ProjectContextHeader";
import { ReferencesView } from "../components/ReferencesView";
import {
  applicationCaptureBlock,
  branchApplications,
  isFinishedOperation,
} from "../engine/application-records";
import { caseWriteBlock } from "../engine/case-lifecycle";
import { componentWriteBlock } from "../engine/component-identity";
import type { FileSystemDirectoryAdapter } from "../engine/fs-adapter";
import { joinAddress } from "../engine/path-budget";
import type { resolveWorkingFilePath } from "../engine/path-shortcuts";
import { referenceWriteBlock } from "../engine/references";
import type { ProgressUpdate, ScanResult, VaultState } from "../engine/types";
import type { ManagedProject, WorkspaceState } from "../engine/workspace-service";
import type { ActiveTab, Operation } from "./types";
import type { useApplicationActions } from "./useApplicationActions";
import { scannedWorkingFile, type useGetVersionActions } from "./useGetVersionActions";
import type { useBranchActions } from "./useBranchActions";
import type { useCaptureActions } from "./useCaptureActions";
import type { useDiagnosticsActions } from "./useDiagnosticsActions";
import type { useDiscardActions } from "./useDiscardActions";
import type { DiscardController } from "../components/DiscardDialog";
import type { useReferenceActions } from "./useReferenceActions";
import type { useReviewActions } from "./useReviewActions";

type BranchActions = ReturnType<typeof useBranchActions>;
type CaptureActions = ReturnType<typeof useCaptureActions>;
type ApplicationActions = ReturnType<typeof useApplicationActions>;
type ReviewActions = ReturnType<typeof useReviewActions>;
type ReferenceActions = ReturnType<typeof useReferenceActions>;
type DiagnosticsActions = ReturnType<typeof useDiagnosticsActions>;
type DiscardActions = ReturnType<typeof useDiscardActions>;

export type ProjectViewsProps = {
  vaultState: VaultState;
  vaultDir: FileSystemDirectoryAdapter;
  workingDir: FileSystemDirectoryAdapter | null;
  activeBranchId: string;
  activeTab: ActiveTab;
  managedProject: ManagedProject | null;
  workspace: WorkspaceState | null;
  managedWorkspaceKey: string | null;
  workspaceBudgetAddress: string | undefined;
  draftCache: Map<string, CaptureDraft>;
  scanResult: ScanResult | null;
  isScanStale: boolean;
  isScanning: boolean;
  isChecking: boolean;
  isCapturing: boolean;
  isVerifyingAll: boolean;
  isCreatingBranch: boolean;
  busy: boolean;
  operation: Operation | null;
  progress: ProgressUpdate | null;
  managedBlockReason: string | undefined;
  missingConnections: string[];
  navigate: (tab: ActiveTab) => void;
  workingFolderResolver: (branchId: string) => () => ReturnType<typeof resolveWorkingFilePath>;
  workingFileResolver: (branchId: string, path: string) => () => ReturnType<typeof resolveWorkingFilePath>;
  handleCancelOperation: () => void;
  handleCaseLifecycle: BranchActions["handleCaseLifecycle"];
  handleReattachWorkingFolder: BranchActions["handleReattachWorkingFolder"];
  handleCreateBranch: BranchActions["handleCreateBranch"];
  handleScanCurrent: CaptureActions["handleScanCurrent"];
  checkFailed: boolean;
  handleCaptureRevision: CaptureActions["handleCaptureRevision"];
  handleApplyAndSave: ApplicationActions["handleApplyAndSave"];
  handleRecoverApplication: ApplicationActions["handleRecoverApplication"];
  handleSaveNow: ApplicationActions["handleSaveNow"];
  handleDontSave: ApplicationActions["handleDontSave"];
  notSavedReasons: ApplicationActions["notSavedReasons"];
  bringBackRequest: ApplicationActions["bringBackRequest"];
  capturePrefill: ApplicationActions["capturePrefill"];
  reviewDiscard: DiscardActions["reviewDiscard"];
  handleDiscard: DiscardActions["handleDiscard"];
  discardBlock: DiscardActions["discardBlock"];
  /** Get this version; undefined outside a managed project. */
  getVersionActions: ReturnType<typeof useGetVersionActions> | undefined;
  handleExportForReview: ReviewActions["handleExportForReview"];
  handleRetrieveReference: ReviewActions["handleRetrieveReference"];
  handleAddReferences: ReferenceActions["handleAddReferences"];
  handleStopApplyingReference: ReferenceActions["handleStopApplyingReference"];
  handleVerifySingleRevisionObjects: DiagnosticsActions["handleVerifySingleRevisionObjects"];
  handleVerifyAllObjects: DiagnosticsActions["handleVerifyAllObjects"];
  handleResetConnections: DiagnosticsActions["handleResetConnections"];
  /** Built in App: uses App's operation and project setters. */
  onEnableComponentTracking: () => Promise<void>;
  /** Built in App: uses App's operation and project setters; undefined outside a managed project. */
  onPrepareWrite: (() => Promise<void>) | undefined;
};

/**
 * The open project's tabs (Changes per branch, References, History, Diagnostics) under its context header.
 * App renders this inside the project container, which carries the remount key and the hidden flag,
 * so every tab stays mounted while the user switches tabs.
 */
export function ProjectViews({
  vaultState,
  vaultDir,
  workingDir,
  activeBranchId,
  activeTab,
  managedProject,
  workspace,
  managedWorkspaceKey,
  workspaceBudgetAddress,
  draftCache,
  scanResult,
  isScanStale,
  isScanning,
  isChecking,
  isCapturing,
  isVerifyingAll,
  isCreatingBranch,
  busy,
  operation,
  progress,
  managedBlockReason,
  missingConnections,
  navigate,
  workingFileResolver,
  workingFolderResolver,
  handleCancelOperation,
  handleCaseLifecycle,
  handleReattachWorkingFolder,
  handleCreateBranch,
  handleScanCurrent,
  checkFailed,
  handleCaptureRevision,
  handleApplyAndSave,
  handleRecoverApplication,
  handleSaveNow,
  handleDontSave,
  notSavedReasons,
  bringBackRequest,
  capturePrefill,
  reviewDiscard,
  handleDiscard,
  discardBlock,
  getVersionActions,
  handleExportForReview,
  handleRetrieveReference,
  handleAddReferences,
  handleStopApplyingReference,
  handleVerifySingleRevisionObjects,
  handleVerifyAllObjects,
  handleResetConnections,
  onEnableComponentTracking,
  onPrepareWrite,
}: ProjectViewsProps) {
  // The Undo link asks for Bring back: show History, where its dialog opens. A
  // request made before this view mounted is not replayed.
  const bringBackNonce = bringBackRequest?.nonce;
  const handledBringBack = useRef(bringBackNonce);
  useEffect(() => {
    if (bringBackNonce === undefined || handledBringBack.current === bringBackNonce) return;
    handledBringBack.current = bringBackNonce;
    if (bringBackRequest?.projectId === vaultState.project.projectId) navigate("history");
  }, [bringBackNonce]);
  const activeScan =
    scanResult?.branchId === activeBranchId ? scanResult : null;
  const unsavedChanges = activeScan?.hasChanges
    ? activeScan.added.length +
      activeScan.modified.length +
      activeScan.deleted.length +
      activeScan.addedDirectories.length +
      activeScan.deletedDirectories.length
    : 0;
  const unfinishedBlock = (branchId: string) =>
    branchApplications(vaultState, branchId).some((op) => !isFinishedOperation(op))
      ? "Finish the earlier change to your files on this case first (see the notice at the top)."
      : undefined;
  const discardController = (branchId: string): DiscardController => ({
    review: reviewDiscard,
    discard: handleDiscard,
    progress,
    cancel: handleCancelOperation,
    blockedReason:
      discardBlock ??
      componentWriteBlock(vaultState) ??
      caseWriteBlock(vaultState, branchId) ??
      unfinishedBlock(branchId) ??
      managedBlockReason ??
      (missingConnections.length
        ? `Reconnect ${missingConnections.join(", ")} before discarding.`
        : undefined),
  });
  return (
    <>
      <ProjectContextHeader
        state={vaultState}
        activeBranchId={activeBranchId}
        showWorkingCase={activeTab !== 'references'}
      />
      <ApplicationStatus
        key={`${vaultState.project.projectId}:${activeBranchId}`}
        state={vaultState}
        branchId={activeBranchId}
        busy={busy}
        progress={progress}
        onCancel={handleCancelOperation}
        notSavedReasons={notSavedReasons}
        onRecover={handleRecoverApplication}
        onDontSave={handleDontSave}
        onSaveNow={(op) => {
          handleSaveNow(op);
          navigate("changes");
        }}
      />
      {vaultState.branches.map((branch) => (
        <div
          key={branch.branchId}
          hidden={
            activeTab !== "changes" ||
            activeBranchId !== branch.branchId
          }
        >
          <ChangesCaptureView
            vaultState={vaultState}
            draftCache={draftCache}
            draftKey={`${managedWorkspaceKey ?? ""}:${workspace?.identity.workspaceId ?? ""}:${vaultState.project.projectId}:${branch.branchId}`}
            activeBranchId={branch.branchId}
            workingFolderName={
              branch.branchId === activeBranchId
                ? (workingDir?.name ?? null)
                : null
            }
            vaultFolderName={vaultDir.name}
            scanResult={
              scanResult?.branchId === branch.branchId &&
              branch.branchId === activeBranchId
                ? scanResult
                : null
            }
            isScanStale={isScanStale}
            isScanning={isScanning}
            isChecking={isChecking && branch.branchId === activeBranchId}
            checkFailed={checkFailed && branch.branchId === activeBranchId}
            isCapturing={isCapturing}
            progress={progress}
            statusBanner={null}
            onScan={handleScanCurrent}
            onCapture={(params) =>
              handleCaptureRevision(branch.branchId, params)
            }
            onEnableComponentTracking={onEnableComponentTracking}
            onCancelOperation={handleCancelOperation}
            onReattachWorkingFolder={handleReattachWorkingFolder}
            operationBlockReason={
              componentWriteBlock(vaultState) ??
              referenceWriteBlock(vaultState) ??
              caseWriteBlock(vaultState, branch.branchId) ??
              applicationCaptureBlock(vaultState, branch.branchId) ??
              managedBlockReason ??
              (missingConnections.length
                ? `Reconnect ${missingConnections.join(", ")} before saving, so folder isolation can be verified.`
                : undefined)
            }
            resolveFilePath={(path) =>
              workingFileResolver(branch.branchId, path)()
            }
            discard={discardController(branch.branchId)}
            prefill={
              capturePrefill &&
              capturePrefill.projectId === vaultState.project.projectId &&
              capturePrefill.branchId === branch.branchId
                ? capturePrefill
                : undefined
            }
          />
        </div>
      ))}
      <div hidden={activeTab !== 'references'}>
        <ReferencesView state={vaultState} busy={busy} progress={progress} onCancel={handleCancelOperation}
          onRetrieve={handleRetrieveReference} onAdd={handleAddReferences} onStopApplying={handleStopApplyingReference}
          addBlockReason={referenceWriteBlock(vaultState) ?? managedBlockReason} />
      </div>
      <div hidden={activeTab !== "history"}>
        <HistoryRecoveryView
          caseControls={(showHidden) => (
            <DesignCases
              state={vaultState}
              activeBranchId={activeBranchId}
              busy={busy}
              progress={progress}
              showHidden={showHidden}
              onCancel={handleCancelOperation}
              onChange={handleCaseLifecycle}
            />
          )}
          onRetrieveReference={handleRetrieveReference}
          application={{
            applyAndSave: handleApplyAndSave,
            progress,
            cancel: handleCancelOperation,
            unsavedChanges,
            onSaveFirst: () => navigate("changes"),
            discard: discardController(activeBranchId),
            blockedReason:
              caseWriteBlock(vaultState, activeBranchId) ??
              managedBlockReason ??
              (branchApplications(vaultState, activeBranchId).some(
                (op) => !isFinishedOperation(op),
              )
                ? "Finish the earlier change to your files on this case first (see the notice at the top)."
                : undefined),
          }}
          getVersion={
            getVersionActions
              ? {
                  ...getVersionActions,
                  workingFile: (path) =>
                    scannedWorkingFile(scanResult, activeBranchId, path),
                  blockedReason:
                    caseWriteBlock(vaultState, activeBranchId) ??
                    managedBlockReason ??
                    (branchApplications(vaultState, activeBranchId).some(
                      (op) => !isFinishedOperation(op),
                    )
                      ? "Finish the earlier change to your files on this case first (see the notice at the top)."
                      : undefined),
                }
              : undefined
          }
          bringBackRequest={
            bringBackRequest?.projectId === vaultState.project.projectId
              ? bringBackRequest
              : undefined
          }
          vaultState={vaultState}
          activeBranchId={activeBranchId}
          progress={progress}
          statusBanner={null}
          onExportForReview={handleExportForReview}
          isExporting={operation === 'export'}
          onVerifySingleRevisionObjects={
            handleVerifySingleRevisionObjects
          }
          onCancelOperation={handleCancelOperation}
          onGoToChanges={() => navigate("changes")}
          onPrepareWrite={onPrepareWrite}
          managedDestination={managedProject?.record.containerPath}
          projectAddress={
            managedProject && workspaceBudgetAddress
              ? joinAddress(workspaceBudgetAddress, managedProject.record.containerPath)
              : undefined
          }
          operationsBlockedReason={
            managedBlockReason ??
            (managedProject && missingConnections.length
              ? "Reconnect workspace before creating cases."
              : undefined)
          }
          onCreateBranch={handleCreateBranch}
          isCreatingBranch={isCreatingBranch}
        />
      </div>
      <div hidden={activeTab !== "diagnostics"}>
        <DiagnosticsView
          vaultState={vaultState}
          isVerifyingAll={isVerifyingAll}
          onVerifyAllObjects={handleVerifyAllObjects}
          onResetConnections={handleResetConnections}
          workingFolderName={
            managedProject
              ? (managedProject.workingPaths[activeBranchId] ?? null)
              : (workingDir?.name ?? null)
          }
          vaultFolderName={vaultDir.name}
          onReattachWorkingFolder={handleReattachWorkingFolder}
          missingConnections={missingConnections}
          resolveFolderPath={workingFolderResolver(activeBranchId)}
        />
      </div>
    </>
  );
}
