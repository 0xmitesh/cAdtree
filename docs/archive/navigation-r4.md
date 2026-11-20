# R4 — Design cases in History

Based on main `5372dba` after R2/R3. Scope is R4 plus the Changes heading alignment fix.

History now has a **Design cases** disclosure immediately below its heading.
Expanding it reveals the existing DesignCases panel: saved activity/divergence,
Compare with Main, Archive case, archived cases and Reopen case. Settings no
longer mounts the panel. No new page or comparison/lifecycle implementation was
introduced. The working-branch selector remains in its existing locations; R5 is
not part of this change.

The panel uses the same state, handlers, confirmation dialogs and lifecycle
checks. Main cannot be archived, the current working case must be switched away
from before archiving, and dirty cases or pending applications still block an
archive. Archive/Reopen preserve the case folder and saved revisions and do not
switch the active working direction. Current History file filtering/inspection
and Changes note drafts survive case inspection and comparison.

Explorer help and the archive success message point to History → Design cases.
Tutorial 4's archive hint and Tutorial 5's final-step text/alt text/caption were
updated. The three real archive captures were regenerated through the current
App with disposable state; the confirmation image remained byte-identical, so
only the other two PNGs changed. Other tutorial screenshots and definitions are
preserved. The original tutorial reports retain their implementation history
with the affected copy and asset hashes updated.

## Verification

The Changes heading now bottom-aligns the active-branch selector and Scan for
changes button, with matching 40px control heights. The rule is scoped to Changes;
other headings and branch behavior are unchanged. Chrome checks at 1100 x 1244,
1366 x 900 and 390 x 844 confirmed matching top edges/heights, no horizontal
overflow and a working Scan action.

- `npm test`: all **318** app tests passed, including two new actual-App R4
  regressions and existing capture/apply/recovery/lifecycle/account/navigation
  checks.
- `tsx --test src/tutorials/*.test.ts`: all **6** definition/asset tests passed.
- `npm run lint` and `npm run build`: passed.
- `node tests/project-learning-check.cjs`: Chrome at **1366 × 900** and
  **390 × 844** passed. The harness now also inspects/compares cases in History,
  cancels and confirms Archive, reopens a case, verifies no new revisions or
  working-file changes, confirms Main remains active and checks overflow/errors.
- `node tests/tutorial-5-capture.cjs --archive-only`: three captures; the real
  service walkthrough still verified Compare → Review → Apply → save → restore
  → Archive, unchanged source files and a four-file verified recovery copy.
- Opening the panel and comparing case/Main endpoints produced **zero adapter
  list/read/write calls** and an identical complete managed-home fingerprint.
  Comparison remains scoped to all saved project files even when History is
  inspecting a particular file. Dirty-case refusal stays in the confirmation;
  Archive/Reopen require confirmation and retain files, revisions and focus.
- Existing server-based Playwright case specs were updated for the new entry
  point; the direct current-App Chrome harness above supplied browser validation.

Browser/capture verification uses injected test authentication and disposable
native-handle facades, not real provider sign-in or native CAD documents. No
engine, storage-format, revision-numbering, apply or recovery changes were made.
R1–R3 remain intact; R5–R11 are unchanged.
