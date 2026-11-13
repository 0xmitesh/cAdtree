# Tutorial 3: Bring existing work into cAdtree

Six steps in the existing TutorialViewerModal, with 12 visuals: seven real cAdtree captures, two synthetic Windows 11 folder pickers and three SVG concepts. Tutorials 1 and 2, viewer behavior, product screens and import implementation are unchanged. Tutorial 4 is not implemented.

## Import behavior used as the source of truth

- Workspace: My workspaces → Home options → Import existing workspace → Choose workspace folder → native folder picker. The chosen folder must already be a cAdtree workspace. The engine creates a child folder named after the workspace inside the connected Cadtree Home (with a counter on a clash), copies and verifies the complete tree, preserves workspace/project identities, records the home registration and publishes its ready marker only after verification. Existing projects, history, reference evidence and uncaptured working files are included. The source is read, not moved or modified. The imported workspace opens automatically.
- Project: inside the workspace → Import existing project → Choose project folder → native folder picker. An ordinary CAD folder supplies the project name. The engine allocates projects/<name>, copies and verifies original files/directories into working/main, creates project/Main records and the vault, then publishes readiness. It creates no saved revision. The imported project opens automatically and is scanned. A complete cAdtree project is also supported with preserved identity/history, as the real dialog states; this tutorial teaches the ordinary CAD-folder path.
- Both dialogs precede the picker. Neither path has a post-selection name form. Copy isolation rejects equal/nested locations, ready-name/identity conflicts reject duplicate enrollment, and no existing destination is overwritten. Source folders need not be empty; new destinations are fresh. These protections are preserved, not changed for the tutorial.
- After success, the managed copy no longer depends on the source location and is not synchronized with it. Edit managed Main. Native CAD references are not rewritten; save/close before importing and check references in the copied assembly afterward.
- Implementation inspected: src/components/HomeWorkspacesView.tsx, WorkspaceProjectsView.tsx, src/App.tsx, src/engine/home-service.ts (bringWorkspaceIntoHome/register), workspace-service.ts (importProject/initializeManagedProject), copy-service.ts and fs-adapter.ts (isolation), vault-service.ts (initial empty history).

## Exact tutorial copy

Tutorial title: Bring existing work into cAdtree

### Step 1 of 6 — Create or import?

Create starts new work. Import brings existing work into a managed copy.

- Start with a connected Cadtree Home. Import existing workspace is for a workspace already created by cAdtree.
- For an ordinary CAD folder, create or open a workspace, then choose Import existing project.

Visual 1 (Concept): **Choose Create for new work; choose Import for existing work.**

Alt text: Create workspace and Create project start new managed work. Import existing workspace copies a cAdtree workspace; Import existing project can copy an ordinary CAD folder.

### Step 2 of 6 — Import an existing workspace

In My workspaces, open Home options and choose Import existing workspace.

- Select the complete Client A cAdtree workspace folder, not its parent or Cadtree Home.
- The folder picker follows the import dialog. After a successful import, Client A opens automatically.

Visual 1 (cAdtree): **1. Open Home options and choose Import existing workspace.**

Alt text: Real My workspaces page with Home options expanded and Import existing workspace highlighted.

Visual 2 (cAdtree): **2. Read the managed-copy notice and click Choose workspace folder.**

Alt text: Real Import existing workspace dialog explains the managed copy and shows Choose workspace folder highlighted.

Visual 3 (Windows): **3. Select Client A, the existing cAdtree workspace, and click Select Folder.**

Alt text: Synthetic Windows folder picker at Documents, Engineering, with Client A selected and a cursor over Select Folder.

### Step 3 of 6 — What happens to the workspace?

cAdtree creates a verified managed copy inside Cadtree Home. The original workspace stays unchanged.

- The copy includes existing projects, saved history and working edits not yet captured. cAdtree records the workspace in this home.
- After a successful import, the source location is no longer required for the managed copy. The two copies are not synchronized.

Visual 1 (Concept): **Import copies and verifies the workspace; it does not move or synchronize the source.**

Alt text: Existing Client A cAdtree workspace stays at Documents/Engineering/Client A. A verified independent copy is registered inside Cadtree Home, including projects, history and working edits.

### Step 4 of 6 — Import an existing project

Inside Client A, choose Import existing project for the separate Bracket Assembly CAD folder.

- Save and close CAD documents first. Select Bracket Assembly itself, containing Bracket.SLDPRT, Mount.SLDPRT and BracketAssembly.SLDASM.
- An ordinary CAD folder supplies the new project name. Choose a source outside the destination workspace.

