import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileSystemDirectoryAdapter,
  RealFileSystemAdapter,
  validateDirectoryIsolation,
} from "./engine/fs-adapter";
import {
  clearAllConvenienceMetadata,
  listRememberedProjectBindings,
  RememberedProjectBinding,
  removeRememberedProjectBinding,
  saveRememberedProjectBinding,
} from "./engine/idb-store";
import {
  restoreRevisionToFolder,
  restoreSelectedFilesToFolder,
} from "./engine/recovery-service";
import { captureRevision, ReviewStaleError } from "./engine/revision-service";
import { scanBranchChanges } from "./engine/scanner";
import {
  FileSpecificNote,
  MAIN_BRANCH_ID,
  ProgressUpdate,
  RestoreResult,
  ScanResult,
  VaultState,
} from "./engine/types";
import {
  formatRevisionNumber,
  initializeProjectVault,
  openExistingVault,
  verifyRevisionObjects,
} from "./engine/vault-service";
import { ProjectConnectView } from "./components/ProjectConnectView";
import { ChangesCaptureView } from "./components/ChangesCaptureView";
import { HistoryRecoveryView } from "./components/HistoryRecoveryView";
import { DiagnosticsView } from "./components/DiagnosticsView";
import {
  GitBranch,
  FolderOpen,
  History,
  Settings,
  ScanLine,
  HardDrive,
} from "lucide-react";
import { IntegrityNotice, Notice, OperationProgress } from "./components/ui";
import { supportsFileSystemAccessApi } from "./utils/format";

