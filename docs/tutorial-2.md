# Tutorial 2: Save your first revision

## Scope and capture provenance

This is a read-only illustrated tutorial. Its controls only browse tutorial content; the tutorial never creates a project, saves a revision, copies a path, or opens a CAD application.

The eight cAdtree PNGs are real Windows Chrome captures of the current App and its real controls, cropped at 3× device scale. They were captured from an isolated local-file bundle because this execution environment cannot reach localhost (EACCES). The actual home/workspace/project services, scans and capture flow ran against disposable in-memory adapters exposed through the existing test-only native-handle facade. No real user folders were selected. No app screen was redrawn or fabricated. Focus highlights are native app focus outlines; transient notices were dismissed using the app controls before capture.

Sample: Cadtree home / Tutorial Workspace / Bracket Assembly / working/main. Files: Bracket.SLDPRT (500 KB initially; 504 KB after the saved edit), Mount.SLDPRT (250 KB), BracketAssembly.SLDASM (125 KB). These are opaque byte fixtures with CAD extensions, not valid SolidWorks models. No SolidWorks session or geometry change was tested.

Windows: one generated Windows 11 File Explorer instructional image with a cursor in the address field and the same sample file names. The tutorial tells users to paste their own copied path. Concepts: two exact SVG diagrams, not app screenshots.

## Workflow findings

- The current labels are Copy folder path, Revision summary, Add note and Save revision. Notes use Problem or intent, Engineering change and Observations. Overall engineering notes are optional.
- An empty managed project has no per-file Copy folder path control yet. The tutorial first directs the user to Settings → Working folder (workspace-relative), then placing files and scanning makes the existing per-file shortcut available. No new path shortcut or filesystem behavior was added.
- Before the first capture, all three files are Added, including the file edited since an earlier scan. A Modified example would require a saved baseline, so this tutorial accurately shows Added and saves the actual first revision.
- The revision detail header displays Rev 001; its graph node uses R001. Save revision rescans the files and may require renewed review if the file set changed. It saves the complete project state, not a selected file.

## Exact user-facing copy

### Step 1: CAD saves and cAdtree revisions

Keep saving normally in your CAD application.

- Create a cAdtree revision when the design reaches a meaningful engineering state worth keeping.
- Example: mounting geometry finalized after a clearance review.

Visual 1 — Concept: CAD Save ≠ cAdtree Revision: keep normal saves; record milestones as revisions.

Alt text: Normal CAD work has repeated saves; cAdtree records fewer meaningful milestones as Rev 001 and Rev 002.

Asset: `/tutorials/save-first-revision/step-1-saves-and-revisions.svg`

### Step 2: Reach your CAD files

Your live CAD files belong in Main's working/main folder.

- For an empty project, open Settings. Working folder shows the location relative to your workspace; place your CAD files there.
- Copy folder path copies a listed file's containing folder. Paste it into File Explorer's address bar.

Visual 1 — cAdtree: 1. Open Settings and find Working folder; place your CAD files in this working/main folder.

Alt text: Real cAdtree Settings, Folder connections: Working folder ends in projects/Bracket Assembly, then working/main.

Asset: `/tutorials/save-first-revision/step-2-working-folder.png`

Visual 2 — cAdtree: 2. Open Changes, then use Copy folder path beside a listed file.

Alt text: Real Changes list containing Bracket.SLDPRT, BracketAssembly.SLDASM and Mount.SLDPRT, with Bracket's Copy folder path icon highlighted.

Asset: `/tutorials/save-first-revision/step-2-copy-folder-path.png`

Visual 3 — Windows: 3. In File Explorer, press Ctrl+L, paste the copied folder path and press Enter.

Alt text: Synthetic Windows 11 File Explorer with a cursor in the address bar, an illustrative Bracket Assembly working/main path and the three sample CAD files.

Asset: `/tutorials/save-first-revision/step-2-windows-address.png`

### Step 3: Make a change

Edit Bracket.SLDPRT and save it normally in your CAD application.

- Save and close the CAD documents before returning to cAdtree.
- cAdtree checks your saved files when you return to it; it does not interpret geometry or monitor CAD edits in real time.

Visual 1 — Concept: Edit in CAD → Save normally → Close documents → Return to cAdtree.

Alt text: Edit and save Bracket.SLDPRT in CAD, close the CAD documents, then return to cAdtree.

Asset: `/tutorials/save-first-revision/step-3-normal-cad-work.svg`

### Step 4: Review detected changes

In Changes, review the list after saving and closing your CAD documents; cAdtree checks your files when you return to it.

- Review each listed file before saving a revision.
- On the first revision, files appear as Added. After a baseline exists, an edited file can appear as Modified.

Notice: A revision saves the complete project state. File selections apply only to notes.

Visual 1 — cAdtree: 1. cAdtree refreshes the list from your saved files by itself.

Alt text: Real Bracket Assembly project header with Working case Main above Changes.

Asset: `/tutorials/save-first-revision/step-4-scan.png`

Visual 2 — cAdtree: 2. Review what cAdtree detected. This first capture contains three Added files.

Alt text: Real Changes list shows three Added files, zero Modified and zero Deleted; Bracket.SLDPRT now contains the saved edit.

Asset: `/tutorials/save-first-revision/step-4-added-files.png`

### Step 5: Add useful revision notes

Revision notes should explain why the design changed, not just that a file changed.

- Enter a required Revision summary, such as “Finalize bracket mounting flange after stress review.”
- Add note supports Problem or intent, Engineering change and Observations. Overall engineering notes are optional too.

Visual 1 — cAdtree: 1. Enter a short Revision summary for the saved design state.

