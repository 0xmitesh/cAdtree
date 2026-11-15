import type { RealFileSystemAdapter } from "../engine/fs-adapter";
import type { HomeState } from "../engine/home-service";
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
  step: "sign-in" | "continue-picker";
  action: PendingAuthAction;
  signingIn: boolean;
  error: string | null;
  info?: string | null;
};
