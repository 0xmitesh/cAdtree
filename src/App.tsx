import { isEffectivelyEmpty } from "./engine/scanner";
import { useEffect, useRef, useState } from "react";
import {
  type FileSystemDirectoryAdapter,
  RealFileSystemAdapter,
} from "./engine/fs-adapter";
import {
  clearAllConvenienceMetadata,
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
  type AuthSnapshot,
  isSignInCancelled,
  isUserActivationError,
  resolveAuthAdapter,
} from "./auth/firebase-auth";
import {
  AccountSignInModal,
  AccountStatusControl,
} from "./components/AccountControls";
import {
  resolveWorkingFilePath,
} from "./engine/path-shortcuts";
import { presentPathBudgetError, pathBudgetWarnSentence } from "./utils/path-budget-message";
import {
  FolderAddressDialog,
  rememberFolderAddress,
  type HomeAddress,
} from "./components/FolderAddressDialog";
import { FilePathShortcutsProvider } from "./components/FilePathShortcuts";
import { exportRevisionForReview } from './engine/review-export';
import type { ExportReviewAction } from './components/ReviewExportDialog';
import { joinAddress } from "./engine/path-budget";
import { captureRevision, ReviewStaleError } from "./engine/revision-service";
import { componentWriteBlock, enableComponentTracking, type IdentityReview } from './engine/component-identity';
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
  type ScanResult,
  type VaultState,
} from "./engine/types";
import {
  formatRevisionNumber,
  openExistingVault,
  verifyRevisionObjects,
} from "./engine/vault-service";
import { ChangesCaptureView } from "./components/ChangesCaptureView";
import { ReferencesView } from './components/ReferencesView';
import { retrieveReferenceAttachment, referenceWriteBlock, type ReferenceReview } from './engine/references';
import { HistoryRecoveryView } from "./components/HistoryRecoveryView";
import { ProjectContextHeader } from "./components/ProjectContextHeader";
import { ProjectLearningModal } from "./components/ProjectLearningModal";
import { useViewHistory, type AppView, type ProjectView } from "./utils/view-history";
import {
  SidebarResizeHandle,
  useSidebarWidth,
} from "./components/SidebarResize";
import { DiagnosticsView } from "./components/DiagnosticsView";
import type { CreateBranchParams } from "./components/CreateBranchDialog";
import {
  FolderOpen,
  BookOpen,
  History,
  Settings,
  ScanLine,
  HardDrive,
  GraduationCap,
} from "lucide-react";
import {
  IntegrityNotice,
  Notice,
  MessageLines,
  OperationProgress,
  Modal,
} from "./components/ui";
import { assertFolderAccess, pickDirectory, folderPermissionError } from "./utils/folder-access";
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
  DUPLICATE_PROJECT_REASON,
  type WorkspaceState,
  type ManagedProject,
  type WorkspaceProjectEntry,
} from "./engine/workspace-service";

type ActiveTab = "connect" | "changes" | "history" | "references" | "diagnostics";
type Operation =
  "scan" | "capture" | "verify" | "branch" | "connect" | "apply" | "export" | "references";
type Context = {
  version: number;
  signal: AbortSignal;
  current: () => boolean;
  progress: (p: ProgressUpdate) => void;
};

type PendingAuthAction =
  | { kind: "connect-home"; create: boolean; saved?: RememberedHome }
  | { kind: "my-workspaces" }
  | { kind: "callback"; run: () => Promise<void> | void };

const PROJECT_NEEDS_ATTENTION =
  "This project location needs attention. Open the workspace to inspect it.";
const PROJECT_NOT_FOUND =
  "This project's folder can't be found in the workspace any more.";
/** Info-level stop: the open project was re-found at a new folder and nothing was written. */
class ProjectRenamedNotice extends Error {}
const renamedNotice = (project: ManagedProject) =>
  `This project's folder was renamed to '${project.record.containerPath.split("/").pop()}'. cAdtree found it by its project ID.`;
type OpenProjectLookup =
  | { kind: "ok"; workspace: WorkspaceState; project: ManagedProject; renamed: boolean }
  | { kind: "unavailable"; workspace: WorkspaceState; reason: string };
/**
 * Identity is the project ID alone: never the folder name or a stored path. This checks identity only;
 * a damaged or incomplete entry that is still found stays blocked by the project's own issues (managedBlockReason).
 */