Alt text: Real Save revision form with Revision summary set to Finalize bracket mounting flange after stress review.

Asset: `/tutorials/save-first-revision/step-5-summary.png`

Visual 2 — cAdtree: 2. Add note for Bracket.SLDPRT: “Increased mounting flange thickness from 4 mm to 5 mm after stress review.”

Alt text: Real Bracket.SLDPRT note editor with Problem or intent, Engineering change and Observations, explaining a flange change from 4 mm to 5 mm after stress review.

Asset: `/tutorials/save-first-revision/step-5-file-note.png`

### Step 6: Save your first revision

When the design state is worth keeping, click Save revision.

- cAdtree scans again before saving; if the files changed, review the updated list and retry.
- Your normal CAD files remain the working files. The saved revision can later be compared, recovered or used as a starting point for another design direction.

Visual 1 — cAdtree: 1. Click Save revision after reviewing the files and notes.

Alt text: Real Save revision form with the example summary and Bracket.SLDPRT file note, and the Save revision button highlighted.

Asset: `/tutorials/save-first-revision/step-6-save.png`

Visual 2 — cAdtree: 2. Open History to find Rev 001 and its saved summary.

Alt text: Real Bracket Assembly History showing the first Main revision, Rev 001 in its detail header and R001 on the graph, with the saved summary.

Asset: `/tutorials/save-first-revision/step-6-history.png`

Closing hint: Your first meaningful design state is saved.

## Asset inventory

| Asset | Source | Pixels / format | SHA-256 |
|---|---|---|---|
| step-1-saves-and-revisions.svg | concept | SVG | cb368c317b40c367ca273564a371cc52117d734301d4e723ff588d5ec4945581 |
| step-2-working-folder.png | cadtree | 2916 × 753 PNG | fce836010f313f0f7ec0cf073b05f7312c5692d83d77617781b9ec5d8d1d407a |
| step-2-copy-folder-path.png | cadtree | 1986 × 891 PNG | cc7686553a1f891b577fbf3c5a29a50e80be7df9356cfe69fcde7d6e0079c2da |
| step-2-windows-address.png | os | 1586 × 992 PNG | bad63c105ed818de100c2841ee183494d20a0cd41b67a0279a1336f72e269394 |
| step-3-normal-cad-work.svg | concept | SVG | 78d497509aaa0904aeafddbeaa66716809f4535c37d9efb6e28dc0dded30d2d2 |
| step-4-scan.png | cadtree | 3336 × 276 PNG | a98bc2fb901919d95a16ae18ed7dc5ef2dc546c18668b17f2a79266cbe3ba9c2 |
| step-4-added-files.png | cadtree | 1986 × 891 PNG | a4f9f38d76baf1385bb4939ed50a86f8f1691f44fe6cd0e420786116990c08da |
| step-5-summary.png | cadtree | 1293 × 1101 PNG | f854602005178ac70dcaafcfaafb5a2d691aba36aa7aefe6041d2ab2e14fe2d5 |
| step-5-file-note.png | cadtree | 1167 × 1278 PNG | c5a2d9ef0887ec5f502b4116e829e6a15461db7cd6969e9192af77103ed197d3 |
| step-6-save.png | cadtree | 1293 × 1332 PNG | da7e0beed26176010cbae642346adcb8d86301d387d20582e5ca7180d6addce5 |
| step-6-history.png | cadtree | 3540 × 1260 PNG | 9e0b5b75af5bd641b0c57b7d819cd7e75083b16b441124307bb4c9ddff8ab099 |

## Validation limits

Only Windows Chrome was used. Automated current-App rendering checks use an isolated file bundle; real OS folder pickers, clipboard permissions, native CAD edits and macOS/Linux were not qualified. The tutorial walkthrough test verifies that a connected sample project retains its complete inventory and gains no revision after browsing and finishing the tutorial.

## Validation results

- `npm test`: 292 tests passed, including both tutorial walkthroughs and the connected-project no-side-effects regression.
- `node --import tsx --test src/tutorials/*.test.ts`: all three tutorial definition/asset checks passed as part of the nine-test focused tutorial run.
- `npm run lint`: TypeScript passed.
- `npm run build`: passed; existing Vite configuration, dynamic-import and chunk-size advisories remain.
- Windows headless Chrome: all 11 visuals loaded at 1366 × 900, 1100 × 1244 and 390 × 844. Verified one image at a time, gated Next/Finish, separate visual/step navigation, opening both tutorials from their cards, Finish, restored focus, three inactive future cards and no horizontal overflow or page errors.
- Tutorial 1 definition bytes match the merged version after removing the concept-only type extension; the shared viewer bytes match after removing the Concept source-label branch. Homepage CSS and its layout are unchanged.

## Implementation files

- `src/tutorials/save-first-revision.ts` and `src/tutorials/save-first-revision.test.ts`: Tutorial 2 definition and asset/copy checks.
- `src/components/revision-tutorial.test.tsx`: connected-project isolation and keyboard/close/reopen tests.
- `src/components/LearnCadtree.tsx`: enable only the existing Save your first revision card.
- `src/components/TutorialViewerModal.tsx` and `src/tutorials/start-tutorial.ts`: support the Concept visual source label/type; no navigation or Tutorial 1 content changes.
- `src/components/tutorial.test.tsx` and `src/components/learn-cadtree.test.tsx`: scope launch buttons to their tutorial cards and keep future topics inactive.
- `public/tutorials/save-first-revision/`: the 11 preserved visual assets listed above.
- `docs/tutorial-2.md`: exact copy, provenance and validation.
