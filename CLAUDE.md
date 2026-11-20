# cAdtree: guide for agents

This is the stable guide for anyone working on this repo: vision, architecture, rules that must never break, and how we work. It changes rarely.

The live status lives elsewhere: what's done, what's next, open decisions and the decision log are in the claude.ai Project doc **"cAdtree — Current state & next steps"**. Read both before starting. If the code and these docs disagree, trust the code and point out the difference. Never silently rewrite an earlier decision.

**Settled decisions are listed in §7 and the architecture is in §2.** Read both before proposing a change. A change that reverses or weakens a §7 decision, an invariant in §3 or the architecture in §2 needs the founder's explicit approval first: name the decision and say why in the design note.

## 1. Vision

**cAdtree is a local-first, software-agnostic, Git-inspired history and experimentation system for CAD work. It runs fully in the browser.** Engineers keep using SolidWorks, AutoCAD and other tools, and they keep control of their files. cAdtree saves recoverable project revisions, lets them branch into design alternatives, compares and applies changes deliberately, and records *why* decisions were made. It's free for individual users.

North star: *the freedom to experiment, the ability to recover, and a trustworthy memory of how and why designs evolved.*

- **Primary users:** individual engineers, students, freelancers and small teams who don't have enterprise PDM.
- **First qualification target:** SolidWorks parts, assemblies and drawings on Windows, in Chrome or Edge.
- **Product stage:** exploration. Work on one feature or fix at a time. Keep the UI minimal and in the current theme, with no duplicate pages or navigation.

**Out of scope unless the founder explicitly reopens it:**
- parsing native SolidWorks or ANSYS files, geometry diffs or merges, or CAD automation;
- a CAD viewer or editor;
- automatic semantic merges of binary files;
- daemons, required desktop installs, mandatory cloud uploads, or new backend services and databases without a demonstrated need;
- AI certification of engineering correctness.

**Never claim:**
- that a hash change means geometry changed;
- that a note, citation or checksum proves an engineering claim;
- that collaboration, cloud storage or AI answering exists before it's built and tested.

## 2. Conceptual model

```
Cadtree Home                 one user-chosen root; .cadtree-home.json + .cadtree-home/workspaces/<registrationId>.json (+ .ready.json);
│                            offline guide: _README cAdtree.txt, _INDEX cAdtree.txt (derived text)
└── <Workspace>/             .cadtree-workspace.json (workspaceId), projects/
    └── projects/<Project>/  .cadtree/{project.json, ready.json, attempt.json, branches/<branchId>.json}; _MAP cAdtree.txt (derived text), _RESTORE cAdtree.html (derived page)
        ├── vault/           objects/<2>/<sha256>.bin, revisions/ (<rev>.manifest.json + derived <rev>.txt listing), branches/, completed/,
        │                    components/, references/, applications/, case-lifecycle/, staging/  (immutable, verified history)
        ├── working/main     Main's working files (the user edits these in CAD)
        ├── working/<Case>   one independent working folder per design case (branch)
        └── Discarded/       <date time>/ copies of discarded or replaced unsaved changes (+ `_DISCARDED cAdtree.txt`), never deleted by cAdtree
```

**Concepts:**
- **Revision:** an immutable, project-wide snapshot with notes. Revisions don't nest folders: bytes live in `vault/objects`.
- **Design case:** a branch from a saved revision, with its own working folder. Cases can be hidden and unhidden, never auto-deleted (see §7).
- **Apply:** two modes. Merge ("Copy files from <case>") brings a design case's changes into another branch. Revert ("Bring back") makes a branch match an earlier revision of itself. Both save a revision automatically after a successful write (one Confirm, reason optional; `applyAndSave`). Discard and Get this version use the same machinery (`replaceWorkingFiles`) but replace working files without saving: the result is unsaved changes, and what they replace is kept in `Discarded/`.
- **Component identity:** a stable ID that is separate from the filename. Renames are confirmed explicitly, and identity is never guessed from names or hashes.
- **Reference:** a versioned supporting document pinned to a revision or component.

