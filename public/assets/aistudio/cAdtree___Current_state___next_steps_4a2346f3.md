# cAdtree: current state and next steps

**Last updated:** 13 Nov 2026, evening. **Development now happens on `main`** (founder's decision, 13 Nov), including future Knowledge Lab work; CLAUDE.md aligned in #71. `cadtree-knowledge-lab` is frozen at `3fc4fdf`. The Windows checkout was rebuilt on `main`.

This is the only live status doc. Update it at the end of every session instead of writing a new handoff. Stable vision, architecture, invariants and working rules are in `CLAUDE.md` at the repo root (merged in #44, updated #59, #67, #69 and #71). Read that first, especially §7 (settled decisions) and the §2 code map.

## Where things are

| Branch (GitHub `0xmitesh/cAdtree`, private) | Head | Contents |
|---|---|---|
| `main` | `0f5eb0a` (tree `09b8756`) | **The development line from 13 Nov.** Production app, Knowledge Lab (M1, M2), readable folder names (#37–#47), path budget (#48–#58), `CLAUDE.md` (#44, #59, #67, #69, #71), housekeeping (#60–#61), Remove Restore copy (#62–#67). Merged from `cadtree-knowledge-lab` in #68 and #70. No deploy is triggered by pushes to `main` (no workflows or deploy scripts). |
| `cadtree-knowledge-lab` | `3fc4fdf` | Frozen; same tree as `main` @ `7d77aef`. No new work goes here. |

**Baseline on `main` @ `7d77aef`** (cloud clone, Node 24.22.1, 13 Nov): `npm run lint` passes, `npm test` 580/580, `npm run test:knowledge-lab` 27/27, `npm run build` succeeds. #71 is docs-only (lint passes).

### Local checkouts

**Windows:** `C:\Users\1\Documents\cAdtree\{main,_test-home}`. `main` @ `0f5eb0a`, tree verified equal to GitHub (13 Nov); `core.autocrlf=true` is set in its repo config, so line-ending-only changes don't show in `git status`. The old `knowledge-lab` checkout was deleted (it had no local changes). The existing `node_modules` is still valid: `package-lock.json` didn't change between `571de68` and `0f5eb0a`. Node on Windows should be 24.12+.

**Mac:** `~/Documents/cadtree/{main,knowledge-lab}`, with `main` @ `7d77aef` (behind) and `knowledge-lab` @ `3fc4fdf` (retired). Not a priority now.
- **Setup:** Node 24 (CLAUDE.md says 24.12+), Chrome, `gh`, `npm ci`.
- **Dev server:** must be started by the founder in Terminal (`npm run dev:knowledge-lab`); the agent's device shell is a Linux sandbox and can't serve to Chrome.
- **Test homes:** `~/CadtreeTest-item1` (+ `-src`, old ID formats: its references now show as unavailable after #61); `~/CadtreeTest-item2` (+ `-src`, new formats; one project at exactly 240); `~/CadtreeTest-pathlimit` is empty and can be deleted.

**Agent workflow:** tests run in the cloud session's own clone of GitHub `main` (Node 24.22.1, `/opt/node24`), so they're never stale. Push, PR and merge go through the REST API (the proxy authenticates; send `Content-Type: application/json`). Local checkouts are fast-forwarded with a git bundle through a temporary `_transfer` folder; run `git bundle list-heads` on the device copy before fetching (once, a just-committed bundle was read stale and the fast-forward silently did nothing). Delete permission for the connected folder must be requested again after the desktop app reconnects; without it a fast-forward half-fails and leaves `.git/index.lock`. Deleting a `node_modules` through the device shell takes several minutes; split it into time-limited steps.

## Done

### Develop on main (13 Nov) — #71
CLAUDE.md §4, §5 and §7 now name `main` as the development line and PR base; `cadtree-knowledge-lab` frozen. Independently reviewed (Sonnet), merged with a merge commit; GitHub tree equals the tested tree.

### Readable folder names (Item 1, 10 Nov) — #37–#47
Readable names, `:`/`/` → `-`, clash → `(2)`, identity by ID after Finder renames, OS clutter files skipped when untracked. Hands-on Mac checks done 10 Nov.

### macOS path limits measured (10 Nov, Chrome)
| Limit | macOS | Windows |
|---|---|---|
| Single name | 255 characters | 255 |
| File name when written (`.crswap`) | 248 | ~248 |
| Full path, folder or file create | 1023 | 247 |
| Full path, file write | 1016 | ~251 |
One standard (warn 200 / block 240) on every platform so projects remain portable to Windows.

### Path budget (Item 2, 11 Nov) — #48–#58
Short IDs (record `YYYYMMDD-HHMMSS-xxxxxx`, event `YYYYMMDD-HHMMSS`), engine checks before the first write, UI hints and messages, safety net at the measured real limits. Hands-on Chrome check 11 Nov. Design note: Project doc `cAdtree_Item2_Path_Budget_Design_Note_2026-11-10`.

### Housekeeping (11–12 Nov)
| PR | Change |
|---|---|
| #60 | Destination conflicts detected by `FileConflictError` class, not message text (recovery service and folder `exclusiveCheck`, real and in-memory adapters alike) |
| #61 | Old reference-ID readers removed (option A): old `<prefix>-<uuid>` IDs and compact/full-hex markers now make reference evidence unavailable. Tests that only covered old formats removed; case ordering, case-to-case apply and staging-artifact coverage kept with new IDs |
| — | Playwright (`npm run test:ui`, cloud Chromium): 28 passed, 8 failed — `apply-preview`, `folder-platform` (4), `home`, `layout`, `welcome`. **All 8 also fail before Item 2** (`bc6e987`), so they're stale specs, not regressions. Home-setup and address-dialog specs pass. Since #65 more specs reference the removed Restore copy (see Next). |

### Remove "Restore copy" (Item 4, 11–12 Nov) — #62–#67
Design note (Project doc `cAdtree_Remove_Restore_Copy_Design_Note_2026-11-11`) approved 11 Nov with all recommendations.

| PR | Piece |
|---|---|
| #62 | Apply revert mode (engine): an earlier revision in the branch's history is brought back with base = the branch's latest revision; all differences are add/replace/delete rows, no conflicts; mode hashed and stored; merge on an ancestor now errors instead of showing 0 changes |
| #63 | "Bring back onto Main…" in History, "Make Main match Rev 003" dialog, all rows pre-selected, reason required, confirm counts, "Brought back from Rev 003" |
| #64 | Export folder `<Project> - <Branch> - R<nn>`, `(2)` on a clash, ≤ 64 characters |
| #65 | Restore copy removed (buttons, dialog, `recoverManagedCopy`, selected-files restore, shortcut, `recoveries/` for new projects). Path budget: user-file prefix 54 → 42, reserve stays 110; the design-case check now counts the 32-character incomplete marker (pre-existing gap) |
| #66 | Dialog wording: "Latest saved · Main" / "Bring back · Rev 003", plural-correct counts |
| #67 | CLAUDE.md, USER_GUIDE, Tutorial 5 step 6 "Return to a saved version" with new screenshots |

How the intents map now: look or share → **Export for review**; bring back onto Main → **Bring back onto Main…**; keep working from it → **Create design case**. Existing `recoveries/` folders are left untouched. Renamed files can't be brought back yet.

**Not yet done:** hands-on Chrome check of Bring back on a fresh test home.

### Context documents and Knowledge Lab
`CLAUDE.md` is the stable guide; Knowledge Lab M1A–M2-2 approved, unchanged.

## Next

1. **Hands-on Chrome check of Bring back** (founder starts `npm run dev:knowledge-lab`): fresh test home; save R1–R3 with a modified, an added and a deleted file; Bring back R1 (all, then only the deleted file); unsaved changes block; renamed file blocked; save afterwards and see "Brought back from"; Export folder names and `(2)`.
2. **Fix the Playwright specs** (tests only, one piece). On `9b99edd`: 24 passed, 12 failed. 8 are the old stale specs: `apply-preview`, `folder-platform` ×4, `home`, `layout`, `welcome`. 4 still look for removed UI: `component-identity` ×2 and `file-history` ("…for recovery" → now "…for export"), `workspace.spec.ts:108` ("Restore project copy").
3. Decide the next item (see Open decisions); Knowledge Lab M3 (PDF text extraction) unchanged.
4. Later, on the Mac: update `main`, retire the `knowledge-lab` checkout.

## Open decisions for the founder

- **Display name vs folder name after a Finder rename** (kept independent for now): (1) independent; (2) adopt the new folder name; (3) show both when they differ.
- **Revision label format:** UI `Rev 003` vs Export `R03`.
- **"Rename back"** for Bring back (renamed files are blocked today).
- **Sign-in for local work** (Firebase ~750 kB).
- **Still unsettled:** collaboration model (shared workspaces on Google Drive is the direction), monetization, the "D" in cAdtree.

## Backlog (not scheduled)

**Code cleanup**
- Old `<id>.done.json` catalog file marker still accepted in `references.ts` (~:212); nothing writes it any more.
- `CASE_INCOMPLETE_MARKER` in `path-budget.ts` duplicates `RECOVERY_MARKER_FILENAME` (drift test guards it).
- "Refresh saved states" in the Apply dialog resets the user's selection and reason (both modes).
- Revert doesn't restore empty folders (same as merge).
- `CreateBranchDialog.tsx` unreachable "choose a destination parent folder" mode.
- History's "Copy folder path" on an older revision points to the current working file.
- Drafts and view state reset after a folder rename (UI keys include the path).
- `App.tsx` ~2,600 lines.
- AI Studio leftovers (`react-example`, unused deps, Gemini key in `.env.example`).
- Firebase web API key restrictions.
- `.nvmrc` / `engines` for Node 24.
- `tests/browser/welcome.spec.ts:67` only checks the shared picker wording.

**Flaky under full-suite load:** `navigation-cleanup.test.tsx` (most often), `home-setup.test.tsx`, `branches.test.tsx` (new, 12 Nov).

**Known weaknesses that predate Item 1:** renaming a design-case folder by hand breaks that case; edited branch-location files with recomputed checksums can swap working leaves; a workspace folder from another home with the same `workspaceId` could be claimed.

**Tooling:** tutorial capture scripts regenerate all images per run (keep only real changes); `tutorial-5-capture.cjs` raises the viewport for the step-6 review image. History lane order sorts by ID (deterministic).

## Decision log (newest first; one line each)

**2026-11-13**
- CLAUDE.md aligned with developing on `main` (#71).
- **All development, including the Knowledge Lab, now happens on `main`**; `cadtree-knowledge-lab` is frozen. Windows checkout rebuilt as `{main,_test-home}`.
- `main` brought level again after #69 (#70).
- CLAUDE.md: new §7 settled decisions and §2 code map; reversing either needs the founder's approval (#69). Old root milestone docs marked historical.
- `cadtree-knowledge-lab` merged into `main` (#68) after checks on the exact head (lint, 580/580, 27/27, build); Playwright debt accepted as tests-only (no product regressions found); Bring back hands-on check still to do.

**2026-11-12**
- Remove Restore copy delivered (#62–#67); the path-budget piece merged into the removal PR because the drift test exercised the removed function.
- Bring back dialog in revert shows two endpoints ("Latest saved", "Bring back"), not Base/Source/Destination.
- The design-case path check counts the incomplete marker (fixed with #65).
- Reserved-looking project names in Export get the standard counter (`CON (2).x - …`).

**2026-11-11**
- Remove Restore copy design approved: "Bring back onto Main…" (Apply revert mode), only for earlier revisions in the active branch's history, all rows pre-selected, renames blocked for now, existing `recoveries/` untouched, Export names via the folder allocator with `(2)` and a 64-character cap.
- Old reference-ID readers removed (option A); case/revision validators not tightened.
- Conflict detection by `FileConflictError` class, never message text.
- Report work by title/problem, not bare item numbers.
- Item 2 complete (#48–#58); CLAUDE.md updated with its standards and the agent workflow (#59).
- Home-setup warning only when the address leaves less room than the default name allowances.
- The safety net reports the maximum allowed length for this computer (measured), not the 240 budget.
- Building phase, no active users: old on-disk formats no longer need to stay readable.
- Revisions and references use the same record-ID standard as everything else.
- The Knowledge Lab marker work (old Item 3) is folded into Item 2 as P4.

**2026-11-10**
- Item 2 design v2: shorten internal IDs before building the check; one standard (200/240) on every platform; address prompt required before the next create/import; allowances 32 (case) and 24 (project); existing projects are never blocked from opening or saving.
- ID standards: record ID `YYYYMMDD-HHMMSS-xxxxxx` for everyday records; event ID `YYYYMMDD-HHMMSS` + counter for Apply and recovery; no type prefixes; no branch/project names inside IDs.
- OS clutter files are ignored only when untracked; the same rule applies to scans, captures and every verify-after-write check.
- Tests run in the cloud clone of GitHub; the local checkout is fast-forwarded after each merge.
- Test homes go in fresh folders outside the repo root folders. `CLAUDE.md` is the stable guide and this doc is the live status.
- Delivery: one PR per reviewed piece (base now `main`), merge commits, tested against the current head.
- Folder naming (Item 1): readable names, `(2)` on clashes, illegal characters → `-`, reserved names → `CON (2)`, 255-byte cap; identity from metadata IDs.

**2026-11-09**
- The Knowledge Lab is an evidence-and-decision memory, not CAD intelligence.
- Native SolidWorks and ANSYS parsing were rejected.
