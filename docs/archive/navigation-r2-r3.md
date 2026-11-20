# R2 and R3 — Main-view navigation

Based on main `9b42f54` after R1. Only R2 and R3 are addressed.

## Navigation rule

- The cAdtree logo is a button that opens the introduction. Its click, Enter and
  Space actions agree; it has no fake `#intro` link to copy or open elsewhere.
- **My workspaces** is the global workspace-list action.
- The explorer's **Cadtree home** row expands/collapses the hierarchy by mouse,
  Enter or Space. It no longer navigates to the workspace list. Workspace,
  project and case navigation in the tree remains available.
- **Back to My workspaces** is hidden above 960 px. It remains a contextual
  return on narrow layouts, matching the existing breakpoint that hides the
  desktop explorer.

## Browser Back and Forward

Main-view visits (introduction, workspace list, workspace projects and project
tabs) now enter browser history. Repeated clicks on the current view, case
switching and tutorial/dialog navigation do not create extra view visits. This
does not introduce a full URL router or deep links to local folders.

History contains only opaque session/index markers. In-memory destinations
contain identifiers and view names, not cached vault records or filesystem
handles. Returning to the currently loaded project changes the displayed view
while keeping its History/Changes components mounted, preserving inspection,
scan and draft state. Returning to another project uses the existing permission,
location and identity checks and reads current project records; note drafts remain
in the existing scoped draft cache. Old revision inspection is not retained after
opening a different project, consistent with the existing project-open behavior.

Back requests during file operations wait for completion. Account changes create
a new navigation session, so Back cannot restore a previous account's project.
After a page reload, old in-memory destinations are unavailable and do not
silently reconnect folders. Switching Cadtree homes also cannot reconnect a
previous home's destinations. Existing file-operation and authentication guards
remain authoritative.

## Checks

Final validation: all 316 app tests, full TypeScript check, production build and
both current-App Chrome viewports passed.

Five new actual-App component regressions cover:

1. Logo semantics, Back/Forward, unchanged inspected revision/working case/notes,
   no dialog history entries, no additional folder picker and identical CAD storage.
2. Root expand/collapse without leaving the workspace or adding a view visit.
3. Account isolation when navigating to old history entries.
4. Back during a held filesystem scan, resumed only after the operation finishes.
5. Back from a different project through workspace/home views, revalidating the
   original project and recovering its existing note draft without file changes.

The current-App Chrome harness `node tests/project-learning-check.cjs` also
checks R1 and R2/R3 at 1366 × 900 and 390 × 844. It verifies native Back/Forward,
keyboard entry, desktop/mobile return visibility, root expansion, state retention,
reload safety, no horizontal overflow and no page errors. It uses disposable
file-handle facades and injected test authentication, not native CAD files or
real provider sign-in. Screenshots are local ignored artifacts under
`artifacts/r1-learning/workspace-navigation-*.png`.

Run `npm test`, `npm run lint`, `npm run build`, and the Chrome harness above.
Existing tutorial tests were updated only to query the logo's new button role.
Tutorial definitions and screenshots, R1's Learn overlay, CAD storage formats,
revision behavior and R4–R11 are unchanged.
