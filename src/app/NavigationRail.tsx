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
  SidebarResizeHandle,
  type useSidebarWidth,
} from "../components/SidebarResize";
import {
  WorkspaceTree,
  type WorkspaceTreeProps,
} from "../components/WorkspaceTree";
import type { HomeState } from "../engine/home-service";
import type { ScanResult, VaultState } from "../engine/types";
import type { WorkspaceState } from "../engine/workspace-service";
import type { ActiveTab } from "./types";

export interface NavigationRailProps {
  sidebar: ReturnType<typeof useSidebarWidth>;
  home: HomeState | null;
  workspace: WorkspaceState | null;
  homeView: boolean;
  introView: boolean;
  busy: boolean;
  activeTab: ActiveTab;
  vaultState: VaultState | null;
  scanResult: ScanResult | null;
  treeProps: WorkspaceTreeProps;
  navigate: (tab: ActiveTab) => void;
  onWordmarkClick: () => void;
  onAllWorkspaces: () => void;
  onBrowseFolders: () => void;
  onLearn: () => void;
}

/** The left rail: wordmark, primary navigation, workspace tree and project navigation. */
export function NavigationRail({
  sidebar,
  home,
  workspace,
  homeView,
  introView,
  busy,
  activeTab,
  vaultState,
  scanResult,
  treeProps,
  navigate,
  onWordmarkClick,
  onAllWorkspaces,
  onBrowseFolders,
  onLearn,
}: NavigationRailProps) {
  return (
    <aside className="navigation-rail">
      <button
        type="button"
        className="wordmark"
        aria-label="cAdtree introduction"
        aria-current={homeView && (introView || !home) ? "page" : undefined}
        disabled={busy}
        onClick={onWordmarkClick}
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
          onClick={onAllWorkspaces}
        >
          <FolderOpen size={18} />
          <span>My workspaces</span>
        </button>
        {home || workspace ? (
          <button
            className="mobile-tree-toggle"
            aria-label="Browse folders"
            disabled={busy}
            onClick={onBrowseFolders}
          >
            <FolderOpen size={18} />
            <span>Browse folders</span>
          </button>
        ) : null}
        <div className="desktop-workspace-tree">
          <WorkspaceTree {...treeProps} />
        </div>
        {/* Always rendered so the Explorer above keeps its height; hidden and inert until a project is open. */}
        <div
          className={`project-navigation${!homeView && vaultState ? " has-project" : ""}`}
          inert={homeView || !vaultState}
          aria-hidden={homeView || !vaultState ? true : undefined}
        >
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
            onClick={onLearn}
          >
            <GraduationCap size={18} />
            <span>Learn cAdtree</span>
          </button>
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
  );
}
