# R5 - One shared working-case selector

Based on merged main `cf72130` (PR #31). Scope is R5 only.

History, Changes, References and Settings now share one project-context header.
It names the project and exposes the existing selector as **Working case**.
Changes and Settings no longer mount their own selectors; History's separate
Current branch status is removed. The shared header stays mounted while moving
between project views and is hidden when leaving the project for an introduction
or workspace view.

The selector still calls the existing `handleSelectBranch`. Folder resolution,
permissions, scan reset, per-case draft caches, archived/unavailable choices,
operation locks and lifecycle safeguards are unchanged. The control is disabled
during a running operation. Explicit explorer case selection remains available.

Inspecting an older revision, comparing saved revisions and highlighting graph
ancestry remain separate from the working destination. Revision detail keeps
the inspected revision's own case label. Merely navigating between project views
does not switch the working case, change files, create revisions or lose notes.

The header reuses the page gutters and existing native select styles at desktop
and mobile sizes. The Changes Scan button keeps its 40px height from PR #31;
the single shared selector also has a 40px minimum height.

Tutorial 2's Scan and first-revision History captures, its Scan alt text, and
Tutorial 4's switching copy, reports and real application captures now match the
shared header. Tutorial 4's capture script also refreshes Tutorial 2's Scan image;
`tests/tutorial-2-capture.cjs` refreshes its first-revision History image.
Tutorial 1/3/5 definitions and
assets remain unchanged; existing test/capture selectors follow the new header.

## Verification

- All 320 application tests passed, including two new current-App regressions
  covering all four views, revision/draft preservation, switching from every
  view, identical managed-home contents and disabled controls during a held scan.
- All six tutorial definition/asset checks passed; TypeScript and the production
  build passed.
- Existing browser/capture assertions now inspect the shared header rather than
  a per-page selector or old History status badge. Standalone History component
  tests leave the working-control assertions to the App regressions.
- Current-App Chrome checks passed at 1366 x 900, 1100 x 1244 and 390 x 844:
  exactly one stable selector, correct working case on every view, no overflow,
  retained notes/inspection, unchanged files, Learn/Back/Forward, and existing
  case Compare/Archive/Reopen behavior. Screenshots were visually inspected.
- Real Tutorial 4 walkthrough retained Main, created the correct case snapshot,
  consumed no revision number on creation, and preserved project-wide revision
  numbering and parent edges. Captures use disposable state and test auth.

No engine, filesystem format, Apply, recovery or reference-library behavior is
changed. R6-R11 remain outside scope. The local demo work is separate.
