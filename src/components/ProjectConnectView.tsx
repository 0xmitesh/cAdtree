import React, { useState } from 'react';
import {
  FolderOpen,
  FolderPlus,
  HardDrive,
  AlertTriangle,
  ExternalLink,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import {
  FileSystemDirectoryAdapter,
  RealFileSystemAdapter,
} from '../engine/fs-adapter';
import { RememberedProjectBinding } from '../engine/idb-store';
import {
  formatTimestamp,
  isEmbeddedIframe,
  supportsFileSystemAccessApi,
} from '../utils/format';

export interface ProjectConnectViewProps {
  rememberedBindings: RememberedProjectBinding[];
  onCreateRealProject: (
    projectName: string,
    workingDir: FileSystemDirectoryAdapter,
    vaultDir: FileSystemDirectoryAdapter
  ) => Promise<void>;
  onOpenRealVault: (
    vaultDir: FileSystemDirectoryAdapter,
    workingDir: FileSystemDirectoryAdapter | null
  ) => Promise<void>;
  onReconnectRemembered: (binding: RememberedProjectBinding) => Promise<void>;
  onRemoveRemembered: (projectId: string) => Promise<void>;
  onClearAllConvenienceMetadata: () => Promise<void>;
}

export const ProjectConnectView: React.FC<ProjectConnectViewProps> = ({
  rememberedBindings,
  onCreateRealProject,
  onOpenRealVault,
  onReconnectRemembered,
  onRemoveRemembered,
  onClearAllConvenienceMetadata,
}) => {
  const [newProjectName, setNewProjectName] = useState('');
  const [createWorkingDir, setCreateWorkingDir] = useState<RealFileSystemAdapter | null>(null);
  const [createVaultDir, setCreateVaultDir] = useState<RealFileSystemAdapter | null>(null);

  const [openVaultDir, setOpenVaultDir] = useState<RealFileSystemAdapter | null>(null);
  const [openWorkingDir, setOpenWorkingDir] = useState<RealFileSystemAdapter | null>(null);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const embedded = isEmbeddedIframe();
  const fsSupported = supportsFileSystemAccessApi();

  const pickDirectory = async (
    mode: 'read' | 'readwrite',
    purposeLabel: string
  ): Promise<RealFileSystemAdapter | null> => {
    setErrorMsg(null);
    if (!fsSupported) {
      setErrorMsg(
        `Cannot select ${purposeLabel}: This browser does not support the File System Access API (window.showDirectoryPicker). Please use Google Chrome or Microsoft Edge on Windows or desktop.`
      );
      return null;
    }
    try {
      const picker = (
        window as unknown as {
          showDirectoryPicker: (opts?: {
            mode?: 'read' | 'readwrite';
          }) => Promise<FileSystemDirectoryHandle>;
        }
      ).showDirectoryPicker;
      const handle = await picker({ mode });
      return new RealFileSystemAdapter(handle);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return null;
      }
      if (err instanceof DOMException && err.name === 'SecurityError') {
        setErrorMsg(
          `Browser blocked directory selection (${purposeLabel}) because this page is running inside an embedded preview frame. Open cAdtree in a standalone top-level browser tab to select local folders.`
        );
        return null;
      }
      setErrorMsg(
        `Failed to select ${purposeLabel}: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (!newProjectName.trim()) {
      setErrorMsg('Enter a project name before creating the vault.');
      return;
    }
    if (!createWorkingDir) {
      setErrorMsg('Select an existing CAD working folder first.');
      return;
    }
    if (!createVaultDir) {
      setErrorMsg('Select a separate empty revision vault folder first.');
      return;
    }
    setBusyAction('create');
    try {
      await onCreateRealProject(newProjectName.trim(), createWorkingDir, createVaultDir);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleOpenVaultSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (!openVaultDir) {
      setErrorMsg('Select an existing cAdtree revision vault directory.');
      return;
    }
    setBusyAction('open');
    try {
      await onOpenRealVault(openVaultDir, openWorkingDir);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-10">
      {/* Hero / Tagline */}
      <section className="space-y-2 border-b border-slate-200 pb-6">
        <p className="text-xs font-medium text-slate-500">
          Local-First CAD Version Control &amp; Verified Recovery
        </p>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 text-balance">
          Your designs. Your versions. Your storage.
        </h1>
        <p className="text-base text-slate-600 max-w-3xl leading-relaxed">
          Preserve saved native CAD project states into a separate local revision vault, record
          file-specific and overall engineering reasons, and recover verified snapshots or selected
          files into fresh folders without modifying active working files.
        </p>
      </section>

      {/* Environment & Standalone Browser Capability Notice */}
      {(embedded || !fsSupported) && (
        <section
          aria-label="Browser environment notice"
          className="bg-amber-50/80 border border-amber-200 rounded-lg p-5 flex flex-col md:flex-row md:items-center justify-between gap-4"
        >
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-amber-900 font-semibold text-sm">
              <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
              <span>
                {embedded
                  ? 'Embedded Preview Detected — Open in Standalone Tab for Local Folder Access'
                  : 'File System Access API Unavailable in Current Browser'}
              </span>
            </div>
            <p className="text-xs text-amber-800 leading-relaxed max-w-3xl">
              {embedded
                ? 'Chromium restricts local folder pickers inside cross-origin preview frames. Open cAdtree in a standalone Chrome or Edge tab to connect your local CAD working folder and revision vault.'
                : 'Local folder access requires Google Chrome or Microsoft Edge over HTTPS or localhost.'}
            </p>
          </div>
          <a
            href={typeof window !== 'undefined' ? window.location.href : '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-amber-950 bg-white border border-amber-300 rounded-md hover:bg-amber-100 transition-colors whitespace-nowrap shrink-0"
          >
            <span>Open in Standalone Tab</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </section>
      )}

      {/* Error Banner */}
      {errorMsg && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-900 flex items-start gap-3"
        >
          <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold">Operation Blocked</p>
            <p className="text-xs text-red-800 leading-relaxed">{errorMsg}</p>
          </div>
        </div>
      )}

      {/* Two Distinct Primary Actions: Create Project & Open Existing Vault */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-stretch">
        {/* Action 1: Create Project */}
        <form
          onSubmit={handleCreateSubmit}
          className="bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between space-y-6"
        >
          <div className="space-y-5">
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                  <FolderPlus className="w-5 h-5 text-slate-700" />
                  <span>01. Create project</span>
                </h2>
                <span className="text-xs text-slate-500 font-mono">New Revision Vault</span>
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">
                Select an existing CAD project working folder (read access) and initialize a
                dedicated empty revision vault folder (read/write access).
              </p>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="create-project-name"
                className="block text-xs font-semibold text-slate-700"
              >
                Project Name
              </label>
              <input
                id="create-project-name"
                type="text"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="e.g. Hydraulic Valve Manifold"
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4 py-2.5 border-b border-slate-100">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-800">
                    1. CAD Working Folder (Read Access)
                  </p>
                  <p className="text-xs text-slate-500 font-mono truncate">
                    {createWorkingDir ? (
                      `Selected: ${createWorkingDir.name}`
                    ) : (
                      'Not selected · Save & close CAD files before capture'
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    const dir = await pickDirectory('read', 'CAD Working Folder');
                    if (dir) {
                      setCreateWorkingDir(dir);
                      if (!newProjectName.trim()) {
                        setNewProjectName(dir.name);
                      }
                    }
                  }}
                  className="px-3 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  Select Working Folder
                </button>
              </div>

              <div className="flex items-center justify-between gap-4 py-2.5 border-b border-slate-100">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-800">
                    2. Revision Vault Folder (Read/Write Access)
                  </p>
                  <p className="text-xs text-slate-500 font-mono truncate">
                    {createVaultDir
                      ? `Selected: ${createVaultDir.name}`
                      : 'Must be an empty, separate directory outside Working Folder'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    const dir = await pickDirectory('readwrite', 'Revision Vault Folder');
                    if (dir) setCreateVaultDir(dir);
                  }}
                  className="px-3 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  Select Empty Vault
                </button>
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={busyAction !== null}
            className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap"
          >
            {busyAction === 'create' ? 'Initializing Vault...' : 'Create Project & Initialize Vault'}
          </button>
        </form>

        {/* Action 2: Open Existing Vault */}
        <form
          onSubmit={handleOpenVaultSubmit}
          className="bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between space-y-6"
        >
          <div className="space-y-5">
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                  <FolderOpen className="w-5 h-5 text-slate-700" />
                  <span>02. Open existing vault</span>
                </h2>
                <span className="text-xs text-slate-500 font-mono">Reopen Repository</span>
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">
                Reopen an existing cAdtree revision vault. Project identity, branches, revision
                history, and notes are reconstructed directly from committed vault records even if
                browser data was cleared.
              </p>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4 py-2.5 border-b border-slate-100">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-800">
                    1. Existing Vault Directory (Required)
                  </p>
                  <p className="text-xs text-slate-500 font-mono truncate">
                    {openVaultDir
                      ? `Selected: ${openVaultDir.name}`
                      : 'Select folder containing project.json & revisions/'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    const dir = await pickDirectory('readwrite', 'Existing Vault Directory');
                    if (dir) setOpenVaultDir(dir);
                  }}
                  className="px-3 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  Select Existing Vault
                </button>
              </div>

              <div className="flex items-center justify-between gap-4 py-2.5 border-b border-slate-100">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-800">
                    2. Working Folder for Main (Optional on Reopen)
                  </p>
                  <p className="text-xs text-slate-500 font-mono truncate">
                    {openWorkingDir
                      ? `Selected: ${openWorkingDir.name}`
                      : 'Can also be reattached explicitly after opening history'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    const dir = await pickDirectory('read', 'CAD Working Folder');
                    if (dir) setOpenWorkingDir(dir);
                  }}
                  className="px-3 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  Attach Working Folder
                </button>
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={busyAction !== null}
            className="w-full py-2.5 px-4 text-xs font-semibold text-slate-900 bg-white border border-slate-900 hover:bg-slate-50 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap"
          >
            {busyAction === 'open' ? 'Reconstructing Vault History...' : 'Open Existing Vault'}
          </button>
        </form>
      </section>

      {/* Remembered Projects in IndexedDB */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-slate-700" />
              <span>Remembered Local Projects</span>
            </h2>
            <p className="text-xs text-slate-500">
              Directory handles saved in browser storage for quick reconnection. Permissions are
              rechecked on reuse. Clearing this list never deletes your vault history.
            </p>
          </div>
          {rememberedBindings.length > 0 && (
            <button
              type="button"
              onClick={onClearAllConvenienceMetadata}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear Remembered Handles</span>
            </button>
          )}
        </div>

        {rememberedBindings.length === 0 ? (
          <p className="text-xs text-slate-500 py-2">
            No remembered projects stored in this browser yet. Create a new project or open an
            existing vault above.
          </p>
        ) : (
          <div className="divide-y divide-slate-100">
            {rememberedBindings.map((item) => (
              <div
                key={item.projectId}
                className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div className="space-y-0.5">
                  <p className="text-sm font-semibold text-slate-900">{item.projectName}</p>
                  <p className="text-xs text-slate-500 font-mono tabular-nums">
                    ID: {item.projectId} · Vault: {item.vaultFolderName} · Working:{' '}
                    {Object.values(item.workingFolderNames)[0] ?? 'Unattached'} · Last opened:{' '}
                    {formatTimestamp(item.lastOpenedAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={async () => {
                      setErrorMsg(null);
                      try {
                        await onReconnectRemembered(item);
                      } catch (err) {
                        setErrorMsg(err instanceof Error ? err.message : String(err));
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Reconnect &amp; Verify Permissions</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove remembered project ${item.projectName}`}
                    onClick={() => onRemoveRemembered(item.projectId)}
                    className="p-1.5 text-slate-400 hover:text-red-600 rounded-md transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
