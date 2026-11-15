import { useEffect, useRef, useState, type RefObject } from "react";
import type { AuthSnapshot } from "../auth/firebase-auth";
import type { ProgressUpdate } from "../engine/types";
import { folderPermissionError } from "../utils/folder-access";
import { presentPathBudgetError } from "../utils/path-budget-message";
import { ProjectRenamedNotice } from "./project-lookup";
import type { ActiveTab, Context, Operation, StatusBanner } from "./types";

export type UseOperationArgs = {
  activeTab: ActiveTab;
  pendingSignOutRef: RefObject<boolean>;
  pendingAccountSnapshotRef: RefObject<AuthSnapshot | null>;
  setSignOutPending: (value: boolean) => void;
  executeSignOut: () => Promise<void> | void;
  applyAuthSnapshot: (next: AuthSnapshot) => void;
};

/** The busy/progress/banner core: one operation at a time, cancellable, with its outcome in the status banner. */
export function useOperation({
  activeTab,
  pendingSignOutRef,
  pendingAccountSnapshotRef,
  setSignOutPending,
  executeSignOut,
  applyAuthSnapshot,
}: UseOperationArgs) {
  const [bannerScope, setBannerScope] = useState<"workspace" | "project">(
    "workspace",
  );
  const [operation, setOperation] = useState<Operation | null>(null);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [statusBanner, setStatusBanner] = useState<StatusBanner | null>(null);
  // Synchronous guards also cover rapid double clicks before React renders disabled controls.
  const operationRef = useRef<AbortController | null>(null);
  const contextVersion = useRef(0);

  useEffect(
    () => () => {
      contextVersion.current++;
      operationRef.current?.abort();
    },
    [],
  );

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

  const handleCancelOperation = () => operationRef.current?.abort();

  return {
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
  };
}
