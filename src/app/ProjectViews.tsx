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
import type { useBranchActions } from "./useBranchActions";
import type { useCaptureActions } from "./useCaptureActions";
import type { useDiagnosticsActions } from "./useDiagnosticsActions";
import type { useReferenceActions } from "./useReferenceActions";
import type { useReviewActions } from "./useReviewActions";

type BranchActions = ReturnType<typeof useBranchActions>;
type CaptureActions = ReturnType<typeof useCaptureActions>;
type ApplicationActions = ReturnType<typeof useApplicationActions>;
type ReviewActions = ReturnType<typeof useReviewActions>;
type ReferenceActions = ReturnType<typeof useReferenceActions>;
type DiagnosticsActions = ReturnType<typeof useDiagnosticsActions>;

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
  handlePrepareApplication: ApplicationActions["handlePrepareApplication"];
  handleRefreshApplicationReview: ApplicationActions["handleRefreshApplicationReview"];
  handleApplyApplication: ApplicationActions["handleApplyApplication"];
  handleRecoverApplication: ApplicationActions["handleRecoverApplication"];
  handleAbandonApplication: ApplicationActions["handleAbandonApplication"];
  handleExportForReview: ReviewActions["handleExportForReview"];
  handleRetrieveReference: ReviewActions["handleRetrieveReference"];
  handleAddReferences: ReferenceActions["handleAddReferences"];
  handleStopApplyingReference: ReferenceActions["handleStopApplyingReference"];
  handleVerifySingleRevisionObjects: DiagnosticsActions["handleVerifySingleRevisionObjects"];
  handleVerifyAllObjects: DiagnosticsActions["handleVerifyAllObjects"];
  handleSimulateClearMetadataAndReopenVault: DiagnosticsActions["handleSimulateClearMetadataAndReopenVault"];
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
  handlePrepareApplication,
  handleRefreshApplicationReview,
  handleApplyApplication,
  handleRecoverApplication,
  handleAbandonApplication,
  handleExportForReview,
  handleRetrieveReference,
  handleAddReferences,
  handleStopApplyingReference,
  handleVerifySingleRevisionObjects,
  handleVerifyAllObjects,
  handleSimulateClearMetadataAndReopenVault,
  onEnableComponentTracking,
  onPrepareWrite,
}: ProjectViewsProps) {
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
        onRecover={handleRecoverApplication}
        onAbandon={handleAbandonApplication}
        onRefresh={handleScanCurrent}
        onChanges={() => navigate("changes")}
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
            draftKey={`${managedWorkspaceKey ?? workspace?.root.name ?? "external"}:${workspace?.identity.workspaceId ?? "external"}:${vaultState.project.projectId}:${branch.branchId}`}
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
            prepare: handlePrepareApplication,
            apply: handleApplyApplication,
            refresh: handleRefreshApplicationReview,
            progress,
            cancel: handleCancelOperation,
            destinationLocation:
              managedProject && workspace
                ? `${workspace.root.name}/${managedProject.workingPaths[activeBranchId]}`
                : workingDir?.name,
            blockedReason:
              caseWriteBlock(vaultState, activeBranchId) ??
              managedBlockReason ??
              (branchApplications(vaultState, activeBranchId).some(
                (op) => !isFinishedOperation(op),
              )
                ? "Resolve the pending application for this branch before applying again."
                : undefined),
          }}
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
              ? "Reconnect workspace before creating branches."
              : undefined)
          }
          onCreateBranch={handleCreateBranch}
          isCreatingBranch={isCreatingBranch}
        />
      </div>
      <div hidden={activeTab !== "diagnostics"}>
        <DiagnosticsView
          managed={Boolean(managedProject)}
          vaultState={vaultState}
          isVerifyingAll={isVerifyingAll}
          onVerifyAllObjects={handleVerifyAllObjects}
          onSimulateClearMetadataAndReopenVault={
            handleSimulateClearMetadataAndReopenVault
          }
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
