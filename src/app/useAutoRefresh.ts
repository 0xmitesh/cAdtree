import { useEffect, useRef, useState, type RefObject } from "react";
import type { Context } from "./types";

/** Delays in milliseconds. A test may shorten them; the app never changes them. */
export const autoRefreshTiming = {
  /** A trigger waits this long, and a second trigger restarts the wait. */
  debounceMs: 1000,
  /** After one automatic refresh starts, one from a focus change waits at least this long. */
  minIntervalMs: 5000,
  /** A refresh that finds an operation or dialog open tries again after this long. */
  retryMs: 1000,
  maxRetries: 5,
};

export type AutoRefreshArgs = {
  /** The running background refresh. `perform` aborts it first, so the user's own action always wins. */
  backgroundRef: { current: AbortController | null };
  operationRef: RefObject<AbortController | null>;
  contextVersion: RefObject<number>;
  /** True while one of the shell's dialogs is open (any open dialog element also counts). */
  dialogOpen: boolean;
  /** The refresh itself: reads the current page again and updates what is shown. Failures are swallowed. */
  run: (context: Context) => Promise<void>;
};

export type RequestOptions = {
  /**
   * The files are known to have just changed (after Apply or Bring back): skips the minimum interval and the
   * dialog check, since the only dialog open is the one the user just used and a rescan does not touch it.
   */
  immediate?: boolean;
};

/**
 * Quiet background refresh of what the page shows (the project's changes, the workspace list or the home list).
 * It runs outside `perform`: no busy state, progress bar or banner. It starts only when no operation runs and
 * no dialog is open, never asks for folder access, and is dropped quietly when the user starts an operation.
 * Triggers: the tab becomes visible, the window gets focus, or a caller asks (`request`).
 */
export function useAutoRefresh(args: AutoRefreshArgs) {
  const latest = useRef(args);
  latest.current = args;
  const [checking, setChecking] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStart = useRef(0);
  const runId = useRef(0);

  const dialogIsOpen = () =>
    latest.current.dialogOpen ||
    (typeof document !== "undefined" && document.querySelector("dialog[open]") !== null);

  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  /** Runs now when nothing is in the way. Returns false when it did not start. */
  const start = async (options: RequestOptions = {}): Promise<boolean> => {
    const { operationRef, backgroundRef, contextVersion } = latest.current;
    const running = backgroundRef.current && !backgroundRef.current.signal.aborted;
    if (operationRef.current || running || (!options.immediate && dialogIsOpen())) return false;
    const now = Date.now();
    if (!options.immediate && now - lastStart.current < autoRefreshTiming.minIntervalMs)
      return true;
    lastStart.current = now;
    const controller = new AbortController();
    const version = contextVersion.current;
    const id = ++runId.current;
    backgroundRef.current = controller;
    const context: Context = {
      version,
      signal: controller.signal,
      current: () =>
        contextVersion.current === version &&
        backgroundRef.current === controller &&
        !controller.signal.aborted,
      progress: () => {},
    };
    controller.signal.addEventListener("abort", () => {
      if (runId.current === id) setChecking(false);
    });
    setChecking(true);
    try {
      await latest.current.run(context);
    } catch {
      /* A background refresh reports nothing: the last result stays and the next trigger tries again. */
    } finally {
      if (backgroundRef.current === controller) backgroundRef.current = null;
      if (runId.current === id) setChecking(false);
    }
    return true;
  };

  /** Starts after the debounce; when something is in the way, tries again a few times. */
  const request = (options: RequestOptions = {}) => {
    clearTimer();
    let attempts = 0;
    const attempt = () => {
      timer.current = null;
      void start(options).then((started) => {
        if (started || attempts++ >= autoRefreshTiming.maxRetries) return;
        timer.current = setTimeout(attempt, autoRefreshTiming.retryMs);
      });
    };
    timer.current = setTimeout(attempt, autoRefreshTiming.debounceMs);
  };

  /** Refresh right now (the interrupted-Apply panel's Refresh). Does nothing while an operation runs. */
  const refreshNow = async () => {
    clearTimer();
    await start({ immediate: true });
  };

  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    const onFocus = () => requestRef.current();
    const onVisible = () => {
      if (document.visibilityState === "visible") requestRef.current();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      if (timer.current !== null) clearTimeout(timer.current);
      latest.current.backgroundRef.current?.abort();
    };
  }, []);

  return { checking, request, refreshNow };
}
