import {
  useId,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  ChevronRight,
  ChevronsDownUp,
  Folder,
  FolderOpen,
  GitBranch,
  Home,
} from "lucide-react";
import {
  homeWorkspaceGroups,
  type HomeState,
  type HomeWorkspaceEntry,
} from "../engine/home-service";
import type {
  WorkspaceState,
  WorkspaceProjectEntry,
} from "../engine/workspace-service";
import type { VaultState } from "../engine/types";

export interface WorkspaceTreeProps {
  home: HomeState | null;
  workspace: WorkspaceState | null;
  managedWorkspaceKey: string | null;
  projectPath?: string;
  activeVault: VaultState | null;
  activeBranchId: string;
  projectView: boolean;
  busy: boolean;
  onHome: () => void;
  onWorkspace: (entry?: HomeWorkspaceEntry) => Promise<void> | void;
  onProject: (
    workspace: HomeWorkspaceEntry | undefined,
    project: WorkspaceProjectEntry,
    branchId?: string,
  ) => Promise<void>;
}
interface TreeNode {
  key: string;
  label: string;
  accessibleLabel?: string;
  kind: "home" | "workspace" | "project" | "branch";
  children: TreeNode[];
  open: () => Promise<void> | void;
  unavailable?: boolean;
  issue?: string;
  count?: number;
}
interface VisibleNode extends TreeNode {
  depth: number;
  parent?: string;
  position: number;
  siblings: number;
}

