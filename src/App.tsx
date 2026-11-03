import { useEffect, useRef, useState } from "react";
import {
  type FileSystemDirectoryAdapter,
  RealFileSystemAdapter,
  validateDirectoryIsolation,
} from "./engine/fs-adapter";
import {
  clearAllConvenienceMetadata,
  rememberWorkspace,
  getRememberedWorkspace,
  type RememberedWorkspace,
  rememberHome,
  getRememberedHome,
  getWorkspaceWindowsPath,
  type RememberedHome,
  bindWorkspaceWindowsPathToRoot,
} from "./engine/idb-store";
import {
  resolveWorkingFilePath,
  resolveRecoveredFilePath,
} from "./engine/path-shortcuts";
import {
  WindowsFolderAddressDialog,
  rememberWindowsAddress,
  type HomeAddress,
} from "./components/WindowsFolderAddressDialog";
import { FilePathShortcutsProvider } from "./components/FilePathShortcuts";
import {
  restoreRevisionToFolder,
  restoreSelectedFilesToFolder,
} from "./engine/recovery-service";
import { captureRevision, ReviewStaleError } from "./engine/revision-service";
import {
  prepareApplication,
  applyPreparedApplication,
  recoverApplication,
  abandonApplication,
  requestApplicationWriteAccess,
  type PreparedApplication,
} from "./engine/application-service";
import {
  applicationCaptureBlock,
  branchApplications,
  type ApplicationReview,
} from "./engine/application-records";
import { ApplicationStatus } from "./components/ApplicationStatus";
import { DesignCases } from "./components/DesignCases";
import { changeCaseLifecycle } from "./engine/case-lifecycle-service";
import { assertCaseWritable, caseWriteBlock } from "./engine/case-lifecycle";
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
  openExistingVault,
  verifyRevisionObjects,
} from "./engine/vault-service";
import { ChangesCaptureView } from "./components/ChangesCaptureView";
import { HistoryRecoveryView } from "./components/HistoryRecoveryView";
import { ActiveBranchPicker } from "./components/ActiveBranchPicker";
import {
  SidebarResizeHandle,
  useSidebarWidth,
} from "./components/SidebarResize";
import { DiagnosticsView } from "./components/DiagnosticsView";
import type { CreateBranchParams } from "./components/CreateBranchDialog";
import {
  FolderOpen,
  History,
  Settings,
  ScanLine,
  HardDrive,
} from "lucide-react";
import {
  IntegrityNotice,
  Notice,
  OperationProgress,
  Modal,
} from "./components/ui";
import { supportsFileSystemAccessApi } from "./utils/format";
import { WorkspaceProjectsView } from "./components/WorkspaceProjectsView";
import { HomeWorkspacesView } from "./components/HomeWorkspacesView";
import {
  WorkspaceTree,
  type WorkspaceTreeProps,
} from "./components/WorkspaceTree";
import {
  createHome,
  openHome,
  createHomeWorkspace,
  bringWorkspaceIntoHome,
  type HomeState,
  type HomeWorkspaceEntry,
} from "./engine/home-service";
import { resolveHomeFilePath } from "./engine/path-shortcuts";
import type { CaptureDraft } from "./components/ChangesCaptureView";
import {
  openWorkspace,
  createProject,
  importProject,
  resolveManagedProject,
  createManagedBranch,
  recoverManagedCopy,
  type WorkspaceState,
  type ManagedProject,
  type WorkspaceProjectEntry,
} from "./engine/workspace-service";

type ActiveTab = "connect" | "changes" | "history" | "diagnostics";
type Operation =
  "scan" | "capture" | "restore" | "verify" | "branch" | "connect" | "apply";
type Context = {
  version: number;
  signal: AbortSignal;
  current: () => boolean;
  progress: (p: ProgressUpdate) => void;
};

