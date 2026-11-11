# cAdtree: guide for agents

This is the stable guide for anyone working on this repo: vision, architecture, rules that must never break, and how we work. It changes rarely.

The live status lives elsewhere: what's done, what's next, open decisions and the decision log are in the claude.ai Project doc **"cAdtree — Current state & next steps"**. Read both before starting. If the code and these docs disagree, trust the code and point out the difference. Never silently rewrite an earlier decision.

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
Cadtree Home                 one user-chosen root; .cadtree-home.json + .cadtree-home/workspaces/<registrationId>.json (+ .ready.json)
└── <Workspace>/             .cadtree-workspace.json (workspaceId), projects/
    └── projects/<Project>/  .cadtree/{project.json, ready.json, attempt.json, branches/<branchId>.json}
        ├── vault/           objects/<2>/<sha256>.bin, revisions/, branches/, completed/, components/, references/,
        │                    applications/, case-lifecycle/, staging/  (immutable, verified history)
        ├── working/main     Main's working files (the user edits these in CAD)
        ├── working/<Case>   one independent working folder per design case (branch)
        └── recoveries/copy-<uuid>   restored copies (Item 4 plans to remove "Restore copy")
```

**Concepts:**
- **Revision:** an immutable, project-wide snapshot with notes. Revisions don't nest folders: bytes live in `vault/objects`.
- **Design case:** a branch from a saved revision, with its own working folder. Cases are archived, never auto-deleted.
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
- These still use UUIDs: home, workspace, registration, project and component IDs (`home-`, `workspace-`, `registration-`, `proj-`, `component-<uuid>`) and recovery copy folders (`copy-<uuid>`). Except `registration-` and `copy-`, they don't appear in paths.

**OS clutter:**
- Untracked `.DS_Store`, `Thumbs.db`, `desktop.ini` and AppleDouble `._x` companions (when `x` exists) are skipped and listed in scans and captures. Tracked ones are handled like any file.
- The same rule applies to every verify-after-write comparison.
- Empty-folder checks tolerate clutter-named files.
- Code: `partitionSystemFiles`, `isEffectivelyEmpty` in `src/engine/scanner.ts`.

**Stack:**
- React 19, TypeScript, Vite and Tailwind.
- The browser File System Access API. Chromium only; Safari and Firefox don't work.
- Firebase Auth for sign-in. Sign-in doesn't upload files.
- The user's filesystem is authoritative. IndexedDB holds only convenience state: remembered handles and preferences.

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
   - Future worst case = project path + internal reserve, or project path + case allowance (32) or recovery prefix + the longest user file or folder. The reserve is computed from the real path builders in `src/engine/path-budget.ts` and guarded by a drift test (currently 110). New internal paths must keep `npm test`'s drift test green.
   - Checks run in the engine after the final folder name is chosen and before the first write: workspace, project create/import/adopt, design case, recovery copy.
   - Existing projects are never blocked from opening or saving. An unknown home address means unchecked, never "ok".
   - Safety net: `PathTooLongError` (`src/engine/path-limits.ts`) turns `InvalidStateError`/`NotFoundError` on creates and writes at the measured real limits into "Path too long" with the real path.
   - cAdtree's own naming must never cause path errors.

## 4. How we work

**Approval and scope**
- **One feature or fix at a time.** If anything is uncertain, ask or counter-question before executing.
- **For each item:**
  1. Read the actual code.
  2. Write a short design note.
  3. Get the founder's approval before writing code.

**Roles and process**
- **Orchestrator and reviewer** (Opus): writes the design notes and the final review, and runs the tests itself.
- **Executors** (Sonnet subagents): implement small pieces from precise briefs. Each brief states the files in scope, the rules, the required tests, and asks for a report back in under 20 lines.
- **Independent review:** every piece is reviewed by an agent that didn't write it before it's merged.
- **Haiku:** only mechanical tasks, never engine code.

**Git and PRs**
- **Branches:** `cadtree-knowledge-lab` is the most up-to-date line, with all features plus the Knowledge Lab. `main` is merged later, only by the founder's decision.
- **One PR per reviewed piece:**
  - Use stacked branches named `item<N>/p<k>-…`, based on `cadtree-knowledge-lab`.
  - Merge with **merge commits, not squash**.
  - Each commit must pass lint and tests on its own.
- **Before every merge:**
  1. Fast-forward the local `knowledge-lab` checkout to the current GitHub `cadtree-knowledge-lab`. Never test against a stale copy.
  2. Test the piece on top of it.
  3. After merging, confirm the GitHub tree equals the tested tree.
  4. Fast-forward the local checkout again.
- **Never commit, push, open a PR, merge or deploy without the founder's explicit approval.**

**Verification:**
- Run real checks: `npm run lint`, `npm test`, `npm run test:knowledge-lab` and `npm run build`. Use hands-on Chrome checks on disposable homes where relevant.
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
npm test                     # engine/history/knowledge/components (~548 tests)
npm run test:knowledge-lab   # 27 tests
npm run build
npm run test:ui              # Playwright; needs `npx playwright install chromium` or CADTREE_BROWSER_CHANNEL=chrome
node tests/tutorial-{3,4,5}-capture.cjs   # regenerate tutorial screenshots (needs Google Chrome; run `npm run build` first);
                                          # keep only PNGs whose content really changed (dates/layout drift otherwise)
```

