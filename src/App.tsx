import { isEffectivelyEmpty } from "./engine/scanner";
import { useEffect, useRef, useState } from "react";
import {
  type FileSystemDirectoryAdapter,
  RealFileSystemAdapter,
} from "./engine/fs-adapter";
import {
  rememberWorkspace,
  getRememberedWorkspace,
  type RememberedWorkspace,
  rememberHome,
  getRememberedHome,
  getWorkspacePath,
  type RememberedHome,
  bindWorkspacePathToRoot,
  setConvenienceAccountScope,
} from "./engine/idb-store";
import {
  type AccountUser,
  type AuthAdapter,
  isUserActivationError,
} from "./auth/firebase-auth";
import { AccountStatusControl } from "./components/AccountControls";
import {
  resolveWorkingFilePath,
  resolveWorkingFolderPath,
} from "./engine/path-shortcuts";
import { pathBudgetWarnSentence } from "./utils/path-budget-message";
import {
  rememberFolderAddress,
  type HomeAddress,
} from "./components/FolderAddressDialog";
import { FilePathShortcutsProvider } from "./components/FilePathShortcuts";
import { joinAddress } from "./engine/path-budget";
import { enableComponentTracking } from './engine/component-identity';
import { requestApplicationWriteAccess } from "./engine/application-service";
import { assertCaseWritable } from "./engine/case-lifecycle";
import { type WorkingFolderBindings } from "./engine/branch-state";
import {
  MAIN_BRANCH_ID,
  type ScanResult,
  type VaultState,
} from "./engine/types";
import { useViewHistory, type AppView, type ProjectView } from "./utils/view-history";
import { useSidebarWidth } from "./components/SidebarResize";
import { assertFolderAccess, pickDirectory } from "./utils/folder-access";
import { WorkspaceProjectsView } from "./components/WorkspaceProjectsView";
import { HomeWorkspacesView } from "./components/HomeWorkspacesView";
import type { WorkspaceTreeProps } from "./components/WorkspaceTree";
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
  type WorkspaceState,
  type ManagedProject,
  type WorkspaceProjectEntry,
} from "./engine/workspace-service";
import { AppDialogs } from "./app/AppDialogs";
import { AppNotices } from "./app/AppNotices";
import { refreshGuidesAfter, workspaceGuideTargets } from "./app/offline-guide-refresh";
import { NavigationRail } from "./app/NavigationRail";
import { ProjectViews } from "./app/ProjectViews";
import { useAuthSession } from "./app/useAuthSession";
import { useApplicationActions } from "./app/useApplicationActions";
import { useBranchActions } from "./app/useBranchActions";
import { useCaptureActions } from "./app/useCaptureActions";
import { useDiagnosticsActions } from "./app/useDiagnosticsActions";
import { useOperation } from "./app/useOperation";
import { useReferenceActions } from "./app/useReferenceActions";
import { useReviewActions } from "./app/useReviewActions";
import type {
  ActiveTab,
  Context,
  PendingAuthAction,
  PendingHome,
} from "./app/types";
import {
  PROJECT_NEEDS_ATTENTION,
  ProjectRenamedNotice,
  type OpenProjectLookup,
  locateProjectById,
  renamedNotice,
} from "./app/project-lookup";

