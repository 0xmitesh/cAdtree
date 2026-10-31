# Workspace navigation and Windows file-path shortcuts

Implemented on the existing `codex/managed-workspace` branch after confirming PR #4 was open and unmerged at feature commit `0fdb073bed8d4d38521930f0c88206642e0c0315`. The v0.3 plan remains the specification, with the user's refinement prompt taking precedence for these flows. No merge or deployment performed. The delivery report records the final upstream commit.

## Changed behavior

- Workspace is the top-level overview, headed by its name and project cards. Add project remains primary; connected workspace management is secondary. Internal IDs/paths are disclosed under Location details. Branch selectors, working-folder banners, integrity information, and capture notifications stay in project views. External projects remain under Advanced.
- An optional Windows root field is offered at creation/reconnection and is editable from workspace options or project Settings. Values are normalized and stored separately per workspace identity in browser convenience storage. Clearing convenience data removes them. No absolute location is added to portable workspace/vault records or used to authorize/redirect filesystem operations.
- Current file rows offer one-click Copy file path and a secondary Copy containing folder path. Missing configuration opens setup and completes the original request after saving. Fresh read-only handle/mapping/existence checks precede path composition; display names and guessed slugs are never used.
- Revision shortcuts explicitly say Copy current working file path and name the recorded branch. Inspection, highlighting, and active branch remain independent. Successful managed recoveries list shortcuts to restored files. External destinations explain their unknown absolute location. No vault object is exposed as an editable-file shortcut.
- Clipboard feedback waits for successful completion. Denied/unavailable access offers a labelled, selectable plain path for manual copying. Failed file checks offer an actionable unavailable state and no fabricated path or copy confirmation. Menu/dialog controls retain keyboard labels and disclosure focus.

The entered absolute root cannot be independently verified against the authorized handle; it is convenience text only. Filesystem operations continue through existing validated handles, verification, and branch services. No desktop helper, protocol, CAD/Explorer launching, backend, cloud integration, or storage-format change was added.

## Verification actually run

- `npm test`: **85 tests passed**, including all 73 M3 tests plus 12 focused regressions (four path/handle engine tests, one per-workspace preference test, seven DOM/application tests).
- `npm run lint`: passed (`tsc --noEmit`).
- `npm run build`: passed; the existing non-blocking Vite config-loader warning remains unchanged.
- `git diff --check`: passed.
- Static source/build audit: zero outbound-request or remote-font/AI-SDK import matches in application sources; zero fixture/handle-facade/test-library matches in production assets. This is a code audit, not observed native browser traffic.

Verification boundary: file-row action → validated handle/mapping/existence → per-workspace local preference → plain path → clipboard or manual fallback. No feature API/backend or credentials are involved. The previous local preview had stopped. A detached restart was rejected by automatic approval review (blocked by policy); running the same local preview in a normal task session succeeded. The app and updated shortcut module returned HTTP 200 on port 2500. This checks delivery, not native browser behavior.

Focused tests cover normalization (drive roots, quotes, spaces, Unicode, UNC, malformed/relative/URL/traversal/device paths); nested file and non-generated branch mappings; disappearance without recreation; restored-copy destinations; per-workspace storage and clearing; session-only behavior on storage failure; deferred clipboard success, denial/unavailable fallback and cancellation; pre-save/post-save existence checks; workspace versus project context; Main inspection while Case A stays active; managed recovery and the external-destination limitation. Read-only shortcut resolution is checked against unchanged filesystem inventory.

DOM tests exercise actual application/services with a deterministic, test-only native-handle facade and mocked clipboard. They do not establish native permissions, clipboard behavior, visual layout, or OS/CAD integration.

Actual browser observation was attempted through the supported browser tool. The existing localhost tab was unavailable; opening the same localhost origin was rejected by a saved permission/managed policy. No alternate surface or browser-policy workaround was used. Actual layout/responsiveness, native keyboard/focus/top-layer behavior, native clipboard permission behavior, and screenshots remain pending. SolidWorks/assembly qualification remains pending separately; Milestone 4 is not complete.

## Run

```powershell
npm ci
npm run dev
# http://127.0.0.1:2500/
npm test
npm run lint
npm run build
npm run preview -- --host=127.0.0.1 --port=2501 --strictPort
# http://127.0.0.1:2501/
```

If the local development server already runs, refresh its existing Edge/Chrome tab rather than starting another copy on port 2500.

## Short manual sequence (pending)

1. Open the updated app in standalone Edge/Chrome. On Workspace, confirm the workspace name, Add project action, secondary workspace menu, readable cards, and collapsed location details. Open a project, confirm workspace/project/branch context; return to Workspace and confirm branch controls/banners/capture messages do not dominate it. Check desktop/narrow layouts and keyboard navigation.
2. Create/open/reconnect a disposable workspace with the optional Windows location blank. Import, capture, branch, and recovery must remain usable. For a current nested file, click Copy file path, paste the actual workspace root from Explorer, save, and paste into a plain text editor: the result must include the filename. Repeat once with no setup dialog, then copy its containing folder from More path actions.
3. Edit the setting and test a quoted path, drive root, spaces/Unicode, trailing separators, and rejected relative/traversal/URL values. UNC acceptance is a text-syntax check, not network-share qualification. Switch between two workspaces and verify separate remembered roots. Clear browser convenience data, reopen the root once, and verify path setup is offered again while projects/cases remain intact.
4. Keep Case A active and inspect a Main revision in Graph and List. Copy current working file path must identify and point to Main without changing Case A. Change/remove a disposable current file or move its branch folder: copying must report unavailable rather than show success. Restore historical bytes through the existing workflow instead.
5. Restore full and selected managed copies, expand Restored files, and verify copied paths point into the new recovery leaf. Exercise the external destination option and confirm its honest unknown-location message. If clipboard access is denied/unavailable, use the selectable manual-copy field; no success confirmation should precede an actual clipboard success.

Use disposable fixtures for these checks. Copying a path does not open Explorer or SolidWorks, and byte/path correctness does not establish assembly reference correctness.