**Environment notes**
- **Requirements:** Node 24 LTS, version 24.12 or newer.
- **Flaky tests:** `src/components/navigation-cleanup.test.tsx` and `home-setup.test.tsx` sometimes fail under full-suite load. If they fail, rerun them on their own and rerun the full suite.
- **Unfinished cleanup:** some leftovers from AI Studio are still there: the package name `react-example`, unused dependencies (`@google/genai`, `express`, `dotenv`, `motion`) and a Gemini key in `.env.example`. None of them are used.

**Local checkouts**
| Machine | Location |
|---|---|
| Windows | `C:\Users\1\Documents\cAdtree\{main,knowledge-lab,_test-home}` |
| Mac | `~/Documents/cadtree/{main,knowledge-lab}` |

On Windows, `_test-home` has a deliberately deep path for reproducing path-budget problems.

**Agent environment** (Claude sessions with a connected folder):
- **The device shell is a Linux sandbox.** It has no GitHub credentials, can't install Windows or macOS software, can't serve to Chrome, and kills background processes when each call ends. The founder starts the dev server in macOS Terminal.
- **Claude in Chrome checks:** an injected script can't reliably open the native folder picker. Let the founder click buttons that open pickers, and don't inspect the tab while a picker is open.
- **Running tests:** run them in the cloud session's own clone of GitHub `cadtree-knowledge-lab`, with Node 24 (`/opt/node24/bin` on PATH), so they are never stale. Push, PR and merge go through the GitHub REST API from there (GraphQL is blocked).
- **Updating the Mac checkout:** fast-forward it after each merge with a git bundle through a temporary `_transfer` folder, and delete that folder afterwards.
- **Windows line endings:** Windows checkouts use CRLF. Use `-c core.autocrlf=input` when staging and `-c core.autocrlf=true` when updating a Windows checkout. Stage only the intended files.
- **Git writes need delete permission:** git has to delete its own lock files in the connected folder. Request delete permission again at the first git write of each session.

## 6. Key docs

- `DEVELOPMENT.md`: feature-level engineering notes.
- `USER_GUIDE.md`: the user-facing guide.
- `docs/KNOWLEDGE_M1B1.md`, `docs/KNOWLEDGE_M2_1.md` and `tests/knowledge-lab/README.md`: the Knowledge Lab.
- `docs/signup-integration.md`: authentication.
- `docs/tutorial-*.md`: the tutorials.