**Folder names are the readable names users chose** (Item 1, 2026-11-10): `Client ABC`, `projects/Packaging Gripper`, `working/Lighter collar`.
- `src/engine/folder-names.ts` (`folderNameFor`, `pickFreeName`) is the only allocator.
- It is cross-platform safe: illegal characters become `-`, reserved names get a counter (`CON (2)`), and names are capped at 255 UTF-8 bytes.
- Name clashes are case-insensitive and get a counter, e.g. `Name (2)`.
- `main` is reserved under `working/`.
- CAD and part files are never renamed.

**Identity comes from metadata IDs, never from folder locations.**
- Projects are found by `projectId`. Stored `containerPath`, `vaultPath` and `workingPath` are informational; only the working leaf name is used.
- Workspaces are found by `workspaceId`. If a registered folder is missing, the lookup by ID is read-only.
- Copies that share an ID are marked duplicate and read-only, never merged.
- We are in a building phase with no active users, so old on-disk formats need not stay readable. Some readers still accept older shapes, but new code must not depend on that.
- Display names live in metadata. Renaming a workspace or project folder in Finder or Explorer changes its location, not its name (current behaviour; an open product decision may change it).

**IDs** (`src/engine/ids.ts`, the generators and validators):
- Record ID `YYYYMMDD-HHMMSS-xxxxxx`: UTC time plus 6 random lowercase `[0-9a-z]`. Used for design cases (branch IDs, except Main), revisions, references and Knowledge Lab records.
- Event ID `YYYYMMDD-HHMMSS`, with `-2`…`-999` on a clash. Used for Apply operations and for recovery attempts of an interrupted Apply (`applications/<case>/<apply>/unexpected/<recovery>/`).
- Main stays `branch-main`. No type prefixes. Branch and project names never go into IDs. Never infer order from an ID; parent links and recorded timestamps decide it.
- Vault objects stay content-addressed: `objects/<2>/<sha256>.bin`.
- Clashes are detected with `FileConflictError` (`src/engine/fs-adapter.ts`) and then redrawn or counted, never overwritten.
- These still use UUIDs: home, workspace, registration, project and component IDs (`home-`, `workspace-`, `registration-`, `proj-`, `component-<uuid>`). Except `registration-`, they don't appear in paths.

**OS clutter:**
- Untracked `.DS_Store`, `Thumbs.db`, `desktop.ini` and AppleDouble `._x` companions (when `x` exists) are skipped and listed in scans and captures. Tracked ones are handled like any file.
- The same rule applies to every verify-after-write comparison.
- Empty-folder checks tolerate clutter-named files.
- Code: `partitionSystemFiles`, `isEffectivelyEmpty` in `src/engine/scanner.ts`.