Visual 1 (cAdtree): **1. In Client A, click Import existing project.**

Alt text: Real Client A workspace heading with Import existing project highlighted beside Create project.

Visual 2 (cAdtree): **2. Read the import notice and click Choose project folder.**

Alt text: Real Import existing project dialog describes the copy, advises saving and closing CAD documents, and highlights Choose project folder.

Visual 3 (Windows): **3. Select the Bracket Assembly CAD project folder and click Select Folder.**

Alt text: Synthetic Windows folder picker at Documents, Engineering, with Bracket Assembly selected and a cursor over Select Folder.

### Step 5 of 6 — Your existing files and cAdtree

For an ordinary CAD folder, cAdtree copies the files into a new managed project's Main working/main folder.

- Edit the managed Main copy from now on. The original Bracket Assembly folder stays unchanged; edits are not synchronized between copies.
- cAdtree creates project records and a revision vault. Ordinary CAD-folder import does not create a saved revision.

Notice: Check CAD references in the managed copy after import. cAdtree does not rewrite native CAD references.

Visual 1 (Concept): **Work in the managed working/main copy. The original is a separate copy, not a live connection.**

Alt text: Original Bracket Assembly CAD folder remains unchanged. The new managed project inside Cadtree Home and Client A contains working/main for editing and a separate vault for saved history.

### Step 6 of 6 — Imported and ready

Your existing work is now available in cAdtree.

- Open Client A from My workspaces, then open Bracket Assembly. In Settings, Working folder shows the Main location relative to the workspace.
- Use that managed copy for CAD work. Follow Save your first revision to record its first meaningful design state.

Visual 1 (cAdtree): **1. Find Client A in My workspaces and click Open workspace.**

Alt text: Real My workspaces page shows Client A connected with one project and an Open workspace button.

Visual 2 (cAdtree): **2. Find Bracket Assembly in Client A and click Open project.**

Alt text: Real Client A workspace lists the managed Bracket Assembly project with Open project.

Visual 3 (cAdtree): **3. Open Settings and find Working folder: this managed working/main is where you work.**

Alt text: Real Bracket Assembly Settings shows Working folder ending in working/main under the managed project folder, with a separate revision vault.

Closing hint: **Next: explore another design direction.**

## Sample state and visual provenance

The real application components and import handlers ran in Chrome on Windows using a file-loaded esbuild bundle and production app CSS. Controlled in-memory directories were exposed through the existing native-handle test facade, exercising the real filesystem adapter, import services, verification and App state transitions. Screenshots are direct 3× pixel-density captures of the rendered UI, with native keyboard-focus outlines highlighting only the relevant action. Forms were not redrawn. This harness avoids unavailable localhost access; it does not establish real native picker compatibility.

Sample state: Cadtree home, an existing empty cAdtree workspace named Client A at Documents/Engineering/Client A, and a separate ordinary Bracket Assembly folder at Documents/Engineering/Bracket Assembly. The three CAD-extension files are explicitly marked opaque tutorial fixtures, not valid SolidWorks documents: Bracket.SLDPRT (512000 bytes), Mount.SLDPRT (256000 bytes), BracketAssembly.SLDASM (128000 bytes). No real user files were used. Workspace import is followed by project import into the copied Client A. Final screens show that one managed project.

Capture assertions passed: exactly three picker-facade calls (open home, import workspace, import project), source workspace unchanged, source CAD folder unchanged, managed Main inventory matches the source byte hashes/sizes/paths, reopened home finds Client A/Bracket Assembly, zero saved revisions, no browser page errors.

The two Windows images are synthetic instructional illustrations, with generic Engineering folders, the selected source folder in both the list and Folder field, and a standard arrow cursor on Select Folder. They are not native screenshots and contain no private machine paths. Concept SVGs show exact relationships.

