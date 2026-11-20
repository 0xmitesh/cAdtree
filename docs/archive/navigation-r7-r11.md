# Remaining navigation findings: R7-R11

Based on merged main `abbf27f` (PR #33). R1-R6 are already merged. This change
addresses the five remaining findings in the navigation review.

## Changes

| Finding | Result |
| --- | --- |
| R7 | Settings has a separate **Browser troubleshooting** disclosure. The action is **Reset all remembered folder connections in this browser**. Its confirmation explicitly covers connections and addresses across all accounts/workspaces, preserves CAD files/history/references/accounts, and explains reconnection. The existing browser-wide clear and reread behavior is retained. |
| R8 | Explorer shows **Show archived cases** only when archived records are known. History replaces an empty archive disclosure with a simple status. An empty reference library prioritizes import; search stays available once records exist, and **Show removed references** appears when removed records exist. Filters remain available when their results are empty. |
| R9 | History uses **Create design case from this revision**; the dialog and submit action use **Create design case**, with **Case name**. Saved revision tabs use **Changed files** and **Saved references**, while project navigation keeps **Changes** and **References**. The shared **Working case** control from R5 remains. Related case/review guidance follows these terms. |
| R10 | Ordinary project cards have one managed-project description. Duplicate-location guidance and incomplete/damaged inspection messages remain. |
| R11 | Each reference card places its reference ID, version ID and SHA-256 inside a closed **Technical details** disclosure. Title, filename, selected version, type, size, import date and ordinary actions remain visible. |

No production page, comparison implementation or case workflow is added or
removed. Persisted branch identifiers, creation parameters, storage formats,
revision numbering, reference context and CAD operations are unchanged. The
reset does not become project-scoped, and authentication is not reset.

## Tutorial alignment

- Tutorials 4 and 5 have updated case/review copy. Reports retain the current
  wording and asset hashes.
- Current-App captures refresh Tutorial 2's first saved revision, Tutorial 3's
  project/location screens, Tutorial 4's case workflow, and affected Tutorial 5
  Compare/Apply/recovery/archive scenes. Unchanged captures remain byte-identical.
- `tests/tutorial-3-capture.cjs` reproduces the imported Bracket Assembly project
  card and location using opaque sample CAD bytes and verifies the original
  source is unchanged. Existing generators reproduce the other refreshed assets.
- Tutorial 1 and the shared viewer/carousel are unchanged. Tutorial navigation
  remains static and does not perform project operations.

## Verification

- **326 app tests** passed, including three new current-App/component regressions:
  cross-account reset/cancellation with an unchanged complete managed-home
  fingerprint; archive-filter appearance and last-case Reopen/focus; reference
  empty/filtered/removed states plus exact attachment retrieval and technical data.
- All **six tutorial definition/asset checks**, TypeScript and production build
  passed. Existing creation, capture, Compare, Apply, recovery, lifecycle,
  authentication and navigation tests remain intact.
- Current-App Chrome checks at **1366 x 900**, **1100 x 1244** and **390 x 844**
  passed: consistent working context, revised tabs/creation controls, empty
  reference/archive filters, reset scope/cancellation, preserved drafts and
  inspection, unchanged project files, existing Archive/Reopen, and no overflow
  or page errors. Reset dialogs also fit each viewport.
- Populated reference cards were checked in Chrome at **1100 x 1244** and
  **390 x 844**: technical data starts hidden and can be opened, keyboard access
  works, selected defaults remain disabled, and choosing another version creates
  one catalogue without a CAD revision.
- Real capture walkthroughs verified case creation without a new revision,
  project-wide history/parent edges, Compare -> Apply -> save -> restore ->
  Archive, unchanged source work, and a verified four-file recovery copy.

Browser checks use disposable state and test authentication, not real user CAD
folders or provider sign-in. The local demo changes remain separate.
