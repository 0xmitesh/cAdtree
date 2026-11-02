# Development and previews

Run `npm install` once, then `npm run dev` for the normal unseeded application (port 2500). Production `npm run build` builds only `index.html`; it does not include development preview entries or seed data.

## Current multi-workspace UI

Run `npm run dev:synthetic`, then open http://127.0.0.1:2517/. Alternatively, open `/tests/synthetic.html` on any normal development server. Use Chrome or Edge with origin-private filesystem support. Click **Reconnect cAdtree Synthetic Preview v2** after sample generation, then complete the required address step (for these browser-only samples, use a fictional development address such as `D:\Synthetic Cadtree`; no physical Windows folder is implied). Navigate using Explorer.

`tests/synthetic.tsx` mounts the current real `src/App.tsx` and creates 4 workspaces, 9 projects, 28 branches, 60 verified revision records, and pending working edits through the real engine. The data consists of synthetic text files, not valid CAD documents. Everything stays in this origin’s browser storage; it never selects or reads real CAD directories. The development banner stays visible. Seeds use fixed dates and a versioned browser-storage directory; IDs are generated normally. A manufacturing-drawing revision changes an actual drawing path, including for the SolidWorks samples.

Reloading reuses the same samples without overwriting preview edits. For a fresh seed, use a fresh browser profile/context or clear this development origin’s site data. Incomplete setup is retained and a new synthetic retry folder is used; a completion marker and a browser lock prevent reusing partial data or racing concurrent setup. Version v2 is separate from the earlier ad-hoc preview’s data. No samples or preview controls are imported by the production entry.

## Isolated component fixtures

`tests/preview.html` and `tests/preview.tsx` are an explicitly labelled component harness for graph edge cases, damaged records, recovery-dialog behavior, and note interaction tests. Their mocked shell and callbacks are not the current application layout. Use the multi-workspace preview above for full application UX reviews. Existing `tests/browser/workspace.spec.ts` deliberately uses this isolated harness; actual-App coverage lives in `home.spec.ts` and `layout.spec.ts`.

## Checks

- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:ui` (requires Playwright browser installation or `CADTREE_BROWSER_CHANNEL=chrome`)

`CADTREE_TEST_PORT` selects an isolated browser-test server port (default 2500). Browser tests use synthetic origin-private data and replace native directory pickers. They do not qualify the OS picker, real disk permission dialogs, or a CAD application integration.

## Review and apply selected changes (Features 3A/3B)

`npm run test:ui -- tests/browser/apply-preview.spec.ts` runs the real application with the development-only `tests/apply-preview-seed.ts` fixture. It constructs saved revisions through the existing engine: a five-file base and Part-X case, a twenty-file Main, and independently changed source/destination cases. It also leaves a working edit uncaptured. Desktop and mobile interactions verify explicit choices, notes, readiness, collision handling, unchanged active-branch/history context, and a byte/directory fingerprint of the complete managed home. The multi-workspace `npm run dev:synthetic` entry also exposes **Review changes to apply**; no fixture or test controls enter the production build.

The pure planner lives in `src/engine/apply-preview.ts`. It reuses the canonical branch baseline resolver, validated history edges, snapshot endpoint validation and snapshot comparison. It produces an ephemeral plan only; it has no working-folder handle or write callback. Keep destination baseline validation conservative and keep ordinary Compare independent of ancestry. File-only choices retain destination directories and add required parents; folder removals and empty-folder-only source changes are deferred. The working-file operation is isolated in `application-service.ts`; it recomputes a validated plan rather than accepting a UI result inventory. `application-records.ts` validates additive disk records and derives pending/captured outcomes independently of IndexedDB.


`npm run test:ui -- tests/browser/application.spec.ts` exercises the actual App at desktop and mobile widths: dirty-destination refusal, explicit final confirmation, five-file source versus twenty-file destination, reload, CAD-like edits, normal capture and revision provenance. `tests/application-fixture.ts` accepts only the named disposable origin-private fixture. No native folders are used. `src/engine/application-service.test.ts` injects failures before writes, between actions, after writes and around capture publication; it also tests recovery of recognized states, preservation of unexpected later bytes, permissions, cancellation, conflict choices, abandoned outcomes and managed-copy/migration retention.

Disk layout: `vault/applications/<destination-branch>/<operation-id>/plan.json`, `events/000001.json` etc., indexed `before/*.bin` and `source/*.bin`, and `unexpected/<recovery-id>/*.bin`. The fixed event protocol is application-specific, not a general transaction layer. Plans/events are exclusive and read back; event checksums link to the immutable plan and prior event. A verified completion paired with the capture-intent revision/manifest hash consumes provenance. Historical manifests/checksums remain unchanged. Unavailable or unresolved records block only their destination (unassignable root damage blocks all branches). Keep failed and completed evidence; no automatic cleanup is provided. Newly required folders remain even after recovery. Native Windows/CAD, external-writer races, hardware durability and large-project qualification are outside these synthetic checks.
