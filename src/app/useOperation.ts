import { useEffect, useRef, useState } from "react";
import type { ProgressUpdate } from "../engine/types";
import { folderPermissionError, isFolderAccessError } from "../utils/folder-access";
import { presentPathBudgetError } from "../utils/path-budget-message";
import { ProjectRenamedNotice } from "./project-lookup";
import type { ActiveTab, BannerScope, Context, Operation, StatusBanner } from "./types";

/** Engines report once per file; React gets at most about 10 updates a second so a big save doesn't re-render every mounted tab per file. */
const PROGRESS_INTERVAL_MS = 100;

export type UseOperationArgs = {
  activeTab: ActiveTab;
};

/** `rethrow`: pass a failure on to the caller. `banner: false`: the caller shows the failure itself, so no status banner. */
export type PerformOptions = { rethrow?: boolean; banner?: boolean };

/** The busy/progress/banner core: one operation at a time, cancellable, with its outcome in the status banner. */
export function useOperation({
  activeTab,
}: UseOperationArgs) {
  const [bannerScope, setBannerScope] = useState<BannerScope>("workspace");
  const [operation, setOperation] = useState<Operation | null>(null);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [statusBanner, setStatusBanner] = useState<StatusBanner | null>(null);
  // Synchronous guards also cover rapid double clicks before React renders disabled controls.
  const operationRef = useRef<AbortController | null>(null);
  // The quiet background refresh (useAutoRefresh). A user operation always wins: it stops the refresh first.
  const backgroundRef = useRef<AbortController | null>(null);
  const contextVersion = useRef(0);
  // Throttle state of the running operation: the phase last shown, the newest update not shown yet, and its flush timer.
  const shownPhase = useRef<ProgressUpdate["phase"] | null>(null);
  const pendingProgress = useRef<ProgressUpdate | null>(null);
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearProgressTimer = () => {
    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = null;
    pendingProgress.current = null;
  };

  useEffect(
    () => () => {
      contextVersion.current++;
      clearProgressTimer();
      operationRef.current?.abort();
    },
    [],
  );

  const perform = async <T,>(
    kind: Operation,
    action: (context: Context) => Promise<T>,
    options: boolean | PerformOptions = false,
  ): Promise<T | undefined> => {
    const { rethrow = false, banner = true } =
      typeof options === "boolean" ? { rethrow: options } : options;
    backgroundRef.current?.abort();
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
    shownPhase.current = null;
    clearProgressTimer();
    const showProgress = (p: ProgressUpdate) => {
      clearProgressTimer();
      shownPhase.current = p.phase;
      setProgress(p);
    };
    const context = {
      version,
      signal: abort.signal,
      current,
      progress: (p: ProgressUpdate) => {
        if (!current()) return;
        // The first update and a new phase show at once; others wait for the trailing flush of the newest one.
        if (p.phase !== shownPhase.current) return showProgress(p);
        pendingProgress.current = p;
        progressTimer.current ??= setTimeout(() => {
          progressTimer.current = null;
          const latest = pendingProgress.current;
          pendingProgress.current = null;
          if (latest && current()) showProgress(latest);
        }, PROGRESS_INTERVAL_MS);
      },
    };
    try {
      return await action(context);
    } catch (error) {
      const reconnect = isFolderAccessError(error);
      error = folderPermissionError(error);
      // Over the path limit: the same wording in the banner and in any dialog that shows the rethrown error.
      error = presentPathBudgetError(error);
      if (banner && current())
        setStatusBanner({
          type:
            (error instanceof DOMException && error.name === "AbortError") ||
            error instanceof ProjectRenamedNotice
              ? "info"
              : "error",
          message: error instanceof Error ? error.message : String(error),
          ...(reconnect ? { reconnect: true } : {}),
        });
      if (rethrow) throw error;
    } finally {
      if (operationRef.current === abort) {
        operationRef.current = null;
        clearProgressTimer();
        setOperation(null);
        setProgress(null);
      }
    }
  };

  const handleCancelOperation = () => operationRef.current?.abort();

  return {
    bannerScope,
    setBannerScope,
    operation,
    progress,
    statusBanner,
    setStatusBanner,
    operationRef,
    backgroundRef,
    contextVersion,
    perform,
    handleCancelOperation,
  };
}
