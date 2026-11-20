# Milestone 3 implementation report

Specification: user-provided MVP Plan v0.3, Section 8. Starting main: `6ed9b6454bf6ac511de3db7a9830d53f3c890794`. Feature branch: `codex/managed-workspace`. The delivered report alongside the build records the final published feature commit. No merge or deployment is authorized or performed.

## Implemented behavior

- One create/open/reconnect workspace entry with multiple discovered projects. Versioned, checksummed records on disk hold workspace/project identities and branch locations. IndexedDB remembers only the root and convenience preferences for managed projects.
- Explicit import into a fresh managed Main leaf: bounded file streams, exact bytes/paths/empty directories, full destination readback, repeated source stability checks, verified vault initialization, and final project publication marker. Originals are retained. The handoff identifies the new editing location; initial capture is explicit.
- Managed case creation asks only for name/reason. The existing branch engine materializes the source, persists a portable binding under its project lock, and then publishes the branch. Capture can refresh managed bindings after taking the lock. Separate working copies share only immutable vault objects.
- Automatic fresh full/selected recovery destinations under each project's recoveries directory, with an explicit external option. Recovery adds no branch or revision. Scan/capture resolves the active working leaf only.
- Normal reopening from one authorized root resolves every intact branch without individual pickers. Missing/moved folders, unsafe mappings, unsupported schemas, permission loss, and duplicate identities are visible. Action preflight refreshes mappings before branch/recovery forms open. Usable history stays inspectable; uncertain writes are blocked.
- Guided adoption copies the old vault and all current branch working trees, retaining uncaptured changes and exact history bytes/IDs/checksums/notes. Workspace registration precedes the project lock; copied metadata and stored content objects are verified before activation. Sources remain untouched. Duplicate locations require explicit selection.
- Existing UI, Graph/List selection, notes, origin links, integrity indicators, and the established-branch ready-marker fix are preserved. The selected revision remains readable outside highlighted ancestry. External-vault workflows remain under Advanced.

## Publication and concurrency

Workspace/project location records surround the existing schema-1 vault rather than modifying it. Discovery reads validated project records; it does not depend on an indexed browser catalogue. Failed imports/adoptions retain their attempt records and destination paths. Project completion is verified before success; write-acknowledgement and browser-cache failures do not invite duplicate publication. Branch mappings are verified before the branch ready marker is published.

Workspace initialization/registration and per-project writer coordination use the existing same-origin Web Locks/in-process mechanism. Lock order is workspace registration → project; branch/capture use only the project lock, and recovery uses its separate destination lock. No repository-wide filesystem transaction, atomic directory reservation against external software, or power-loss durability is claimed.

## Checks actually run

- Baseline: **54 inherited tests passed** after aligning the local exported checkout with current main.
- Final automated suite: **73 tests passed**. Thirteen new workspace engine tests, four application integration tests, a root-only IndexedDB preference test, and a selected-revision readability regression cover the new work alongside inherited tests.
- `npm run lint`: passed (`tsc --noEmit`).
- `npm run build`: passed. The production output is the app entry plus bundled JS/CSS, with no fixture entry or runtime CDN font/script requirement.
- `git diff --check`: passed. Source/build privacy audit and local HTTP delivery checks are recorded in the delivered report.
- Static source audit: zero `fetch`, `sendBeacon`, `WebSocket`, remote-font, or AI-SDK import matches in application sources; zero fixture/test-code matches in the production assets; zero remote HTML script/style references. This is a code/build audit, not native-browser network observation. App, App module, and workspace-service module returned HTTP 200 on localhost.
- Build environment: Node `v24.19.0`, npm `12.2.1`, Vite `8.3.5`. Output: `index.html` (1,062 bytes), bundled CSS (31,511 bytes), bundled JS (382,217 bytes). The existing future Vite config-loader warning remains non-blocking.

Engine evidence includes two projects, independent IDs/history, Unicode/empty/binary files and empty directories, exact originals, Main and Cases A/B/C, global revision numbers and parents, automatic full/selected recovery, missing/overlapping mappings, schema/permission failures, duplicate locations, cancellation, unstable sources, failed publication/mappings, acknowledgement failure, adoption with uncaptured changes and corrupt-object rejection, and concurrent branch creation.