type ActiveTab = "connect" | "changes" | "history" | "diagnostics";

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("connect");
  const [rememberedBindings, setRememberedBindings] = useState<
    RememberedProjectBinding[]
  >([]);

  // Active workspace adapters and state
  const [vaultDir, setVaultDir] = useState<FileSystemDirectoryAdapter | null>(
    null,
  );
  const [workingDir, setWorkingDir] =
    useState<FileSystemDirectoryAdapter | null>(null);
  const [vaultState, setVaultState] = useState<VaultState | null>(null);
  const [activeBranchId, setActiveBranchId] = useState<string>(MAIN_BRANCH_ID);

  // Scan & operation state
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [isScanStale, setIsScanStale] = useState<boolean>(false);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [isRestoring, setIsRestoring] = useState<boolean>(false);
  const [isVerifyingAll, setIsVerifyingAll] = useState<boolean>(false);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [statusBanner, setStatusBanner] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);

  const [lastRestoreReport, setLastRestoreReport] = useState<{
    result: RestoreResult;
  } | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  const refreshRememberedList = useCallback(async () => {
    const list = await listRememberedProjectBindings();
    setRememberedBindings(list);
  }, []);

  useEffect(() => {
    refreshRememberedList();
  }, [refreshRememberedList]);

  // Mark scan result as potentially stale a few seconds after completion
  useEffect(() => {
    if (!scanResult) return;
    setIsScanStale(false);
    const timer = setTimeout(() => {
      setIsScanStale(true);
    }, 5000);
    return () => clearTimeout(timer);
  }, [scanResult]);

  const runScan = useCallback(
    async (
      targetWorkingDir: FileSystemDirectoryAdapter,
      currentVaultState: VaultState,
      branchId: string,
    ) => {
      const abort = new AbortController();
      abortControllerRef.current = abort;
      setIsScanning(true);
      setProgress({
        phase: "scanning_source",
        processedFiles: 0,
        totalFiles: 0,
        processedBytes: 0,
        totalBytes: 0,
        message: "Scanning working folder and computing SHA-256 digests...",
      });

      try {
        const headRevId = currentVaultState.branchHeads[branchId] ?? null;
        const headRev = headRevId
          ? (currentVaultState.revisions.find(
              (r) => r.manifest.revisionId === headRevId,
            ) ?? null)
          : null;

        const res = await scanBranchChanges(
          targetWorkingDir,
          branchId,
          headRev && headRev.integrityStatus !== "corrupted"
            ? headRev.manifest
            : null,
          {
            signal: abort.signal,
            onProgress: (path, count, bytes) => {
              setProgress({
                phase: "scanning_source",
                currentFile: path,
                processedFiles: count,
                totalFiles: count,
                processedBytes: bytes,
                totalBytes: bytes,
                message: `Hashing ${path}...`,
              });
            },
          },
        );
        setScanResult(res);
        return res;
      } finally {
        setIsScanning(false);
        setProgress(null);
        abortControllerRef.current = null;
      }
    },
    [],
  );

  const persistRealBinding = async (
    state: VaultState,
    vDir: FileSystemDirectoryAdapter,
    wDir: FileSystemDirectoryAdapter | null,
  ) => {
    if (vDir.kind !== "real") return;
    const realV = vDir as RealFileSystemAdapter;
    const realW =
      wDir && wDir.kind === "real" ? (wDir as RealFileSystemAdapter) : null;

    const binding: RememberedProjectBinding = {
      projectId: state.project.projectId,
      projectName: state.project.name,
      vaultHandle: realV.handle,
      branchWorkingHandles: realW ? { [MAIN_BRANCH_ID]: realW.handle } : {},
      vaultFolderName: realV.name,
      workingFolderNames: realW ? { [MAIN_BRANCH_ID]: realW.name } : {},
      lastOpenedAt: new Date().toISOString(),
    };
    await saveRememberedProjectBinding(binding);
    await refreshRememberedList();
  };

  // 1. Create Real Project
  const handleCreateRealProject = async (
    projectName: string,
    selectedWorkingDir: FileSystemDirectoryAdapter,
    selectedVaultDir: FileSystemDirectoryAdapter,
  ) => {
    setStatusBanner(null);
    const wPerm = await selectedWorkingDir.requestPermission("read");
    if (wPerm !== "granted") {
      throw new Error(
        "Read permission was not granted for the CAD working folder.",
      );
    }
    const vPerm = await selectedVaultDir.requestPermission("readwrite");
    if (vPerm !== "granted") {
      throw new Error(
        "Read/write permission was not granted for the revision vault folder.",
      );
    }

    const state = await initializeProjectVault(
      selectedWorkingDir,
      selectedVaultDir,
      projectName,
    );

    setVaultDir(selectedVaultDir);
    setWorkingDir(selectedWorkingDir);
    setVaultState(state);
    setActiveBranchId(MAIN_BRANCH_ID);
    setLastRestoreReport(null);

    await persistRealBinding(state, selectedVaultDir, selectedWorkingDir);
    await runScan(selectedWorkingDir, state, MAIN_BRANCH_ID);
    setStatusBanner({
      type: "success",
      message: `Initialized vault "${selectedVaultDir.name}" for project "${state.project.name}" and completed initial working folder scan.`,
    });
    setActiveTab("changes");
  };

  // 2. Open Existing Real Vault
  const handleOpenRealVault = async (
    selectedVaultDir: FileSystemDirectoryAdapter,
    selectedWorkingDir: FileSystemDirectoryAdapter | null,
  ) => {
    setStatusBanner(null);
    const vPerm = await selectedVaultDir.requestPermission("readwrite");
    if (vPerm !== "granted") {
      throw new Error(
        "Read/write permission is required to open the revision vault.",
      );
    }

    if (selectedWorkingDir) {
      const wPerm = await selectedWorkingDir.requestPermission("read");
      if (wPerm !== "granted") {
        throw new Error(
          "Read permission was not granted for the attached working folder.",
        );
      }
      await validateDirectoryIsolation(
        selectedWorkingDir,
        selectedVaultDir,
        "Working folder",
        "Revision vault",
      );
    }

    const state = await openExistingVault(selectedVaultDir);
    setVaultDir(selectedVaultDir);
    setWorkingDir(selectedWorkingDir);
    setVaultState(state);
    setActiveBranchId(MAIN_BRANCH_ID);
    setLastRestoreReport(null);

    await persistRealBinding(state, selectedVaultDir, selectedWorkingDir);

    if (selectedWorkingDir) {
      await runScan(selectedWorkingDir, state, MAIN_BRANCH_ID);
      setStatusBanner({
        type: "success",
        message: `Reopened vault "${state.project.name}" (${state.revisions.length} committed revision(s)) and scanned attached working folder.`,
      });
      setActiveTab(state.revisions.length ? "history" : "changes");
    } else {
      setScanResult(null);
      setStatusBanner({
        type: "info",
        message: `Reconstructed project "${state.project.name}" (${state.revisions.length} committed revision(s)) directly from vault files. Reattach a working folder explicitly to scan or save new changes.`,
      });
      setActiveTab(state.revisions.length > 0 ? "history" : "changes");
    }
  };

  // 3. Reconnect Remembered Project from IndexedDB
  const handleReconnectRemembered = async (
    binding: RememberedProjectBinding,
  ) => {
    setStatusBanner(null);
    if (!binding.vaultHandle) {
      throw new Error(
        "Saved binding does not have a directory handle. Please reopen the vault folder manually.",
      );
    }
    const vAdapter = new RealFileSystemAdapter(binding.vaultHandle);
    const wHandle = binding.branchWorkingHandles[MAIN_BRANCH_ID];
    const wAdapter = wHandle ? new RealFileSystemAdapter(wHandle) : null;
    await handleOpenRealVault(vAdapter, wAdapter);
  };

  // 4. Scan Working Folder
  const handleScanCurrent = async () => {
    if (!workingDir || !vaultState) return;
    setStatusBanner(null);
    try {
      const res = await runScan(workingDir, vaultState, activeBranchId);
      setStatusBanner({
        type: "info",
        message: res.hasChanges
          ? `Scan complete: +${res.added.length} added, ~${res.modified.length} modified, -${res.deleted.length} deleted, ${res.unchanged.length} unchanged.`
          : "Scan complete: Working folder matches the latest saved revision (no changes).",
      });
    } catch (err) {
      setStatusBanner({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // 5. Capture Revision
  const handleCaptureRevision = async (params: {
    summary: string;
    notes: { problem: string; modification: string; observations: string };
    fileNotes: FileSpecificNote[];
    reviewedChangesSignature: string;
  }) => {
    if (!workingDir || !vaultDir || !vaultState) return;
    setStatusBanner(null);
    const abort = new AbortController();
    abortControllerRef.current = abort;
    setIsCapturing(true);

    try {
      const {
        revision,
        vaultState: updatedState,
        cacheWarning,
      } = await captureRevision(workingDir, vaultDir, {
        branchId: activeBranchId,
        summary: params.summary,
        notes: params.notes,
        fileNotes: params.fileNotes,
        reviewedChangesSignature: params.reviewedChangesSignature,
        signal: abort.signal,
        onProgress: (p) => setProgress(p),
      });

      setVaultState(updatedState);
      await runScan(workingDir, updatedState, activeBranchId);

      setStatusBanner({
        type: "success",
        message: `Published and verified ${formatRevisionNumber(
          revision.manifest.displayNumber,
        )} ("${revision.manifest.summary}") with ${
          revision.manifest.files.length
        } files.${cacheWarning ? ` (${cacheWarning})` : ""}`,
      });
    } catch (err) {
      if (err instanceof ReviewStaleError) {
        setScanResult(err.freshScan);
      }
      setStatusBanner({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      setIsCapturing(false);
      setProgress(null);
      abortControllerRef.current = null;
    }
  };

  // 6. Reattach Working Folder explicitly
  const handleReattachWorkingFolder = async () => {
    if (!vaultDir || !vaultState) return;
    setStatusBanner(null);

    if (!supportsFileSystemAccessApi()) {
      setStatusBanner({
        type: "error",
        message: "Directory picker is unavailable in this browser context.",
      });
      return;
    }

    try {
      const picker = (
        window as unknown as {
          showDirectoryPicker: (opts?: {
            mode?: "read" | "readwrite";
          }) => Promise<FileSystemDirectoryHandle>;
        }
      ).showDirectoryPicker;
      const handle = await picker({ mode: "read" });
      const newWDir = new RealFileSystemAdapter(handle);
      await validateDirectoryIsolation(
        newWDir,
        vaultDir,
        "Working folder",
        "Revision vault",
      );

      setWorkingDir(newWDir);
      await persistRealBinding(vaultState, vaultDir, newWDir);
      await runScan(newWDir, vaultState, activeBranchId);
      setStatusBanner({
        type: "success",
        message: `Reattached working folder "${newWDir.name}" and completed a fresh SHA-256 scan.`,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setStatusBanner({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // 7. Pick Destination Folder Helper for Recovery
  const pickRecoveryDestinationFolder =
    async (): Promise<FileSystemDirectoryAdapter | null> => {
      if (!supportsFileSystemAccessApi()) {
        setStatusBanner({
          type: "error",
          message: "Directory picker is unavailable in this browser context.",
        });
        return null;
      }
      try {
        const picker = (
          window as unknown as {
            showDirectoryPicker: (opts?: {
              mode?: "read" | "readwrite";
            }) => Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker;
        const handle = await picker({ mode: "readwrite" });
        return new RealFileSystemAdapter(handle);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError")
          return null;
        setStatusBanner({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    };

  // 8A. Restore Full Project Copy
  const handleRestoreFullProject = async (revisionId: string) => {
    if (!vaultDir || !vaultState) return;
    setStatusBanner(null);
    setLastRestoreReport(null);

    const destDir = await pickRecoveryDestinationFolder();
    if (!destDir) return;

    const abort = new AbortController();
    abortControllerRef.current = abort;
    setIsRestoring(true);

    try {
      const result = await restoreRevisionToFolder({
        vaultDir,
        destinationDir: destDir,
        workingDir,
        revisionId,
        signal: abort.signal,
        onProgress: (p) => setProgress(p),
      });

      setVaultState((prev) =>
        prev
          ? {
              ...prev,
              revisions: prev.revisions.map((r) =>
                r.manifest.revisionId === revisionId
                  ? { ...r, integrityStatus: "objects_verified" }
                  : r,
              ),
            }
          : prev,
      );

      setLastRestoreReport({ result });
    } catch (err) {
      setStatusBanner({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsRestoring(false);
      setProgress(null);
      abortControllerRef.current = null;
    }
  };

  // 8B. Restore Selected Files as a Copy
  const handleRestoreSelectedFiles = async (
    revisionId: string,
    selectedPaths: string[],
  ) => {
    if (!vaultDir || !vaultState) return;
    setStatusBanner(null);
    setLastRestoreReport(null);

    if (selectedPaths.length === 0) {
      setStatusBanner({
        type: "error",
        message:
          "Select at least one file in the revision inventory before restoring selected files.",
      });
      return;
    }

    const destDir = await pickRecoveryDestinationFolder();
    if (!destDir) return;

    const abort = new AbortController();
    abortControllerRef.current = abort;
    setIsRestoring(true);

    try {
      const result = await restoreSelectedFilesToFolder({
        vaultDir,
        destinationDir: destDir,
        workingDir,
        revisionId,
        selectedPaths,
        signal: abort.signal,
        onProgress: (p) => setProgress(p),
      });

      setLastRestoreReport({ result });
    } catch (err) {
      setStatusBanner({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsRestoring(false);
      setProgress(null);
      abortControllerRef.current = null;
    }
  };

  // 9. Verify single or all revision objects
  const handleVerifySingleRevisionObjects = async (revisionId: string) => {
    await handleVerifyObjects([revisionId]);
  };

  const handleVerifyObjects = async (revisionIds: string[]) => {
    if (!vaultDir || !vaultState) return;
    const abort = new AbortController();
    abortControllerRef.current = abort;
    setIsVerifyingAll(true);
    setStatusBanner(null);
    const targets = vaultState.revisions.filter((r) =>
      revisionIds.includes(r.manifest.revisionId),
    );
    const totalFiles = targets.reduce((n, r) => n + r.manifest.files.length, 0);
    const totalBytes = targets.reduce(
      (n, r) => n + r.manifest.files.reduce((s, f) => s + f.size, 0),
      0,
    );
    let processedFiles = 0;
    let processedBytes = 0;
    try {
      const updated = [];
      let anyCorrupt = false;
      for (const rev of targets) {
        if (abort.signal.aborted)
          throw new DOMException("Verification cancelled.", "AbortError");
        setProgress({
          phase: "verifying_objects",
          message: `Checking file contents in ${formatRevisionNumber(rev.manifest.displayNumber)}…`,
          processedFiles,
          totalFiles,
          processedBytes,
          totalBytes,
        });
        const v = await verifyRevisionObjects(vaultDir, rev, abort.signal);
        if (v.integrityStatus === "corrupted") anyCorrupt = true;
        updated.push(v);
        if (v.integrityStatus === "objects_verified") {
          processedFiles += v.manifest.files.length;
          processedBytes += v.manifest.files.reduce((n, f) => n + f.size, 0);
        }
        setVaultState((prev) =>
          prev
            ? {
                ...prev,
                revisions: prev.revisions.map((r) =>
                  r.manifest.revisionId === v.manifest.revisionId ? v : r,
                ),
              }
            : prev,
        );
      }
      setStatusBanner({
        type: anyCorrupt ? "error" : "success",
        message: anyCorrupt
          ? "One or more revisions failed object integrity verification."
          : `Verified all content objects across ${updated.length} committed revision(s).`,
      });
    } catch (err) {
      setStatusBanner({
        type:
          err instanceof DOMException && err.name === "AbortError"
            ? "info"
            : "error",
        message:
          err instanceof DOMException && err.name === "AbortError"
            ? "Verification cancelled. Completed checks have been retained."
            : err instanceof Error
              ? err.message
              : String(err),
      });
    } finally {
      setIsVerifyingAll(false);
      setProgress(null);
      abortControllerRef.current = null;
    }
  };
  const handleVerifyAllObjects = async () => {
    await handleVerifyObjects(
      vaultState?.revisions.map((r) => r.manifest.revisionId) ?? [],
    );
  };

  // 10. Clear Browser Convenience Handles & Reload Vault Only
  const handleSimulateClearMetadataAndReopenVault = async () => {
    if (!vaultDir) return;
    await clearAllConvenienceMetadata();
    await refreshRememberedList();

    setWorkingDir(null);
    setScanResult(null);
    const reopened = await openExistingVault(vaultDir);
    setVaultState(reopened);
    setStatusBanner({
      type: "success",
      message: `Cleared remembered browser handles and reloaded "${reopened.project.name}" (${reopened.revisions.length} revision(s)) directly from vault files. Working folder is detached until you click "Reattach Working Folder".`,
    });
    setActiveTab("history");
  };

  const handleCancelOperation = () => {
    abortControllerRef.current?.abort();
  };

  const busy = isScanning || isCapturing || isRestoring || isVerifyingAll;
  const navigate = (tab: ActiveTab) => {
    if (!busy) setActiveTab(tab);
  };
  const activeBranch = vaultState?.branches.find(
    (b) => b.branchId === activeBranchId,
  );
  return (
    <div className="app-shell">
      <aside className="navigation-rail">
        <a
          className="wordmark"
          aria-label="cAdtree projects"
          href="#projects"
          onClick={(e) => {
            e.preventDefault();
            navigate("connect");
          }}
        >
          <svg
            width="29"
            height="31"
            viewBox="0 0 29 31"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M8 25V7M8 18C8 12 21 18 21 7"
              stroke="currentColor"
              strokeWidth="2"
            />
            <circle cx="8" cy="25" r="3" fill="currentColor" />
            <circle cx="8" cy="6" r="3" fill="currentColor" />
            <circle cx="21" cy="6" r="3" fill="currentColor" />
          </svg>
          <span>
            cAdtree<span className="wordmark-dot">.</span>
          </span>
        </a>
        <p className="rail-caption">DESIGN. RECORD. EVOLVE.</p>
        <nav aria-label="Primary navigation">
          <button
            aria-label="Projects"
            disabled={busy}
            aria-current={activeTab === "connect" ? "page" : undefined}
            onClick={() => navigate("connect")}
          >
            <FolderOpen size={18} />
            <span>Projects</span>
          </button>
          <div className="rail-divider" />
          <p className="rail-section-label">WORKSPACE</p>
          <button
            aria-label="History"
            disabled={!vaultState || busy}
            aria-current={activeTab === "history" ? "page" : undefined}
            onClick={() => navigate("history")}
          >
            <History size={18} />
            <span>History</span>
          </button>
          <button
            aria-label="Changes"
            disabled={!vaultState || busy}
            aria-current={activeTab === "changes" ? "page" : undefined}
            onClick={() => navigate("changes")}
          >
            <ScanLine size={18} />
            <span>Changes</span>
            {scanResult?.hasChanges ? <i className="nav-change-dot" /> : null}
          </button>
          <button
            aria-label="Settings"
            disabled={!vaultState || busy}
            aria-current={activeTab === "diagnostics" ? "page" : undefined}
            onClick={() => navigate("diagnostics")}
          >
            <Settings size={18} />
            <span>Settings</span>
          </button>
        </nav>
        <div className="rail-bottom">
          <HardDrive size={17} />
          <div>
            <strong>Local by design</strong>
            <p>Your files. Your storage.</p>
          </div>
        </div>
      </aside>
      <div className="workspace-shell">
        <header className="workspace-header">
          <div className="workspace-context">
            <span className="workspace-symbol">
              <FolderOpen size={17} />
            </span>
            <strong>{vaultState?.project.name ?? "Your workspace"}</strong>
            {vaultState ? (
              <span className="current-branch">
                <GitBranch size={14} />
                {activeBranch?.name ?? "Unknown branch"}
              </span>
            ) : null}
          </div>
          <span className="local-indicator">
            <i />
            Local workspace
          </span>
        </header>
        <main id="main-content">
          {isVerifyingAll ? (
            <div className="global-feedback">
              <OperationProgress
                progress={progress}
                onCancel={handleCancelOperation}
              />
            </div>
          ) : null}
          {statusBanner ? (
            <div className="global-feedback">
              <Notice
                type={statusBanner.type}
                onDismiss={() => setStatusBanner(null)}
              >
                {statusBanner.message}
              </Notice>
            </div>
          ) : null}
          {vaultState ? (
            <div className="global-integrity">
              <IntegrityNotice state={vaultState} />
            </div>
          ) : null}
          {activeTab === "connect" || !vaultState || !vaultDir ? (
            <ProjectConnectView
              rememberedBindings={rememberedBindings}
              onCreateRealProject={handleCreateRealProject}
              onOpenRealVault={handleOpenRealVault}
              onReconnectRemembered={handleReconnectRemembered}
              onRemoveRemembered={async (id) => {
                await removeRememberedProjectBinding(id);
                await refreshRememberedList();
              }}
              onClearAllConvenienceMetadata={async () => {
                await clearAllConvenienceMetadata();
                await refreshRememberedList();
              }}
            />
          ) : null}
          {vaultState && vaultDir ? (
            <div key={vaultState.project.projectId}>
              <div hidden={activeTab !== "changes"}>
                <ChangesCaptureView
                  vaultState={vaultState}
                  activeBranchId={activeBranchId}
                  workingFolderName={workingDir?.name ?? null}
                  vaultFolderName={vaultDir.name}
                  scanResult={scanResult}
                  isScanStale={isScanStale}
                  isScanning={isScanning}
                  isCapturing={isCapturing}
                  progress={progress}
                  statusBanner={null}
                  onScan={handleScanCurrent}
                  onCapture={handleCaptureRevision}
                  onCancelOperation={handleCancelOperation}
                  onReattachWorkingFolder={handleReattachWorkingFolder}
                />
              </div>
              <div hidden={activeTab !== "history"}>
                <HistoryRecoveryView
                  vaultState={vaultState}
                  activeBranchId={activeBranchId}
                  isRestoring={isRestoring}
                  progress={progress}
                  lastRestoreReport={lastRestoreReport}
                  statusBanner={null}
                  onRestoreFullProject={handleRestoreFullProject}
                  onRestoreSelectedFiles={handleRestoreSelectedFiles}
                  onVerifySingleRevisionObjects={
                    handleVerifySingleRevisionObjects
                  }
                  onCancelOperation={handleCancelOperation}
                  onGoToChanges={() => navigate("changes")}
                />
              </div>
              <div hidden={activeTab !== "diagnostics"}>
                <DiagnosticsView
                  vaultState={vaultState}
                  isVerifyingAll={isVerifyingAll}
                  onVerifyAllObjects={handleVerifyAllObjects}
                  onSimulateClearMetadataAndReopenVault={
                    handleSimulateClearMetadataAndReopenVault
                  }
                  workingFolderName={workingDir?.name ?? null}
                  vaultFolderName={vaultDir.name}
                  onReattachWorkingFolder={handleReattachWorkingFolder}
                />
              </div>
            </div>
          ) : null}
        </main>
        <footer className="workspace-footer">
          <span>cAdtree · CAD project history</span>
          <span>Complete revisions. Separate recovery copies.</span>
        </footer>
      </div>
    </div>
  );
}