export default function App({ auth }: { auth?: AuthAdapter } = {}) {
  const sidebar = useSidebarWidth();
  const [home, setHome] = useState<HomeState | null>(null);
  const [rememberedHome, setRememberedHome] = useState<RememberedHome | null>(
    null,
  );
  const [homeView, setHomeView] = useState(true);
  const [introView, setIntroView] = useState(false);
  const [pendingHome, setPendingHome] = useState<PendingHome | null>(null);
  const [homeAddress, setHomeAddress] = useState<HomeAddress | null>(null);
  const homeAddressCache = useRef<HomeAddress[]>([]);
  const cacheHomeAddress = (address: HomeAddress) => {
    // Lets the adapter (and its workspace/project children) explain a path-too-long failure with the real path.
    address.root.setAddress?.(address.path);
    homeAddressCache.current = [
      ...homeAddressCache.current.filter((item) => item.root !== address.root),
      address,
    ];
    setHomeAddress(address);
  };
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [learningOpen, setLearningOpen] = useState(false);
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
  const [projectSession, setProjectSession] = useState(0);
  // Set when the open project can't be re-found by its ID (gone, or copied so the ID is shared): read-only.
  const [projectUnavailable, setProjectUnavailable] = useState<string | null>(null);
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

  const resetActiveSessionUi = () => {
    contextVersion.current++;
    setLearningOpen(false);
    setManagedProject(null);
    setProjectUnavailable(null);
    setVaultState(null);
    setVaultDir(null);
    setWorkingFolders({});
    setWorkingDir(null);
    setScanResult(null);
    setActiveBranchId(MAIN_BRANCH_ID);
    setActiveTab("connect");
    setStatusBanner(null);
    setWorkspace(null);
    setHome(null);
    setHomeView(true);
    setIntroView(false);
    setManagedWorkspaceKey(null);
    setPendingHome(null);
    setExplorerOpen(false);
    homeAddressCache.current = [];
    setHomeAddress(null);
    draftCache.current.clear();
    branchContexts.current.clear();
    setRememberedWorkspace(null);
    setRememberedHome(null);
    setConvenienceEpoch((value) => value + 1);
  };

  // Called here so its auth subscription effect keeps its place among App's effects.
  const {
    authState,
    authStateRef,
    signInPrompt,
    setSignInPrompt,
    signOutPending,
    setSignOutPending,
    pendingSignOutRef,
    pendingAccountSnapshotRef,
    applyAuthSnapshot,
    executeSignOut,
    handleRequestSignOut,
    requestSignIn,
    handleContinueWithGoogle,
    handleSubmitEmailAuth,
    handleForgotPassword,
    handleContinuePickerAfterSignIn,
  } = useAuthSession({
    auth,
    resetActiveSessionUi,
    setRememberedWorkspace,
    setRememberedHome,
    // Declared below by useOperation and the home actions; read only after this render.
    getOperationRef: () => operationRef,
    setBannerScope: (scope) => setBannerScope(scope),
    setStatusBanner: (banner) => setStatusBanner(banner),
    completeAuthenticatedSignIn: (account, intendedAction) =>
      completeAuthenticatedSignIn(account, intendedAction),
    connectHomeInternal: (create, saved) => connectHomeInternal(create, saved),
  });

  useEffect(() => {
    const uid = authState.ready && authState.user ? authState.user.uid : null;
    setConvenienceAccountScope(uid);
    if (!uid) {
      setRememberedWorkspace(null);
      setRememberedHome(null);
      return;
    }
    let cancelled = false;
    void getRememberedWorkspace().then((value) => {
      if (!cancelled && authStateRef.current.user?.uid === uid) {
        setRememberedWorkspace(value);
      }
    });
    void getRememberedHome()
      .then((value) => {
        if (!cancelled && authStateRef.current.user?.uid === uid) {
          setRememberedHome(value);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [authState.ready, authState.user?.uid]);

  // Declared here so its unmount effect keeps its place among App's effects.
  const {
    bannerScope,
    setBannerScope,
    operation,
    progress,
    statusBanner,
    setStatusBanner,
    operationRef,
    contextVersion,
    perform,
    handleCancelOperation,
  } = useOperation({
    activeTab,
    pendingSignOutRef,
    pendingAccountSnapshotRef,
    setSignOutPending,
    executeSignOut,
    applyAuthSnapshot,
  });
  useEffect(() => {
    setIsScanStale(false);
    if (!scanResult) return;
    const timer = setTimeout(() => setIsScanStale(true), 5000);
    return () => clearTimeout(timer);
  }, [scanResult]);

  const pickFolder = async (mode: "read" | "readwrite") => new RealFileSystemAdapter(await pickDirectory(mode));
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
    project?: { path: string; id: string },
    branchId?: string,
    currentHome = home,
  ) => {
    if (!(current.root instanceof RealFileSystemAdapter)) return "";
    const value = {
      workspaceId: current.identity.workspaceId,
      name: current.identity.name,
      rootHandle: current.root.handle,
      // The path is informational; the project is recognised by its ID.
      projectPath: project?.path,
      projectId: project?.id,
      activeBranchId: branchId,
    };
    setRememberedWorkspace(value);
    if (project && branchId)
      branchContexts.current.set(
        `${current.identity.workspaceId}:${project.id}`,
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
          projectPath: project?.path,
          projectId: project?.id,
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
    setLearningOpen(false);
    setManagedProject(null);
    setProjectUnavailable(null);
    setVaultState(null);
    setVaultDir(null);
    setWorkingFolders({});
    setWorkingDir(null);
    setScanResult(null);
    setActiveBranchId(MAIN_BRANCH_ID);
    setActiveTab("connect");
    setStatusBanner(null);
  };
  const allWorkspaces = () => {
    if (operationRef.current) return;
    if (!authStateRef.current.user) {
      requestSignIn({ kind: "my-workspaces" });
      return;
    }
    setStatusBanner(null);
    setHomeView(true);
    setIntroView(false);
    setLearningOpen(false);
    setExplorerOpen(false);
  };
  const installHome = async (
    next: HomeState,
    root: RealFileSystemAdapter,
    path: string,
    saved?: RememberedHome,
    warning = "",
  ) => {
    // A home was created or opened: give it its Readme and Index (skipped when it is read-only).
    refreshGuidesAfter({ homeRoot: root });
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
      projectId: saved?.projectId,
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
  const connectHomeInternal = async (
    create: boolean,
    saved?: RememberedHome,
    options?: { pauseOnGestureError?: boolean },
  ) => {
    let gestureBlocked = false;
    await perform(
      "connect",
      async (context) => {
        assertFolderAccess();
        // Start the picker in the user action; perform owns connection errors.
        let root: RealFileSystemAdapter;
        if (saved) {
          root = new RealFileSystemAdapter(saved.rootHandle);
        } else {
          try {
            root = await pickFolder("readwrite");
          } catch (error: unknown) {
            if (options?.pauseOnGestureError && isUserActivationError(error)) {
              gestureBlocked = true;
              return;
            }
            if (error instanceof DOMException && error.name === "AbortError")
              throw new Error(
                create
                  ? "Folder selection was cancelled. Choose an empty dedicated folder, suggested name Cadtree, to create your Cadtree home."
                  : "Folder selection was cancelled. Choose your existing Cadtree home folder to continue.",
              );
            throw error;
          }
        }
        if ((await root.requestPermission("readwrite")) !== "granted")
          throw new Error("Read/write folder access was denied. Allow local folder access in your browser site settings, then reconnect your Cadtree home.");
        if (create) {
          if (!isEffectivelyEmpty(await root.listEntries()))
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
            path = await getWorkspacePath(
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
    if (gestureBlocked) {
      setSignInPrompt({
        step: "continue-picker",
        action: { kind: "connect-home", create, saved },
        signingIn: false,
        error: null,
      });
    }
  };
  const connectHome = async (create: boolean, saved?: RememberedHome) => {
    if (!authStateRef.current.user) {
      requestSignIn({ kind: "connect-home", create, saved });
      return;
    }
    await connectHomeInternal(create, saved);
  };
  const completeAuthenticatedSignIn = async (
    account: AccountUser,
    intendedAction: PendingAuthAction,
  ) => {
    applyAuthSnapshot({ ready: true, user: account });
    const [remWorkspace, remHome] = await Promise.all([
      getRememberedWorkspace(),
      getRememberedHome().catch(() => null),
    ]);
    if (authStateRef.current.user?.uid === account.uid) {
      setRememberedWorkspace(remWorkspace);
      setRememberedHome(remHome);
    }
    setSignInPrompt(null);
    if (intendedAction.kind === "connect-home") {
      await connectHomeInternal(
        intendedAction.create,
        intendedAction.saved,
        { pauseOnGestureError: true },
      );
    } else if (intendedAction.kind === "my-workspaces") {
      leaveProject();
      setWorkspace(null);
      setHomeView(true);
      setIntroView(false);
      setManagedWorkspaceKey(null);
    } else if (intendedAction.kind === "callback") {
      await intendedAction.run();
    }
  };
  const completeHomeSetup = async (path: string) => {
    if (!authStateRef.current.ready || !authStateRef.current.user) {
      requestSignIn({
        kind: "callback",
        run: () => completeHomeSetup(path),
      });
      return;
    }
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
        const warning = await rememberFolderAddress(
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
    if (!authStateRef.current.ready || !authStateRef.current.user) {
      requestSignIn({
        kind: "callback",
        run: () => openHomeEntry(entry),
      });
      return;
    }
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
    if (!authStateRef.current.ready || !authStateRef.current.user) {
      requestSignIn({
        kind: "callback",
        run: () => addHomeWorkspace(name),
      });
      return;
    }
    if (!home) throw new Error("Choose a Cadtree home first.");
    // Only await when the prompt is needed: the folder picker below must still start inside the click.
    if (!budgetHomeAddress()) await ensureHomeAddress("home");
    await perform(
      "connect",
      async (context) => {
        try {
          // The picker is part of this operation: keep account changes deferred
          // until the import has finished using the initiating account's scope.
          const source = name === undefined ? await pickFolder("read") : undefined;
          if (source && (await source.requestPermission("read")) !== "granted")
            throw new Error(
              "Grant access to inspect and copy the existing workspace.",
            );
          const result = source
            ? await bringWorkspaceIntoHome(home.root, source, {
                expectedHomeId: home.identity.homeId,
                signal: context.signal,
                onProgress: context.progress,
                budget: { homeAddress: budgetHomeAddress() },
              })
            : await createHomeWorkspace(home.root, name!, {
                expectedHomeId: home.identity.homeId,
                signal: context.signal,
                onProgress: context.progress,
                budget: { homeAddress: budgetHomeAddress() },
              });
          // The workspace is published: update the home's Index. A copied workspace carries its old Maps, so
          // rewrite those too (the engine skips projects that are not writable).
          refreshGuidesAfter({
            homeRoot: home.root,
            projects: source ? workspaceGuideTargets(result.workspace) : undefined,
          });
          const next = await openHome(home.root);
          if (!context.current()) return;
          if (source instanceof RealFileSystemAdapter) {
            // Keep the retained original's optional absolute path tied to that root,
            // including if its copied descendant is later opened through compatibility mode.
            try {
              await bindWorkspacePathToRoot(
                result.workspace.identity.workspaceId,
                source.handle,
              );
            } catch {
              /* Convenience storage does not control publication. */
            }
          }
          // My workspaces keeps the last project in memory; a new workspace must not open it.
          leaveProject();
          setHome(next);
          setWorkspace(result.workspace);
          setHomeView(false);
          setManagedWorkspaceKey(
            next.workspaces.find((e) => e.directory === result.directory)!.key,
          );
          setStatusBanner({
            type: "success",
            message: `${source ? "Verified copy ready. Continue working in" : "Created workspace at"} ${home.root.name}/${result.directory}/. ${source ? "Original workspace retained unchanged; continue editing only in this managed copy." : ""} ${pathBudgetWarnSentence(result.pathBudget)}`.trim(),
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
  // Re-find the open project by its ID (a rename in Explorer or Finder changes only its location).
  // A rename is rebound in memory; none, several or duplicate copies make the project read-only. Never writes.
  const refindOpenProject = async (
    context: Context,
    prescanned?: WorkspaceState,
  ): Promise<OpenProjectLookup | null> => {
    if (!managedProject || !workspace) return null;
    const current = prescanned ?? (await openWorkspace(workspace.root));
    const found = locateProjectById(
      current,
      managedProject.record.projectId,
      managedProject.record.containerPath,
    );
    if (!context.current()) return found;
    setWorkspace(current);
    if (found.kind === "unavailable") {
      setProjectUnavailable(found.reason);
      return found;
    }
    setProjectUnavailable(null);
    if (found.renamed) {
      const project = found.project;
      setManagedProject(project);
      setVaultDir(project.vaultDir);
      setVaultState(project.vaultState);
      setWorkingFolders(project.workingFolders);
      setWorkingDir(project.workingFolders[activeBranchId] ?? null);
      setScanResult(null);
      void persistWorkspace(
        current,
        { path: project.record.containerPath, id: project.record.projectId },
        activeBranchId,
      );
    }
    return found;
  };
  // Run before every write: a project that was renamed, removed or duplicated while open must not be written to.
  // A rename is rebound, then the operation stops so nothing lands in a location the user didn't see.
  // This is a check before the write, not a lock: it can't stop a rename or copy made in Finder or Explorer
  // during the write itself. The stale browser handle failing is the backstop for that.
  const assertProjectWritable = async (
    context: Context,
    readOnlyOperation = false,
  ): Promise<ManagedProject | null> => {
    const found = await refindOpenProject(context);
    if (!found) return null;
    if (found.kind === "unavailable") throw new Error(found.reason);
    if (found.renamed)
      throw new ProjectRenamedNotice(
        readOnlyOperation
          ? renamedNotice(found.project)
          : `${renamedNotice(found.project)} Nothing was written. Try again to continue at the new location.`,
      );
    return found.project;
  };
  const refreshWorkspace = async () => {
    if (!workspace) return;
    await perform("connect", async (context) => {
      if ((await workspace.root.requestPermission("readwrite")) !== "granted")
        throw new Error("Reconnect the workspace to renew its permission.");
      const current = await openWorkspace(workspace.root);
      if (context.current()) setWorkspace(current);
      if (managedProject) {
        const found = await refindOpenProject(context, current);
        if (found?.kind === "ok" && context.current()) {
          setManagedProject(found.project);
          setVaultState(found.project.vaultState);
          setWorkingFolders(found.project.workingFolders);
          setWorkingDir(found.project.workingFolders[activeBranchId] ?? null);
          setScanResult(null);
          if (found.renamed)
            setStatusBanner({ type: "info", message: renamedNotice(found.project) });
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
        `${current.identity.workspaceId}:${project.record.projectId}`,
      ) ??
      (rememberedWorkspace?.workspaceId === current.identity.workspaceId &&
      rememberedWorkspace.projectId === project.record.projectId
        ? rememberedWorkspace.activeBranchId
        : rememberedHome?.workspaceId === current.identity.workspaceId &&
            rememberedHome.projectId === project.record.projectId
          ? rememberedHome.activeBranchId
          : MAIN_BRANCH_ID);
    const branchId = project.vaultState.branches.some(
      (branch) => branch.branchId === preferred,
    )
      ? preferred!
      : MAIN_BRANCH_ID;
    // Switching case inside the open project keeps the page the user is on; opening a project starts at its default.
    const keepTab =
      projectView &&
      managedProject?.record.projectId === project.record.projectId &&
      workspace?.identity.workspaceId === current.identity.workspaceId;
    setManagedProject(project);
    setProjectUnavailable(null);
    setBannerScope("project");
    await installProject(
      project.vaultState,
      project.vaultDir,
      project.workingFolders,
      branchId,
      keepTab,
    );
    const warning = await persistWorkspace(
      current,
      { path: project.record.containerPath, id: project.record.projectId },
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
    if (!authStateRef.current.ready || !authStateRef.current.user) {
      requestSignIn({
        kind: "callback",
        run: () => openManaged(entry),
      });
      return;
    }
    if (!workspace) return;
    await perform(
      "connect",
      async (context) => {
        const current = await openWorkspace(workspace.root);
        if (context.current()) setWorkspace(current);
        // Copies that share a project identity are read-only and never opened (same rule as the tree).
        const fresh = current.projects.find(
          (project) => project.containerPath === entry.containerPath,
        );
        if (
          !fresh?.project ||
          fresh.status === "duplicate" ||
          fresh.projectId !== entry.projectId
        )
          throw new Error(PROJECT_NEEDS_ATTENTION);
        await activateManaged(
          current,
          await resolveManagedProject(workspace.root, fresh.containerPath),
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
    if (!authStateRef.current.ready || !authStateRef.current.user) {
      requestSignIn({
        kind: "callback",
        run: () => openTreeProject(homeWorkspace, entry, branchId),
      });
      return;
    }
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
          throw new Error(PROJECT_NEEDS_ATTENTION);
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
  // Absolute addresses for the engine's path budget check. Unknown (undefined) means "unchecked".
  // Read the cache ref (not render state) so an address saved a moment ago by the prompt below is seen.
  const cachedHomeAddress = (): HomeAddress | undefined =>
    home
      ? [...homeAddressCache.current].reverse().find((a) => a.homeId === home.identity.homeId)
      : undefined;
  const budgetHomeAddress = (): string | undefined => cachedHomeAddress()?.path || undefined;
  const budgetWorkspaceAddress = async (): Promise<string | undefined> => {
    const base = budgetHomeAddress();
    const address = cachedHomeAddress();
    if (!base || !home || !workspace || !address) return undefined;
    const relative = await address.root.resolveRelativePath(workspace.root);
    return relative && relative.length === 1 ? joinAddress(base, relative[0]) : undefined;
  };
  // Live addresses for the name hints in the create dialogs (nothing is written; undefined = unknown).
  const [workspaceBudgetAddress, setWorkspaceBudgetAddress] = useState<string | undefined>();
  useEffect(() => {
    let cancelled = false;
    budgetWorkspaceAddress().then(
      (address) => { if (!cancelled) setWorkspaceBudgetAddress(address); },
      () => { if (!cancelled) setWorkspaceBudgetAddress(undefined); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home, homeAddress, workspace]);
  // Required prompt: a home with no saved address is asked once before the next create/import.
  const [addressPrompt, setAddressPrompt] = useState<{ resolve: (saved: boolean) => void } | null>(null);
  const addressPromptRef = useRef<{ resolve: (saved: boolean) => void } | null>(null);
  const settleAddressPrompt = (saved: boolean) => {
    const pending = addressPromptRef.current;
    addressPromptRef.current = null;
    setAddressPrompt(null);
    pending?.resolve(saved);
  };
  // Home changed, signed out or unmounted: a pending prompt is cancelled and nothing is written.
  const settlePromptRef = useRef(settleAddressPrompt);
  settlePromptRef.current = settleAddressPrompt;
  useEffect(() => {
    settlePromptRef.current(false);
  }, [home?.identity.homeId]);
  useEffect(() => () => settlePromptRef.current(false), []);
  const ensureHomeAddress = async (scope: "home" | "workspace") => {
    if (!home || budgetHomeAddress()) return;
    // A workspace that is not directly under the home cannot be measured, so it never prompts.
    if (scope === "workspace") {
      if (!workspace) return;
      const relative = await home.root.resolveRelativePath(workspace.root);
      if (!relative || relative.length !== 1) return;
    }
    // A newer prompt replaces an older one: settle the old one as cancelled so nothing hangs.
    settleAddressPrompt(false);
    const saved = await new Promise<boolean>((resolve) => {
      const entry = { resolve };
      addressPromptRef.current = entry;
      setAddressPrompt(entry);
    });
    if (!saved)
      throw new Error("Nothing was created. cAdtree needs your Cadtree home address to keep paths within Windows' limit.");
  };
  const saveHomeAddressFromPrompt = async (path: string) => {
    if (!home || !addressPrompt) return;
    const warning = await rememberFolderAddress(
      home.identity.homeId,
      path,
      home.root instanceof RealFileSystemAdapter ? home.root.handle : undefined,
    );
    cacheHomeAddress({ homeId: home.identity.homeId, root: home.root, path });
    if (warning) {
      setBannerScope("workspace");
      setStatusBanner({ type: "info", message: warning });
    }
    settleAddressPrompt(true);
  };
  const addManagedProject = async (
    name: string,
    source?: FileSystemDirectoryAdapter,
  ) => {
    if (!authStateRef.current.ready || !authStateRef.current.user) {
      requestSignIn({
        kind: "callback",
        run: () => addManagedProject(name, source),
      });
      return;
    }
    if (!workspace) throw new Error("Choose a workspace first.");
    await ensureHomeAddress("workspace");
    await perform(
      "connect",
      async (context) => {
        const options = {
          signal: context.signal,
          onProgress: context.progress,
          budget: { workspaceAddress: await budgetWorkspaceAddress() },
        };
        const project = source
          ? await importProject(workspace.root, source, name, options)
          : await createProject(workspace.root, name, options);
        // Created, imported or adopted: write the project's Map and update the home's Index.
        refreshGuidesAfter({
          project: { workspaceRoot: workspace.root, containerPath: project.record.containerPath },
          homeRoot: home?.root,
        });
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
          (source
            ? `Continue working in this copy: ${current.root.name}/${project.workingPaths[MAIN_BRANCH_ID]}. Original "${source.name}" was retained and is not tracked by this managed project. Open the new copy manually in SolidWorks and check its references. Capture the initial revision explicitly.`
            : `Created project "${project.record.name}". Save your CAD files in ${current.root.name}/${project.workingPaths[MAIN_BRANCH_ID]}/, then scan and save your first revision.`) + (pathBudgetWarnSentence(project.pathBudget) ? ` ${pathBudgetWarnSentence(project.pathBudget)}` : ""),
        );
      },
      true,
    );
  };
  const { scan, handleScanCurrent, handleCaptureRevision } = useCaptureActions({
    vaultDir,
    workingDir,
    workingFolders,
    activeBranchId,
    managedProject,
    workspace,
    authStateRef,
    perform,
    assertProjectWritable,
    refindOpenProject,
    applyVaultState,
    setVaultState,
    setManagedProject,
    setWorkingFolders,
    setWorkingDir,
    setScanResult,
    setStatusBanner,
  });
  // Install a project only after all explicit connections have passed identity checks.
  const installProject = async (
    state: VaultState,
    vault: FileSystemDirectoryAdapter,
    folders: WorkingFolderBindings,
    branchId: string,
    keepTab = false,
  ) => {
    setProjectSession((previous) => previous + 1);
    setVaultDir(vault);
    setVaultState(state);
    setWorkingFolders(folders);
    setActiveBranchId(branchId);
    setWorkingDir(folders[branchId] ?? null);
    setScanResult(null);
    if (!keepTab) setActiveTab(state.revisions.length ? "history" : "changes");
  };
  const {
    applicationOptions,
    handlePrepareApplication,
    handleRefreshApplicationReview,
    handleApplyApplication,
    handleRecoverApplication,
    handleAbandonApplication,
  } = useApplicationActions({
    vaultDir,
    vaultState,
    workingDir,
    workingFolders,
    activeBranchId,
    managedProject,
    workspace,
    perform,
    assertProjectWritable,
    applyVaultState,
    setScanResult,
    setStatusBanner,
  });
  const {
    handleSelectBranch,
    handleCaseLifecycle,
    handleReattachWorkingFolder,
    handleCreateBranch,
  } = useBranchActions({
    vaultDir,
    vaultState,
    workingFolders,
    activeBranchId,
    managedProject,
    workspace,
    operationRef,
    contextVersion,
    perform,
    assertProjectWritable,
    scan,
    applicationOptions,
    applyVaultState,
    persistWorkspace,
    refreshWorkspace,
    ensureHomeAddress,
    budgetWorkspaceAddress,
    setVaultState,
    setManagedProject,
    setWorkingFolders,
    setWorkingDir,
    setActiveBranchId,
    setScanResult,
    setStatusBanner,
  });
  const { handleAddReferences, handleStopApplyingReference } = useReferenceActions({
    vaultDir,
    vaultState,
    managedProject,
    workspace,
    authStateRef,
    perform,
    assertProjectWritable,
    setVaultState,
    setStatusBanner,
  });
  const { handleExportForReview, handleRetrieveReference } = useReviewActions({
    vaultDir,
    vaultState,
    workingFolders,
    managedProject,
    workspace,
    perform,
    assertProjectWritable,
  });
  const {
    handleVerifySingleRevisionObjects,
    handleVerifyAllObjects,
    handleSimulateClearMetadataAndReopenVault,
  } = useDiagnosticsActions({
    vaultDir,
    vaultState,
    activeBranchId,
    managedProject,
    workspace,
    homeAddressCache,
    perform,
    setHomeAddress,
    setConvenienceEpoch,
    setRememberedWorkspace,
    setRememberedHome,
    setWorkspace,
    setProjectUnavailable,
    setManagedProject,
    setVaultState,
    setWorkingFolders,
    setWorkingDir,
    setScanResult,
    setActiveTab,
    setStatusBanner,
  });
  const busy = operation !== null || signOutPending;
  const isScanning = operation === "scan";
  const isCapturing = operation === "capture";
  const isVerifyingAll = operation === "verify";
  const isCreatingBranch = operation === "branch";
  const navigate = (tab: ActiveTab) => {
    if (!operationRef.current) {
      // A status banner belongs to the page where it was raised: it does not follow the user to another one.
      if (tab !== activeTab) setStatusBanner(null);
      setActiveTab(tab);
    }
  };
  const missingConnections =
    vaultState?.branches
      .filter((b) => !workingFolders[b.branchId])
      .map((b) => b.name) ?? [];
  const managedBlockReason = managedProject && projectUnavailable
    ? `Managed project is read-only. ${projectUnavailable}`
    : managedProject && (!managedProject.ready || managedProject.issues.length)
      ? `Managed project is read-only. ${managedProject.issues.join(" ")}`
      : undefined;
  const projectView =
    !homeView && activeTab !== "connect" && Boolean(vaultState && vaultDir);
  const view: AppView = homeView
    ? introView || !home ? { view: "intro" } : { view: "workspaces", homeId: home.identity.homeId }
    : workspace ? {
        homeId: home?.identity.homeId,
        workspaceId: workspace.identity.workspaceId,
        workspaceKey: managedWorkspaceKey,
        ...(projectView && managedProject && vaultState
          ? { view: "project", projectId: vaultState.project.projectId, tab: activeTab as ProjectView }
          : { view: "workspace" }),
      } : { view: "intro" };
  useViewHistory({
    view,
    scope: authState.user?.uid ?? "signed-out",
    ready: authState.ready,
    busy,
    onVisit: async (target) => {
      if (operationRef.current || pendingSignOutRef.current) return false;
      const uid = authStateRef.current.user?.uid;
      // Back/Forward leaves the page too: its banner stays behind. A visit that cannot move keeps it.
      setLearningOpen(false);
      setExplorerOpen(false);
      if (target.view === "intro") {
        setStatusBanner(null);
        setHomeView(true);
        setIntroView(true);
        return true;
      }
      if (!uid || target.homeId !== home?.identity.homeId) return false;
      if (target.view === "workspaces") { allWorkspaces(); return true; }
      const sameWorkspace = target.workspaceId === workspace?.identity.workspaceId && target.workspaceKey === managedWorkspaceKey;
      if (target.view === "workspace" && sameWorkspace) {
        setStatusBanner(null);
        setHomeView(false);
        setActiveTab("connect");
        return true;
      }
      if (target.view === "project" && sameWorkspace && target.projectId === managedProject?.record.projectId && vaultState) {
        setStatusBanner(null);
        setHomeView(false);
        setActiveTab(target.tab);
        return true;
      }
      const entry = home?.workspaces.find(e => e.key === target.workspaceKey && e.workspaceId === target.workspaceId);
      if (target.view === "workspace") {
        if (!entry?.workspace) return false;
        setStatusBanner(null);
        await openHomeEntry(entry);
      } else {
        const available = entry?.workspace ?? (sameWorkspace ? workspace : null);
        // Identity is the project ID alone. The folder may have been renamed since this entry was recorded.
        const matches = available?.projects.filter(p => p.projectId === target.projectId) ?? [];
        const project = matches.length === 1 ? matches[0] : undefined;
        if (!project?.project || project.status === "duplicate") return false;
        setStatusBanner(null);
        // Reopen other project locations through existing permission and identity validation.
        await openTreeProject(entry, project);
        if (authStateRef.current.user?.uid !== uid) return false;
        setActiveTab(target.tab);
      }
      return authStateRef.current.user?.uid === uid;
    },
  });
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
        "Full local file paths are unavailable for external projects. Bring this project into a workspace to enable path shortcuts.",
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
  const workingFolderResolver = (branchId: string) => async () => {
    if (!workspace || !managedProject)
      throw new Error(
        "Full local folder paths are unavailable for external projects. Bring this project into a workspace to enable path shortcuts.",
      );
    const location = await resolveWorkingFolderPath(
      workspace.root,
      workspace.identity.workspaceId,
      managedProject.record.containerPath,
      branchId,
    );
    return shortcutHome && homeEntry?.directory
      ? resolveHomeFilePath(shortcutHome, homeEntry, location)
      : location;
  };
  const treeProps: WorkspaceTreeProps = {
    home,
    workspace: homeView ? null : workspace,
    managedWorkspaceKey: homeView ? null : managedWorkspaceKey,
    projectId: managedProject?.record.projectId,
    activeVault: vaultState,
    activeBranchId,
    projectView,
    busy,
    onWorkspace: async (entry) => {
      if (entry && entry.key !== managedWorkspaceKey)
        await openHomeEntry(entry);
      else { setHomeView(false); navigate("connect"); }
      setExplorerOpen(false);
    },
    onProject: async (entry, project, branch) => {
      // A case of the project that is already open is switched in place, on the same page.
      if (
        branch &&
        projectView &&
        project.projectId !== undefined &&
        project.projectId === managedProject?.record.projectId &&
        (entry?.key ?? null) === managedWorkspaceKey
      )
        await handleSelectBranch(branch);
      else await openTreeProject(entry, project, branch);
      setExplorerOpen(false);
    },
  };

  // Built here, not in ProjectViews, because they use App's operation and project setters.
  const handleEnableComponentTracking = async () => {
    if (!vaultDir || !workingDir) return;
    await perform('capture', async (context) => {
      await assertProjectWritable(context);
      await requestApplicationWriteAccess(vaultDir, workingDir);
      const updated = await enableComponentTracking(vaultDir);
      if (context.current()) {
        setVaultState(updated);
        setScanResult(null);
      }
    }, true);
  };
  const handlePrepareWrite =
    managedProject && workspace
      ? async () => {
          await perform(
            "connect",
            async (context) => {
              await assertProjectWritable(context);
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
      : undefined;

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
        <NavigationRail
          sidebar={sidebar}
          home={home}
          workspace={workspace}
          homeView={homeView}
          introView={introView}
          busy={busy}
          activeTab={activeTab}
          vaultState={vaultState}
          scanResult={scanResult}
          treeProps={treeProps}
          navigate={navigate}
          onWordmarkClick={() => {
            if (operationRef.current) return;
            setStatusBanner(null);
            if (!authStateRef.current.user) {
              setHomeView(true);
              setIntroView(true);
              return;
            }
            setHomeView(true);
            setIntroView(true);
            setLearningOpen(false);
          }}
          onAllWorkspaces={allWorkspaces}
          onBrowseFolders={() => setExplorerOpen(true)}
          onLearn={() => setLearningOpen(true)}
        />
        <div className="workspace-shell">
          <div className="shell-top-bar">
            <AccountStatusControl
              ready={authState.ready}
              user={authState.user}
              busy={busy}
              signOutPending={signOutPending}
              onSignIn={() => requestSignIn({ kind: "my-workspaces" })}
              onSignOut={handleRequestSignOut}
            />
            <span className="local-indicator compact-local-indicator">
              <i />
              Local workspace
            </span>
          </div>
          <main id="main-content" aria-busy={busy}>
            <AppNotices
              progress={progress}
              isVerifyingAll={isVerifyingAll}
              isScanning={isScanning}
              activeTab={activeTab}
              statusBanner={statusBanner}
              setStatusBanner={setStatusBanner}
              bannerScope={bannerScope}
              projectView={projectView}
              busy={busy}
              vaultState={vaultState}
              managedProject={managedProject}
              managedBlockReason={managedBlockReason}
              missingConnections={missingConnections}
              navigate={navigate}
              onCancelOperation={handleCancelOperation}
              onReattachWorkingFolder={handleReattachWorkingFolder}
            />
            {homeView ? (
              <HomeWorkspacesView
                home={authState.ready && authState.user ? home : null}
                homeAddress={budgetHomeAddress()}
                intro={introView}
                remembered={
                  authState.ready && authState.user ? rememberedHome : null
                }
                busy={busy}
                progress={progress}
                onConnect={connectHome}
                onReconnect={async () => {
                  if (!authStateRef.current.user) {
                    requestSignIn({
                      kind: "connect-home",
                      create: false,
                      saved: rememberedHome ?? undefined,
                    });
                    return;
                  }
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
                workspaceAddress={workspaceBudgetAddress}
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
              <div hidden={!projectView} key={`${vaultState.project.projectId}:${projectSession}`}>
                <ProjectViews
                  vaultState={vaultState}
                  vaultDir={vaultDir}
                  workingDir={workingDir}
                  activeBranchId={activeBranchId}
                  activeTab={activeTab}
                  managedProject={managedProject}
                  workspace={workspace}
                  managedWorkspaceKey={managedWorkspaceKey}
                  workspaceBudgetAddress={workspaceBudgetAddress}
                  draftCache={draftCache.current}
                  scanResult={scanResult}
                  isScanStale={isScanStale}
                  isScanning={isScanning}
                  isCapturing={isCapturing}
                  isVerifyingAll={isVerifyingAll}
                  isCreatingBranch={isCreatingBranch}
                  busy={busy}
                  operation={operation}
                  progress={progress}
                  managedBlockReason={managedBlockReason}
                  missingConnections={missingConnections}
                  navigate={navigate}
                  workingFileResolver={workingFileResolver}
                  workingFolderResolver={workingFolderResolver}
                  handleCancelOperation={handleCancelOperation}
                  handleCaseLifecycle={handleCaseLifecycle}
                  handleReattachWorkingFolder={handleReattachWorkingFolder}
                  handleCreateBranch={handleCreateBranch}
                  handleScanCurrent={handleScanCurrent}
                  handleCaptureRevision={handleCaptureRevision}
                  handlePrepareApplication={handlePrepareApplication}
                  handleRefreshApplicationReview={handleRefreshApplicationReview}
                  handleApplyApplication={handleApplyApplication}
                  handleRecoverApplication={handleRecoverApplication}
                  handleAbandonApplication={handleAbandonApplication}
                  handleExportForReview={handleExportForReview}
                  handleRetrieveReference={handleRetrieveReference}
                  handleAddReferences={handleAddReferences}
                  handleStopApplyingReference={handleStopApplyingReference}
                  handleVerifySingleRevisionObjects={handleVerifySingleRevisionObjects}
                  handleVerifyAllObjects={handleVerifyAllObjects}
                  handleSimulateClearMetadataAndReopenVault={handleSimulateClearMetadataAndReopenVault}
                  onEnableComponentTracking={handleEnableComponentTracking}
                  onPrepareWrite={handlePrepareWrite}
                />
              </div>
            ) : null}
          </main>
          <AppDialogs
            busy={busy}
            home={home}
            homeView={homeView}
            vaultState={vaultState}
            treeProps={treeProps}
            pendingHome={pendingHome}
            setPendingHome={setPendingHome}
            connectHome={connectHome}
            setBannerScope={setBannerScope}
            setStatusBanner={setStatusBanner}
            onCompleteHomeSetup={completeHomeSetup}
            addressPrompt={addressPrompt}
            settleAddressPrompt={settleAddressPrompt}
            onSaveHomeAddressFromPrompt={saveHomeAddressFromPrompt}
            learningOpen={learningOpen}
            setLearningOpen={setLearningOpen}
            explorerOpen={explorerOpen}
            setExplorerOpen={setExplorerOpen}
            signInPrompt={signInPrompt}
            setSignInPrompt={setSignInPrompt}
            handleContinueWithGoogle={handleContinueWithGoogle}
            handleSubmitEmailAuth={handleSubmitEmailAuth}
            handleForgotPassword={handleForgotPassword}
            onContinuePickerAfterSignIn={handleContinuePickerAfterSignIn}
          />
        </div>
      </div>
    </FilePathShortcutsProvider>
  );
}
