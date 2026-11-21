import { useState } from "react";
import { createRoot } from "react-dom/client";
import { HistoryRecoveryView } from "../src/components/HistoryRecoveryView";
import { ChangesCaptureView } from "../src/components/ChangesCaptureView";
import { DiagnosticsView } from "../src/components/DiagnosticsView";
import {
  FolderOpen,
  GitBranch,
  HardDrive,
  History,
  ScanLine,
  Settings,
} from "lucide-react";
import { IntegrityNotice, Notice } from "../src/components/ui";
import { scenarioState } from "./history-data";
import type { ScanResult } from "../src/engine/types";
import "../src/index.css";
if (!import.meta.env.DEV) throw new Error("Development preview only");
const scenario = new URLSearchParams(location.search).get("scenario") ?? "main";
const state = scenarioState(scenario);
const scan: ScanResult = {
  scannedAt: "2026-10-29T13:28:00Z",
  branchId: "branch-main",
  baselineRevisionId: "r6",
  baselineDisplayNumber: 6,
  added: [],
  modified: state.revisions.length
    ? [
        {
          current: {
            ...state.revisions[0].manifest.files[1],
            sha256: "b".repeat(64),
          },
          previous: state.revisions[0].manifest.files[1],
        },
      ]
    : [],
  deleted: [],
  unchanged: state.revisions[0]?.manifest.files.filter((_, i) => i !== 1) ?? [],
  directories: ["Parts", "Drawings"],
  addedDirectories: [],
  deletedDirectories: [],
  errors: [],
  hasChanges: true,
  canCapture: true,
  totalBytes: 84000,
  changesSignature: "preview-scan",
};
function Preview() {
  const [view, setView] = useState("history");
  const [message, setMessage] = useState("");
  const noop = async () => {};
  return (
    <div className="app-shell component-fixture-preview">
      <div className="component-fixture-label" role="note">
        SYNTHETIC COMPONENT HARNESS · isolated view tests, not the current
        application shell.{" "}
        <a href="/tests/synthetic.html">
          Open the current multi-workspace preview
        </a>
      </div>
      <aside className="navigation-rail">
        <a className="wordmark" href="/" aria-label="cAdtree projects">
          <GitBranch size={29} />
          <span>
            cAdtree<span className="wordmark-dot">.</span>
          </span>
        </a>
        <p className="rail-caption">DESIGN. RECORD. EVOLVE.</p>
        <nav aria-label="Primary navigation">
          {[
            ["history", History, "History"],
            ["changes", ScanLine, "Changes"],
            ["settings", Settings, "Settings"],
          ].map(([id, Icon, label]: any) => (
            <button
              key={id}
              aria-current={id === view ? "page" : undefined}
              aria-label={label}
              onClick={() => setView(id)}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="rail-bottom">
          <HardDrive size={17} />
          <div>
            <strong>Local by design</strong>
            <p>Your files. Your storage.</p>
          </div>
        </div>
      </aside>
      <div className="workspace-shell">
        <header className="workspace-header">
          <div className="workspace-context">
            <span className="workspace-symbol">
              <FolderOpen size={17} />
            </span>
            <strong>{state.project.name}</strong>
            <span className="current-branch">
              <GitBranch size={14} />
              Main
            </span>
          </div>
          <span className="local-indicator">Development · synthetic data</span>
        </header>
        <main>
          <div className="global-integrity">
            <IntegrityNotice state={state} />
          </div>
          {message ? (
            <div className="global-feedback">
              <Notice onDismiss={() => setMessage("")}>{message}</Notice>
            </div>
          ) : null}
          <div hidden={view !== "history"}>
            <HistoryRecoveryView
              vaultState={state}
              activeBranchId="branch-main"
              progress={null}
              statusBanner={null}
              onVerifySingleRevisionObjects={noop}
              onCancelOperation={() => {}}
              onExportForReview={async () => {
                throw new Error("Synthetic preview does not export");
              }}
              onGoToChanges={() => setView("changes")}
            />
          </div>
          <div hidden={view !== "changes"}>
            <ChangesCaptureView
              vaultState={state}
              activeBranchId="branch-main"
              workingFolderName="Linear actuator — Working"
              vaultFolderName="Actuator vault"
              scanResult={scan}
              isScanning={false}
              isCapturing={false}
              progress={null}
              statusBanner={null}
              onScan={noop}
              onCapture={async () => setMessage("Synthetic capture submitted")}
              onCancelOperation={() => {}}
              onReattachWorkingFolder={noop}
            />
          </div>
          {view === "settings" ? (
            <DiagnosticsView
              vaultState={state}
              isVerifyingAll={false}
              onVerifyAllObjects={noop}
              onResetConnections={noop}
              workingFolderName="Linear actuator — Working"
              vaultFolderName="Actuator vault"
              onReattachWorkingFolder={noop}
            />
          ) : null}
        </main>
        <footer className="workspace-footer">
          <span>cAdtree · CAD project history</span>
          <span>Complete revisions. Separate recovery copies.</span>
        </footer>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