DOM integration tests use the actual application/services through a test-only native-handle facade over deterministic in-memory directories. They exercise onboarding/import, no-parent-picker cases, external recovery override, one-root rediscovery, read-only missing-leaf states and preflight, and guided legacy adoption. They do **not** establish native picker semantics, layout, browser permission persistence, or CAD compatibility.

## Unavailable checks and limits

- Native browser inspection was attempted against the existing localhost tab. The browser tool rejected observation because a saved permission/managed policy denies that origin. No alternate browser surface, raw CDP, or indirect workaround was used. Actual picker/write/readback, permission renewal/restart, keyboard focus/top-layer behavior, screenshots/responsive layout, loaded-session offline operation, and observed outbound-request auditing remain pending in the real browser.
- Real SolidWorks files were not used as development fixtures. Standalone-part, assembly, drawing, external-reference, rebuild, import/adoption, and recovery checks remain pending. Milestone 4 is not complete and no SolidWorks validation claim is made.
- A same-path physical directory replacement after all branch handles are discarded is not independently authenticated by portable path records. Missing/moved paths and identity/mapping conflicts are rejected; no name-only fallback occurs. Junctions, aliases, network shares, and cloud placeholders are outside qualification.
- Hash/inventory checks are best-effort stability checks, not an instantaneous CAD-consistent snapshot. Save/close documents before operations. Current hashing follows the existing incremental engine; responsiveness and memory on the proposed 1 GB file / 5 GB project / 1,000-file workloads have not been measured.
- Cross-origin/browser/profile/device writers, concurrent editing of retained old/managed project copies, cloud sync, in-place checkout, CAD reference rewriting, and cold offline/PWA startup are unsupported or deferred.

## Run and build

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

The deliverables include source, a static build ZIP, this report, and USER_GUIDE.md. No hosting deployment was performed.

## Actual-browser and SolidWorks checklist

Record feature commit, Windows/browser/SolidWorks versions, hardware, source project, and workspace layout. These checks are **pending**, not passed:

1. In a standalone Edge/Chrome tab, create an empty workspace and import a disposable standalone part. Test the native picker, write/readback, cancellation, and permission denial/renewal. Confirm the original stays unchanged and the UI says **Continue working in this copy**.
2. Import a second self-contained project containing an assembly, parts, a drawing, and an empty directory. Open the managed files manually and inspect actual component/drawing/external-reference paths. Close previously open documents. Temporarily make only the disposable original unavailable to expose accidental reference fallback; do not delete real production sources.
3. Capture Main 001 → 002 → 003. Create Cases A/B/C from 001 without selecting destination parents. Open each case manually, make distinct edits, save/close, and capture. Verify their parents/global numbers and all other working folders remain unchanged.
4. Leave draft summary/overall/file notes on a case, switch twice, and confirm isolation. Inspect an old revision outside highlighted ancestry: it must stay readable and must not switch the active case. Exercise keyboard navigation, dialogs, focus return, and narrow/desktop layouts.
5. Restore a full revision and selected files to automatic recovery folders, then test the external override. Verify copies, reported locations, unchanged tracked history, assembly/drawing behavior, and selected-file dependency limits.
6. Restart the browser, then clear convenience data and reopen again. Select the workspace root once; all intact projects/cases must reconnect without one picker per branch. Move a disposable case folder temporarily: it must remain disconnected/read-only until its recorded location is restored.
7. Open a disposable legacy M2 project through Advanced, connect all its current working folders once, include uncaptured edits, and bring it into the workspace. Compare history bytes and working edits; verify CAD references and explicit location selection. Continue modelling only in the chosen managed location.
8. After assets have loaded, disconnect the network and repeat core actions. Observe browser network traffic during real-mode operations: no CAD content or project metadata should leave the computer. Cold offline startup remains a separate deferred feature.
9. Measure the proposed performance workloads with elapsed time, responsiveness, and memory. Record limits rather than treating these proposed sizes as established capacity.

Next user test: begin with checklist item 1 in Edge at the local app, then qualify the small assembly/drawing before using larger real projects. Byte-perfect copies do not prove that SolidWorks resolves references to the intended folder.