| Asset | Source | SHA-256 |
| --- | --- | --- |
| step-1-create-or-import.svg | Concept SVG | 2906ebe0c26ea0d8447aa18d3b6a4f39c014cc18deeed1820bbeab2951cdb25b |
| step-2-workspace-menu.png | Real running cAdtree | bf66e51c4a0ecaf939fdebaf215cdb9b6404af1fc9697f0d9f971b4df6d7763b |
| step-2-workspace-dialog.png | Real running cAdtree | c3e1e3bdaeb397eaed87275d99498fe2fc13b6c1915f5a0871a52ea60fdfd21d |
| step-2-windows-workspace.png | Synthetic Windows 11 | f261e71acc2d033b4de6fd0afd0c9e6ccabee9967a586466d732e00e5124c738 |
| step-3-workspace-copy.svg | Concept SVG | 54893062aa964be1b347b02ef39f7ff658d7cde5d9e9d875cf5ac5b44e1a5a08 |
| step-4-project-action.png | Real running cAdtree | 2af93aa8a1a0c22546a2fe95fef253f1a58d6469178d3e3ac972fb62e9b77e09 |
| step-4-project-dialog.png | Real running cAdtree | d3b714a077f9d6dd4e29f7fbac01c8b5b420e860375eecaf843ca1ab2e5b1d8e |
| step-4-windows-project.png | Synthetic Windows 11 | e1cc48ee85d940cd2dc97c91fe1b6eac36bd534b1307b13b5b89bea07baf2c4b |
| step-5-managed-files.svg | Concept SVG | 1d40ebf7e761d87138f4b416063a39f94301db6ca05711f4fdc30e92b38d3fd2 |
| step-6-workspaces.png | Real running cAdtree | b053a3277848b9a31f8d98ac6d66b80d9457904848cb899a9a1a81cb052aab87 |
| step-6-projects.png | Real running cAdtree | 9b0882ca7044384cc7947fb42fa1f9310708b74409c57b1d3c13ccea80ed1ef3 |
| step-6-managed-main.png | Real running cAdtree | 8f7b0e30cbcc61e0b91935d5cfca935572005726b80a8c29091c929eb19e8f3d |

## Integration and files changed

LearnCadtree imports BRING_EXISTING_WORK_TUTORIAL and changes only existing-work from coming-soon to available, binding its existing Start tutorial action to the shared viewer. No shared viewer, carousel, layout, CSS, engine, filesystem behavior, dependency or existing tutorial content changed. The two later cards remain noninteractive.

- src/tutorials/bring-existing-work.ts — six-step definition.
- src/tutorials/bring-existing-work.test.ts — asset and behavior-copy contract.
- src/components/import-tutorial.test.tsx — connected-work isolation, carousel/navigation, gating, keyboard, close/replay and finish.
- src/components/LearnCadtree.tsx — enable only Tutorial 3.
- src/components/learn-cadtree.test.tsx — three available cards, two coming soon.
- src/components/revision-tutorial.test.tsx — remaining coming-soon count only.
- public/tutorials/bring-existing-work/ — 12 visuals listed above.
- docs/tutorial-3.md — this walkthrough, exact copy and validation record.

## Validation

- npm test: 294 passed, including both new Tutorial 3 component tests, existing Tutorials 1/2 and workspace/project import suites.
- node node_modules/tsx/dist/cli.mjs --test src/tutorials/*.test.ts: 4 passed.
- npm run lint: TypeScript passed.
- npm run build: production build passed; existing Vite native-config and bundle/dynamic-import warnings remain.
- Chrome rendering at 1366×900, 1100×1244 and 390×844: all 12 Tutorial 3 visuals loaded at each size, one image at a time, no horizontal overflow, gated Next/Finish, independent step/image navigation, Finish focus restoration, no picker calls and no page errors. Tutorials 1 and 2 still open correctly.
- Capture/test inventories confirm original and managed bytes/records remain unchanged by tutorial browsing. No project, revision or import is created by the tutorial itself.

## Short manual walkthrough and limits

1. On the homepage, find Bring existing work into cAdtree and choose Start tutorial. Check the Create/Import distinction and the cAdtree-workspace requirement.
2. In steps 2 and 4, confirm Next stays disabled until all three visuals have been viewed; image arrows must stay within the step. Go Back and return: the image should reset to the first.
3. Read the workspace-copy and managed-Main diagrams. Confirm unchanged originals, no sync, no revision from ordinary import, and the CAD-reference notice are clear.
4. In the final step, inspect Client A, Bracket Assembly and Settings → Working folder. Finish, replay and Close; only the tutorial should change.
5. Native follow-up: on a supported desktop browser, use disposable real folders for both import routes, check original bytes remain unchanged, reopen the managed copy without the source attached, and open a real CAD assembly from managed Main to check document references.

Actual OS tested: Windows (automated Chrome rendering and simulated native directory handles). Real operating-system folder picker interaction, physical filesystem imports and SolidWorks assembly behavior were not manually verified. macOS and Linux were not tested. No unresolved uncertainty about the inspected happy-path copy behavior; the remaining limits are native/device validation.