export default function App() {
  const sidebar = useSidebarWidth();
  const [home, setHome] = useState<HomeState | null>(null);
  const [rememberedHome, setRememberedHome] = useState<RememberedHome | null>(
    null,
  );
  const [homeView, setHomeView] = useState(true);
  const [introView, setIntroView] = useState(false);
  const [pendingHome, setPendingHome] = useState<{
    root: RealFileSystemAdapter;
    next?: HomeState;
    create: boolean;
    saved?: RememberedHome;
    requestId: string;
  } | null>(null);
  const [homeAddress, setHomeAddress] = useState<HomeAddress | null>(null);
  const homeAddressCache = useRef<HomeAddress[]>([]);
  const cacheHomeAddress = (address: HomeAddress) => {
    homeAddressCache.current = [
      ...homeAddressCache.current.filter((item) => item.root !== address.root),
      address,
    ];
    setHomeAddress(address);
  };
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [managedWorkspaceKey, setManagedWorkspaceKey] = useState<string | null>(
    null,
  );
  const draftCache = useRef(new Map<string, CaptureDraft>());
  const branchContexts = useRef(new Map<string, string>());
  const [activeTab, setActiveTab] = useState<ActiveTab>("connect");
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  useEffect(() => {
    if (workspace && managedWorkspaceKey)
      setHome((previous) =>
        previous
          ? {
              ...previous,
              workspaces: previous.workspaces.map((e) =>
                e.key === managedWorkspaceKey ? { ...e, workspace } : e,
              ),
            }
          : null,
      );
  }, [workspace, managedWorkspaceKey]);
  const [managedProject, setManagedProject] = useState<ManagedProject | null>(
    null,
  );
  const [rememberedWorkspace, setRememberedWorkspace] =
    useState<RememberedWorkspace | null>(null);
  const [convenienceEpoch, setConvenienceEpoch] = useState(0);
  const [bannerScope, setBannerScope] = useState<"workspace" | "project">(
    "workspace",
  );
  const [projectSession, setProjectSession] = useState(0);
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
    destinationPath?: string;
    recoveredFiles?: { relativeDirectory: string; paths: string[] };
  } | null>(null);
  // Synchronous guards also cover rapid double clicks before React renders disabled controls.
  const operationRef = useRef<AbortController | null>(null);
  const contextVersion = useRef(0);
  useEffect(() => {
    void getRememberedWorkspace().then(setRememberedWorkspace);
    void getRememberedHome()
      .then(setRememberedHome)
      .catch(() => {});
  }, []);
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
    setBannerScope(activeTab === "connect" ? "workspace" : "project");
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
  const persistWorkspace = async (
    current: WorkspaceState,
    projectPath?: string,
    branchId?: string,
    currentHome = home,
  ) => {
    if (!(current.root instanceof RealFileSystemAdapter)) return "";
    const value = {
      workspaceId: current.identity.workspaceId,
      name: current.identity.name,
      rootHandle: current.root.handle,
      projectPath,
      activeBranchId: branchId,
    };
    setRememberedWorkspace(value);
    if (projectPath && branchId)
      branchContexts.current.set(
        `${current.identity.workspaceId}:${projectPath}`,
        branchId,
      );
    try {
      await rememberWorkspace(value);
      const registered = currentHome?.workspaces.find(
        (e) => e.workspaceId === current.identity.workspaceId && e.workspace,
      );
      if (
        currentHome &&
        registered?.workspace &&
        (await registered.workspace.root.isSameEntry(current.root)) &&
        currentHome.root instanceof RealFileSystemAdapter
      ) {
        const binding = {
          homeId: currentHome.identity.homeId,
          name: currentHome.identity.name,
          rootHandle: currentHome.root.handle,
          workspaceId: current.identity.workspaceId,
          projectPath,
          activeBranchId: branchId,
        };
        await rememberHome(binding);
        setRememberedHome(binding);
      }
      return "";
    } catch (error) {
      return `Browser convenience data could not be saved (${error instanceof Error ? error.message : String(error)}). Your project is on disk; select the workspace once after reopening.`;
    }
  };
  const leaveProject = () => {
    contextVersion.current++;
    setManagedProject(null);
    setVaultState(null);
    setVaultDir(null);
    setWorkingFolders({});
    setWorkingDir(null);
    setScanResult(null);
    setLastRestoreReport(null);
    setActiveBranchId(MAIN_BRANCH_ID);
    setActiveTab("connect");
    setStatusBanner(null);
  };
  const allWorkspaces = () => {
    if (operationRef.current) return;
    leaveProject();
    setWorkspace(null);
    setHomeView(true);
    setIntroView(false);
    setManagedWorkspaceKey(null);
  };
  const installHome = async (
    next: HomeState,
    root: RealFileSystemAdapter,
    path: string,
    saved?: RememberedHome,
    warning = "",
  ) => {
    leaveProject();
    setWorkspace(null);
    setManagedWorkspaceKey(null);
    cacheHomeAddress({ homeId: next.identity.homeId, root, path });
    setHome(next);
    setHomeView(true);
    setIntroView(false);
    setPendingHome(null);
    const binding = {
      homeId: next.identity.homeId,
      name: next.identity.name,
      rootHandle: root.handle,
      workspaceId: saved?.workspaceId,
      projectPath: saved?.projectPath,
      activeBranchId: saved?.activeBranchId,
    };
    setRememberedHome(binding);
    try {
      await rememberHome(binding);
    } catch {
      warning +=
        " Home access could not be remembered. Select the folder again after reopening.";
    }
    setBannerScope("workspace");
    setStatusBanner(warning ? { type: "info", message: warning } : null);
  };
  const connectHome = async (create: boolean, saved?: RememberedHome) => {
    await perform(
      "connect",
      async (context) => {
        // Start the picker in the user action; perform owns connection errors.
        const root = saved
          ? new RealFileSystemAdapter(saved.rootHandle)
          : await pickFolder("readwrite").catch((error: unknown) => {
              if (error instanceof DOMException && error.name === "AbortError")
                throw new Error(
                  create
                    ? "Choose an empty dedicated folder, suggested name Cadtree. Use Open Cadtree home for a recognized existing home."
                    : "Folder selection was cancelled. Choose your existing Cadtree home folder to continue.",
                );
              throw error;
            });
        if ((await root.requestPermission("readwrite")) !== "granted")
          throw new Error("Grant access to reconnect your Cadtree home.");
        if (create) {
          if ((await root.listEntries()).length)
            throw new Error(
              "Choose an empty dedicated folder, suggested name Cadtree. Use Open Cadtree home for a recognized existing home.",
            );
          if (context.current())
            setPendingHome({
              root,
              create,
              saved,
              requestId: crypto.randomUUID(),
            });
          return;
        }
        const next = await openHome(root);
        if (saved && next.identity.homeId !== saved.homeId)
          throw new Error(
            "This folder contains a different Cadtree home. Open it explicitly.",
          );
        let path = "";
        for (const address of [...homeAddressCache.current].reverse()) {
          if (
            address.homeId === next.identity.homeId &&
            (await root.isSameEntry(address.root))
          ) {
            path = address.path;
            break;
          }
        }
        if (!path) {
          try {
            path = await getWorkspaceWindowsPath(
              next.identity.homeId,
              root.handle,
            );
          } catch {
            /* Required entry also works with session-only preferences. */
          }
        }
        if (!context.current()) return;
        if (path) await installHome(next, root, path, saved);
        else
          setPendingHome({
            root,
            next,
            create,
            saved,
            requestId: crypto.randomUUID(),
          });
      },
    );
  };
  const completeHomeSetup = async (path: string) => {
    if (!pendingHome) return;
    const selected = pendingHome;
    await perform(
      "connect",
      async (context) => {
        if ((await selected.root.requestPermission("readwrite")) !== "granted")
          throw new Error("Grant access to complete home setup.");
        const next = selected.next
          ? await openHome(selected.root)
          : await createHome(selected.root);
        if (
          selected.next &&
          next.identity.homeId !== selected.next.identity.homeId
        )
          throw new Error(
            "The Cadtree home identity changed during setup. Select the intended home again.",
          );
        // Retain the published identity for retries; no user files are removed on cancellation.
        if (context.current()) setPendingHome({ ...selected, next });
        const warning = await rememberWindowsAddress(
          next.identity.homeId,
          path,
          selected.root.handle,
        );
        if (context.current())
          await installHome(next, selected.root, path, selected.saved, warning);
      },
      true,
    );
  };
  const refreshHome = async () => {
    if (!home) return;
    await perform(
      "connect",
      async (context) => {
        if ((await home.root.requestPermission("readwrite")) !== "granted")
          throw new Error("Reconnect the Cadtree home to renew access.");
        const next = await openHome(home.root);
        if (next.identity.homeId !== home.identity.homeId)
          throw new Error(
            "Cadtree home identity changed. Open the intended home explicitly.",
          );
        if (context.current()) setHome(next);
      },
      true,
    );
  };
  const openHomeEntry = async (entry: HomeWorkspaceEntry) => {
    if (!home) return;
    await perform(
      "connect",
      async (context) => {
        if ((await home.root.requestPermission("readwrite")) !== "granted")
          throw new Error("Reconnect the Cadtree home to renew access.");
        const next = await openHome(home.root);
        if (next.identity.homeId !== home.identity.homeId)
          throw new Error(
            "Cadtree home identity changed. Open the intended home explicitly.",
          );
        const chosen = next.workspaces.find((e) => e.key === entry.key);
        if (context.current()) setHome(next);
        if (!chosen?.workspace)
          throw new Error(
            chosen?.issues.join(" ") ||
              "Workspace is unavailable. No directory was recreated.",
          );
        if (!context.current()) return;
        leaveProject();
        setHomeView(false);
        setWorkspace(chosen.workspace);
        setManagedWorkspaceKey(chosen.key);
        await persistWorkspace(chosen.workspace);
      },
      true,
    );
  };
  const addHomeWorkspace = async (name?: string) => {
    if (!home) throw new Error("Choose a Cadtree home first.");
    const source = name === undefined ? await pickFolder("read") : undefined;
    await perform(
      "connect",
      async (context) => {
        try {
          if (source && (await source.requestPermission("read")) !== "granted")
            throw new Error(
              "Grant access to inspect and copy the existing workspace.",
            );
          const result = source
            ? await bringWorkspaceIntoHome(home.root, source, {
                expectedHomeId: home.identity.homeId,
                signal: context.signal,
                onProgress: context.progress,
              })
            : await createHomeWorkspace(home.root, name!, {
                expectedHomeId: home.identity.homeId,
                signal: context.signal,
                onProgress: context.progress,
              });
          const next = await openHome(home.root);
          if (!context.current()) return;
          if (source instanceof RealFileSystemAdapter) {
            // Keep the retained original's optional absolute path tied to that root,
            // including if its copied descendant is later opened through compatibility mode.
            try {
              await bindWorkspaceWindowsPathToRoot(
                result.workspace.identity.workspaceId,
                source.handle,
              );
            } catch {
              /* Convenience storage does not control publication. */
            }
          }
          setHome(next);
          setWorkspace(result.workspace);
          setHomeView(false);
          setManagedWorkspaceKey(
            next.workspaces.find((e) => e.directory === result.directory)!.key,
          );
          setStatusBanner({
            type: "success",
            message: `${source ? "Verified copy ready. Continue working in" : "Created workspace at"} ${home.root.name}/${result.directory}/. ${source ? "Original workspace retained unchanged; continue editing only in this managed copy." : ""}`,
          });
          await persistWorkspace(result.workspace, undefined, undefined, next);
        } catch (error) {
          const next = await openHome(home.root);
          if (
            context.current() &&
            next.identity.homeId === home.identity.homeId
          )
            setHome(next);
          throw error;
        }
      },
      true,
    );
  };
  const refreshWorkspace = async () => {
    if (!workspace) return;
    await perform("connect", async (context) => {
      if ((await workspace.root.requestPermission("readwrite")) !== "granted")
        throw new Error("Reconnect the workspace to renew its permission.");
      const current = await openWorkspace(workspace.root);
      if (context.current()) setWorkspace(current);
      if (managedProject) {
        const managed = await resolveManagedProject(
          workspace.root,
          managedProject.record.containerPath,
        );
        if (context.current()) {
          setManagedProject(managed);
          setVaultState(managed.vaultState);
          setWorkingFolders(managed.workingFolders);
          setWorkingDir(managed.workingFolders[activeBranchId] ?? null);
          setScanResult(null);
        }
      }
    });
  };
  const activateManaged = async (
    current: WorkspaceState,
    project: ManagedProject,
    context: Context,
    message = "",
    requestedBranchId?: string,
  ) => {
    if (!context.current()) return;
    if (requestedBranchId)
      assertCaseWritable(project.vaultState, requestedBranchId);
    if (
      requestedBranchId &&
      !project.vaultState.branches.some(
        (branch) => branch.branchId === requestedBranchId,
      )
    )
      throw new Error(
        "This branch is no longer available. Refresh the workspace.",
      );
    const preferred =
      requestedBranchId ??
      branchContexts.current.get(
        `${current.identity.workspaceId}:${project.record.containerPath}`,
      ) ??
      (rememberedWorkspace?.workspaceId === current.identity.workspaceId &&
      rememberedWorkspace.projectPath === project.record.containerPath
        ? rememberedWorkspace.activeBranchId
        : rememberedHome?.workspaceId === current.identity.workspaceId &&
            rememberedHome.projectPath === project.record.containerPath
          ? rememberedHome.activeBranchId
          : MAIN_BRANCH_ID);
    const branchId = project.vaultState.branches.some(
      (branch) => branch.branchId === preferred,
    )
      ? preferred!
      : MAIN_BRANCH_ID;
    setManagedProject(project);
    setBannerScope("project");
    await installProject(
      project.vaultState,
      project.vaultDir,
      project.workingFolders,
      branchId,
    );
    const warning = await persistWorkspace(
      current,
      project.record.containerPath,
      branchId,
    );
    if (project.ready && !project.issues.length) {
      try {
        await scan(
          project.vaultDir,
          project.workingFolders,
          branchId,
          context,
          { root: current.root, path: project.record.containerPath },
        );
      } catch (error) {
        message += ` Scan unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (context.current())
      setStatusBanner(
        message.trim() || warning.trim()
          ? {
              type: "info",
              message: `${message} ${warning}`.trim(),
            }
          : null,
      );
  };
  const openManaged = async (entry: WorkspaceProjectEntry) => {
    if (!workspace) return;
    await perform(
      "connect",
      async (context) => {
        const current = await openWorkspace(workspace.root);
        if (context.current()) setWorkspace(current);
        await activateManaged(
          current,
          await resolveManagedProject(workspace.root, entry.containerPath),
          context,
        );
      },
      true,
    );
  };
  const openTreeProject: WorkspaceTreeProps["onProject"] = async (
    homeWorkspace,
    entry,
    branchId,
  ) => {
    await perform(
      "connect",
      async (context) => {
        let current: WorkspaceState;
        if (homeWorkspace && home) {
          if ((await home.root.requestPermission("readwrite")) !== "granted")
            throw new Error("Reconnect the Cadtree home to renew access.");
          const discovered = await openHome(home.root);
          if (discovered.identity.homeId !== home.identity.homeId)
            throw new Error(
              "Cadtree home identity changed. Reopen it explicitly.",
            );
          const chosen = discovered.workspaces.find(
            (item) => item.key === homeWorkspace.key,
          );
          if (
            !chosen?.workspace ||
            chosen.workspaceId !== homeWorkspace.workspaceId
          )
            throw new Error(
              "This workspace is unavailable. Refresh home to inspect its connections.",
            );
          current = chosen.workspace;
          if (context.current()) setHome(discovered);
        } else {
          if (!workspace) throw new Error("Choose a workspace first.");
          if (
            (await workspace.root.requestPermission("readwrite")) !== "granted"
          )
            throw new Error("Reconnect the workspace to renew access.");
          current = await openWorkspace(workspace.root);
          if (current.identity.workspaceId !== workspace.identity.workspaceId)
            throw new Error(
              "Workspace identity changed. Open the intended workspace explicitly.",
            );
        }
        const fresh = current.projects.find(
          (project) => project.containerPath === entry.containerPath,
        );
        if (
          !fresh?.project ||
          fresh.status === "duplicate" ||
          fresh.projectId !== entry.projectId
        )
          throw new Error(
            "This project location needs attention. Open the workspace to inspect it.",
          );
        const project = await resolveManagedProject(
          current.root,
          fresh.containerPath,
        );
        if (
          branchId &&
          !project.vaultState.branches.some(
            (branch) => branch.branchId === branchId,
          )
        )
          throw new Error(
            "This branch is no longer available. Refresh the workspace.",
          );
        if (!context.current()) return;
        setWorkspace(current);
        setManagedWorkspaceKey(homeWorkspace?.key ?? null);
        setHomeView(false);
        await activateManaged(current, project, context, "", branchId);
      },
      true,
    );
  };
  const addManagedProject = async (
    name: string,
    source?: FileSystemDirectoryAdapter,
  ) => {
    if (!workspace) throw new Error("Choose a workspace first.");
    await perform(
      "connect",
      async (context) => {
        const options = {
          signal: context.signal,
          onProgress: context.progress,
        };
        const project = source
          ? await importProject(workspace.root, source, name, options)
          : await createProject(workspace.root, name, options);
        if (!context.current()) return;
        const current = {
          ...workspace,
          projects: [
            ...workspace.projects,
            {
              containerPath: project.record.containerPath,
              projectId: project.record.projectId,
              name: project.record.name,
              status: "ready" as const,
              issues: [],
              project,
            },
          ],
        };
        setWorkspace(current);
        await activateManaged(
          current,
          project,
          context,
          source
            ? `Continue working in this copy: ${current.identity.name}/${project.workingPaths[MAIN_BRANCH_ID]}. Original "${source.name}" was retained and is not tracked by this managed project. Open the new copy manually in SolidWorks and check its references. Capture the initial revision explicitly.`
            : `Created project "${project.record.name}". Save your CAD files in ${current.identity.name}/${project.workingPaths[MAIN_BRANCH_ID]}/, then scan and save your first revision.`,
        );
      },
      true,
    );
  };
  const scan = async (
    vault: FileSystemDirectoryAdapter,
    folders: WorkingFolderBindings,
    branchId: string,
    context: Context,
    managedContext: {
      root: FileSystemDirectoryAdapter;
      path: string;
    } | null = managedProject && workspace
      ? { root: workspace.root, path: managedProject.record.containerPath }
      : null,
  ) => {
    let folder = folders[branchId];
    let state: VaultState;
    if (managedContext) {
      const current = await resolveManagedProject(
        managedContext.root,
        managedContext.path,
      );
      if (context.current()) {
        setManagedProject(current);
        setWorkingFolders(current.workingFolders);
        setWorkingDir(current.workingFolders[branchId] ?? null);
      }
      if (!current.ready || current.issues.length)
        throw new Error(
          `This managed project is read-only. ${current.issues.join(" ")}`,
        );
      folders = current.workingFolders;
      folder = folders[branchId];
      state = current.vaultState;
    } else state = await openExistingVault(vault);
    if (!folder)
      throw new Error(
        "Connect the selected branch’s working folder before scanning.",
      );
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
    setProjectSession((previous) => previous + 1);
    setVaultDir(vault);
    setVaultState(state);
    setWorkingFolders(folders);
    setActiveBranchId(branchId);
    setWorkingDir(folders[branchId] ?? null);
    setScanResult(null);
    setLastRestoreReport(null);
    setActiveTab(state.revisions.length ? "history" : "changes");
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
    setScanResult(null);
    setLastRestoreReport(null);
    setStatusBanner(null);
    await perform("scan", async (context) => {
      const state = await openExistingVault(vaultDir);
      if (!context.current()) return;
      applyVaultState(state);
      if (!state.branches.some((b) => b.branchId === branchId))
        throw new Error("Selected branch is missing. Reopen the vault.");
      assertCaseWritable(state, branchId);
      setActiveBranchId(branchId);
      setWorkingDir(null);
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
      const warning = workspace && managedProject
        ? await persistWorkspace(workspace, managedProject.record.containerPath, branchId)
        : "";
      if (context.current())
        setStatusBanner(
          !readable || warning
            ? {
                type: "info",
                message:
                  `${readable ? "" : "Connect this branch’s working folder explicitly to scan or save."} ${warning}`.trim(),
              }
            : null,
        );
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
            resolveWorkingFolders:
              managedProject && workspace
                ? async (state) => {
                    const current = await resolveManagedProject(
                      workspace.root,
                      managedProject.record.containerPath,
                      state,
                    );
                    if (!current.ready || current.issues.length)
                      throw new Error(current.issues.join(" "));
                    return current.workingFolders;
                  }
                : undefined,
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
  const applicationFolders = async (state: VaultState) => {
    if (!managedProject || !workspace) return workingFolders;
    const current = await resolveManagedProject(
      workspace.root,
      managedProject.record.containerPath,
      state,
    );
    if (!current.ready || current.issues.length)
      throw new Error(current.issues.join(" "));
    return current.workingFolders;
  };
  const applicationOptions = (context: Context) => ({
    workingFolders,
    resolveWorkingFolders: applicationFolders,
    signal: context.signal,
    onProgress: context.progress,
  });
  const handleCaseLifecycle = async (
    branchId: string,
    status: "active" | "archived",
    expectedVersion: string | null,
  ) => {
    if (!vaultDir || !vaultState) throw new Error("Open the project first.");
    await perform(
      "scan",
      async (context) => {
        try {
          if (
            (await vaultDir.queryPermission("readwrite")) !== "granted" &&
            (await vaultDir.requestPermission("readwrite")) !== "granted"
          )
            throw new Error(
              "Write access to the vault is required for lifecycle metadata.",
            );
          const result = await changeCaseLifecycle(
            vaultDir,
            {
              projectId: vaultState.project.projectId,
              branchId,
              activeBranchId,
              status,
              expectedVersion,
            },
            applicationOptions(context),
          );
          if (context.current()) {
            applyVaultState(result.state);
            setStatusBanner({
              type: "success",
              message: `${status === "archived" ? "Archived" : "Reopened"} ${result.state.branches.find((branch) => branch.branchId === branchId)?.name}. ${status === "archived" ? "Find archived cases in Settings → Design cases or Show archived cases in Explorer." : "The working branch has not been switched."} ${result.warning ?? ""}`,
            });
          }
        } finally {
          if (context.current()) {
            try {
              applyVaultState(await openExistingVault(vaultDir));
            } catch {
              /* Original error remains visible. */
            }
          }
        }
      },
      true,
    );
  };
  const handlePrepareApplication = async (review: ApplicationReview) => {
    if (!vaultDir || review.destinationBranchId !== activeBranchId)
      throw new Error("Destination context changed. Refresh and review again.");
    const result = await perform(
      "apply",
      async (context) => {
        await requestApplicationWriteAccess(vaultDir, workingDir);
        return prepareApplication(
          vaultDir,
          review,
          applicationOptions(context),
        );
      },
      true,
    );
    if (!result) throw new Error("Application preparation did not finish.");
    return result;
  };
  const handleRefreshApplicationReview = async () => {
    if (!vaultDir) throw new Error("Reconnect the revision vault.");
    await perform(
      "scan",
      async (context) => {
        const state = await openExistingVault(vaultDir);
        if (context.current()) {
          applyVaultState(state);
          setScanResult(null);
        }
      },
      true,
    );
  };
  const refreshApplicationState = async () => {
    if (!vaultDir) return;
    try {
      applyVaultState(await openExistingVault(vaultDir));
      setScanResult(null);
    } catch {
      /* The operation's original permission/outcome error remains visible. */
    }
  };
  const handleApplyApplication = async (prepared: PreparedApplication) => {
    if (!vaultDir || prepared.review.destinationBranchId !== activeBranchId)
      throw new Error("Destination context changed. Refresh and review again.");
    await perform(
      "apply",
      async (context) => {
        try {
          await applyPreparedApplication(
            vaultDir,
            prepared,
            applicationOptions(context),
          );
          if (context.current())
            setStatusBanner({
              type: "success",
              message: "Applied to working files — revision not yet saved.",
            });
        } finally {
          if (context.current()) await refreshApplicationState();
        }
      },
      true,
    );
  };
  const handleRecoverApplication = async (id: string) => {
    if (!vaultDir || !vaultState) return;
    await perform(
      "apply",
      async (context) => {
        try {
          await requestApplicationWriteAccess(vaultDir, workingDir);
          const result = await recoverApplication(
            vaultDir,
            vaultState.project.projectId,
            activeBranchId,
            id,
            applicationOptions(context),
          );
          if (result.manualPaths.length)
            throw new Error(
              `Manual recovery required: ${result.manualPaths.join(", ")}. Unexpected files remain untouched; readable copies are retained under the operation's unexpected folder. Inspect the before-state evidence, restore affected paths manually, then retry recovery.`,
            );
          if (context.current())
            setStatusBanner({
              type: "success",
              message:
                "Affected file before-states recovered and verified. Unrelated files and directories were retained. Scan before saving.",
            });
        } finally {
          if (context.current()) await refreshApplicationState();
        }
      },
      true,
    );
  };
  const handleAbandonApplication = async (id: string) => {
    if (!vaultDir || !vaultState) return;
    await perform(
      "apply",
      async (context) => {
        try {
          await abandonApplication(
            vaultDir,
            vaultState.project.projectId,
            activeBranchId,
            id,
          );
        } finally {
          if (context.current()) await refreshApplicationState();
        }
      },
      true,
    );
  };
  const handleReattachWorkingFolder = async () => {
    if (managedProject && workspace) await refreshWorkspace();
  };
  const handleCreateBranch = async (params: CreateBranchParams) => {
    if (!vaultDir || !vaultState || !managedProject || !workspace)
      throw new Error("Open a project in a Cadtree workspace first.");
    await perform(
      "branch",
      async (context) => {
        if (managedProject && workspace) {
          const current = await createManagedBranch(
            workspace.root,
            managedProject.record.containerPath,
            {
              sourceRevisionId: params.sourceRevisionId,
              name: params.name,
              reason: params.reason,
              signal: context.signal,
              onProgress: context.progress,
            },
          );
          if (!context.current()) return;
          setManagedProject(current);
          setVaultState(current.vaultState);
          setWorkingFolders(current.workingFolders);
          setWorkingDir(current.workingFolders[current.createdBranchId]!);
          setActiveBranchId(current.createdBranchId);
          setScanResult(null);
          setLastRestoreReport(null);
          const warning = await persistWorkspace(
            workspace,
            current.record.containerPath,
            current.createdBranchId,
          );
          try {
            await scan(
              current.vaultDir,
              current.workingFolders,
              current.createdBranchId,
              context,
            );
          } catch {
            /* The published branch stays successful; connection diagnostics are refreshed next time. */
          }
          if (context.current())
            setStatusBanner({
              type: "success",
              message: `Created and verified "${params.name}". Open ${workspace.identity.name}/${current.workingPaths[current.createdBranchId]} manually in SolidWorks. ${warning}`,
            });
          return;
        }
      },
      true,
    );
  };
  const restore = async (
    revisionId: string,
    selectedPaths?: string[],
    external = false,
  ) => {
    if (!vaultDir || !vaultState) return;
    await perform("restore", async (context) => {
      setLastRestoreReport(null);
      if (managedProject && workspace && !external) {
        const recovered = await recoverManagedCopy(
          workspace.root,
          managedProject.record.containerPath,
          revisionId,
          selectedPaths,
          { signal: context.signal, onProgress: context.progress },
        );
        if (context.current())
          setLastRestoreReport({
            result: recovered.result,
            destinationPath: `${workspace.identity.name}/${recovered.relativePath}`,
            recoveredFiles: {
              relativeDirectory: recovered.relativePath,
              paths:
                selectedPaths ??
                managedProject.vaultState.revisions
                  .find(
                    (revision) => revision.manifest.revisionId === revisionId,
                  )!
                  .manifest.files.map((file) => file.path),
            },
          });
        return;
      }
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
        workingFolders,
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
  const handleRestoreFullProject = (revisionId: string, external?: boolean) =>
    restore(revisionId, undefined, external);
  const handleRestoreSelectedFiles = (
    revisionId: string,
    selectedPaths: string[],
    external?: boolean,
  ) => restore(revisionId, selectedPaths, external);
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
    homeAddressCache.current = [];
    setHomeAddress(null);
    setConvenienceEpoch((value) => value + 1);
    setRememberedWorkspace(null);
    setRememberedHome(null);
    if (workspace && managedProject) {
      const current = await openWorkspace(workspace.root);
      const managed = await resolveManagedProject(
        workspace.root,
        managedProject.record.containerPath,
      );
      setWorkspace(current);
      setManagedProject(managed);
      setVaultState(managed.vaultState);
      setWorkingFolders(managed.workingFolders);
      setWorkingDir(managed.workingFolders[activeBranchId] ?? null);
      setScanResult(null);
      setLastRestoreReport(null);
      setActiveTab("history");
      setStatusBanner({
        type: "info",
        message:
          "Cleared browser convenience data. All managed project and branch locations were resolved again from the workspace records. After a browser restart, select the workspace root once.",
      });
      return;
    }
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
    if (!operationRef.current) {
      setActiveTab(tab);
    }
  };
  const missingConnections =
    vaultState?.branches
      .filter((b) => !workingFolders[b.branchId])
      .map((b) => b.name) ?? [];
  const managedBlockReason =
    managedProject && (!managedProject.ready || managedProject.issues.length)
      ? `Managed project is read-only. ${managedProject.issues.join(" ")}`
      : undefined;
  const projectView =
    !homeView && activeTab !== "connect" && Boolean(vaultState && vaultDir);
  const homeEntry = home?.workspaces.find(
    (e) =>
      e.key === managedWorkspaceKey &&
      e.workspace &&
      e.workspaceId === workspace?.identity.workspaceId,
  );
  const shortcutHome = homeEntry ? home : null;
  const workingFileResolver = (branchId: string, path: string) => async () => {
    if (!workspace || !managedProject)
      throw new Error(
        "Full Windows file paths are unavailable for external projects. Bring this project into a workspace to enable path shortcuts.",
      );
    const location = await resolveWorkingFilePath(
      workspace.root,
      workspace.identity.workspaceId,
      managedProject.record.containerPath,
      branchId,
      path,
    );
    return shortcutHome && homeEntry?.directory
      ? resolveHomeFilePath(shortcutHome, homeEntry, location)
      : location;
  };
  const treeProps: WorkspaceTreeProps = {
    home,
    workspace,
    managedWorkspaceKey,
    projectPath: managedProject?.record.containerPath,
    activeVault: vaultState,
    activeBranchId,
    projectView,
    busy,
    onHome: () => {
      allWorkspaces();
      setExplorerOpen(false);
    },
    onWorkspace: async (entry) => {
      if (entry && entry.key !== managedWorkspaceKey)
        await openHomeEntry(entry);
      else navigate("connect");
      setExplorerOpen(false);
    },
    onProject: async (entry, project, branch) => {
      await openTreeProject(entry, project, branch);
      setExplorerOpen(false);
    },
  };

  return (
    <FilePathShortcutsProvider
      workspace={workspace}
      home={shortcutHome ?? (homeView ? home : null)}
      contextKey={`${homeView}:${workspace?.identity.workspaceId}:${managedWorkspaceKey}:${managedProject?.record.projectId}:${activeBranchId}`}
      convenienceEpoch={convenienceEpoch}
      homeAddress={homeAddress}
      onHomeAddressChange={cacheHomeAddress}
    >
      <div className="app-shell" style={sidebar.style}>
        <aside className="navigation-rail">
          <a
            className="wordmark"
            aria-label="cAdtree introduction"
            aria-current={homeView && (introView || !home) ? "page" : undefined}
            href="#intro"
            onClick={(e) => {
              e.preventDefault();
              if (operationRef.current) return;
              allWorkspaces();
              setIntroView(true);
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
          <p className="rail-caption">CREATE. ADAPT. DEFINE.</p>
          <nav aria-label="Primary navigation" className="rail-navigation">
            <button
              aria-label="My workspaces"
              disabled={busy}
              aria-current={homeView && !introView && home ? "page" : undefined}
              onClick={allWorkspaces}
            >
              <FolderOpen size={18} />
              <span>My workspaces</span>
            </button>
            {home || workspace ? (
              <button
                className="mobile-tree-toggle"
                aria-label="Browse folders"
                disabled={busy}
                onClick={() => setExplorerOpen(true)}
              >
                <FolderOpen size={18} />
                <span>Browse folders</span>
              </button>
            ) : null}
            <div className="desktop-workspace-tree">
              <WorkspaceTree {...treeProps} />
            </div>
            <div
              className={`project-navigation${!homeView && vaultState ? " has-project" : ""}`}
            >
              {!homeView ? (
                <>
                  {vaultState ? (
                    <>
                      <p className="rail-section-label">PROJECT</p>
                      <button
                        aria-label="History"
                        disabled={!vaultState || busy}
                        aria-current={
                          activeTab === "history" ? "page" : undefined
                        }
                        onClick={() => navigate("history")}
                      >
                        <History size={18} />
                        <span>History</span>
                      </button>
                      <button
                        aria-label="Changes"
                        disabled={!vaultState || busy}
                        aria-current={
                          activeTab === "changes" ? "page" : undefined
                        }
                        onClick={() => navigate("changes")}
                      >
                        <ScanLine size={18} />
                        <span>Changes</span>
                        {scanResult?.hasChanges ? (
                          <i className="nav-change-dot" />
                        ) : null}
                      </button>
                      <button
                        aria-label="Settings"
                        disabled={!vaultState || busy}
                        aria-current={
                          activeTab === "diagnostics" ? "page" : undefined
                        }
                        onClick={() => navigate("diagnostics")}
                      >
                        <Settings size={18} />
                        <span>Settings</span>
                      </button>
                    </>
                  ) : null}
                </>
              ) : null}
            </div>
          </nav>
          <div className="rail-bottom">
            <HardDrive size={17} />
            <div>
              <strong>Local by design</strong>
              <p>Your files. Your storage.</p>
            </div>
          </div>
          <SidebarResizeHandle
            width={sidebar.width}
            max={sidebar.max}
            onChange={sidebar.change}
          />
        </aside>
        <div className="workspace-shell">
          <span className="local-indicator compact-local-indicator">
            <i />
            Local workspace
          </span>
          <main id="main-content" aria-busy={busy}>
            {progress &&
            (isVerifyingAll || (isScanning && activeTab !== "changes")) ? (
              <div className="global-feedback">
                <OperationProgress
                  progress={progress}
                  onCancel={handleCancelOperation}
                />
              </div>
            ) : null}
            {statusBanner && (projectView || bannerScope === "workspace") ? (
              <div className="global-feedback app-status-feedback">
                <Notice
                  type={statusBanner.type}
                  onDismiss={() => setStatusBanner(null)}
                >
                  {statusBanner.message}
                  {statusBanner.type === "error" &&
                  /permission|reconnect|access|notallowed/i.test(
                    statusBanner.message,
                  ) &&
                  projectView ? (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={handleReattachWorkingFolder}
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
                    {vaultState.incompleteAttempts.length} incomplete or
                    interrupted operation(s) retained. These are not committed
                    revisions.
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
                      ? "Reconnect the workspace to resolve these recorded branch locations: "
                      : "Connect the working folders for "}
                    {missingConnections.join(", ")} before saving or creating
                    branches.{" "}
                    {managedProject
                      ? "Missing or moved folders will stay disconnected until their recorded location is restored."
                      : "Select each branch, then Connect folder."}
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={handleReattachWorkingFolder}
                    >
                      {managedProject
                        ? "Reconnect workspace"
                        : "Connect folder"}
                    </button>
                  </Notice>
                ) : null}
              </div>
            ) : null}
            {homeView ? (
              <HomeWorkspacesView
                home={home}
                intro={introView}
                remembered={rememberedHome}
                busy={busy}
                progress={progress}
                onConnect={connectHome}
                onReconnect={async () => {
                  if (home) {
                    allWorkspaces();
                    return;
                  }
                  if (rememberedHome) await connectHome(false, rememberedHome);
                }}
                onCreate={addHomeWorkspace}
                onBring={() => addHomeWorkspace()}
                onOpen={openHomeEntry}
                onRefresh={refreshHome}
                onCancel={handleCancelOperation}
              />
            ) : workspace && (activeTab === "connect" || !vaultState || !vaultDir) ? (
              <WorkspaceProjectsView
                onAllWorkspaces={allWorkspaces}
                workspace={workspace}
                busy={busy}
                progress={progress}
                onRefresh={refreshWorkspace}
                onCreate={(name) => addManagedProject(name)}
                onImport={(source) => addManagedProject(source.name, source)}
                onOpenProject={openManaged}
                onCancel={handleCancelOperation}
              />
            ) : null}
            {vaultState && vaultDir ? (
              <div key={`${vaultState.project.projectId}:${projectSession}`}>
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
                      branchControl={
                        <ActiveBranchPicker
                          state={vaultState}
                          activeBranchId={activeBranchId}
                          busy={busy}
                          onSelect={handleSelectBranch}
                        />
                      }
                      vaultState={vaultState}
                      draftCache={draftCache.current}
                      draftKey={`${managedWorkspaceKey ?? workspace?.root.name ?? "external"}:${workspace?.identity.workspaceId ?? "external"}:${managedProject?.record.containerPath ?? vaultDir.name}:${vaultState.project.projectId}:${branch.branchId}`}
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
                <div hidden={activeTab !== "history"}>
                  <HistoryRecoveryView
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
                          (op) =>
                            !["captured", "recovered", "abandoned"].includes(
                              op.status,
                            ),
                        )
                          ? "Resolve the pending application for this branch before applying again."
                          : undefined),
                    }}
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
                    onPrepareWrite={
                      managedProject && workspace
                        ? async () => {
                            await perform(
                              "connect",
                              async (context) => {
                                const current = await resolveManagedProject(
                                  workspace.root,
                                  managedProject.record.containerPath,
                                );
                                if (context.current()) {
                                  setManagedProject(current);
                                  setWorkingFolders(current.workingFolders);
                                  setWorkingDir(
                                    current.workingFolders[activeBranchId] ??
                                      null,
                                  );
                                }
                                if (!current.ready || current.issues.length)
                                  throw new Error(
                                    `Managed project is read-only. ${current.issues.join(" ")}`,
                                  );
                              },
                              true,
                            );
                          }
                        : undefined
                    }
                    managedDestination={managedProject?.record.containerPath}
                    operationsBlockedReason={
                      managedBlockReason ??
                      (managedProject && missingConnections.length
                        ? "Reconnect workspace before creating branches or recovering copies."
                        : undefined)
                    }
                    onCreateBranch={handleCreateBranch}
                    isCreatingBranch={isCreatingBranch}
                    resolveWorkingFilePath={(branchId, path) =>
                      workingFileResolver(branchId, path)()
                    }
                    resolveRecoveredFilePath={
                      lastRestoreReport?.recoveredFiles &&
                      workspace &&
                      managedProject
                        ? async (path) => {
                            const location = await resolveRecoveredFilePath(
                              workspace.root,
                              workspace.identity.workspaceId,
                              managedProject.record.containerPath,
                              lastRestoreReport.recoveredFiles!
                                .relativeDirectory,
                              path,
                            );
                            return shortcutHome && homeEntry?.directory
                              ? resolveHomeFilePath(
                                  shortcutHome,
                                  homeEntry,
                                  location,
                                )
                              : location;
                          }
                        : undefined
                    }
                  />
                </div>
                <div hidden={activeTab !== "diagnostics"}>
                  <DiagnosticsView
                    caseControls={
                      <DesignCases
                        state={vaultState}
                        activeBranchId={activeBranchId}
                        busy={busy}
                        progress={progress}
                        onCancel={handleCancelOperation}
                        onChange={handleCaseLifecycle}
                      />
                    }
                    branchControl={
                      <ActiveBranchPicker
                        state={vaultState}
                        activeBranchId={activeBranchId}
                        busy={busy}
                        onSelect={handleSelectBranch}
                      />
                    }
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
                  />
                </div>
              </div>
            ) : null}
          </main>
          {pendingHome ? (
            <WindowsFolderAddressDialog
              key={pendingHome.requestId}
              home
              folderName={pendingHome.root.name}
              onSave={completeHomeSetup}
              onCancel={() => setPendingHome(null)}
              onBack={() => {
                const create = pendingHome.create;
                setPendingHome(null);
                void connectHome(create).catch((error) => {
                  setBannerScope("workspace");
                  setStatusBanner({ type: "error", message: String(error) });
                });
              }}
            />
          ) : null}
          {explorerOpen ? (
            <Modal
              title="Browse folders"
              busy={busy}
              onClose={() => setExplorerOpen(false)}
            >
              <div className="mobile-workspace-tree">
                <WorkspaceTree {...treeProps} />
              </div>
            </Modal>
          ) : null}
        </div>
      </div>
    </FilePathShortcutsProvider>
  );
}
