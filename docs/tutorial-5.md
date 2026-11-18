# Tutorial 5 — Compare, apply & recover

R4 update: Design cases now lives in History; affected archive guidance and screenshots were refreshed. Original implementation/validation history below is retained.

Implemented on branch `codex/tutorial-5-compare-apply-recover` from merged main `9797d7f290d58303ab6badda3dc277eac020021f` (Tutorial 4 / PR #26). Only the final tutorial and its Learn-card availability were added. No engine, working-screen, viewer, carousel or product-style changes.

## 1. Final step structure

| Step | Title | Visuals |
| --- | --- | --- |
| 1 | Compare before deciding | 0 real screenshots; 1 concepts |
| 2 | Compare saved revisions | 4 real screenshots; 0 concepts |
| 3 | Understand what Compare means | 0 real screenshots; 1 concepts |
| 4 | Review before applying | 3 real screenshots; 0 concepts |
| 5 | Apply reviewed changes | 4 real screenshots; 0 concepts |
| 6 | Return to a saved version | 3 real screenshots; 0 concepts |
| 7 | Preserve the Design Case | 3 real screenshots; 0 concepts |

## 2. Exact user-facing copy

Title: **Compare, apply & recover**

The text below is exported directly from the final tutorial definition. Shared controls remain Previous visual / Next visual, Back / Next, Close / Close dialog and Finish. Multi-visual steps retain the existing requirement to view each image before advancing; controls remain independent.

### Step 1 of 7 — Compare before deciding

Before bringing another design direction into Main, compare the saved states first.

- In Bracket Assembly, Lightweight bracket starts from Main's Rev 003. The case reaches Rev 005 while Main continues to Rev 006.
- Compare Main Rev 006 with case Rev 005 to see which project files differ. These are saved states, not unsaved work in CAD.

Visual 1 (Concept): **Compare the saved Main and Design Case states before deciding what to reuse.**

Alt text: Main and Lightweight bracket share Rev 003. The case continues through Rev 004 to Rev 005; Main continues to Rev 006. Compare the saved Main Rev 006 and case Rev 005 before deciding.

Asset: [step-1-compare-directions.svg](../public/tutorials/compare-apply-recover/step-1-compare-directions.svg)

### Step 2 of 7 — Compare saved revisions

In History, select Rev 005 — Reinforced mounting rib, then click Compare.

- Choose From revision: Rev 006 on Main, and To revision: Rev 005 on Lightweight bracket. You can compare any two available saved revisions, including across design cases.
- Added and deleted are relative to From → To. Swap reverses that direction. Review the file counts and recorded overall and per-file engineering notes.

Visual 1 (cAdtree): **1. Select the saved revision in History and click Compare.**

Alt text: Real History details for Rev 005, Reinforced mounting rib on Lightweight bracket, with Compare focused.

Asset: [step-2-open-compare.png](../public/tutorials/compare-apply-recover/step-2-open-compare.png)

Visual 2 (cAdtree): **2. Choose From and To; Swap reverses the comparison.**

Alt text: Real Compare saved revisions selectors show From Rev 006 on Main and To Rev 005 on Lightweight bracket, with Swap between them.

Asset: [step-2-choose-states.png](../public/tutorials/compare-apply-recover/step-2-choose-states.png)

Visual 3 (cAdtree): **3. Review the file differences and the saved notes for Bracket.SLDPRT.**

Alt text: Real comparison shows one added, one deleted, two modified and one unchanged file, plus Bracket.SLDPRT's saved presence, content-hash controls and per-file notes.

Asset: [step-2-file-differences.png](../public/tutorials/compare-apply-recover/step-2-file-differences.png)

Visual 4 (cAdtree): **4. Read the engineering notes recorded at each selected revision.**

Alt text: Real Overall engineering notes compare Main Rev 006's mounting update with case Rev 005's lighter bracket and reinforcement study.

Asset: [step-2-engineering-notes.png](../public/tutorials/compare-apply-recover/step-2-engineering-notes.png)

### Step 3 of 7 — Understand what Compare means

Modified means the saved content hashes differ for the same file path. It does not tell you which CAD features or geometry changed.

- Added means present only in To; deleted means present only in From. Unchanged means matching saved content hashes. File metadata edits can change a hash too.
- Compare also lists directory additions and deletions, including empty folders. It does not assess stress, assembly references or CAD compatibility.
- Compare reads saved records; it does not rescan working files or recheck stored binary contents. Missing or damaged revision evidence makes the comparison unavailable.

Visual 1 (Concept): **A file-level difference is evidence to review, not a geometry or compatibility result.**

Alt text: At the same Bracket.SLDPRT path, Main Rev 006 has saved content A and case Rev 005 has saved content B. Different saved content hashes mean Modified; geometry and CAD compatibility still need engineering review.

Asset: [step-3-file-evidence.svg](../public/tutorials/compare-apply-recover/step-3-file-evidence.svg)

### Step 4 of 7 — Review before applying

Keep Main active. In History, select the case's Rev 005, then choose Review changes to apply.

- Source is the saved design you are bringing work from: Rev 005. Destination is the active direction you are updating: Main, with saved baseline Rev 006. Base is their shared starting state, Rev 003.
- Nothing starts selected. Choose the exact file actions and add an engineering reason. Here, replace Bracket.SLDPRT, add Rib.SLDPRT and delete Spacer.SLDPRT; Main's independent Mount.SLDPRT update stays.
- Resolve any Conflict explicitly. If saved evidence changes, use Refresh saved states and review again. An unavailable preview is not permission to apply.

Note: This is a file-action review. Existing destination folders stay; empty-folder-only changes are not applied. No working files change during this review.

Visual 1 (cAdtree): **1. With Main active, review the saved case revision before changing Main.**

Alt text: Real History details for source Rev 005 on Lightweight bracket with Review changes to apply focused; Main remains the active destination.

Asset: [step-4-open-review.png](../public/tutorials/compare-apply-recover/step-4-open-review.png)

Visual 2 (cAdtree): **2. Check Base, Source and Destination — including Main's saved baseline.**

Alt text: Real review planner shows Base Rev 003 on Main, Source Rev 005 on Lightweight bracket and Destination Rev 006 on the Main working case.

Asset: [step-4-source-destination.png](../public/tutorials/compare-apply-recover/step-4-source-destination.png)

Visual 3 (cAdtree): **3. Select only the file actions you intend, including any explicit deletion.**

Alt text: Real source-change checkboxes select a Bracket.SLDPRT modification, Rib.SLDPRT addition and Spacer.SLDPRT deletion; the deletion notice says the destination file will be deleted.

Asset: [step-4-selected-actions.png](../public/tutorials/compare-apply-recover/step-4-selected-actions.png)

### Step 5 of 7 — Apply reviewed changes

Choose Prepare application to check the destination, then review Confirm working-file application.

- Preparation needs read/write access and a destination matching its saved baseline. Save uncaptured Main work as a normal revision, then refresh and review again.
- Check Destination: Main, its connected folder, baseline Rev 006, Source Rev 005 and the exact additions, replacements and deletions. Save and close relevant CAD documents, check the confirmation and choose Apply confirmed changes.
- Apply changes working files; no revision is saved yet. Open Main manually in CAD, check references and rebuild, then save and close after adjustments. In Changes, scan, review and Save revision: Main Rev 007 in this example.

Note: Keep other apps and sync from writing during Apply; cAdtree cannot lock them or make multiple file writes atomic. Apply does not delete or archive the Design Case.

Visual 1 (cAdtree): **1. Confirm Main, its working location and the exact file actions.**

Alt text: Real confirmation identifies Bracket Assembly, Destination Main, its connected working location, baseline Rev 006, Source Rev 005 and the three confirmed file actions.

Asset: [step-5-confirm-actions.png](../public/tutorials/compare-apply-recover/step-5-confirm-actions.png)

Visual 2 (cAdtree): **2. Save and close CAD documents, confirm the destination, then apply.**

Alt text: Real saved-and-closed CAD confirmation checkbox is checked and Apply confirmed changes is focused.

Asset: [step-5-confirm-apply.png](../public/tutorials/compare-apply-recover/step-5-confirm-apply.png)

Visual 3 (cAdtree): **3. Applied working files still need your CAD check and a saved revision.**

Alt text: Real Application completed dialog says Applied to working files — revision not yet saved, and instructs checking the destination in CAD before saving a normal revision.

Asset: [step-5-applied-working-files.png](../public/tutorials/compare-apply-recover/step-5-applied-working-files.png)

Visual 4 (cAdtree): **4. After the CAD check, save the reviewed Main state; its application origin is retained.**

Alt text: Real History shows Main Rev 007, Adopt lightweight bracket after review, and Applied from Rev 005 on Lightweight bracket.

Asset: [step-5-saved-main.png](../public/tutorials/compare-apply-recover/step-5-saved-main.png)

### Step 6 of 7 — Return to a saved version

A saved revision gives you a known design state to return to. Bring back onto Main makes Main's working files match it, after you review every change.

- Save your current work first; unsaved working changes block a bring-back. Select Rev 003 in History and choose Bring back onto Main…. cAdtree lists every difference between Main's latest saved state and Rev 003, all pre-selected: Bring back, Replace with Rev 003's version, or Remove (not in Rev 003).
- Deselect any file you want to keep as it is, enter the Engineering reason for bringing this back and click Prepare bring-back. Check the counts in the confirmation, acknowledge that CAD documents are saved and closed, then click Bring back confirmed changes.
- Only Main's working files change, and no revision is saved yet. Check the files in CAD, then save a revision; History shows Brought back from Rev 003. Files that were replaced or removed are kept with the operation and Rev 007 stays in history, so nothing is lost.
- To get a separate copy to look at or share instead, use Export a copy on the revision. Renamed files cannot be brought back yet; export them or create a design case from the revision.

Visual 1 (cAdtree): **1. Select the earlier revision in History, then choose Bring back onto Main….**

Alt text: Real History details for the selected Rev 003, Reviewed baseline, with Bring back onto Main… focused.

Asset: [step-6-bring-back-action.png](../public/tutorials/compare-apply-recover/step-6-bring-back-action.png)

Visual 2 (cAdtree): **2. Review the pre-selected changes, give the reason and click Prepare bring-back.**

Alt text: Real Make Main match Rev 003 review shows Latest saved Rev 007 and Bring back Rev 003 cards, the count 1 file brought back, 2 replaced, 1 removed, the Engineering reason for bringing this back field and four pre-selected changes: Bracket and Mount replaced, Rib removed, Spacer brought back.

Asset: [step-6-bring-back-review.png](../public/tutorials/compare-apply-recover/step-6-bring-back-review.png)

Visual 3 (cAdtree): **3. Main's working files now match Rev 003; save a revision to record it.**

Alt text: Real Bring back completed dialog reports that the files were brought back into working files and the revision is not yet saved.

Asset: [step-6-brought-back.png](../public/tutorials/compare-apply-recover/step-6-brought-back.png)

### Step 7 of 7 — Preserve the Design Case

Finished Design Cases do not need to be deleted. Archive the experiment while preserving its working folder and saved history.

- Keep Main active. In History, expand Design cases, find Lightweight bracket and choose Archive case. Review Archive design case, then confirm Archive case. Uncaptured case edits or pending applications must be resolved first.
- Archive is independent of Apply; it preserves useful alternatives whether or not you adopted them. Main cannot be archived. Archived cases can be reopened later with Reopen case; reopening does not switch your working case.

Visual 1 (cAdtree): **1. With Main active, expand Design cases in History and find the finished case.**

Alt text: Real History Design cases lists Lightweight bracket as Active with Archive case focused while Main is the active working direction.

Asset: [step-7-archive-action.png](../public/tutorials/compare-apply-recover/step-7-archive-action.png)

Visual 2 (cAdtree): **2. Review the preservation notice and confirm Archive case.**

Alt text: Real Archive design case dialog identifies Lightweight bracket, explains the clean-baseline check and retained files/history, and focuses Archive case.

Asset: [step-7-archive-confirmation.png](../public/tutorials/compare-apply-recover/step-7-archive-confirmation.png)

Visual 3 (cAdtree): **3. The archived case remains available to inspect or reopen later.**

Alt text: Real Archived cases section shows Lightweight bracket as Archived with Reopen case available; saved history and the working folder remain retained.

Asset: [step-7-archived-case.png](../public/tutorials/compare-apply-recover/step-7-archived-case.png)

Closing copy: **You now know the core cAdtree workflow. Save meaningful revisions, explore alternatives separately, compare before applying changes, and preserve useful design history.**

## 3. Actual Compare behavior and terminology

History selects the revision to inspect. Its Compare button opens Compare saved revisions. From revision is the comparison baseline; To revision is the compared state. The inspected revision defaults to To and an available parent defaults to From. Swap reverses endpoints and therefore the meaning of additions/deletions. Any two available saved revisions can be compared across Main and a Design Case, without requiring every intervening ancestor to be available.

Added, Deleted, Modified and Unchanged describe saved path presence and content hashes. Modified does not mean geometry changed; metadata edits in a CAD file can also change its bytes. Compare shows overall engineering notes and per-file notes at the two endpoints, plus directory additions/deletions including empty directories. It does not summarize all intervening notes, scan working files, verify stored binary objects, evaluate CAD compatibility or infer feature, geometry or stress changes. Missing, corrupt, ambiguous or invalid endpoint metadata makes the comparison unavailable. The tutorial uses the normal History route rather than teaching the secondary Compare with Main route in Design cases.

Terminology retained from the build: Main, Design cases, branch, Compare, Compare saved revisions, From revision, To revision, Swap, Review changes to apply, Base, Source, Destination, Prepare application, Confirm working-file application, Apply confirmed changes, Bring back onto Main…, Prepare bring-back, Bring back confirmed changes, Export, Archive case and Reopen case. The product still exposes branch in some UI; there is no global rename and no new Merge action or Git lesson.

Sources inspected: `src/components/CompareRevisionsDialog.tsx`, `src/engine/snapshot-comparison.ts`, `src/components/HistoryRecoveryView.tsx`.

## 4. Actual Review & Apply behavior

With Main active, inspect the source case revision and choose Review changes to apply. The dialog title is Review changes to apply — preview. Source is the chosen saved revision, Destination is the active direction’s saved baseline, and Base is their nearest validated common ancestor. Unlike Compare, planning validates parent edges and required ancestry. Missing or inconsistent evidence blocks the planner.

Nothing is selected initially. The engineer selects source file actions, resolves any conflict explicitly and supplies an engineering reason. Source-unchanged or destination-only changes are retained; matching endpoint states require no action. The sample explicitly replaces Bracket.SLDPRT, adds Rib.SLDPRT and deletes Spacer.SLDPRT while retaining Main’s independent Mount.SLDPRT update. This is file replacement/action planning, not an automatic CAD geometry merge.

Prepare application checks the bound destination, read/write permission for working storage and vault, absence of unfinished applications, a clean saved baseline (including empty directories) and the expected review plan. Uncaptured destination work must be saved normally before refreshing and reviewing again. Existing destination directories are retained, required parent directories are added, empty-folder-only changes are not applied, and existing directories are not removed by Apply.

Confirm working-file application identifies project, destination, exact connected location, saved baseline, source, reason and exact additions/replacements/deletions. Apply confirmed changes remains disabled until the saved/closed-CAD acknowledgement is checked. Applying revalidates under the project writer lock, verifies staged source content and preserves before-state evidence. It cannot lock CAD/sync writers or provide an atomic transaction over multiple file writes.

Application completed explicitly reports Applied to working files — revision not yet saved. The engineer opens the destination manually in CAD, checks native references/rebuild and adjusts as needed, saves/closes, then scans/reviews/saves a normal revision in Changes. That revision retains the destination parent and Applied from source provenance. Apply does not save a revision automatically, delete/archive the source or imply CAD compatibility.

Sources inspected: `src/components/ApplyPreviewDialog.tsx`, `src/components/ApplicationStatus.tsx`, `src/engine/apply-preview.ts`, `src/engine/application-service.ts`, `src/App.tsx`.

## 5. Actual recovery behavior

Restore copy no longer exists. The lesson teaches History → select an earlier revision of the active branch → Bring back onto Main… → Make Main match Rev 003 (every difference pre-selected; deselect to bring back only some files; an Engineering reason for bringing this back is required) → Prepare bring-back → Confirm bringing back into working files → Bring back confirmed changes. The dialog ends with Bring back completed: Brought back into working files — revision not yet saved. Unsaved working changes block the operation, and renamed files cannot be brought back yet.

The engineer checks the files in CAD and saves a revision; History then shows Brought back from Rev 003. Replaced and removed files are kept with the operation, and the latest revision stays in history. The capture script stops after the completion dialog and does not save the revision.

Export writes a separate folder named `<Project> - <Branch> - R<nn>` (a clash gets `(2)`) from any revision, whole or selected files, including files deleted later. It is mentioned briefly as the way to get a copy to look at or share. Create design case from this revision remains the distinct alternative-workflow action taught in Tutorial 4. The product also uses Recover for an interrupted working-file application’s retained before-state, which is separate from Bring back. No destructive historical Rollback action exists.

Sources inspected: `src/components/HistoryRecoveryView.tsx`, `src/components/ApplyPreviewDialog.tsx`, `src/engine/workspace-service.ts`, `src/components/ApplicationStatus.tsx`, `src/engine/application-service.ts`.

## 6. Actual Archive behavior

History → Design cases provides Archive case and the Archive design case confirmation. Only a non-Main case that is not the active working direction can be archived. Main stays active in the sample. Archiving checks the case’s clean saved baseline including directories; uncaptured changes, pending applications or unavailable evidence block it.

Archive changes lifecycle metadata only. Working files, saved revisions and history remain available, independently of whether any work was applied. Archived cases exposes Reopen case. Reopening changes lifecycle state without switching the active direction or restoring files. No case-deletion action was found. The tutorial briefly mentions reopen without adding an archive-management walkthrough.

Sources inspected: `src/components/DesignCases.tsx`, `src/engine/case-lifecycle-service.ts`.

## 7. Real screenshots and controlled scenario

Seventeen direct current-App PNG screenshots were captured with `node tests/tutorial-5-capture.cjs`, using the real App, production CSS, real engine services/RealFileSystemAdapter and the established disposable native-directory-handle facade. Forms and dialogs were not recreated. Capture-only CSS removes panel/modal shadows, and crops focus on the relevant real controls. Chrome capture viewport: 1024 × 1200; device scale factor: 3. Assets contain no decorative Windows visuals or synthetic cAdtree forms.

The fixture is Tutorial Workspace / Bracket Assembly / Lightweight bracket. It uses opaque deterministic bytes with CAD filenames to exercise file operations; they are not valid CAD models and do not establish native CAD compatibility.

| Saved revision | Direction | Meaning |
| --- | --- | --- |
| Rev 001 | Main | Initial layout |
| Rev 002 | Main | Mount geometry updated |
| Rev 003 | Main | Reviewed baseline; case origin |
| Rev 004 | Lightweight bracket | Reduced bracket thickness |
| Rev 005 | Lightweight bracket | Reinforced mounting rib |
| Rev 006 | Main | Mounting detail refined |
| Rev 007 | Main | Adopt lightweight bracket after review |

Revision numbers are project-wide. Case creation adds no revision. Applying Rev 005 to Main at Rev 006 leaves six saved revisions; the later normal save creates Rev 007 with Main Rev 006 as its parent and Applied from Rev 005 provenance. Bringing back Rev 003 changes Main's working files to match its four files and writes no revision. Archive retains all seven revisions and the unchanged source case files.

Capture assertions passed: Compare and Swap make no storage changes; no initial review selection; confirmation requires acknowledgement; exact three apply actions; Main’s independent Mount hash survives; source case signature stays unchanged; no automatic revision; expected Rev 007 parent/provenance; after Bring back, Main's working files exactly match Rev 003 with no new revision and the case unchanged; archive retains history/files. One picker is used only to open the disposable home in the capture harness. Tutorial playback itself invokes no picker.

Evidence (local ignored artifacts): `artifacts/tutorial-5/capture-verification.json`, `viewer-verification.json` and `contact.png`. Reproduction requires the repo’s installed dependencies and Chrome on Windows: `npm run build`, `node tests/tutorial-5-capture.cjs`, `node tests/tutorial-5-check.cjs`.

## 8. Conceptual visuals

Two precise SVGs were created: shared Rev 003 origin with Main Rev 006 versus case Rev 005; and same-path file hash evidence and its geometry limitation. Each has descriptive SVG text and useful adjacent tutorial copy/alt text. They are simple instructional diagrams consistent with the existing teal/purple graph conventions.

### Asset inventory and SHA-256

All paths below are under `public/tutorials/compare-apply-recover/`.

| File | Source | SHA-256 |
| --- | --- | --- |
| step-1-compare-directions.svg | Concept SVG | `3f09b88b397069ce4d4bd3bfca7e14d8d796052fb0a06235ca76f590acb4d8fe` |
| step-2-choose-states.png | Real cAdtree | `9fc50f3a6ddbdf26d1f0f662c29940e703ee9769ec406bb729bb68f586219ab9` |
| step-2-engineering-notes.png | Real cAdtree | `21cd88c161cb4383fae8eb9f44661893d29cac0234fb8b1212df1accf15d05be` |
| step-2-file-differences.png | Real cAdtree | `936b249bd2683e99e2cf200ec87a91a8df7e1414b71380b4b932cc86bf0d18a1` |
| step-2-open-compare.png | Real cAdtree | `92bbff1ae68309abf57c727bef37ba602aa5d26ac9f85af8d80c24b30a409580` |
| step-3-file-evidence.svg | Concept SVG | `1c3b1b2672edc1a8579ddc857464521cf9d4250d302671d9b8045ca6d2692116` |
| step-4-open-review.png | Real cAdtree | `c63434fe00ca6efba2613bbdda5eadf0a50d84528162b408683e5bfd25d64da9` |
| step-4-selected-actions.png | Real cAdtree | `7b8f7d5b6d1c5df4e9baba633e60a9d5d0978662c9d37900fa658722c502441a` |
| step-4-source-destination.png | Real cAdtree | `d34de1dda0c599cbad9eb2944233ecd418e379b159c5b9284dce4ceb8ce7d697` |
| step-5-applied-working-files.png | Real cAdtree | `5570a66d9abbb9acdaff5bfc7ecc56608a5105574018d1e2fa6219d4ee88ba28` |
| step-5-confirm-actions.png | Real cAdtree | `fc346c5222344ab46e1357931a733bb29f7c1720364c3b2414e95ec961cbf4c4` |
| step-5-confirm-apply.png | Real cAdtree | `25125411e8892f257984b57a335896bc125c1fc452360f03ecf8d686aa21c123` |
| step-5-saved-main.png | Real cAdtree | `fab4dc005a405415daa0bf8a8f24e80e5d9a10e844a5ca68a9f7b377ac8ed81e` |
| step-6-bring-back-action.png | Real cAdtree | `2e0866e80bc2744ce44536baadc453af48e3c98609f7e2ac7cc2d770e7f5151b` |
| step-6-bring-back-review.png | Real cAdtree | `9c98cdaa3cafe04151ad8bbb253eb56b14674e38a3937be97c453b02dccedbe1` |
| step-6-brought-back.png | Real cAdtree | `444c53045d3eb46864e94a441fcd7085befb19a62d485d408bdc7decb2cb5bc6` |
| step-7-archive-action.png | Real cAdtree | `0622daba6096575418e6b0899b767fd6411bc40527bffa9a75f4aa6eed7442b0` |
| step-7-archive-confirmation.png | Real cAdtree | `6429023f4287af052a24ea743511a19c10d1a787899c062b4cacaece222ce572` |
| step-7-archived-case.png | Real cAdtree | `728115309712f28595495567a9c0762eb40b1607362e24a693082fbf0f160c23` |

## 9. Files/components changed

- `src/tutorials/compare-apply-recover.ts`: independent seven-step final tutorial definition.
- `public/tutorials/compare-apply-recover/`: 17 real PNG captures and two SVG concepts.
- `src/components/LearnCadtree.tsx`: final card import/binding, title and available status only.
- `src/components/final-tutorial.test.tsx`, `src/tutorials/compare-apply-recover.test.ts`: final tutorial interaction, isolation and asset checks.
- `tests/compare-apply-recover-sample.ts`: disposable controlled sample using real services.
- `tests/tutorial-5-capture.cjs`, `tests/tutorial-5-check.cjs`: reproducible current-App captures and responsive viewer checks.
- `src/components/learn-cadtree.test.tsx`, `revision-tutorial.test.tsx`, `import-tutorial.test.tsx`, `alternatives-tutorial.test.tsx`, `tests/tutorial-4-check.cjs`: only obsolete final-card Coming soon expectations updated.
- `docs/tutorial-5.md`: this completion report and exact copy.

Tutorials 1–4 definitions/assets, TutorialViewerModal, carousel implementation, product CSS and engine behavior are unchanged.

## 10. Learn card activation

Only the existing `compare-recover` card was enabled. Its title is now Compare, apply & recover, its status is available and its tutorial reference points to COMPARE_APPLY_RECOVER_TUTORIAL. The existing renderer supplies Start tutorial → and 7 steps. Its description, preview, category, position and design stay intact; the first four cards are unchanged. There are exactly five available cards, no remaining Coming soon card and no invented extra tutorial.

## 11. Validation

| Check | Result |
| --- | --- |
| `npm test` | 298 passed, zero failures; existing Compare, Apply, recovery, branch and lifecycle tests included |
| `npx tsx --test src/tutorials/*.test.ts` | Six definition/asset tests passed |
| Focused new final component/definition tests | Three passed (also covered by the suites above) |
| `npm run lint` | TypeScript passed |
| `npm run build` | Passed; existing Vite config/chunk/dynamic-import advisories remain |
| `node tests/tutorial-5-capture.cjs` | 17 captures, complete Compare → Review → Apply → save → bring back → archive assertions passed; no page errors |
| `node tests/tutorial-5-check.cjs` | All 20 visuals passed at 1366 × 900, 1100 × 1244 and 390 × 844; no page errors or horizontal overflow |
| Running preview at http://127.0.0.1:2526/ | All seven steps traversed in the user’s in-app browser; Finish returns focus to the final Learn trigger |

Final-tutorial tests seed connected work with a retained pending application, uncaptured Main work and dirty case work, then traverse every step/visual. They assert identical complete home inventories (files, directories, records and pending evidence), identical application operations/lifecycles, unchanged active case, no picker calls, no extra application/recovery dialogs and no revision/branch changes. Keyboard operation, one image at a time, distinct step/visual navigation, gating, boundaries, Back, Close, replay, Finish and focus return are checked. Existing Tutorials 1–4 open/close in both component and browser harnesses; their existing suites pass.

Visual QA inspected the complete asset contact sheet and representative desktop/mobile viewer captures. Tight crops retain real UI text and focus rings without baked-in shadow edges or conceptual text overlap. The shared viewer remains scrollable at smaller sizes.

## 12. Inconsistencies, uncertainty and practical limits

No product behavior was changed to fit the tutorial. Relevant distinctions: Compare can show empty-directory differences but Apply does not apply empty-directory-only changes; Compare validates endpoint records but does not reverify binary contents; Apply has validated ancestry and separate preparation/confirmation; Apply is not a saved revision; historical restoration is a separate copy; pending-operation Recover is a different recovery path; Archive is independent of Apply and preserves the working folder.

Some current product text still says branch or merged; screenshots preserve that actual UI, while tutorial instructions use Design Case and the real Review changes to apply control. No global terminology changes were made.

The fixture validates file/state behavior with opaque sample data, not CAD geometry, native assembly rebuilds or real-world CAD integrations. OS permission UI, native folder pickers, clipboard paste into Explorer, Mac/Linux behavior and concurrent external CAD/sync writes were not newly qualified. The tutorial explicitly leaves native CAD checks to the engineer and does not claim automatic conflict or compatibility resolution. Managed paths contain generated identifiers because the real application shows them; the lesson teaches the recoveries/working locations rather than asking users to memorize those identifiers.

No unrelated tutorial, homepage or product functionality was added. Implementation stops here.
