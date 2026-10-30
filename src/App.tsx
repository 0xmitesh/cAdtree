import { useCallback, useEffect, useRef, useState } from "react";
import {
  type FileSystemDirectoryAdapter,
  RealFileSystemAdapter,
  validateDirectoryIsolation,
} from "./engine/fs-adapter";
import {
  clearAllConvenienceMetadata,
  getRememberedProjectBinding,
  listRememberedProjectBindings,
  type RememberedProjectBinding,
  removeRememberedProjectBinding,
  rememberBranchConnection,
} from "./engine/idb-store";
import {
  restoreRevisionToFolder,
  restoreSelectedFilesToFolder,
} from "./engine/recovery-service";
import { captureRevision, ReviewStaleError } from "./engine/revision-service";
import { createDesignBranch } from "./engine/branch-service";
import {
  getBranchBaseline,
  validateWorkingFolderBindings,
  type WorkingFolderBindings,
} from "./engine/branch-state";
import { scanBranchChanges } from "./engine/scanner";
import {
  type FileSpecificNote,
  MAIN_BRANCH_ID,
  type ProgressUpdate,
  type RestoreResult,
  type ScanResult,
  type VaultState,
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
import type { CreateBranchParams } from "./components/CreateBranchDialog";
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
type Operation =
  | "scan"
  | "capture"
  | "restore"
  | "verify"
  | "branch"
  | "connect";
type Context = {
  version: number;
  signal: AbortSignal;
  current: () => boolean;
  progress: (p: ProgressUpdate) => void;
};

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("connect");
  const [rememberedBindings, setRememberedBindings] = useState<
    RememberedProjectBinding[]
  >([]);
  const [vaultDir, setVaultDir] = useState<FileSystemDirectoryAdapter | null>(
    null,
  );
  const [workingFolders, setWorkingFolders] = useState<WorkingFolderBindings>(
    {},
  );
  const [workingDir, setWorkingDir] =
    useState<FileSystemDirectoryAdapter | null>(null);
  const [vaultState, setVaultState] = useState<VaultState | null>(null);
  const [activeBranchId, setActiveBranchId] = useState(MAIN_BRANCH_ID);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [isScanStale, setIsScanStale] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [statusBanner, setStatusBanner] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);
  const [lastRestoreReport, setLastRestoreReport] = useState<{
    result: RestoreResult;
  } | null>(null);
  // Synchronous guards also cover rapid double clicks before React renders disabled controls.
  const operationRef = useRef<AbortController | null>(null);
  const contextVersion = useRef(0);
  const refreshRememberedList = useCallback(
    async () => setRememberedBindings(await listRememberedProjectBindings()),
    [],
  );
  useEffect(() => {
    void refreshRememberedList();
  }, [refreshRememberedList]);
  useEffect(
    () => () => {
      contextVersion.current++;
      operationRef.current?.abort();
    },
    [],
  );
  useEffect(() => {
    setIsScanStale(false);
    if (!scanResult) return;
    const timer = setTimeout(() => setIsScanStale(true), 5000);
    return () => clearTimeout(timer);
  }, [scanResult]);

  const perform = async <T,>(
    kind: Operation,
    action: (context: Context) => Promise<T>,
    rethrow = false,
  ): Promise<T | undefined> => {
    if (operationRef.current) {
      if (rethrow)
        throw new Error("Finish or cancel the current operation first.");
      return;
    }
    const abort = new AbortController();
    const version = contextVersion.current;
    operationRef.current = abort;
    setOperation(kind);
    setStatusBanner(null);
    const current = () =>
      contextVersion.current === version && operationRef.current === abort;
    const context = {
      version,
      signal: abort.signal,
      current,
      progress: (p: ProgressUpdate) => {
        if (current()) setProgress(p);
      },
    };
    try {
      return await action(context);
    } catch (error) {
      if (current())
        setStatusBanner({
          type:
            error instanceof DOMException && error.name === "AbortError"
              ? "info"
              : "error",
          message: error instanceof Error ? error.message : String(error),
        });
      if (rethrow) throw error;
    } finally {
      if (operationRef.current === abort) {
        operationRef.current = null;
        setOperation(null);
        setProgress(null);
      }
    }
  };
  const pickFolder = async (mode: "read" | "readwrite") => {
    if (!supportsFileSystemAccessApi())
      throw new Error(
        "Folder selection is unavailable here. Open cAdtree in Edge or Chrome.",
      );
    const picker = (
      window as unknown as {
        showDirectoryPicker: (options: {
          mode: string;
        }) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;
    return new RealFileSystemAdapter(await picker({ mode }));
  };
  const applyVaultState = (next: VaultState) => {
    setVaultState((previous) => {
      if (previous?.project.projectId !== next.project.projectId) return next;
      return {
        ...next,
        revisions: next.revisions.map((revision) => {
          const checked = previous.revisions.find(
            (old) => old.manifest.revisionId === revision.manifest.revisionId,
          );
          return revision.integrityStatus !== "corrupted" &&
            checked &&
            checked.integrityStatus !== "manifest_verified" &&
            checked.manifest.manifestPayloadSha256 ===
              revision.manifest.manifestPayloadSha256 &&
            checked.completion.manifestSha256 ===
              revision.completion.manifestSha256
            ? checked
            : revision;
        }),
      };
    });
  };
  const persistBinding = async (
    state: VaultState,
    vault: FileSystemDirectoryAdapter,
    branchId: string,
    working?: FileSystemDirectoryAdapter | null,
  ): Promise<string> => {
    if (!(vault instanceof RealFileSystemAdapter)) return "";
    try {
      await rememberBranchConnection(
        {
          projectId: state.project.projectId,
          projectName: state.project.name,
          vaultHandle: vault.handle,
          vaultFolderName: vault.name,
        },
        branchId,
        working instanceof RealFileSystemAdapter ? working.handle : undefined,
      );
      await refreshRememberedList();
      return "";
    } catch (error) {
      return `Browser convenience data could not be saved (${error instanceof Error ? error.message : String(error)}). Vault publication is independent; reconnect folders explicitly after reopening.`;
    }
  };
  const scan = async (
    vault: FileSystemDirectoryAdapter,
    folders: WorkingFolderBindings,
    branchId: string,
    context: Context,
  ) => {
    const folder = folders[branchId];
    if (!folder)
      throw new Error(
        "Connect the selected branch’s working folder before scanning.",
      );
    const state = await openExistingVault(vault);
    if (!context.current()) return;
    applyVaultState(state);
    await validateWorkingFolderBindings(state, vault, folders, false);
    if ((await folder.queryPermission("read")) !== "granted")
      throw new Error(
        "Reconnect the selected branch’s working folder to restore read permission.",
      );
    const baseline = getBranchBaseline(state, branchId);
    const result = await scanBranchChanges(folder, branchId, baseline, {
      signal: context.signal,
      onProgress: (path, files, bytes) =>
        context.progress({
          phase: "scanning_source",
          currentFile: path,
          processedFiles: files,
          totalFiles: files,
          processedBytes: bytes,
          totalBytes: bytes,
          message: `Scanning ${path}…`,
        }),
    });
    if (context.current()) setScanResult(result);
    return result;
  };
  // Install a project only after all explicit connections have passed identity checks.
  const installProject = async (
    state: VaultState,
    vault: FileSystemDirectoryAdapter,
    folders: WorkingFolderBindings,
    branchId: string,
  ) => {
    setVaultDir(vault);
    setVaultState(state);
    setWorkingFolders(folders);
    setActiveBranchId(branchId);
    setWorkingDir(folders[branchId] ?? null);
    setScanResult(null);
    setLastRestoreReport(null);
    setActiveTab(state.revisions.length ? "history" : "changes");
  };
  const handleCreateRealProject = async (
    name: string,
    working: FileSystemDirectoryAdapter,
    vault: FileSystemDirectoryAdapter,
  ) => {
    await perform(
      "connect",
      async (context) => {
        if (
          (await working.requestPermission("read")) !== "granted" ||
          (await vault.requestPermission("readwrite")) !== "granted"
        )
          throw new Error("Folder permission was not granted.");
        const state = await initializeProjectVault(working, vault, name);
        if (!context.current()) return;
        await installProject(
          state,
          vault,
          { [MAIN_BRANCH_ID]: working },
          MAIN_BRANCH_ID,
        );
        let warning = await persistBinding(
          state,
          vault,
          MAIN_BRANCH_ID,
          working,
        );
        try {
          await scan(
            vault,
            { [MAIN_BRANCH_ID]: working },
            MAIN_BRANCH_ID,
            context,
          );
        } catch (error) {
          warning += ` Scan needed: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (!context.current()) return;
        setStatusBanner({
          type: warning ? "info" : "success",
          message: `Created project "${name}". Save a revision to preserve the complete working project. ${warning}`,
        });
      },
      true,
    );
  };
  const openProject = async (
    vault: FileSystemDirectoryAdapter,
    selectedWorking: FileSystemDirectoryAdapter | null,
    saved?: RememberedProjectBinding,
  ) => {
    await perform(
      "connect",
      async (context) => {
        if ((await vault.requestPermission("readwrite")) !== "granted")
          throw new Error(
            "Read/write permission is required for the revision vault.",
          );
        const state = await openExistingVault(vault);
        if (!context.current()) return;
        if (saved && saved.projectId !== state.project.projectId)
          throw new Error(
            "The remembered vault now contains a different project. Reopen it manually before connecting working folders.",
          );
        const remembered =
          saved ?? (await getRememberedProjectBinding(state.project.projectId));
        const branchId =
          saved &&
          state.branches.some((b) => b.branchId === saved.activeBranchId)
            ? saved.activeBranchId!
            : MAIN_BRANCH_ID;
        const folders: WorkingFolderBindings = {};
        for (const branch of state.branches) {
          const handle = remembered?.branchWorkingHandles[branch.branchId];
          if (handle) {
            const adapter = new RealFileSystemAdapter(handle);
            try {
              if ((await adapter.queryPermission("read")) === "granted")
                folders[branch.branchId] = adapter;
            } catch {
              /* Invalid remembered handles are reconnected explicitly. */
            }
          }
        }
        if (selectedWorking) {
          if ((await selectedWorking.requestPermission("read")) !== "granted")
            throw new Error(
              "Read permission was not granted for the selected working folder.",
            );
          folders[MAIN_BRANCH_ID] = selectedWorking;
        }
        await validateWorkingFolderBindings(state, vault, folders, false);
        await installProject(state, vault, folders, branchId);
        let warning = await persistBinding(
          state,
          vault,
          branchId,
          folders[branchId],
        );
        if (folders[branchId]) {
          try {
            await scan(vault, folders, branchId, context);
          } catch (error) {
            warning += ` Scan unavailable: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        if (!context.current()) return;
        setStatusBanner({
          type: "info",
          message: `Opened "${state.project.name}" from vault records with ${state.branches.length} branches and ${state.revisions.length} revisions. Select a branch to work on it; connect missing folders explicitly. ${warning}`,
        });
      },
      true,
    );
  };
  const handleOpenRealVault = (
    vault: FileSystemDirectoryAdapter,
    working: FileSystemDirectoryAdapter | null,
  ) => openProject(vault, working);
  const handleReconnectRemembered = async (
    binding: RememberedProjectBinding,
  ) => {
    if (!binding.vaultHandle)
      throw new Error(
        "Reopen the vault folder manually to restore its connection.",
      );
    return openProject(
      new RealFileSystemAdapter(binding.vaultHandle),
      null,
      binding,
    );
  };
  const handleSelectBranch = async (branchId: string) => {
    if (
      operationRef.current ||
      !vaultState ||
      !vaultDir ||
      branchId === activeBranchId
    )
      return;
    contextVersion.current++;
    setActiveBranchId(branchId);
    setScanResult(null);
    setLastRestoreReport(null);
    setStatusBanner(null);
    setWorkingDir(null);
    await perform("scan", async (context) => {
      const state = await openExistingVault(vaultDir);
      if (!context.current()) return;
      applyVaultState(state);
      if (!state.branches.some((b) => b.branchId === branchId))
        throw new Error("Selected branch is missing. Reopen the vault.");
      const folder = workingFolders[branchId];
      let readable = false;
      try {
        readable = Boolean(
          folder && (await folder.queryPermission("read")) === "granted",
        );
      } catch {
        /* Reconnect a stale handle explicitly. */
      }
      if (folder && readable) {
        if (!context.current()) return;
        setWorkingDir(folder);
        await scan(vaultDir, workingFolders, branchId, context);
      } else {
        setWorkingFolders((previous) => {
          const updated = { ...previous };
          delete updated[branchId];
          return updated;
        });
      }
      const warning = await persistBinding(state, vaultDir, branchId);
      if (context.current())
        setStatusBanner({
          type: "info",
          message: `${readable ? "Open this branch’s folder manually in SolidWorks." : "Connect this branch’s working folder explicitly to scan or save."} ${warning}`,
        });
    });
  };
  const handleScanCurrent = async () => {
    if (!vaultDir) return;
    await perform("scan", async (context) => {
      setScanResult(null);
      const result = await scan(
        vaultDir,
        workingFolders,
        activeBranchId,
        context,
      );
      if (result && context.current())
        setStatusBanner({
          type: "info",
          message: result.hasChanges
            ? `Scan complete: ${result.added.length} added, ${result.modified.length} modified, ${result.deleted.length} deleted.`
            : "This working folder matches its branch’s saved revision.",
        });
    });
  };
  const handleCaptureRevision = async (
    branchId: string,
    params: {
      summary: string;
      notes: { problem: string; modification: string; observations: string };
      fileNotes: FileSpecificNote[];
      reviewedChangesSignature: string;
    },
  ) => {
    if (!workingDir || !vaultDir || branchId !== activeBranchId)
      throw new Error(
        "The active branch connection changed. Scan again before saving.",
      );
    await perform(
      "capture",
      async (context) => {
        try {
          const result = await captureRevision(workingDir, vaultDir, {
            ...params,
            branchId,
            workingFolders,
            signal: context.signal,
            onProgress: context.progress,
          });
          if (!context.current()) return;
          setVaultState(result.vaultState);
          setScanResult(null);
          // Publication succeeded even if a subsequent scan loses folder access.
          let scanWarning = "";
          try {
            await scan(vaultDir, workingFolders, branchId, context);
          } catch (error) {
            scanWarning = `Rescan needed: ${error instanceof Error ? error.message : String(error)}`;
          }
          if (context.current())
            setStatusBanner({
              type: "success",
              message: `Published and verified ${formatRevisionNumber(result.revision.manifest.displayNumber)} on this branch. ${result.cacheWarning ?? ""} ${scanWarning}`,
            });
        } catch (error) {
          if (error instanceof ReviewStaleError && context.current())
            setScanResult(error.freshScan);
          throw error;
        }
      },
      true,
    );
  };
  const handleReattachWorkingFolder = async () => {
    if (!vaultDir || !vaultState) return;
    await perform("connect", async (context) => {
      const selected = await pickFolder("read");
      const state = await openExistingVault(vaultDir);
      const folders = { ...workingFolders, [activeBranchId]: selected };
      await validateWorkingFolderBindings(state, vaultDir, folders, false);
      if (!context.current()) return;
      setWorkingFolders(folders);
      setWorkingDir(selected);
      setScanResult(null);
      const warning = await persistBinding(
        state,
        vaultDir,
        activeBranchId,
        selected,
      );
      await scan(vaultDir, folders, activeBranchId, context);
      if (context.current())
        setStatusBanner({
          type: "info",
          message: `Connected "${selected.name}" to this branch. Open this folder manually in SolidWorks. ${warning}`,
        });
    });
  };
  const handleCreateBranch = async (params: CreateBranchParams) => {
    if (!vaultDir || !vaultState)
      throw new Error("Open a project vault first.");
    await perform(
      "branch",
      async (context) => {
        const result = await createDesignBranch({
          ...params,
          vaultDir,
          workingFolders,
          signal: context.signal,
          onProgress: context.progress,
        });
        if (!context.current()) return;
        const folders = {
          ...workingFolders,
          [result.branch.branchId]: result.workingDir,
        };
        setVaultState(result.vaultState);
        setWorkingFolders(folders);
        setWorkingDir(result.workingDir);
        setActiveBranchId(result.branch.branchId);
        setScanResult(null);
        setLastRestoreReport(null);
        const warning = await persistBinding(
          result.vaultState,
          vaultDir,
          result.branch.branchId,
          result.workingDir,
        );
        let scanWarning = "";
        try {
          await scan(vaultDir, folders, result.branch.branchId, context);
        } catch (error) {
          scanWarning = `Scan needed: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (context.current())
          setStatusBanner({
            type: "success",
            message: `Created and verified "${result.branch.name}". Open "${result.workingDir.name}" manually in SolidWorks. ${result.publicationWarning ?? ""} ${warning} ${scanWarning}`,
          });
      },
      true,
    );
  };
  const restore = async (revisionId: string, selectedPaths?: string[]) => {
    if (!vaultDir || !vaultState) return;
    await perform("restore", async (context) => {
      setLastRestoreReport(null);
      const destinationDir = await pickFolder("readwrite");
      const state = await openExistingVault(vaultDir);
      await validateWorkingFolderBindings(state, vaultDir, workingFolders);
      // Plain recovery must also remain isolated from every branch working folder.
      for (const branch of state.branches)
        await validateDirectoryIsolation(
          destinationDir,
          workingFolders[branch.branchId]!,
          "Recovery destination",
          `"${branch.name}" working folder`,
        );
      const options = {
        vaultDir,
        destinationDir,
        workingDir,
        revisionId,
        signal: context.signal,
        onProgress: context.progress,
      };
      const result = selectedPaths
        ? await restoreSelectedFilesToFolder({ ...options, selectedPaths })
        : await restoreRevisionToFolder(options);
      if (context.current()) {
        setLastRestoreReport({ result });
        if (!selectedPaths)
          setVaultState((previous) =>
            previous
              ? {
                  ...previous,
                  revisions: previous.revisions.map((revision) =>
                    revision.manifest.revisionId === revisionId
                      ? { ...revision, integrityStatus: "objects_verified" }
                      : revision,
                  ),
                }
              : previous,
          );
      }
    });
  };
  const handleRestoreFullProject = (revisionId: string) => restore(revisionId);
  const handleRestoreSelectedFiles = (
    revisionId: string,
    selectedPaths: string[],
  ) => restore(revisionId, selectedPaths);
  const handleVerifyObjects = async (ids: string[]) => {
    if (!vaultDir || !vaultState) return;
    await perform("verify", async (context) => {
      let processedFiles = 0,
        processedBytes = 0,
        corrupt = false;
      const targets = vaultState.revisions.filter((r) =>
        ids.includes(r.manifest.revisionId),
      );
      const totalFiles = targets.reduce(
        (n, r) => n + r.manifest.files.length,
        0,
      );
      const totalBytes = targets.reduce(
        (n, r) => n + r.manifest.files.reduce((s, f) => s + f.size, 0),
        0,
      );
      for (const revision of targets) {
        if (context.signal.aborted)
          throw new DOMException(
            "Verification cancelled. Completed checks have been retained.",
            "AbortError",
          );
        context.progress({
          phase: "verifying_objects",
          processedFiles,
          totalFiles,
          processedBytes,
          totalBytes,
          message: `Verifying ${formatRevisionNumber(revision.manifest.displayNumber)}…`,
        });
        const verified = await verifyRevisionObjects(
          vaultDir,
          revision,
          context.signal,
        );
        corrupt ||= verified.integrityStatus === "corrupted";
        if (context.current())
          setVaultState((previous) =>
            previous
              ? {
                  ...previous,
                  revisions: previous.revisions.map((r) =>
                    r.manifest.revisionId === verified.manifest.revisionId
                      ? verified
                      : r,
                  ),
                }
              : previous,
          );
        if (verified.integrityStatus === "objects_verified") {
          processedFiles += verified.manifest.files.length;
          processedBytes += verified.manifest.files.reduce(
            (n, f) => n + f.size,
            0,
          );
        }
      }
      if (context.current())
        setStatusBanner({
          type: corrupt ? "error" : "success",
          message: corrupt
            ? "One or more revisions failed content verification."
            : `Verified file contents across ${targets.length} revisions.`,
        });
    });
  };
  const handleVerifySingleRevisionObjects = (id: string) =>
    handleVerifyObjects([id]);
  const handleVerifyAllObjects = () =>
    handleVerifyObjects(
      vaultState?.revisions.map((r) => r.manifest.revisionId) ?? [],
    );
  const clearConnections = async () => {
    await clearAllConvenienceMetadata();
    await refreshRememberedList();
    setWorkingFolders({});
    setWorkingDir(null);
    setScanResult(null);
    setLastRestoreReport(null);
    if (vaultDir) {
      setVaultState(await openExistingVault(vaultDir));
      setActiveTab("history");
    }
    setStatusBanner({
      type: "info",
      message:
        "Cleared browser convenience bindings. All branches and saved revisions were reconstructed from the vault. Reconnect each branch folder explicitly before saving or creating a branch.",
    });
  };
  const handleSimulateClearMetadataAndReopenVault = async () => {
    await perform("connect", clearConnections);
  };
  const handleCancelOperation = () => operationRef.current?.abort();
  const busy = operation !== null;
  const isScanning = operation === "scan";
  const isCapturing = operation === "capture";
  const isRestoring = operation === "restore";
  const isVerifyingAll = operation === "verify";
  const isCreatingBranch = operation === "branch";
  const navigate = (tab: ActiveTab) => {
    if (!operationRef.current) setActiveTab(tab);
  };
  const activeBranch = vaultState?.branches.find(
    (b) => b.branchId === activeBranchId,
  );
  const missingConnections =
    vaultState?.branches
      .filter((b) => !workingFolders[b.branchId])
      .map((b) => b.name) ?? [];

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
                <label className="branch-picker">
                  <span>Active branch</span>
                  <select
                    aria-label="Active branch"
                    value={activeBranchId}
                    disabled={busy}
                    onChange={(e) => {
                      void handleSelectBranch(e.target.value);
                    }}
                  >
                    {vaultState.branches.map((branch) => (
                      <option key={branch.branchId} value={branch.branchId}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </label>
              </span>
            ) : null}
          </div>
          <span className="local-indicator">
            <i />
            Local workspace
          </span>
        </header>
        {vaultState ? (
          <div className="workspace-folder-bar">
            <div>
              <strong>
                {activeBranch?.name ?? "Unknown branch"} · Working folder:{" "}
                {workingDir?.name ?? "Not connected"}
              </strong>
              <p>
                Open this branch’s folder manually in SolidWorks before editing
                or saving CAD documents.
              </p>
            </div>
            <button
              className="button secondary"
              disabled={busy}
              onClick={handleReattachWorkingFolder}
            >
              {workingDir ? "Change branch folder" : "Connect folder"}
            </button>
          </div>
        ) : null}
        <main id="main-content">
          {isVerifyingAll || (isScanning && activeTab !== "changes") ? (
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
              {missingConnections.length ? (
                <Notice>
                  Connect the working folders for{" "}
                  {missingConnections.join(", ")} before saving or creating
                  branches. Select each branch, then Connect folder.
                </Notice>
              ) : null}
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
                await perform("connect", clearConnections);
              }}
            />
          ) : null}
          {vaultState && vaultDir ? (
            <div key={vaultState.project.projectId}>
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
                    isCapturing={isCapturing}
                    progress={progress}
                    statusBanner={null}
                    onScan={handleScanCurrent}
                    onCapture={(params) =>
                      handleCaptureRevision(branch.branchId, params)
                    }
                    onCancelOperation={handleCancelOperation}
                    onReattachWorkingFolder={handleReattachWorkingFolder}
                    operationBlockReason={
                      missingConnections.length
                        ? `Reconnect ${missingConnections.join(", ")} before saving, so folder isolation can be verified.`
                        : undefined
                    }
                  />
                </div>
              ))}
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
                  onCreateBranch={handleCreateBranch}
                  isCreatingBranch={isCreatingBranch}
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
