import { useEffect, useRef } from "react";

export type ProjectView = "history" | "changes" | "references" | "diagnostics";
type WorkspaceLocation = { homeId?: string; workspaceId: string; workspaceKey: string | null };
export type AppView =
  | { view: "intro" }
  | { view: "workspaces"; homeId: string }
  | ({ view: "workspace" } & WorkspaceLocation)
  | ({ view: "project"; projectId: string; tab: ProjectView } & WorkspaceLocation);

const STATE_KEY = "cadtreeView";
const key = (view: AppView) => JSON.stringify(view);

/** Main-view visits only. Handles, project records and account IDs never enter browser history. */
export function useViewHistory({ view, scope, ready, busy, onVisit }: {
  view: AppView;
  scope: string;
  ready: boolean;
  busy: boolean;
  onVisit: (view: AppView) => Promise<boolean>;
}) {
  const latest = useRef({ view, scope, ready, busy, onVisit });
  latest.current = { view, scope, ready, busy, onVisit };
  const session = useRef<{
    scope: string;
    id: string;
    index: number;
    entries: Map<number, AppView>;
    pending?: number;
    restoring?: number;
  } | null>(null);

  const mark = (replace: boolean) => {
    const s = session.current!;
    const state = { ...window.history.state, [STATE_KEY]: { session: s.id, index: s.index } };
    // Remove the old fake destination if a pre-fix bookmark opened this app.
    const url = window.location.hash === "#intro"
      ? window.location.pathname + window.location.search : undefined;
    window.history[replace ? "replaceState" : "pushState"](state, "", url);
  };
  const replay = (index: number) => {
    const s = session.current!;
    const target = s.entries.get(index)!;
    s.index = index;
    if (key(target) === key(latest.current.view)) { s.restoring = undefined; return; }
    s.restoring = index;
    const fail = () => {
      if (session.current !== s || s.restoring !== index) return;
      s.restoring = undefined;
      s.entries.set(index, latest.current.view);
      mark(true);
    };
    void latest.current.onVisit(target).then(ok => { if (!ok) fail(); }, fail);
  };
  const replayRef = useRef(replay);
  replayRef.current = replay;

  useEffect(() => {
    const pop = (event: PopStateEvent) => {
      const s = session.current;
      if (!s || !latest.current.ready || s.scope !== latest.current.scope) return;
      const target = event.state?.[STATE_KEY];
      if (target?.session !== s.id || !s.entries.has(target.index)) {
        // Reloaded or previous-account entries cannot reconnect an old session.
        mark(true);
        return;
      }
      if (latest.current.busy) s.pending = target.index;
      else replayRef.current(target.index);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  const viewKey = key(view);
  useEffect(() => {
    if (!ready) return;
    if (session.current?.scope !== scope) {
      session.current = { scope, id: crypto.randomUUID(), index: 0, entries: new Map([[0, view]]) };
      mark(true);
      return;
    }
    const s = session.current;
    // A Back/Forward request waits for file operations and deferred account changes.
    if (busy) return;
    if (s.pending !== undefined) {
      const target = s.pending;
      s.pending = undefined;
      replayRef.current(target);
      return;
    }
    if (s.restoring !== undefined) {
      if (key(s.entries.get(s.restoring)!) === viewKey) s.restoring = undefined;
      return;
    }
    if (key(s.entries.get(s.index)!) === viewKey) return;
    for (const index of s.entries.keys()) if (index > s.index) s.entries.delete(index);
    s.entries.set(++s.index, view);
    mark(false);
  }, [viewKey, scope, ready, busy]);
}