/** Product navigation only: storage internals never become editable explorer targets. */
export function WorkspaceTree(props: WorkspaceTreeProps) {
  const descriptionId = useId();
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(["home"]),
  );
  const [focusedKey, setFocusedKey] = useState("home");
  const rows = useRef(new Map<string, HTMLDivElement>());
  const workspaceKey = props.workspace
    ? (props.managedWorkspaceKey ??
      `external:${props.workspace.identity.workspaceId}`)
    : undefined;
  const projectKey =
    workspaceKey && props.projectPath
      ? `${workspaceKey}/project:${props.projectPath}`
      : undefined;
  const selectedKey =
    props.projectView && projectKey
      ? `${projectKey}/branch:${props.activeBranchId}`
      : (workspaceKey ?? "home");

  const projects = (
    workspace: WorkspaceState,
    key: string,
    homeEntry?: HomeWorkspaceEntry,
  ): TreeNode[] =>
    workspace.projects.map((entry) => {
      const keyForProject = `${key}/project:${entry.containerPath}`;
      const active =
        key === workspaceKey && entry.containerPath === props.projectPath;
      const vault = active
        ? (props.activeVault ?? entry.project?.vaultState)
        : entry.project?.vaultState;
      const unavailable = !entry.project || entry.status === "duplicate";
      return {
        key: keyForProject,
        label: entry.name,
        accessibleLabel: `${entry.name}, ${workspace.identity.name}`,
        kind: "project",
        unavailable,
        issue: entry.issues.join(" "),
        count: vault?.branches.length,
        open: () => props.onProject(homeEntry, entry),
        children: (vault?.branches ?? []).map((branch) => ({
          key: `${keyForProject}/branch:${branch.branchId}`,
          label: branch.name,
          accessibleLabel: `${branch.name}, ${entry.name}, ${workspace.identity.name}`,
          kind: "branch",
          children: [],
          unavailable,
          open: () => props.onProject(homeEntry, entry, branch.branchId),
        })),
      };
    });
  const workspaces: TreeNode[] = homeWorkspaceGroups(
    props.home?.workspaces ?? [],
  )
    .map((entries): TreeNode => {
      const entry = entries.find((item) => item.workspace) ?? entries[0];
      return {
        key: entry.key,
        label: entry.name,
        kind: "workspace",
        unavailable: !entry.workspace,
        issue: entry.issues.join(" "),
        count: entry.workspace?.projects.length,
        open: () => props.onWorkspace(entry),
        children: entry.workspace
          ? projects(entry.workspace, entry.key, entry)
          : [],
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  const roots: TreeNode[] = [
    {
      key: "home",
      label: "Cadtree home",
      kind: "home",
      children: workspaces,
      open: props.onHome,
    },
  ];
  if (props.workspace && !props.managedWorkspaceKey)
    roots.push({
      key: workspaceKey!,
      label: `${props.workspace.identity.name} · External`,
      kind: "workspace",
      count: props.workspace.projects.length,
      children: projects(props.workspace, workspaceKey!),
      open: () => props.onWorkspace(),
    });

  // Follow navigation to its ancestry, while leaving manually collapsed folders alone.
  useEffect(() => {
    setExpanded((previous) => {
      const next = new Set(previous);
      next.add("home");
      if (workspaceKey) next.add(workspaceKey);
      if (props.projectView && projectKey) next.add(projectKey);
      return next;
    });
    setFocusedKey(selectedKey);
  }, [selectedKey, workspaceKey, projectKey, props.projectView]);

  const visible: VisibleNode[] = [];
  const flatten = (nodes: TreeNode[], depth: number, parent?: string) =>
    nodes.forEach((node, index) => {
      visible.push({
        ...node,
        depth,
        parent,
        position: index + 1,
        siblings: nodes.length,
      });
      if (expanded.has(node.key)) flatten(node.children, depth + 1, node.key);
    });
  flatten(roots, 0);
  const tabKey = visible.some((node) => node.key === focusedKey)
    ? focusedKey
    : visible[0]?.key;
  const focus = (key: string) => {
    setFocusedKey(key);
    rows.current.get(key)?.focus();
  };
  const toggle = (node: TreeNode) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(node.key)) next.delete(node.key);
      else next.add(node.key);
      return next;
    });
  const open = (node: TreeNode) => {
    if (props.busy || node.unavailable) return;
    focus(node.key);
    void Promise.resolve(node.open()).catch(() => {
      /* App surfaces connection errors. */
    });
  };
  const onKey = (event: KeyboardEvent, node: VisibleNode) => {
    const index = visible.findIndex((item) => item.key === node.key);
    if (event.key === "ArrowDown")
      focus(visible[Math.min(index + 1, visible.length - 1)].key);
    else if (event.key === "ArrowUp")
      focus(visible[Math.max(index - 1, 0)].key);
    else if (event.key === "Home") focus(visible[0].key);
    else if (event.key === "End") focus(visible[visible.length - 1].key);
    else if (event.key === "ArrowRight" && node.children.length) {
      if (!expanded.has(node.key)) toggle(node);
      else focus(node.children[0].key);
    } else if (event.key === "ArrowLeft") {
      if (node.children.length && expanded.has(node.key)) toggle(node);
      else if (node.parent) focus(node.parent);
    } else if (event.key === "Enter" || event.key === " ") open(node);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  if (!props.home && !props.workspace) return null;
  return (
    <section className="workspace-tree" aria-label="Workspace folders">
      <div className="tree-heading">
        <span>EXPLORER</span>
        <button
          type="button"
          className="tree-collapse"
          aria-label="Collapse folders"
          title="Collapse folders"
          onClick={() => {
            setExpanded(new Set(["home"]));
            setFocusedKey("home");
          }}
        >
          <ChevronsDownUp size={14} />
        </button>
      </div>
      <div
        role="tree"
        aria-label="Workspace explorer"
        aria-busy={props.busy}
        className="tree-items"
      >
        {visible.map((node, index) => {
          const isExpanded = expanded.has(node.key);
          const Icon =
            node.kind === "home"
              ? Home
              : node.kind === "branch"
                ? GitBranch
                : isExpanded
                  ? FolderOpen
                  : Folder;
          return (
            <div
              key={node.key}
              ref={(element) => {
                if (element) rows.current.set(node.key, element);
                else rows.current.delete(node.key);
              }}
              role="treeitem"
              aria-label={node.accessibleLabel ?? node.label}
              aria-describedby={
                !node.unavailable && node.count !== undefined
                  ? `${descriptionId}-${index}`
                  : undefined
              }
              aria-level={node.depth + 1}
              aria-posinset={node.position}
              aria-setsize={node.siblings}
              aria-expanded={node.children.length ? isExpanded : undefined}
              aria-selected={node.key === selectedKey}
              aria-disabled={props.busy || node.unavailable || undefined}
              tabIndex={node.key === tabKey ? 0 : -1}
              className={`tree-row ${node.kind}${node.unavailable ? " unavailable" : ""}`}
              title={node.issue ? `${node.label} — ${node.issue}` : node.label}
              style={{ "--tree-depth": node.depth } as CSSProperties}
              onFocus={() => setFocusedKey(node.key)}
              onKeyDown={(event) => onKey(event, node)}
              onClick={() => open(node)}
            >
              {node.children.length ? (
                <button
                  type="button"
                  tabIndex={-1}
                  className="tree-expander"
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.label}`}
                  aria-expanded={isExpanded}
                  onClick={(event) => {
                    event.stopPropagation();
                    focus(node.key);
                    toggle(node);
                  }}
                >
                  <ChevronRight
                    size={13}
                    className={isExpanded ? "expanded" : ""}
                  />
                </button>
              ) : (
                <span className="tree-expander empty" />
              )}
              <Icon size={15} className="tree-folder-icon" aria-hidden="true" />
              <span className="tree-label">{node.label}</span>
              {node.unavailable ? (
                <span className="tree-warning" aria-hidden="true">
                  !
                </span>
              ) : node.count !== undefined ? (
                <span
                  className="tree-count"
                  title={`${node.count} ${node.kind === "workspace" ? "projects" : "branches"}`}
                >
                  <span aria-hidden="true">{node.count}</span>
                  <span className="sr-only" id={`${descriptionId}-${index}`}>
                    {node.count}{" "}
                    {node.kind === "workspace" ? "projects" : "branches"}
                  </span>
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
