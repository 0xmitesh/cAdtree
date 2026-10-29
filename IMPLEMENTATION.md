# Workspace and revision graph

Implemented on a separate branch from upstream commit `01ea7d165dc38c8fde297ebf407f1220ad6191ce`.

The workspace uses a graphite navigation rail, neutral surfaces, teal actions, and a scrollable SVG history. History and Changes share persistent workspace context. Recent projects lead the Projects screen; setup uses a single focused native dialog. Settings contains connections, verification actions, damaged records, interrupted attempts, and collapsed advanced metadata.

The graph is a pure metadata projection in `src/history/layout.ts`. Parent revision identities determine topology. The layout is deterministic under input reordering and clock skew. Branch records determine colors; same-branch competing children receive separate lanes. Missing, corrupt, duplicate, and cyclic ancestry is flagged without invented edges. Ambiguous heads are never marked latest. Graph/List share selection and a detail panel. Selection never changes the active branch or baseline.

Changes defaults to changed files. Overall notes are optional; scoped file notes are entered from their rows. The Changes component stays mounted when navigating, preserving drafts. A capture rescan that changes the reviewed signature requires explicit re-review; drafts remain intact. Deleted files are selectable only in an earlier snapshot that contains them. Both recovery actions disclose the revision and file count before choosing a destination.

The engine, storage schema, checksums, isolation rules, no-overwrite protections, and original safety tests are unchanged. No graph dependency, backend, accounts, Git runtime, cloud storage, CAD parsing, or geometry viewer was introduced.

## Verification

- `npm ci`: reproducible dependency install using the added lockfile. The pre-existing esbuild peer conflict with Vite 8 was corrected.
- `npm test`: engine acceptance tests plus graph and React DOM integration tests.
- `npm run lint`: TypeScript check.
- `npm run build`: production build; dev preview and fixture data are not part of the production entry.
- `npm run dev`: loopback-only preview at http://127.0.0.1:2500, with a strict port to avoid opening the wrong app.
- `npm run test:ui`: browser verification and screenshots at 1366×768, 1440×900, and 390×844. Requires an installed Playwright browser and permission to inspect the local app.

The development-only entry is `/tests/preview.html`. Its `scenario` query accepts `empty`, `single`, `main`, `branches`, `long` (120 revisions), and `damaged`. It is separate from the normal application and refuses to run outside development. Preview recovery callbacks report synthetic requests; they do not invoke native folder pickers.

## Limitations of this verification session

Browser inspection was attempted using the available browser tool, including port 2500 as requested. A saved permission/managed policy and subsequent origin permission denials prevented access even after the user approved local inspection in chat. No alternate browser route was used to bypass the denial. Browser tests and screenshots therefore remain unexecuted; there are no claimed screenshots or visual QA results.

React DOM tests verify selection, keyboard events, draft retention, deleted-file navigation, recovery review callbacks, and stale capture review with the real engine against an in-memory filesystem. They do not verify actual layout, native dialog focus trapping, native directory permissions, or real disk recovery. Existing engine tests cover synthetic binary preservation and recovery safety; none of this is SolidWorks validation.

Before merging, run browser tests, inspect the generated screenshots, and exercise real folder permission, save, verify, and both recovery flows in standalone Chrome or Edge using disposable local project folders.