const locateProjectById = (
  current: WorkspaceState,
  projectId: string,
  storedPath: string,
): OpenProjectLookup => {
  const matches = current.projects.filter((entry) => entry.projectId === projectId);
  if (matches.length > 1 || matches[0]?.status === "duplicate")
    return { kind: "unavailable", workspace: current, reason: DUPLICATE_PROJECT_REASON };
  const entry = matches[0];
  if (!entry?.project) {
    // A damaged or incomplete folder at the stored location is not "gone": it needs a look.
    const stillThere = current.projects.some((e) => !e.projectId && e.containerPath === storedPath);
    return {
      kind: "unavailable",
      workspace: current,
      reason: stillThere ? PROJECT_NEEDS_ATTENTION : PROJECT_NOT_FOUND,
    };
  }
  return {
    kind: "ok",
    workspace: current,
    project: entry.project,
    renamed: entry.containerPath !== storedPath,
  };
};

export default function App({ auth }: { auth?: AuthAdapter } = {}) {
  const sidebar = useSidebarWidth();
  const authAdapterRef = useRef<AuthAdapter | null>(null);
  if (!authAdapterRef.current || auth) {
    authAdapterRef.current = resolveAuthAdapter(auth);
  }
  const authAdapter = authAdapterRef.current;
  const [authState, setAuthState] = useState<AuthSnapshot>(() => {
    const initial = authAdapter.getCurrentState?.() ?? {
      ready: false,
      user: null,
    };
    setConvenienceAccountScope(
      initial.ready && initial.user ? initial.user.uid : null,
    );
    return initial;
  });
  const authStateRef = useRef<AuthSnapshot>(authState);
  authStateRef.current = authState;
  const [signInPrompt, setSignInPrompt] = useState<{
    step: "sign-in" | "continue-picker";
    action: PendingAuthAction;
    signingIn: boolean;
    error: string | null;
    info?: string | null;
  } | null>(null);
  const [signOutPending, setSignOutPending] = useState(false);
  const pendingSignOutRef = useRef(false);
  const pendingAccountSnapshotRef = useRef<AuthSnapshot | null>(null);

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
  const [bannerScope, setBannerScope] = useState<"workspace" | "project">(
    "workspace",
  );
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
  const [operation, setOperation] = useState<Operation | null>(null);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [statusBanner, setStatusBanner] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);
  // Synchronous guards also cover rapid double clicks before React renders disabled controls.
  const operationRef = useRef<AbortController | null>(null);
  const contextVersion = useRef(0);

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

  const applyAuthSnapshot = (next: AuthSnapshot) => {
    const prevUid = authStateRef.current.user?.uid ?? null;
    const nextUid = next.ready && next.user ? next.user.uid : null;
    setConvenienceAccountScope(nextUid);
    authStateRef.current = next;
    setAuthState(next);
    if (prevUid !== null && prevUid !== nextUid) {
      resetActiveSessionUi();
    } else if (nextUid === null) {
      setRememberedWorkspace(null);
      setRememberedHome(null);
    }
  };

  useEffect(() => {
    return authAdapter.subscribe((next) => {
      const prevUid = authStateRef.current.user?.uid ?? null;
      const nextUid = next.ready && next.user ? next.user.uid : null;
      if (operationRef.current && prevUid !== null && prevUid !== nextUid) {
        pendingAccountSnapshotRef.current = next;
        setSignOutPending(true);
        return;
      }
      // A later auth event can return to the account whose write is still running.
      // Discard any superseded switch rather than applying it after completion.
      if (operationRef.current && pendingAccountSnapshotRef.current) {
        pendingAccountSnapshotRef.current = null;
        setSignOutPending(pendingSignOutRef.current);
      }
      applyAuthSnapshot(next);
    });
  }, [authAdapter]);

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
    if (operationRef.current || pendingSignOutRef.current || pendingAccountSnapshotRef.current) {
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
      error = folderPermissionError(error);
      // Over the path limit: the same wording in the banner and in any dialog that shows the rethrown error.
      error = presentPathBudgetError(error);
      if (current())
        setStatusBanner({
          type:
            (error instanceof DOMException && error.name === "AbortError") ||
            error instanceof ProjectRenamedNotice
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
        if (pendingSignOutRef.current) {
          pendingSignOutRef.current = false;
          void executeSignOut();
        } else if (pendingAccountSnapshotRef.current) {
          const pending = pendingAccountSnapshotRef.current;
          pendingAccountSnapshotRef.current = null;
          setSignOutPending(false);
          applyAuthSnapshot(pending);
        }
      }
    }
  };

  const executeSignOut = async () => {
    setSignOutPending(true);
    try {
      await authAdapter.signOut();
    } catch (error) {
      pendingSignOutRef.current = false;
      setBannerScope("workspace");
      setStatusBanner({
        type: "error",
        message:
          error instanceof Error ? error.message : "Could not sign out.",
      });
      setSignOutPending(false);
      return;
    }
    pendingSignOutRef.current = false;
    pendingAccountSnapshotRef.current = null;
    setSignOutPending(false);
    setSignInPrompt(null);
    applyAuthSnapshot({ ready: true, user: null });
    resetActiveSessionUi();
  };

  const handleRequestSignOut = () => {
    if (signOutPending || pendingSignOutRef.current) return;
    pendingSignOutRef.current = true;
    if (operationRef.current) {
      setSignOutPending(true);
      return;
    }
    void executeSignOut();
  };

  const requestSignIn = (action: PendingAuthAction) => {
    setSignInPrompt({
      step: "sign-in",
      action,
      signingIn: false,
      error: null,
      info: null,
    });
  };
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
  const handleContinueWithGoogle = async () => {
    if (!signInPrompt || signInPrompt.signingIn) return;
    const intendedAction = signInPrompt.action;
    setSignInPrompt({
      ...signInPrompt,
      signingIn: true,
      error: null,
      info: null,
    });
    try {
      const account = await authAdapter.signInWithGoogle();
      await completeAuthenticatedSignIn(account, intendedAction);
    } catch (error) {
      if (isSignInCancelled(error)) {
        setSignInPrompt(null);
        return;
      }
      setSignInPrompt({
        step: "sign-in",
        action: intendedAction,
        signingIn: false,
        error:
          error instanceof Error
            ? error.message
            : "Google sign-in failed. Try again.",
        info: null,
      });
    }
  };
  const handleSubmitEmailAuth = async (
    mode: "sign-in" | "create-account",
    email: string,
    password: string,
  ) => {
    if (!signInPrompt || signInPrompt.signingIn) return;
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setSignInPrompt({
        ...signInPrompt,
        error: "Enter your email address.",
        info: null,
      });
      return;
    }
    if (!password || password.length < 6) {
      setSignInPrompt({
        ...signInPrompt,
        error: "Password must be at least 6 characters.",
        info: null,
      });
      return;
    }
    const intendedAction = signInPrompt.action;
    setSignInPrompt({
      ...signInPrompt,
      signingIn: true,
      error: null,
      info: null,
    });
    try {
      const emailAction = mode === "create-account"
        ? authAdapter.signUpWithEmail
        : authAdapter.signInWithEmail;
      if (!emailAction) throw new Error("Email authentication is unavailable. Use Continue with Google.");
      const account = await emailAction.call(authAdapter, trimmedEmail, password);
      await completeAuthenticatedSignIn(account, intendedAction);
    } catch (error) {
      setSignInPrompt({
        step: "sign-in",
        action: intendedAction,
        signingIn: false,
        error:
          error instanceof Error
            ? error.message
            : mode === "create-account"
              ? "Account creation failed. Try again."
              : "Sign-in failed. Try again.",
        info: null,
      });
    }
  };
  const handleForgotPassword = async (email: string) => {
    if (!signInPrompt || signInPrompt.signingIn) return;
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setSignInPrompt({
        ...signInPrompt,
        error: "Enter your email address first to receive a password reset link.",
        info: null,
      });
      return;
    }
    const intendedAction = signInPrompt.action;
    setSignInPrompt({
      ...signInPrompt,
      signingIn: true,
      error: null,
      info: null,
    });
    try {
      if (!authAdapter.sendPasswordReset) throw new Error("Password reset is unavailable. Try again later.");
      await authAdapter.sendPasswordReset(trimmedEmail);
      setSignInPrompt({
        step: "sign-in",
        action: intendedAction,
        signingIn: false,
        error: null,
        info: `Password reset email sent to ${trimmedEmail}. Check your inbox.`,
      });
    } catch (error) {
      setSignInPrompt({
        step: "sign-in",
        action: intendedAction,
        signingIn: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not send password reset email. Try again.",
        info: null,
      });
    }
  };
  const handleContinuePickerAfterSignIn = () => {
    if (!signInPrompt || signInPrompt.action.kind !== "connect-home") {
      setSignInPrompt(null);
      return;
    }
    const { create, saved } = signInPrompt.action;
    setSignInPrompt(null);
    void connectHomeInternal(create, saved);
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
    setManagedProject(project);
    setProjectUnavailable(null);
    setBannerScope("project");
    await installProject(
      project.vaultState,
      project.vaultDir,
      project.workingFolders,
      branchId,
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
  const scan = async (
    vault: FileSystemDirectoryAdapter,
    folders: WorkingFolderBindings,
    branchId: string,
    context: Context,
    explicitContext?: {
      root: FileSystemDirectoryAdapter;
      path: string;
    } | null,
    // Called when the open project was re-found at a new folder during this scan (the banner is already set).
    onRebound?: (notice: string) => void,
  ) => {
    let folder = folders[branchId];
    let state: VaultState;
    // Without an explicit location, the open project's stored path is used, and re-found by ID if it moved.
    const managedContext =
      explicitContext !== undefined
        ? explicitContext
        : managedProject && workspace
          ? { root: workspace.root, path: managedProject.record.containerPath }
          : null;
    if (managedContext) {
      let current: ManagedProject;
      try {
        current = await resolveManagedProject(
          managedContext.root,
          managedContext.path,
        );
        if (
          explicitContext === undefined &&
          current.record.projectId !== managedProject?.record.projectId
        )
          throw new Error("The project at the stored location changed.");
      } catch (error) {
        if (explicitContext !== undefined) throw error;
        const found = await refindOpenProject(context);
        if (!found) throw error;
        if (found.kind === "unavailable") throw new Error(found.reason);
        current = found.project;
        vault = current.vaultDir;
        if (found.renamed) {
          const notice = renamedNotice(found.project);
          if (context.current()) setStatusBanner({ type: "info", message: notice });
          onRebound?.(notice);
        }
      }
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
    setStatusBanner(null);
    await perform("scan", async (context) => {
      await assertProjectWritable(context, true);
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
        ? await persistWorkspace(
            workspace,
            { path: managedProject.record.containerPath, id: managedProject.record.projectId },
            branchId,
          )
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
      let renamed: string | null = null;
      const result = await scan(
        vaultDir,
        workingFolders,
        activeBranchId,
        context,
        undefined,
        (notice) => {
          renamed = notice;
        },
      );
      if (result && context.current())
        setStatusBanner({
          type: "info",
          message: `${renamed ? `${renamed} ` : ""}${
            result.hasChanges
              ? `Scan complete: ${result.added.length} added, ${result.modified.length} modified, ${result.deleted.length} deleted.`
              : "This working folder matches its branch’s saved revision."
          }`,
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
      identityReview?: IdentityReview;
      referenceReview?: ReferenceReview;
      referenceAttachments?: import('./engine/references').PendingReferenceAttachment[];
      onReferenceAttachmentsStored?: (review: ReferenceReview) => void;
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
          await assertProjectWritable(context);
          const result = await captureRevision(workingDir, vaultDir, {
            ...params,
            referenceAuthor: authStateRef.current.user ? { id: authStateRef.current.user.uid, displayName: authStateRef.current.user.displayName || authStateRef.current.user.email || 'User' } : undefined,
            onReferenceAttachmentsStored: (review, state) => {
              if (!context.current()) return;
              setVaultState(state);
              params.onReferenceAttachmentsStored?.(review);
            },
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
              message: `Published and verified ${formatRevisionNumber(result.revision.manifest.displayNumber)} on this working case. ${result.cacheWarning ?? ""} ${scanWarning}`,
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
          await assertProjectWritable(context);
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
              message: `${status === "archived" ? "Archived" : "Reopened"} ${result.state.branches.find((branch) => branch.branchId === branchId)?.name}. ${status === "archived" ? "Find archived cases in History → Design cases or Show archived cases in Explorer." : "The working case has not been switched."} ${result.warning ?? ""}`,
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
        await assertProjectWritable(context);
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
          await assertProjectWritable(context);
          await applyPreparedApplication(
            vaultDir,
            prepared,
            applicationOptions(context),
          );
          if (context.current())
            setStatusBanner({
              type: "success",
              message:
                prepared.plan.mode === "revert"
                  ? "Brought back into working files — revision not yet saved."
                  : "Applied to working files — revision not yet saved.",
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
          await assertProjectWritable(context);
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
          await assertProjectWritable(context);
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
    await ensureHomeAddress("workspace");
    await perform(
      "branch",
      async (context) => {
        await assertProjectWritable(context);
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
              budget: { workspaceAddress: await budgetWorkspaceAddress() },
            },
          );
          if (!context.current()) return;
          setManagedProject(current);
          setVaultState(current.vaultState);
          setWorkingFolders(current.workingFolders);
          setWorkingDir(current.workingFolders[current.createdBranchId]!);
          setActiveBranchId(current.createdBranchId);
          setScanResult(null);
          const warning = await persistWorkspace(
            workspace,
            { path: current.record.containerPath, id: current.record.projectId },
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
              message: `Created and verified "${params.name}". Open ${workspace.root.name}/${current.workingPaths[current.createdBranchId]} manually in SolidWorks. ${warning}${pathBudgetWarnSentence(current.pathBudget) ? ` ${pathBudgetWarnSentence(current.pathBudget)}` : ""}`,
            });
          return;
        }
      },
      true,
    );
  };
  const handleExportForReview: ExportReviewAction = async (plan, parent, folderName) => {
    if (!vaultDir || !vaultState) throw new Error('Open the saved project before exporting.');
    const result = await perform('export', async context => {
      await assertProjectWritable(context);
      return exportRevisionForReview({
      vaultDir, parent, plan, folderName, workingFolders,
      signal: context.signal, onProgress: context.progress,
      resolveWorkingFolders: managedProject && workspace ? async () => {
        const current = await resolveManagedProject(workspace.root, managedProject.record.containerPath);
        if (current.record.projectId !== plan.projectId || !current.ready || current.issues.length) throw new Error('Reconnect the project to validate its working-folder isolation before exporting.');
        return current.workingFolders;
      } : undefined,
    });
    }, true);
    if (!result) throw new Error('Export did not complete.');
    return result;
  };
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
      const found = locateProjectById(
        current,
        managedProject.record.projectId,
        managedProject.record.containerPath,
      );
      if (found.kind === "unavailable") {
        setWorkspace(current);
        setProjectUnavailable(found.reason);
        setStatusBanner({ type: "error", message: found.reason });
        return;
      }
      setProjectUnavailable(null);
      const managed = found.project;
      setWorkspace(current);
      setManagedProject(managed);
      setVaultState(managed.vaultState);
      setWorkingFolders(managed.workingFolders);
      setWorkingDir(managed.workingFolders[activeBranchId] ?? null);
      setScanResult(null);
      setActiveTab("history");
      setStatusBanner({
        type: "info",
        message:
          "Reset remembered folder connections and addresses across all accounts and workspaces in this browser. The current workspace was reread; reconnect folders and re-enter their addresses when needed.",
      });
      return;
    }
    setWorkingFolders({});
    setWorkingDir(null);
    setScanResult(null);
    if (vaultDir) {
      setVaultState(await openExistingVault(vaultDir));
      setActiveTab("history");
    }
    setStatusBanner({
      type: "info",
      message:
        "Reset remembered folder connections and addresses across all accounts and workspaces in this browser. Saved history was reread from the vault. Reconnect working folders and re-enter their addresses when needed.",
    });
  };
  const handleSimulateClearMetadataAndReopenVault = async () => {
    await perform("connect", clearConnections);
  };
  const handleRetrieveReference = async (referenceId: string, versionId: string) => {
    if (!vaultDir || !vaultState) throw new Error('Open a project first.');
    await perform('references', async context => {
      if (await vaultDir.requestPermission('read') !== 'granted') throw new Error('Allow read access to the project folder, then retrieve the attachment again.');
      const { version, bytes } = await retrieveReferenceAttachment(vaultDir, vaultState.project.projectId, referenceId, versionId);
      if (!context.current() || context.signal.aborted) throw new Error('Attachment retrieval cancelled.');
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = version.originalFilename;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, true);
  };
  const handleCancelOperation = () => operationRef.current?.abort();
  const busy = operation !== null || signOutPending;
  const isScanning = operation === "scan";
  const isCapturing = operation === "capture";
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
      setLearningOpen(false);
      setExplorerOpen(false);
      if (target.view === "intro") {
        setHomeView(true);
        setIntroView(true);
        return true;
      }
      if (!uid || target.homeId !== home?.identity.homeId) return false;
      if (target.view === "workspaces") { allWorkspaces(); return true; }
      const sameWorkspace = target.workspaceId === workspace?.identity.workspaceId && target.workspaceKey === managedWorkspaceKey;
      if (target.view === "workspace" && sameWorkspace) {
        setHomeView(false);
        setActiveTab("connect");
        return true;
      }
      if (target.view === "project" && sameWorkspace && target.projectId === managedProject?.record.projectId && vaultState) {
        setHomeView(false);
        setActiveTab(target.tab);
        return true;
      }
      const entry = home?.workspaces.find(e => e.key === target.workspaceKey && e.workspaceId === target.workspaceId);
      if (target.view === "workspace") {
        if (!entry?.workspace) return false;
        await openHomeEntry(entry);
      } else {
        const available = entry?.workspace ?? (sameWorkspace ? workspace : null);
        // Identity is the project ID alone. The folder may have been renamed since this entry was recorded.
        const matches = available?.projects.filter(p => p.projectId === target.projectId) ?? [];
        const project = matches.length === 1 ? matches[0] : undefined;
        if (!project?.project || project.status === "duplicate") return false;
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
          <button
            type="button"
            className="wordmark"
            aria-label="cAdtree introduction"
            aria-current={homeView && (introView || !home) ? "page" : undefined}
            disabled={busy}
            onClick={() => {
              if (operationRef.current) return;
              if (!authStateRef.current.user) {
                setHomeView(true);
                setIntroView(true);
                return;
              }
              setHomeView(true);
              setIntroView(true);
              setLearningOpen(false);
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
          </button>
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
                      <button aria-label="References" disabled={busy || !vaultState} aria-current={activeTab === 'references' ? 'page' : undefined} onClick={() => navigate('references')}><BookOpen size={18} /><span>References</span></button>
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
                      <button
                        aria-label="Learn cAdtree"
                        aria-haspopup="dialog"
                        disabled={busy}
                        onClick={() => setLearningOpen(true)}
                      >
                        <GraduationCap size={18} />
                        <span>Learn cAdtree</span>
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
                  <MessageLines text={statusBanner.message} />
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
                <ProjectContextHeader
                  state={vaultState}
                  activeBranchId={activeBranchId}
                  busy={busy}
                  onSelect={handleSelectBranch}
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
                      draftCache={draftCache.current}
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
                      isCapturing={isCapturing}
                      progress={progress}
                      statusBanner={null}
                      onScan={handleScanCurrent}
                      onCapture={(params) =>
                        handleCaptureRevision(branch.branchId, params)
                      }
                      onEnableComponentTracking={async () => {
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
                      }}
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
                    onRetrieve={handleRetrieveReference} />
                </div>
                <div hidden={activeTab !== "history"}>
                  <HistoryRecoveryView
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
                    progress={progress}
                    statusBanner={null}
                    onExportForReview={handleExportForReview}
                    isExporting={operation === 'export'}
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
                        : undefined
                    }
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
                    resolveWorkingFilePath={(branchId, path) =>
                      workingFileResolver(branchId, path)()
                    }
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
                  />
                </div>
              </div>
            ) : null}
          </main>
          {pendingHome ? (
            <FolderAddressDialog
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
          {addressPrompt && home ? (
            <FolderAddressDialog
              home
              folderName={home.root.name}
              title="Add your Cadtree home address"
              intro="cAdtree needs the full address to keep paths within Windows' limit; the browser can't read it."
              onSave={saveHomeAddressFromPrompt}
              onCancel={() => {
                settleAddressPrompt(false);
              }}
            />
          ) : null}
          {learningOpen && !homeView && vaultState ? (
            <ProjectLearningModal busy={busy} onClose={() => setLearningOpen(false)} />
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
          {signInPrompt ? (
            <AccountSignInModal
              step={signInPrompt.step}
              createHomePicker={
                signInPrompt.action.kind === "connect-home"
                  ? signInPrompt.action.create
                  : undefined
              }
              signingIn={signInPrompt.signingIn}
              error={signInPrompt.error}
              info={signInPrompt.info}
              onContinueWithGoogle={() => {
                void handleContinueWithGoogle();
              }}
              onSubmitEmail={(mode, email, password) => {
                void handleSubmitEmailAuth(mode, email, password);
              }}
              onForgotPassword={(email) => {
                void handleForgotPassword(email);
              }}
              onClearFeedback={() => {
                setSignInPrompt((prev) =>
                  prev ? { ...prev, error: null, info: null } : null,
                );
              }}
              onContinuePicker={handleContinuePickerAfterSignIn}
              onCancel={() => {
                if (!signInPrompt.signingIn) setSignInPrompt(null);
              }}
            />
          ) : null}
        </div>
      </div>
    </FilePathShortcutsProvider>
  );
}
