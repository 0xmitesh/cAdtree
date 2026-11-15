import type { RememberedHome } from "../engine/idb-store";
import type { ProgressUpdate } from "../engine/types";

export type ActiveTab = "connect" | "changes" | "history" | "references" | "diagnostics";
export type Operation =
  "scan" | "capture" | "verify" | "branch" | "connect" | "apply" | "export" | "references";
export type Context = {
  version: number;
  signal: AbortSignal;
  current: () => boolean;
  progress: (p: ProgressUpdate) => void;
};

export type PendingAuthAction =
  | { kind: "connect-home"; create: boolean; saved?: RememberedHome }
  | { kind: "my-workspaces" }
  | { kind: "callback"; run: () => Promise<void> | void };