**Stack:**
- React 19, TypeScript, Vite and Tailwind.
- The browser File System Access API. Chromium only; Safari and Firefox don't work.
- Firebase Auth for sign-in, which is **optional** (2026-11-19, #105): local work never needs an account. Firebase is loaded lazily (`src/auth/firebase-adapter.ts` via `import()` from `src/auth/firebase-auth.ts`). Convenience storage (`idb-store`) uses one browser scope, not one per account. Sign-in doesn't upload files.
- The user's filesystem is authoritative. IndexedDB holds only convenience state: remembered handles and preferences.

**Code map** (`src/engine` unless noted). Put new code in the layer that owns the concern; don't duplicate an owner.
- **Filesystem and integrity primitives:** `fs-adapter` (adapter interface, `FileConflictError`, real and in-memory adapters), `object-store` (content-addressed objects, verified write/read), `copy-service` (bounded, verified tree copy), `scanner` (working-folder scan, OS clutter; optional `knownHashes` cache used only by automatic scans, capture always hashes everything), `locks` (single-writer Web Locks), `hash` / `hash.worker` (SHA-256), `path-encoding`, `idb-store` (convenience state only), `types`.
- **Naming and IDs:** `folder-names` (the only folder-name allocator), `ids` (record and event IDs).
- **Path budget:** `path-budget` (limits, templates, reserve, worst-case paths), `path-limits` (measured real limits, "Path too long" safety net), `src/utils/path-budget-message.ts` (UI wording).
- **Home, workspace, project:** `home-service`, `workspace-service`, `vault-service` (vault initialisation, validation, loading).
- **History:** `revision-service` (capture), `branch-service` (create a design case), `branch-state`, `case-lifecycle` / `case-lifecycle-service` (Hide case / Unhide; stored as lifecycle status `archived`, with `unsavedAtHide`), `case-activity`, `snapshot-comparison`; views in `src/history/` (`layout` graph from parent edges and `copies` (dashed links from captured application records), `file-history`, `reference-browser`).
- **Apply (Copy files, Bring back, Discard, Get this version):** `apply-preview` (read-only plans: `buildApplyPreview` for merge and revert, `buildReplacePlan` for Discard and Get this version; `ReplacePlanChangedError` when a confirmed replace plan is stale), `application-service` (`applyAndSave`: apply then save under one project lock; `replaceWorkingFiles` with modes `discard` and `restore-file`, keeping a copy in `Discarded/`; `recoverApplication` (undo an unfinished one); `abandonApplication` = "Don't save it" for a written but unsaved Bring back or Copy), `application-records` (sealed records; status `done` for a finished Discard or Get this version; `isFinishedOperation`), `discarded-paths` (`Discarded/<date time>/` names, shared with `path-budget`); the save is `captureUnderLock` with an `expectedSnapshot` (`revision-service`).
- **Restore primitive and Export:** `recovery-service` (`restoreRevisionToFolder`, used by design-case creation; the name is historical), `review-export` (Export a copy; can include the revision's references).
- **Identity and references:** `component-identity`, `references`.
- **Offline guide:** `offline-guide` (pure text builders for the home Readme and Index, project Map and revision listings; `refreshProjectGuide` / `refreshHomeGuide`, the only writers; best-effort, never throw) `offline-restore-page` (pure builder of the self-contained `_RESTORE cAdtree.html`; its script is in `offline-restore-page-script`) and `offline-guide-paths` (file names and paths, shared with `path-budget`). The app calls them after successful operations through `src/app/offline-guide-refresh.ts` (`refreshGuidesAfter`, fire-and-forget, no React state).
- **Knowledge Lab:** `src/knowledge/` (index, retrieval, persisted `records/`), test vault and Explorer under `tests/knowledge-lab`.
- **UI shell:** `src/App.tsx` (shared state; home/workspace/project open and leave, `leaveProject`; the home-address prompt; Back/Forward wiring; home and workspace views) and `src/app/`:
  - shell components: `NavigationRail`, `AppNotices`, `AppDialogs`, `ProjectViews` (the project tabs inside App's keyed container);
  - `useOperation` (`perform`: one operation at a time, busy state, progress, banners, cancellation via `context.signal`; `context.current()` stops updates from an operation that has been replaced or unmounted) and `useAuthSession` (sign-in/out);
  - `useAutoRefresh` (quiet automatic scans and re-reads outside `perform`, no busy state or banner; `perform` aborts it first);
  - action hooks per concern: `useCaptureActions`, `useApplicationActions` (Bring back and Copy files, Save now, Don't save it, undo unfinished), `useDiscardActions`, `useGetVersionActions`, `useBranchActions` (incl. Hide case / Unhide), `useDiagnosticsActions`, `useReferenceActions` (add reference, stop applying), `useReviewActions`. Each takes the current render's values and setters and runs its work through `perform`; hooks that write project files (all except `useDiagnosticsActions`) call `assertProjectWritable(context)` first;
  - `types.ts` (shared types incl. `Perform`, `AssertProjectWritable`), `project-lookup.ts`. `ActiveBranchPicker` is gone: the Explorer is the case switcher.
  - New UI concerns get their own hook or component here; reusable views stay in `src/components/` (e.g. `ApplyPreviewDialog`, `ApplicationStatus`, `DiscardDialog`, `GetVersionDialog`, `DesignCases`).

## 3. Invariants (never weaken)

1. **Writes are integrity-checked.**
   - A single-writer Web Lock covers each project, workspace and home.
   - Writes are staged, then read back and hash-verified.
   - Publication uses completion or ready markers.
   - New folders are created with `exclusiveCreate`.
   - The write order is fixed. For example, a home registration is written before its folder. A design case goes: exclusive staging attempt, working folder, restored files, workspace breadcrumb, vault branch record, then the ready marker last.
2. **Fail conservatively.** Damaged, ambiguous or incomplete state becomes read-only or reported, never silently repaired, rebound or overwritten. Leftovers from failed attempts are kept and never reused: a retry gets `(2)`.
3. **Never touch a user's real CAD folders.** Tests and experiments use disposable homes and in-memory adapters (`InMemoryFileSystemAdapter`). Retrieval and history views do no writes.
4. **Review before apply.** Older parts may not fit newer assemblies, so conflicts are surfaced and never hidden.
5. **Knowledge Lab trust rules** (`src/knowledge`, `tests/knowledge-lab`):
   - Originals are authoritative; derived indexes can be rebuilt.
   - Identity is verified, never guessed.
   - Provenance survives every layer.
   - Record ownership, citation origin and citation applicability are three separate things.
   - Checksum-verified *metadata*, verified *attachment bytes* and a validated *engineering claim* are three separate levels.
   - Missing information is shown, and "no match" is never presented as "nothing happened".
   - Read-only by default. Determinism comes before AI.
   - The Explorer is development-only, on port 2727.
6. **Browser path limits.**
   - Measured with Chrome on Windows: folder creation fails at a full path of 248 characters or more, and file writes fail at about 252 or more (because of `.crswap`).
   - Measured with Chrome on macOS (10 Nov 2026): a single name may be 255 characters (macOS counts characters; 120 three-byte characters = 360 bytes were accepted). Folder and file creation fail at a full path of 1024, and file writes at 1017 (`.crswap`). Linux is still unmeasured.
   - **Enforced rule (Item 2):** one standard on every platform. The full absolute path is counted in UTF-16 units; warn from 200, block above 240, plus 7 for the `.crswap` sibling of a written file; names are capped at 255 bytes.
   - Future worst case = project path + internal reserve, or project path + case allowance (32) + the longest user file or folder, where the `Discarded/` prefix (≤ 30, templates in `path-budget`) stays under the 41-character case allowance (`working/` + 32 + `/`) so the reserve stays 110, and where the design-case check also counts the 32-character incomplete marker (`_CADTREE_RECOVERY_INCOMPLETE.txt`) written into `working/<case>/` if creation fails. The reserve is computed from the real path builders in `src/engine/path-budget.ts` and guarded by a drift test (currently 110). New internal paths must keep `npm test`'s drift test green.
   - Checks run in the engine after the final folder name is chosen and before the first write: workspace, project create/import/adopt, design case.
   - Existing projects are never blocked from opening or saving. An unknown home address means unchecked, never "ok".
   - Safety net: `PathTooLongError` (`src/engine/path-limits.ts`) turns `InvalidStateError`/`NotFoundError` on creates and writes at the measured real limits into "Path too long" with the real path.
   - cAdtree's own naming must never cause path errors.

## 4. How we work

**Approval and scope**
- **One feature or fix at a time** (related small cleanups may be batched, see Batching in Roles and process). If anything is uncertain, ask or counter-question before executing.
- **Name work by its title or problem** (e.g. "Remove Restore copy"), not by a bare item number, in reports, briefs and PR titles.
- **For each item:**
  1. Read the actual code.
  2. Write a short design note.
  3. Get the founder's approval before writing code.

**Roles and process**
- **Orchestrator** (the main chat, Opus): reads the code, writes the design notes, briefs the subagents, does the final review of every diff, runs all checks itself on the final head, opens and merges the PRs, updates the local checkout and the status doc. It keeps its own context small: broad code searches go to a read-only Explore subagent, not into the main chat.
- **Executor** (subagent, model Sonnet 5.5, effort high): implements one piece from a precise brief. Each brief states the problem, the files in scope, the rules (cite CLAUDE.md sections), the required tests, the verification commands and the commit message; it asks for a report back in under 20 lines. Executors commit on the feature branch but never push.
- **Independent reviewer** (subagent, model Opus 5.5, effort medium): reviews every piece before it's merged. It never edits, commits or pushes. Its brief says what to check (correctness, every write path, invariants, whether the tests fail without the fix) and asks for a verdict with blocker/should/nit findings in under 20–25 lines. Should-fix findings go back to the same executor as a follow-up commit; the orchestrator checks the follow-up diff itself.
- **Critical refactors** (e.g. the `App.tsx` split, 2026-11-15): the founder may choose Opus 5.5 (medium) to implement and Opus 5.5 (high) to review instead of Sonnet. Pure refactors must prove they change nothing: bodies moved word for word, effect order unchanged, and rendered `body.innerHTML` identical between base and head in many app states (seeded clock, `Math.random`, `crypto.getRandomValues` and `randomUUID`; compare same-run pairs).
- **Haiku:** not used for reviews or engine code; at most for purely mechanical chores.
- **Design notes for the simplification plan (18 Nov 2026):** required only for engine phases (Phases 3 and 4); UI-only phases used the approved plan as approval.
- **Parallel pieces** are built in git worktrees and merged one at a time; every commit still passes lint.
- **Batching:** small, related cleanups may share one PR, with one commit each. Anything touching identity, writes or invariants gets its own PR.
- **Standing approval:** once the founder approves an item (or its design note), the orchestrator may commit, push, open the PR and merge it when the review has no open blockers or should-fix items and all checks pass on the final head. It reports after each merge.

**Git and PRs**
- **Branches:** `main` is the development line for everything, including the Knowledge Lab (since 2026-11-13). `cadtree-knowledge-lab` is frozen at `3fc4fdf`, the same tree as `main` when development moved; nothing new goes there.
- **One PR per reviewed piece** (small related cleanups may be batched, see Batching above):
  - Use stacked branches named `item<N>/p<k>-…`, based on `main` (`housekeeping/p<k>-…` or `docs/p<k>-…` for work outside an item).
  - Merge with **merge commits, not squash**.
  - Each commit must pass lint and tests on its own.
- **Before every merge:**
  1. Fast-forward the local `main` checkout to the current GitHub `main`. Never test against a stale copy.
  2. Test the piece on top of it, and check that the PR's CI checks (GitHub Actions `CI`) are green. They come in addition to the orchestrator's own runs, not instead of them. GitHub Free can't enforce required checks on a private repo, so this is process-only: read the result with the REST call `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` (GraphQL is blocked).
  3. After merging, confirm the GitHub tree equals the tested tree.
  4. Fast-forward the local checkout again.
- **Never commit, push, open a PR or merge without the founder's explicit approval** (an approved item carries standing approval to merge it, see above). Never deploy.

**Verification:**
- Run real checks: `npm run lint`, `npm test`, `npm run test:knowledge-lab` and `npm run build`, plus `npm run test:ui` when UI or specs change. Use hands-on Chrome checks on disposable homes where relevant.
- Report only the commands that actually ran, with their results.
- Don't turn sandbox network failures into claims that the app works.
- Update the status doc at the end of each session instead of writing new handoff documents.

## 5. Commands and environment

```
npm ci                       # install (never npm install / never edit the lockfile casually)
npm run dev                  # app, http://127.0.0.1:2500 (real Firebase sign-in)
npm run dev:synthetic        # synthetic preview, :2517 (fake "Test Engineer" sign-in; seeds 4 workspaces/9 projects)
npm run dev:knowledge-lab    # :2727, Knowledge Explorer at /tests/knowledge-lab.html
npm run lint                 # tsc --noEmit
npm test                     # engine/history/knowledge/components (~630 tests)
npm run test:knowledge-lab   # 27 tests
npm run build
npm run test:ui              # Playwright; needs `npx playwright install chromium` or CADTREE_BROWSER_CHANNEL=chrome
node tests/tutorial-{3,4,5}-capture.cjs   # regenerate tutorial screenshots (needs Google Chrome; run `npm run build` first);
                                          # keep only PNGs whose content really changed (dates/layout drift otherwise)
```

**Environment notes**
- **Requirements:** Node 24 LTS, version 24.12 or newer (pinned by `.nvmrc` and `engines` in `package.json`; `engine-strict` is off).
- **CI:** `.github/workflows/ci.yml` (workflow `CI`) runs lint, `npm test`, `npm run test:knowledge-lab` and `npm run build` on every push to `main`, on every PR and on manual runs, and the Playwright browser tests (Playwright's Chromium, `LC_ALL=C.UTF-8`) on PRs and manual runs. It never deploys.
- **Flaky tests:** `home-setup.test.tsx` and `branches.test.tsx` may still fail under full-suite load (each passes alone). If one fails, rerun it on its own and rerun the full suite. `navigation-cleanup.test.tsx` was a focus race, fixed in #75; if it fails now, treat it as real.
- **Browser tests in the cloud sandbox:** run `npm run test:ui` with Playwright's own Chromium (`npx playwright install chromium`, no `CADTREE_BROWSER_CHANNEL`) and `LC_ALL=C.UTF-8`. The sandbox's system Chrome crashes when it reads stored OPFS handles. On Windows or Mac, `CADTREE_BROWSER_CHANNEL=chrome` is fine.
- **AI Studio leftovers (kept on purpose):** the repo still syncs with Google AI Studio, so the package name `react-example`, `metadata.json` and the Gemini placeholder in `.env.example` stay. The unused dependencies (`@google/genai`, `express`, `dotenv`, `motion`) were removed, and the stale status-doc copy in `public/assets/aistudio/` is gone.

**Local checkouts**
| Machine | Location |
|---|---|
| Windows | `C:\Users\1\Documents\cAdtree\{main,_test-home}` |
| Mac | `~/Documents/cadtree/main` (an old `knowledge-lab` checkout there is retired and can be removed) |

On Windows, `_test-home` has a deliberately deep path for reproducing path-budget problems.

**Agent environment** (Claude sessions with a connected folder):
- **The device shell is a Linux sandbox.** It has no GitHub credentials, can't install Windows or macOS software, can't serve to Chrome, and kills background processes when each call ends. The founder starts the dev server: in Terminal on the Mac, or on Windows by double-clicking `C:\Users\1\Documents\cAdtree\start-cadtree-dev.cmd` (outside the repo; it checks Node, installs packages if missing, runs `npm.cmd run dev` and keeps its window open on errors). Computer use can't type into terminals, so agents can't start it.
- **Claude in Chrome checks:** an injected script can't reliably open the native folder picker. Let the founder click buttons that open pickers, and don't inspect the tab while a picker is open.
- **Playwright ports and git stash:** set `CADTREE_TEST_PORT` per worktree so parallel `npm run test:ui` runs don't collide. `git stash` is shared across worktrees; executors commit instead.
- **Running tests:** run them in the cloud session's own clone of GitHub `main`, with Node 24 (`/opt/node24/bin` on PATH), so they are never stale. Push, PR and merge go through the GitHub REST API from there (GraphQL is blocked). The session's proxy supplies the GitHub credentials; send `Content-Type: application/json` with every write request, or PR creation fails without a clear error.
- **Updating the local checkouts:** after each merge into `main`, fast-forward the local `main` checkout with a git bundle through a temporary `_transfer` folder, confirm its tree equals GitHub's, and delete that folder afterwards. Give every bundle a unique file name (e.g. `main-<short sha>.bundle`) and check `git bundle list-heads` on the device before fetching: re-sending a file under the same name has delivered a stale copy. Fetch with enough history before bundling (`git fetch --depth=50 origin main` in the shallow cloud clone) and run `git bundle verify`: a too-shallow clone produced a bundle that "did not send all necessary objects".
- **Windows line endings:** Windows checkouts use CRLF. Use `-c core.autocrlf=input` when staging and `-c core.autocrlf=true` when updating a Windows checkout. Stage only the intended files.
- **Git writes need delete permission:** git has to delete its own lock files and replace files in the connected folder. Request delete permission at the first git write of each session **and again after the desktop app reconnects** (the grant doesn't survive a reconnect). Before any git write, check that a test delete works and **stop if it fails**: without permission a fast-forward half-applies, leaving `.git/index.lock` and partly written files.

## 6. Key docs

- `DEVELOPMENT.md`: feature-level engineering notes.
- `USER_GUIDE.md`: the user-facing guide.
- `docs/KNOWLEDGE_M1B1.md`, `docs/KNOWLEDGE_M2_1.md` and `tests/knowledge-lab/README.md`: the Knowledge Lab.
- `docs/signup-integration.md`: authentication.
- `docs/tutorial-*.md`: the tutorials.
- Design notes for each item live in the claude.ai Project (e.g. `cAdtree_Item1_Readable_Folder_Names_Design_Note_2026-11-10`, `cAdtree_Item2_Path_Budget_Design_Note_2026-11-10`, `cAdtree_Remove_Restore_Copy_Design_Note_2026-11-11`).
- **Historical, not current:** `IMPLEMENTATION.md`, `MILESTONE2.md`, `MILESTONE3.md`, `USABILITY_REFINEMENTS.md` and `docs/navigation-r*.md` record earlier milestones (they still describe Restore copy, old IDs and old counts). Don't treat them as the current design.

## 7. Settled decisions (reopen only with the founder)

These are decided. Build on them; don't redesign around them. The full decision log, with the reasoning, is in the status doc and the Project's design notes. Grouped by topic.

**Product and scope**
- The Knowledge Lab is an evidence-and-decision memory, not CAD intelligence. Native SolidWorks and ANSYS parsing were rejected (2026-11-09).
- Local-first and browser-only: the user's filesystem is the source of truth; no backend, database or required install without a demonstrated need (§1).
- We are in a building phase with no active users: old on-disk formats don't need to stay readable, and compatibility code may be removed (2026-11-11; legacy reference readers removed in #61).
- Automatic scan (2026-11-19, #106): the open project or page is re-checked quietly when the tab or window regains focus and after Apply or Bring back (`useAutoRefresh`, outside `perform`, no write, no lock); the Scan for changes, Refresh home and Refresh workspace buttons are gone.
- Optional sign-in (2026-11-19, #105): no sign-in gate for local work; sign-in lives in an Account control in the navigation rail and is described as being for future features, without claiming they exist (§1).
- Settings and History details live in collapsed Troubleshooting sections (2026-11-18, #99, #100).
- Notes UI shows one Description/Note field (`modification`) with More detail for Why (`problem`) and What you noticed (`observations`); the data model is unchanged (2026-11-18, #101).

**Storage, names and IDs**
- Folders carry the readable names users chose; identity comes from metadata IDs, never folder locations. `folder-names.ts` is the only allocator: illegal characters → `-`, case-insensitive clash → `(2)`, reserved names → `CON (2)`, 255-byte cap (Item 1, 2026-11-10).
- A Finder or Explorer rename changes a folder's location, not its display name (kept for now; open decision on adopting or showing both).
- One ID standard: record ID `YYYYMMDD-HHMMSS-xxxxxx` for cases, revisions, references and Knowledge Lab records; event ID `YYYYMMDD-HHMMSS` + counter for Apply and recovery; no type prefixes; no branch or project names in IDs; vault objects stay content-addressed by SHA-256 (2026-11-10/11).
- Clashes are detected with `FileConflictError` and redrawn or counted, never overwritten, and never detected by matching error text (2026-11-11, #60).
- OS clutter files are ignored only when untracked, and the same rule applies to every verify-after-write check (2026-11-10).

**Path limits**
- One standard on every platform, so projects stay portable to Windows: warn from 200, block above 240 characters of full path, +7 for `.crswap`; cAdtree's own IDs were shortened first so its naming never causes path errors (Item 2, 2026-11-10).
- Allowances: 32 for a case name, 24 for a project name and 24 for a workspace name; internal reserve computed from the real path builders and guarded by the drift test (110 today).
- The home address is asked for before the next create or import when it's unknown; the home-setup warning appears only when the address leaves less room than the default name allowances (2026-11-10/11).
- Existing projects are never blocked from opening or saving; an unknown home address means unchecked, never "ok"; the safety net reports this computer's measured real limit, not the 240 budget (2026-11-11).

**History and recovery**
- Every intent for an older version has one feature (2026-11-11, "Remove Restore copy", #62–#67):
  - look at or share it → **Export a copy** (can include the revision's references in `References/`; folder `<Project> - <Branch> - R<nn>`, `(2)` on a clash, cAdtree's part ≤ 64 characters);
  - make a branch match it again → **Bring back onto <branch>…** (Apply's revert mode, only for earlier revisions in that branch's history; renamed files blocked for now; one Confirm, reason optional, saved automatically, 2026-11-19, #110, #112);
  - get one file → **Get this version** (2026-11-19, #114; `replaceWorkingFiles` mode `restore-file`, built on the Apply machinery, not a parallel restore path; the result is an unsaved change, undone with Discard);
  - keep working from it → **Create design case**.
- "Restore copy" and `recoveries/` are gone and must not come back as a parallel path. Existing `recoveries/` folders are left untouched; cAdtree never deletes user data.
- Saved automatically (2026-11-19, #108, #110, #112; replaces "Apply only changes working files; the user saves a revision afterwards"): Bring back and Copy files from <case> save a revision automatically after a successful write (`applyAndSave`: the save is `captureUnderLock` under the same lock, refused if a fresh scan differs from the plan's result). Copy shows one list; files changed on both sides need Keep mine / Take theirs, with no default. If the write succeeds but the save fails, the files stay and the user is offered Save now or Don't save it. Prepare, the confirm screen and Abandon pending provenance are gone. Review before apply (§3.4) is unchanged.
- Discard (2026-11-19, #111, #113): Discard all… and Discard per file or folder put unsaved changes back to the latest saved revision without saving (`replaceWorkingFiles` mode `discard`); only the selected paths are checked and written; a stale plan is refused (`ReplacePlanChangedError`) and reviewed again. Bring back with unsaved changes offers Save my changes first or Discard them.
- Apply reviews folder changes like files (2026-11-15, #80–#81): folders added or removed between base and source are rows (pre-selected in Bring back); a removal whose folder would still hold files or a subfolder that stays is kept and not selectable; a folder to remove that holds only untracked OS clutter stops the Apply before any write (a deliberate exception to skipping untracked clutter: cAdtree never deletes it, so the user deletes it or unticks the folder); recovery undoes folder changes too. Case-only renames stay blocked at review.
- Hide case (2026-11-19, #109; replaces archive): design cases can be hidden and unhidden (whole cases only, never Main; allowed with unsaved changes after a warning, which stay in the case's folder), never auto-deleted; a hidden case is read-only and leaves the graph and the Explorer unless Show hidden cases is on. Duplicated IDs become read-only, never merged.
- Discarded copies (2026-11-19, #111): what Discard or Get this version replaces is kept in `projects/<P>/Discarded/<date time>/` (with `_DISCARDED cAdtree.txt`) and never deleted by cAdtree; a copy whose path is too long stays inside the vault only and is listed.

**Offline guide**
- Offline guide (2026-11-16): `_README cAdtree.txt` and `_INDEX cAdtree.txt` at the home root, `_MAP cAdtree.txt` and `_RESTORE cAdtree.html` per project and `vault/revisions/<rev>.txt` per revision let a user recover files without cAdtree. The restore page is self-contained (inline script, strict CSP, no network, data only through `textContent`); it restores single files by checksum (any browser) or rebuilds a whole revision into an empty folder outside the vault (Chrome or Edge, vault opened read-only), verifying every checksum. They are derived and never read back, so the vault always wins. They are written best-effort after successful operations (revision saved, case created, hidden or unhidden, project created or imported, workspace created or brought in, writable home opened), never on failure, never by opening or browsing a project, only into writable projects and homes, never into strict vault folders (`staging/`, `components/`, `references/`, `case-lifecycle/`, `applications/`), and listings are written once. The three project paths have templates in `path-budget`; the reserve stays 110. Guide format is 2.

**How we work**
- One stable `CLAUDE.md` in the repo plus one living status doc in the Project; no new handoff documents (2026-11-10).
- Every item: read the code, write a design note, get the founder's approval, then deliver in small reviewed PRs into `main` with merge commits, each tested on top of the current GitHub head (2026-11-10).
- All development, including the Knowledge Lab, happens on `main`; `cadtree-knowledge-lab` is frozen (2026-11-13).
- Cost-aware orchestration (2026-11-13, updated 2026-11-15): the main chat orchestrates; Sonnet 5.5 (high) implements; Opus 5.5 (medium) gives the independent review; the orchestrator runs the checks and merges approved items (§4). Critical refactors may use Opus (medium) to implement and Opus (high) to review, at the founder's choice.
- CI (2026-11-15, #83): GitHub Actions `CI` must be green on a PR before merging, in addition to the orchestrator's own runs; it never deploys.
- `App.tsx` split (2026-11-15, #84–#88): concerns live in `src/app/` hooks and shell components (§2 code map); home/workspace/project open-leave and Back/Forward deliberately stay in `App.tsx` (moving them was declined as not worth the risk).
