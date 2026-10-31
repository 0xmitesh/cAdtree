# Development and previews

Run `npm install` once, then `npm run dev` for the normal unseeded application (port 2500). Production `npm run build` builds only `index.html`; it does not include development preview entries or seed data.

## Current multi-workspace UI

Run `npm run dev:synthetic`, then open http://127.0.0.1:2517/. Alternatively, open `/tests/synthetic.html` on any normal development server. Use Chrome or Edge with origin-private filesystem support. Click **Reconnect cAdtree Synthetic Preview v2** after setup, then navigate using Explorer.

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
