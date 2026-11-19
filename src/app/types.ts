import type { RealFileSystemAdapter } from "../engine/fs-adapter";
import type { HomeState } from "../engine/home-service";
import type { RememberedHome } from "../engine/idb-store";
import type { ProgressUpdate } from "../engine/types";
import type { ManagedProject } from "../engine/workspace-service";
import type { useOperation } from "./useOperation";

export type ActiveTab = "connect" | "changes" | "history" | "references" | "diagnostics";
export type Operation =
  "scan" | "capture" | "verify" | "branch" | "connect" | "apply" | "export" | "references";
export type Context = {
  version: number;
  signal: AbortSignal;
  current: () => boolean;
  progress: (p: ProgressUpdate) => void;
};
/** Runs an operation through the shared operation lifecycle (see useOperation). */
export type Perform = ReturnType<typeof useOperation>["perform"];
/** Re-finds the open project before a write; throws when it is unavailable or was renamed. */
export type AssertProjectWritable = (context: Context, readOnlyOperation?: boolean) => Promise<ManagedProject | null>;

export type BannerScope = "workspace" | "project";

export type StatusBanner = {
  type: "success" | "error" | "info";
  message: string;
};

export type PendingHome = {
  root: RealFileSystemAdapter;
  next?: HomeState;
  create: boolean;
  saved?: RememberedHome;
  requestId: string;
};

export type SignInPrompt = {
  signingIn: boolean;
  error: string | null;
  info?: string | null;
};
