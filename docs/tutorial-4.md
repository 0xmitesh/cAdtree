# Tutorial 4 — Explore design alternatives

R4 update: Design cases now lives in History; affected archive guidance and screenshots were refreshed. Original implementation/validation history below is retained.

Implemented against merged main a4f1fc91e1230af026cd54cbcfd0c3d2f6269f76 (PR #25). Only Tutorial 4 is enabled. No Tutorial 5 implementation.

## 1. Final step structure

| Step | Title | Visuals |
| --- | --- | --- |
| 1 | Main and design alternatives | Concept |
| 2 | Start from a saved revision | Real cAdtree; Real cAdtree |
| 3 | Name the Design Case | Real cAdtree |
| 4 | A separate working location | Concept; Real cAdtree; Real cAdtree |
| 5 | Switch between design directions | Real cAdtree; Real cAdtree; Real cAdtree |
| 6 | Keep both histories | Concept; Real cAdtree |

## 2. Exact tutorial copy

Title: **Explore design alternatives**

### Step 1 of 6 — Main and design alternatives

Main is your primary design direction. A Design Case lets you explore an alternative without changing Main.

- Create a case to test a lighter bracket or a different mounting arrangement.
- This example starts Lightweight bracket from the reviewed Main baseline, Rev 003. The UI also calls a case a branch.

Visual 1 (Concept): **Start an alternative from a saved baseline while keeping Main separate.**

Alt text: Main saves Rev 001, Rev 002 and Rev 003. Lightweight bracket is a Design Case starting from Rev 003 in its own working location; Main remains a separate direction.

### Step 2 of 6 — Start from a saved revision

In History, select the saved revision where the alternative should begin, then choose Create branch from here.

- Choose Rev 003 — Reviewed design baseline in Bracket Assembly.
- A saved revision gives the case a recorded starting point and a complete project copy. Newer unsaved working edits are not included. Inspecting a revision does not switch your active branch.

Visual 1 (cAdtree): **1. Choose the revision where the alternative should begin.**

Alt text: Close view of the real Bracket Assembly History graph with Main's Rev 001 through Rev 003 and Reviewed design baseline selected.

Visual 2 (cAdtree): **2. Click Create branch from here for the selected saved revision.**

Alt text: Close view of the real History actions for the selected revision, with Create branch from here focused.

### Step 3 of 6 — Name the Design Case

In Create design branch, enter a Branch name and Engineering reason, then click Create branch.

- Branch name: Lightweight bracket. Engineering reason: Explore a lighter mounting solution without changing Main.
- For this managed project, cAdtree creates and verifies a fresh working folder automatically. No folder picker is needed. The new case becomes active; creation adds no revision.

Visual 1 (cAdtree): **Name the alternative, explain why, then click Create branch.**

Alt text: Close view of the real Create design branch form: Lightweight bracket in Branch name, the engineering reason filled, automatic destination guidance and Create branch focused.

### Step 4 of 6 — A separate working location

Main and the Design Case have separate working locations inside the same managed project.

- Main uses working/main. Lightweight bracket uses its own uniquely named child of working. Editing that case's files does not directly modify Main.
- Settings → Working folder shows the active direction's exact location. In Changes, reveal unchanged files if needed and use a file's Copy folder path; paste it into your file manager to reach that folder.
- Open the CAD files from that location. Keep managed folders where cAdtree creates them.

Visual 1 (Concept): **Two working folders, one project: edit the folder for your chosen direction.**

Alt text: Bracket Assembly has two separate children under working: main for Main, and a unique case folder allocated by cAdtree for Lightweight bracket. Saved history is shared in the project's separate vault. Settings shows exact generated locations.

Visual 2 (cAdtree): **1. In Settings, check Working folder for the active case's exact location.**

Alt text: Real Settings shows Active branch Lightweight bracket and Working folder ending in working slash the uniquely generated cAdtree-Lightweight-bracket folder.

Visual 3 (cAdtree): **2. In Changes, reveal unchanged files if needed and use Copy folder path.**

Alt text: Real Changes view on Lightweight bracket with unchanged files revealed and Copy folder path for Bracket.SLDPRT focused.

### Step 5 of 6 — Switch between design directions

In Settings or Changes, use Active branch to choose Main or Lightweight bracket. Check the selected name before working.

- cAdtree scans and saves from the selected direction's working folder. In History, Current branch identifies that direction; selecting an old revision does not change it.
- Switch back to Main with the same selector. Each direction keeps its own files; switching does not replace the other folder's contents.

Notice: Save and close CAD documents before moving to the other working location, then open its files manually. cAdtree does not launch CAD or change which documents CAD has open.

Visual 1 (cAdtree): **1. Main is active; Working folder identifies Main's files.**

Alt text: Real Bracket Assembly Settings shows Main selected in Active branch and its Working folder ending in working/main.

Visual 2 (cAdtree): **2. Choose Lightweight bracket in Active branch to work on the alternative.**

Alt text: Real Settings after selecting Lightweight bracket in Active branch shows the case selected and its separate generated Working folder.

Visual 3 (cAdtree): **3. History confirms the current case and the saved revision it started from.**

Alt text: Real History shows Current branch Lightweight bracket, Started from Rev 003 on Main and the case's engineering reason.

### Step 6 of 6 — Keep both histories

Continue saving meaningful revisions in whichever design direction you are working on: save CAD files, scan and review Changes, then Save revision.

- The case's first changed save follows Rev 003. In this example, Lightweight bracket gets Rev 004 and Rev 005; Main later gets Rev 006 with Rev 003 as its parent. Numbers run across the whole project, not from one on each case.
- Both histories keep their connection to the starting revision. Do not delete a useful alternative just because it did not become Main.
- Finished alternatives can be archived in History → Design cases while preserving their working folder and saved history. Main cannot be archived.

Visual 1 (Concept): **Separate histories share an origin; revision numbers belong to the whole project.**

Alt text: Project-wide numbering: Main Rev 001 to Rev 002 to Rev 003, then Main Rev 006. Lightweight bracket branches from Rev 003 to Rev 004, Reduced bracket thickness, then Rev 005, Reinforced mounting rib. Main Rev 006 has Rev 003 as its parent, not the case's Rev 005.

Visual 2 (cAdtree): **Both design directions remain in the project's saved history.**

Alt text: Close view of the real Bracket Assembly History graph: Main's Rev 003 baseline connects to Lightweight bracket Rev 004 and Rev 005 and Main Rev 006.

Closing hint: **Next: compare, apply and recover designs.**

## 3. Exact terminology in the current build

| Surface | Exact UI text |
| --- | --- |
| Settings section | Design cases |
| History creation action | Create branch from here |
| Creation dialog | Create design branch |
| Creation fields | Branch name; Engineering reason |
| Submit action | Create branch |
| Settings / Changes selector | Active branch |
| History indicator | Current branch |
| Case origin | Started from Rev 003 on Main (for this sample) |
| Settings location | Working folder |
| File shortcut | Copy folder path |
| Lifecycle actions | Archive case; Reopen case |

Tutorial copy uses Design Case for the engineering concept and explicitly identifies the branch labels. No global UI renaming.

## 4. Actual creation workflow discovered

History → select a saved revision → Create branch from here → Create design branch → Branch name and Engineering reason → Create branch. The managed App supplies the destination automatically and does not show the external destination-parent picker supported by the generic dialog. The dialog displays a managed working destination followed by <new case>.

The engine verifies saved ancestry and folder isolation, restores the entire saved snapshot (including unchanged files and empty directories), verifies the resulting inventory and registers the branch and portable working-folder binding. Creation does not create a revision or consume a revision number. The App activates and scans the new case. Main's bytes and saved history stay intact. The source is the chosen saved revision, not uncaptured working edits.

## 5. Actual working-folder and switching behavior

Within a managed project, Main is working/main. A new case lives below the same working parent in cAdtree-<name slug>-<generated UUID>. The example's exact captured workspace-relative path is:

```text
projects/Bracket-Assembly-774bece9-3454-4876-8c59-6e5d37bf0216/working/cAdtree-Lightweight-bracket-f1c09659-f383-44bb-90c9-f707003ca99d
```

The concept diagram deliberately labels this a unique case folder; Settings screenshots show the exact generated location. No user-facing instruction asks the user to type an ID or move managed folders. The shared vault sits outside these editable working folders.

Active branch appears in Settings and Changes, not as a selector in History. Choosing it resolves the recorded folder and scans that direction. History displays Current branch and, for a case, the origin and engineering reason. Revision selection and graph ancestry highlighting do not switch working context. Explorer also supports explicit branch switching; the tutorial teaches only the selector.

Settings → Working folder shows the active location relative to the workspace. Changes → Show N unchanged files reveals paths when the working copy matches its baseline; Copy folder path beside a file addresses its immediate containing folder. The example file is at the working root, so its shortcut reaches that direction's root. Users paste the copied path in their file manager, then open the CAD documents manually. cAdtree does not launch CAD, close documents, switch open CAD files, or rewrite native assembly references. Save/close before moving locations is practical advice consistent with the existing CAD-save/capture guidance, not a new enforced condition.

## 6. Actual revision numbering and preservation

Revision capture uses max existing project display number + 1, across all branches. Each save uses its active branch's validated baseline as parent. The UI formats the sample as Rev 001 through Rev 006.

| Saved revision | Direction | Saved parent | Summary |
| --- | --- | --- | --- |
| Rev 001 | Main | None | Initial layout |
| Rev 002 | Main | Rev 001 | Mounting geometry updated |
| Rev 003 | Main | Rev 002 | Reviewed design baseline |
| Rev 004 | Lightweight bracket | Rev 003 | Reduced bracket thickness |
| Rev 005 | Lightweight bracket | Rev 004 | Reinforced mounting rib |
| Rev 006 | Main | Rev 003 | Main mounting detail refined |

Case creation initially leaves the revision count at three. Its first changed capture is Rev 004, not case Rev 001. Main Rev 006 continues from Rev 003, not from case Rev 005.

The current product has archive/reopen, with no case-delete action. Main cannot be archived. An active working case must be switched away from, and its clean saved baseline checked, before archiving. Archiving preserves files/history; reopening retains identity, origin and working location. Tutorial 4 mentions preservation and where archive lives without teaching the lifecycle workflow.

## 7–8. Captured screenshots and conceptual visuals

Nine direct screenshots of the current running App and three exact SVG diagrams. No cAdtree form was redrawn; no synthetic Windows visual was needed. App captures use the existing native-handle test facade and real engine services with disposable sample folders. All cAdtree captures are at 3× device pixel density, preserving aspect ratio. Native keyboard focus outlines identify actions. Concept colors follow the current teal/purple graph palette.

Sample: Tutorial Workspace / Bracket Assembly, with Bracket.SLDPRT (512000 bytes), Mount.SLDPRT (256000 bytes) and BracketAssembly.SLDASM (128000 bytes). These are explicitly opaque tutorial fixtures, not valid SolidWorks models. No user CAD data. Initial saves use real engine capture; branch creation and switching use real App handlers; later sample saves use the same capture service.

Capture assertions: Main unchanged after creation; case bytes exactly match the saved baseline; zero extra revisions from creation; new case active; origin equals Rev 003; only the home-opening picker called; all six saved parent edges and project-wide numbers correct; no page errors.

| Asset | Source | SHA-256 |
| --- | --- | --- |
| step-1-design-directions.svg | Concept SVG | 1b372c3837eb6adfbedbfb26ead2a2dbc8d7d5a7c0ce7a21229f4d82c47d5d1e |
| step-2-choose-revision.png | Real running cAdtree | e3ad0915c0c40f52f4ee2aae192cb37d7e2eb4e70b0ca02d74d492b643963bf0 |
| step-2-create-action.png | Real running cAdtree | a8eeb9c8161bf55b2aa121a0fced47491b563713617a23c96094f76e64b8db0b |
| step-3-create-dialog.png | Real running cAdtree | ad35bf27938188a19eb03231408440ad64efeb813a5237ba02a7d25055ba321c |
| step-4-working-locations.svg | Concept SVG | b72bf10bb006241d6e1941b440a114256e7120b4e6ddc011bca0a50b4f9beda2 |
| step-4-case-location.png | Real running cAdtree | 6b658423964d923ad3dc866e68840ed342d2c0e19c54c2cb23471c30914c2936 |
| step-4-copy-folder-path.png | Real running cAdtree | 865c0c3251f40d8cce5bef608cad94a477e0271d3aea08a1296b24cd30e22f06 |
| step-5-main-active.png | Real running cAdtree | eb8fcfb811d4205f312759eda453f4624b4fb63483efc285f8c3e511a1a070eb |
| step-5-case-active.png | Real running cAdtree | e577c12552a6d00bccdf0334848ccad9c53a623750dc1d1960d1b43392d09924 |
| step-5-case-origin.png | Real running cAdtree | 59be15c90b5b48046fd13f0a291c73c25f5382576fb5dc8eafca1a46ce56814c |
| step-6-independent-history.svg | Concept SVG | 2208fb08767599b753e964ef341b025a7349854a8bc82caf01b52eb137d8ebb1 |
| step-6-saved-histories.png | Real running cAdtree | ae033195268e544dd3b9545275937b7d0cc8c12d974d0114386f49be431ef097 |

Reproduce captures with npm run build, then node tests/tutorial-4-capture.cjs. This writes controlled real-App screenshots into public/tutorials/explore-design-alternatives and capture evidence into ignored artifacts/tutorial-4. Native OS pickers are replaced in the sample; filesystem operations still run through the production adapter/services.

## 9. Files/components changed

- src/tutorials/explore-design-alternatives.ts: independent six-step data definition.
- public/tutorials/explore-design-alternatives/: nine PNGs and three concept SVGs.
- src/components/LearnCadtree.tsx: import and enable Tutorial 4 on its existing card.
- src/components/alternatives-tutorial.test.tsx: full connected-project isolation, navigation, gating, single visual, keyboard, replay, Close/Finish and active-case preservation.
- src/tutorials/explore-design-alternatives.test.ts: asset/accessibility validation.
- src/components/learn-cadtree.test.tsx, revision-tutorial.test.tsx, import-tutorial.test.tsx: only expected available/future card counts adjusted.
- tests/design-alternatives-sample.ts: disposable shared sample setup.
- tests/tutorial-4-capture.cjs, tests/tutorial-4-check.cjs: repeatable current-App capture and viewer checks.
- docs/tutorial-4.md: this completion report, exact copy and provenance.

TutorialViewerModal, all existing tutorial definitions/assets, product CSS/screens, engine services, storage formats and dependencies are unchanged.

## 10. Learn card integration

The existing design-alternatives card changes from coming-soon to available and binds EXPLORE_DESIGN_ALTERNATIVES_TUTORIAL. Existing Start tutorial → rendering and the shared viewer do the rest. Card title, description, position and design stay unchanged. Tutorials 1–3 remain enabled with their existing definitions; Compare & recover remains the sole noninteractive Coming soon card.

## 11. Tests and review

- npm test: 296 passed, including existing branch creation/switching, case lifecycle, revision and import suites.
- node node_modules/tsx/dist/cli.mjs --test src/tutorials/*.test.ts: five passed.
- Final focused Tutorial 4 component/asset run after final copy edits: three passed.
- npm run lint: TypeScript passed.
- npm run build: passed. Existing nonfatal Vite native-config, dynamic-import and bundle-size advisories remain.
- node tests/tutorial-4-capture.cjs: nine real captures and all sample inventory/origin/numbering assertions passed.
- node tests/tutorial-4-check.cjs: 12 visuals loaded at each of 1366×900, 1100×1244 and 390×844. One visual at a time; independent visual/step navigation; bounded controls; gated Next/Finish; keyboard controls; Back/reset/review retention; Close/replay; opener focus; Tutorials 1–3 launch; inactive Tutorial 5; zero picker calls; no horizontal overflow or page errors.
- Actual-App connected-work test: full home inventory signature (files, directories, hashes and records) unchanged; existing case count and revision count unchanged; uncaptured case edit preserved; lifecycle untouched; active case retained on return.
- Captures and desktop/mobile viewer layouts visually inspected.

## 12. Uncertainty and limits

Behavior is grounded in inspected source and exercised actual-App/engine sample flows. Actual test host: Windows with Chrome. Rendered checks use a file-loaded bundle of the current App and production CSS, consistent with prior tutorial captures. Native picker/permission/clipboard behavior, physical-disk faults and real SolidWorks document/reference handling are not qualified by these samples. macOS and Linux were not tested.

An initial direct Chrome check of localhost:2526 was refused by the execution sandbox with ERR_NETWORK_ACCESS_DENIED. After the stalled server was restarted through the connected runtime, live in-app browser review on port 2526 confirmed the corrected diagram and enlarged screenshot views. Automated rendering and interaction checks also passed in the isolated current-App harness described above.

## Visual refinement after annotated review

- Moved Reviewed baseline above Rev 003 so the branch curve cannot cross its text.
- Recaptured all nine real app screenshots with tighter regions. Revision selection now focuses on the three saved revisions, creation actions on their actual button group, and the creation form on its fields and submit action. A small white margin retains the full keyboard focus ring.
- Settings and path screenshots use a narrower real app viewport and focus on the working location. The final history image focuses on the shared Rev 003 origin, case Rev 004/005 and Main Rev 006, preserving the actual connecting edges.
- Removed container shadows only in the capture harness and cropped out modal edges. Product styles, tutorial layout, carousel and earlier tutorials remain unchanged.
- Preserved direct 3× captures, original aspect ratios and useful alt text; no screenshot was redrawn or generated. Updated the asset hashes and sample path above.
- Fifteen focused tutorial/component/asset tests passed after refinement. The production build passed. All 12 visuals loaded at 1366×900, 1100×1244 and 390×844 with no horizontal overflow or page errors. Actual-App sample assertions still confirmed unchanged Main bytes, exact case baseline, no revision from creation and correct project-wide parent edges.
- Live in-app browser inspection at the annotated viewport confirmed the cleared text overlap, enlarged revision and action controls, clean creation form, and readable final branch graph.

## Short manual walkthrough

1. Open the homepage and start Explore design alternatives.
2. Browse all six steps; Next/Finish stays gated until every visual in the current step is seen. Image arrows stay in the step.
3. Verify the real Rev 003 creation action/dialog, unique managed location, Main/case selector and History origin.
4. Read the project-wide Rev 004/005/006 graph, preservation guidance and closing hint. Finish, replay and Close.
5. Return to an existing project: active direction, files and saved history should be unchanged. Compare & recover remains Coming soon.
