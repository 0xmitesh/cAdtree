# cAdtree — home and managed workspace guide

Your designs. Your versions. Your storage.

## Run locally

Use a current standalone desktop Microsoft Edge or Google Chrome tab on Windows, macOS or Linux. Folder access is checked by browser capability, not by operating-system name. Use HTTPS or localhost; an embedded preview, Safari or Firefox cannot provide this folder workflow. If access is denied or revoked, allow local folder access in the browser site settings and explicitly reconnect the home. Cancelling a picker makes no connection or revision. From the source folder:

```powershell
npm ci
npm run dev
```

Open `http://127.0.0.1:2500/`. The development server listens only on your computer. If it is already running, refresh the page instead of starting another server on the same port.

For the production build:

```powershell
npm run build
npm run preview -- --host=127.0.0.1 --port=2501 --strictPort
```

Open `http://127.0.0.1:2501/`. The separate static-build ZIP contains `index.html` and its bundled `assets/`; serve its extracted directory over localhost or HTTPS. Opening the HTML directly as a computer file is not the supported folder-access workflow.

## Choose your Cadtree home

The hierarchy is **Cadtree home → Workspaces → Projects → Design branches and revisions**. Workspaces can represent clients, CAD tools, organisations, or other groups. They are organisational folders; no accounts, collaboration roles, or access controls are added. You do not need to sign in to use cAdtree: everything on your own computer works without an account. The **Account** control at the bottom of the left navigation lets you sign in anyway, for features that may come later (sharing, cloud storage, an AI knowledge base); none of these are available yet.

1. The welcome screen introduces saved design history, separate cases and recovery. Choose **Start my Cadtree home** for a new beginning. In the native folder picker, create/select a dedicated empty folder, suggested name **Cadtree**. Unrelated populated storage is rejected. **Open my Cadtree home** opens an existing recognized home. Home management options appear after connecting a home.
2. In **Complete home setup**, enter the selected folder’s full **Cadtree home folder address**, for example `D:\Cadtree`, copied from File Explorer’s address bar. This is required before the home is connected. Cancel or Back leaves the selected folder untouched; Back starts a new native folder selection and clears the address. The browser grants folder access but does not share its full absolute address, so cAdtree cannot compare your entry with the selected folder.
3. On **My workspaces**, choose **Create workspace** and enter a readable name. cAdtree allocates a unique child folder automatically. No second parent picker is needed. Repeated display names receive independent identities and folders.
4. **Open workspace** opens its projects. Use **Explorer** to move between connected workspaces, or **My workspaces** to return home. Switching never removes another workspace's registration.
5. The home shows actual discovered project counts and connection state. Missing, damaged, duplicate, and incomplete locations remain visible; no identity is guessed from a folder name.

Select the **cAdtree logo** to revisit the introduction. **My workspaces** returns to your connected home’s workspace overview. Returning from the introduction keeps the connected home available without another folder prompt.

The sidebar's **Explorer** presents an expandable **Cadtree home → Workspace → Project → Branch** tree in the same theme. Workspaces are selected through this tree, without a duplicate workspace shortcut above it. Use a chevron to expand/collapse a folder; select its name to open it. Selecting the current workspace returns to its overview while retaining the loaded project context and drafts. Selecting a branch explicitly changes the active working context. Moving keyboard focus or expanding folders does not change the active branch or the revision being inspected. The tree contains product navigation rather than editable vault internals.

The Explorer pane stays in the same sidebar position and retains its height when a project opens. **History**, **Changes**, and **Settings** appear in the project area beneath the tree. The tree scrolls independently when expanded folders exceed its available space.

Use Up/Down to move through visible items, Right/Left to expand/collapse or move to a child/parent, Home/End for the first/last item, and Enter/Space to open the focused item. On smaller screens, **Browse folders** opens the explorer in a dialog. Unavailable locations remain labelled and cannot be opened through the tree. Each tree selection validates its workspace/project identities and branch binding before installing the new context.

```text
Cadtree/
  .cadtree-home.json                 portable home identity
  .cadtree-home/workspaces/          checked registrations and publication markers
  Personal SolidWorks-<unique-id>/   workspace identity and projects
  Client ABC-<unique-id>/
  AutoCAD-<unique-id>/
```

## Create or import a project inside a workspace

Choose **Create project**, enter a name, and confirm. cAdtree creates an empty managed project and its Main working folder inside the workspace automatically. Save CAD files in the displayed Main folder, then scan and save your first revision explicitly.

Choose **Import existing project**, then **Choose project folder**. Save and close CAD documents before selecting the original CAD folder. Its folder name becomes the project name; copying and verification begin after selection, without a second name or submit step. The original stays untouched. Continue editing the managed Main copy and check CAD references. Import creates no revision automatically.

A project or workspace shows **Location details** (technical identities and paths) only when it needs attention or has extra or moved locations. History, Changes, Settings, and branch controls belong to an opened project.

Typical layout, relative to the selected workspace:

```text
.cadtree-workspace.json
projects/<project-name-unique-id>/
  .cadtree/                  portable project and branch locations
  vault/                     shared immutable revision history and objects
  working/main/              Main's editable CAD files
  working/<case-name-id>/    a case's independent editable CAD files
```

Scan/capture starts at the active `working/.../` leaf. The enclosing project container, other cases, vault, and management records are not scanned as part of that leaf.

cAdtree skips untracked OS-generated files when scanning a working folder: `.DS_Store`, `Thumbs.db`, `desktop.ini`, and macOS `._name` companion files that sit beside `name`. The Changes view lists them as skipped and never saves them in a revision. A file that is already part of a revision is tracked normally, even with one of these names.

## Work with cases

Select a saved revision in History and choose **Create branch from here**. For a managed project, enter only a name and engineering reason. cAdtree allocates the working folder automatically, restores and verifies the full baseline, saves its portable binding, and activates the case. Creation adds no revision.

Use **Active branch** in the header to select the working context. Open that case's displayed folder manually in SolidWorks. Selecting a case never replaces another folder's files or changes which CAD documents are open.

The first changed capture uses the selected source revision as its parent and receives the next project-wide revision number. Each project's branch selection and each branch's draft summary, overall notes, and file notes are preserved during same-session project/workspace switching. Drafts are session convenience state and are not saved revisions; a page reload discards them. Inspecting old revisions and clicking graph ancestry labels are independent of the active branch selector.

## Return to or copy historical files

There are three ways to use an earlier saved revision. None of them rewrites history.

- **Bring back onto Main…** (the button names the active branch). Select an earlier revision of the active branch in **History** and choose it. The dialog **Make Main match Rev NNN** lists every difference, all selected: **Bring back**, **Replace with Rev NNN's version** or **Remove (not in Rev NNN)**. Deselect files to bring back only some, enter the engineering reason, choose **Prepare bring-back** and confirm the counts. Only the working files change. Save a revision afterwards; History then shows **Brought back Rev NNN — your reason**. Replaced and removed files are kept with the operation and the latest revision stays in history. Unsaved working changes block it, and renamed files cannot be brought back yet.
- **Export a copy.** Select a revision and choose **Export a copy**; there you choose a folder to save in, pick the complete project or just the files you want, and export them into a separate folder named `<Project> - <Branch> - R<nn>` (a clash gets `(2)`). Use it to look at, share, or recover files, including files deleted later. See **Export a copy of a saved revision**.
- **Create design case.** Select a revision and choose **Create branch from here** to continue from it independently.

Export creates neither a branch nor a revision. An export of selected files may omit CAD dependencies, and cAdtree does not rewrite CAD references.

## Reopen and reconnect

Choose **Return to Cadtree** (or the remembered home folder's name), or **Open my Cadtree home** and select the home once. cAdtree reads its on-disk workspace catalogue, projects, and all intact branch locations. Renew browser permission when requested. The saved home address is reused only for the same selected directory entry. A copied home with the same portable ID needs its own address; an older unbound Windows setting is reused only when remembered access proves the original location. Otherwise the required address step appears, while the old preference text is retained. If it is missing, complete the required address step before connecting; cancelling leaves the on-disk home untouched. IndexedDB remembers handles, local addresses and last context; it is not the authoritative catalogue.

After clearing browser convenience data, select the home again. Do not locate each workspace, project, or case separately. Missing, moved, inaccessible, or invalidly mapped folders remain unavailable; cAdtree never recreates or rebinds them by name. Restore the recorded location or permission, then use **Refresh home**, **Refresh workspace**, or **Reconnect workspace**. Usable history remains inspectable while writes are blocked.

## Bring existing workspaces such as cam 2 or autocad into Cadtree

1. Open the target Cadtree home and choose **Home options → Import existing workspace**, then **Choose workspace folder**.
2. Select the existing workspace folder once. Save/close CAD documents and avoid editing that workspace during copying.
3. cAdtree coordinates same-origin writers, validates the projects and stored historical content, copies the complete workspace tree to a fresh child folder, and rechecks both copies before publishing it.
4. Continue work only in the displayed **Cadtree/<new managed folder>/** location. Originals remain untouched. Workspace/project/branch identities, historical record bytes, checksums, notes, relative project layouts, recovery folders, empty directories, and uncaptured working edits are preserved. No revision is invented.

An already published workspace identity is not copied again. Open its managed location from My workspaces. Use Import existing workspace to bring other existing workspaces into the home.

An interrupted migration retains a registered incomplete destination. Retrying allocates a fresh folder and keeps the earlier attempt under that workspace's **Location details**. An ambiguous/corrupt publication or duplicate established identity must be inspected before another copy can be made. cAdtree does not delete, repair, or clean up user storage automatically.

## Incomplete or damaged operations

Cancellation, read failures, unstable source files, and failed writes leave identified incomplete destinations. They are not presented as ready projects/cases. Retry uses fresh storage and never deletes the old directory automatically. If final publication cannot be confirmed, reopen first before retrying.

An established branch with a broken publication marker remains visible as damaged, keeps its identity/name reserved, and remains part of folder-isolation checks. Its historical records are not repaired or rewritten automatically. Settings explains integrity failures and interrupted attempts.

## Path length limits

Windows, and the browser's folder access on top of it, cannot open very long paths. cAdtree keeps every folder and file it creates under **240 characters** of full path, counted from the drive (for example `C:\Cadtree\Client ABC\projects\Packaging Gripper\...`). It measures the longest path that could appear later in that location: its own deepest internal files, and your longest CAD file path when it is known.

- **Keep your Cadtree home short.** A home such as `C:\Cadtree` leaves the most room. On macOS or Linux something like `/Users/<you>/Cadtree` works the same way; the limit still applies because the same folders may be opened on Windows.
- **Name hints.** When you create a workspace, project or design case, the name field shows "{n} characters left" once fewer than 30 remain. If the name would go over, the message appears under the field and the create button is disabled. Names that get a counter, such as `Name (2)`, need four more characters; cAdtree checks again when you create.
- **Warnings.** From 200 characters the action still works, and the confirmation adds a note such as "This location uses 212 of 240 characters." Shorter names leave room for design cases and deeper folders.
- **If an action is blocked,** nothing is created. The message says how many characters over the limit you are, shows the deepest path it measured, and tells you which name to shorten. Either shorten that name, or move your Cadtree home closer to the drive. If you moved the home folder, update its address in **Home options > Edit home folder address**.
- **Home address prompt.** The browser cannot tell cAdtree where the home folder is, so cAdtree asks you to paste its full address. If the address is missing, the next time you create or bring in a workspace, create or import a project, or create a design case, cAdtree asks for it once ("Add your Cadtree home address"). Save continues what you were doing; Cancel stops it without creating anything. Workspaces that are not directly inside your Cadtree home cannot be measured, so they are not checked and do not ask.
- **Long home address during setup.** If the address you enter for a new home is long, setup shows a warning but you can still save it.
- **"Path too long" after a create or save.** If a folder or file still cannot be written because its real path is too long (for example a CAD file nested deeper than cAdtree could measure, or a home address that is out of date), cAdtree shows "Path too long: {full path} ({n} characters; this computer's limit is {max})". Shorten the folder or file names along that path, or move your Cadtree home closer to the drive. Nothing is silently changed; retry after shortening.

## Copy folder and file paths

Home setup uses the native folder picker followed by a required absolute address entry. Windows drive addresses, Windows UNC addresses and absolute POSIX addresses are supported. The entered root determines separators; platform detection does not rewrite it. Quotes around pasted addresses, spaces, Unicode and drive/filesystem roots are accepted. POSIX case, Unicode spelling and literal backslashes are preserved. Use the expanded absolute address: `~`, `$HOME`, `${HOME}` and `%USERPROFILE%` shorthand are not expanded. Once configured, managed workspaces, projects and branches use that home root automatically. Edit a moved or mistaken root under **My workspaces → Home options → Edit home folder address**. This is the canonical local setting for managed descendants.

This address never authorizes or redirects filesystem operations. The browser cannot verify the typed absolute root against its handle; check it describes the same home. The descendant mappings and actual file existence are validated before copying. The setting stays in this browser/device, associated with the home identity and selected folder handle, and never enters portable records. A migrated workspace never inherits its old external absolute path. External recovery locations without known roots never receive invented paths. Clearing browser convenience data also clears these settings. If preference storage fails, an entered address remains usable for this session with a warning; it must be entered again after reopening. If a copy unexpectedly has no configured address, the same required setup dialog appears and completes the pending copy after successful setup.

Beside a file in Changes, the **…** menu (**File actions**) holds **Copy folder path**, which copies the full absolute path of its immediate containing folder, without the filename. For `Parts\Bracket.SLDPRT`, it copies the `Parts` folder; for a file directly in the branch working folder, it copies that working folder. Use this in your platform's file manager to open the folder, then open the file manually. **Copy file path** in the same menu includes the filename instead.

Without a saved root, the **Set up folder-path copying** dialog offers **Cancel** or **Save and copy**. Saving completes the original request. Canceling leaves your workspace usable and copies nothing. **Folder path copied** appears only after clipboard success; denied/unavailable access offers a selectable plain path for manual copying with Ctrl+C on Windows/Linux or Command+C on macOS.

History's revision details do not offer folder-path shortcuts: they would point at the current working copy, which can differ from (or no longer contain) the saved file. Use Changes for file-location shortcuts, or export the revision for the exact saved files.

For exact historical bytes, export the revision or selected files. Vault objects are never presented as editable CAD-file locations.

Shortcuts copy plain text only. They do not open a file manager, launch SolidWorks, switch branches, save revisions, or change CAD files.

### Get and use a folder address

| Platform | Copy the selected folder's address | Open a copied folder path |
| --- | --- | --- |
| Windows | Open the folder in File Explorer, press Ctrl+L and copy the address bar. | Paste into File Explorer's address bar and press Enter. |
| macOS | Select the folder in Finder and press Option+Command+C (Copy as Pathname). | In Finder press Shift+Command+G, paste, then Return. |
| Linux | Open the folder in your file manager and copy its location bar (usually Ctrl+L). | Paste into the file manager's location bar and press Enter. |

Choose the folder itself before copying its address. The browser cannot verify this text against the granted directory. If the OS moves a directory while retaining its handle, the browser cannot discover its new absolute address: update the home address explicitly. The address grants no access and never enters project metadata. cAdtree's **Explorer** remains its own navigation panel.

## Qualifications still needed

Automated Chrome tests exercise real browser filesystem handles in origin-private storage, actual IndexedDB persistence, reload/reconnection, cleared-convenience rediscovery, loaded-session offline scan/capture, dialog focus, and desktop/mobile layouts. The directory picker is replaced in those tests. Native OS picker/permission renewal, a full browser-process restart with local-disk handles, large-project performance, and real SolidWorks assembly/drawing reference resolution still require manual qualification. Cold offline app startup remains deferred. Begin with disposable self-contained files and keep real production folders out of development fixtures.

Byte-perfect storage and recovery do not prove SolidWorks reference correctness. Prepare a self-contained CAD source with the CAD application's own workflow where needed; this MVP does not discover or rewrite proprietary references.


### Compact project navigation

The project name appears above History, Changes, and Settings. The current case is shown as text (**Case: …**) beside the project name on History, Changes and Settings; the Explorer is the one place to switch cases and working folders (on narrow screens, open **Browse folders**). Selecting a saved revision or highlighting graph ancestry only changes the history inspection; it does not switch working folders.

Drag the desktop sidebar’s right edge to resize it. You can also focus **Resize sidebar** with Tab and use Left/Right arrows, Home (minimum), or End (maximum). Width is remembered locally and bounded to leave room for the main content. The tree keeps its position and scrolls independently above the project navigation. Narrow screens retain **Browse folders**.

Settings is short. **Folder connections** lists a working folder only when a connection is missing or needs repair; otherwise it says that all folders are connected. **Troubleshooting** (closed by default) holds the working-folder location and **Reconnect workspace**, **Verify all file contents**, incomplete attempts, advanced record information and **Reset folder connections**. If an incomplete attempt or a damaged record exists, Settings shows a one-line hint that opens Troubleshooting. When a connection is missing, an actionable message also appears in the project view. Errors, integrity warnings, incomplete operations, and progress remain visible when relevant.


### Home options

After connecting a home, **Home options** appears beside **Create workspace** and provides **Edit home folder address**, **Import existing workspace**, and **Switch Cadtree home**. It is absent from the welcome screen. Import-specific copy and original-file protections are explained inside the import flow. Switching homes moves no files and deletes no home. Each home retains its own address. There is no permanent management block beneath the workspace cards.

### File history

Use **File** beside the Current branch indicator in History. **All files** keeps the existing complete project history. Click the box and pick a file, or type part of its path to narrow the list (case does not matter); use the arrow keys and Enter to choose, Escape to close the list, and the clear button (or **All files**) to return to the complete history. Every file is listed once, by its latest known name. Selecting it shows its addition, byte modifications, deletion, and reintroduction across Main and cases. Files deleted from the latest snapshot remain in the list; the same filename in two directories is two files. Reverting to earlier bytes remains a separate modification.

Files tracked by component identity are followed across confirmed renames. A file saved before tracking is listed by its path, and its renames appear as deletion/addition; the page says so when you select it. If two entries would otherwise look the same (for example, a deleted file and a different file that later took its name), a short ID is added to tell them apart.

In file history, the existing branch buttons filter the selected branch's recorded ancestry. Click the selected button again or **Show all branches** to clear the filter. In All files, a branch button selects that case's latest revision, scrolls it into view and lightly marks only the revisions saved on that case (not the earlier history it branched from); click it again to clear the mark. Nothing is faded. Both Graph and List show the newest revision first. Neither filtering, file selection, nor revision inspection changes the active working branch. Select a branch in Explorer to change the working folder. File selection resets when you open a different project.

The graph follows actual parents and skips unchanged snapshots. Dashed **Inherited state** or **Inherited absence** nodes preserve branch origins and are counted separately from change events. An unchanged parent opened through a deleted file's **View in parent revision** shortcut is also context only. Revision numbers remain project-wide, so gaps are expected. Branch labels identify where the recorded revision belongs; file-state labels may point to an earlier revision when a case has not changed the file since then.

The details panel keeps the project summary, revision number and branch, and adds the selected file's status and any notes recorded for it at that revision. Export and bring-back work from a complete saved project snapshot. Deleted files must be taken from an earlier snapshot, never from their deletion event. Missing, damaged, cyclic, or ambiguous parent evidence is labelled **History unavailable**, rather than inferred as deletion or unchanged content. Byte changes do not necessarily indicate geometry changes. No CAD parsing, new records, or storage changes are involved.

Development regression: `npm run test:ui -- tests/browser/file-history.spec.ts` runs the actual App against isolated browser-storage fixtures created by `tests/file-history-seed.ts` through the existing engine. The fixture covers ten Main snapshots with four pin events, an older fork, unchanged captures, a revert, deleted historical paths, and deletion/reintroduction, saved without component tracking so the picker lists paths. It is development-only and is not included in production. The existing `npm run dev:synthetic` preview also exposes File history with its multi-workspace samples; `tests/preview.tsx` remains an isolated component harness.

### Compare two saved revisions

In History, inspect a saved revision and choose **Compare** in its details. **To** starts with that inspected revision. **From** starts with its recorded parent when that parent is available; otherwise choose a baseline. Each selector identifies the project revision number, branch and summary. Any two saved revisions from this project can be compared, including nonadjacent revisions and different cases. **Swap** reverses the direction. Selecting endpoints and closing the dialog leave the working branch, history selection, file filter, graph/list mode and recovery selection intact. Opening another project resets comparison state.

Results describe **From → To**. Added files exist only in To; deleted files exist only in From; modified files share a relative path but have different content hashes; unchanged files share a path and hash. Timestamps do not create changes. Changed files appear first, and unchanged files can be expanded. File paths remain distinct even when their basenames match. Byte differences remain grouped by path. Comparing a revision with itself is valid and shows no differences.

If opened from File history, comparison initially focuses on that selected path. The scope is labelled explicitly; choose **Show all files** for the complete project or **Focus on selected file** to return. A path absent in both endpoints is explained. **Project directory changes** always covers the complete project, including empty folders, independently of file scope.

**Overall engineering notes** shows the complete project notes for both endpoints in labelled From/To panels and remains available in file scope. It starts expanded and can be collapsed. Each file's From/To panels also show presence, saved size, and per-file notes recorded at that endpoint, labelled by revision. Content hashes (SHA-256) and the component-identity notice (continuity across different paths or different components at the same path) are kept in a closed **Technical details** section inside the dialog. Missing overall or per-file notes are stated explicitly. These notes do not summarize intervening changes. Comparison reads saved manifests and hashes only; it does not scan working folders, verify all stored binary contents, analyze geometry, or assess CAD compatibility. Previously verified contents are labelled separately from verified metadata. Missing, damaged or ambiguous selected endpoints show an explicit unavailable result. Two healthy endpoints can still be compared when intervening ancestry is unavailable.

Comparison is read-only: it cannot apply, merge or bring back files. Close it to use the existing History controls if needed. Complete project snapshots, portable records and storage formats remain unchanged.

Development regression: `npm run test:ui -- tests/browser/comparison.spec.ts` loads the actual App using `tests/comparison-seed.ts`. The isolated browser-storage fixture contains an older five-file case and a twenty-file Main revision, endpoint notes, equal basenames, deleted historical files and empty folders. The test fingerprints the managed home before and after comparison interactions. The fixture is development-only and is not included in production. `npm run dev:synthetic` also provides Compare in the existing populated preview.

### Review and apply selected case changes

Inspect a saved revision in History and choose **Review changes to apply**. **Source** is that revision. **Destination** is the active working branch's latest trustworthy saved baseline (including its inherited origin before its first capture). **Base** is their nearest shared ancestor, established through validated parent relationships. Revision numbers, branches and summaries identify all three. Opening and closing the review does not switch the working branch or change history inspection. Ordinary **Compare** remains read-only and separate.

Start with no files selected. Choose source additions, modifications and explicit deletions. Source-unchanged paths preserve Destination, including newer destination versions and Main-only additions. Identical endpoint bytes need no application. The planner remains path-based; rename-dependent actions and different components at the same path are blocked when identity evidence is available; equal basenames in different directories remain distinct. Byte hashes describe content, not geometry or CAD compatibility.

For independently changed paths, explicitly choose **Keep destination**, **Use source state**, or **Leave unresolved**. Source deletion choices say **DELETE destination file**. Unselected conflicts retain Destination; selected unresolved conflicts block readiness. Deselecting a conflict clears its decision. Enter an **Engineering reason for proposed application**. Review **Selected actions**, **Proposed files**, overall engineering notes and each path's saved file states/notes. Notes are labelled Base/Source/Destination and describe those endpoints rather than every intervening change. Metadata verification is distinct from binary-content verification.

Choose **Prepare application**. If a previously read-only connection needs write access, the explicit Prepare/Recover action requests permission; denied access stops without a working-file change. cAdtree resolves and validates branch connections, then scans the complete destination against its saved baseline, including directory changes. If it contains uncaptured edits, stop: save a normal revision first, then refresh History and review a fresh plan. Preparation never discards edits or captures them automatically. Current uncaptured edits are excluded from the saved-state plan and are not authorized for replacement.

The final confirmation identifies the project, destination branch, connected working location, saved baseline, source revision, exact additions/replacements/deletions, retained conflict decisions and reason. Save and close relevant CAD documents, acknowledge the confirmation, then choose **Apply confirmed changes**. Back to review requires preparation and acknowledgement again. A changed baseline, mapping or reviewed plan is rejected. **Refresh saved states** reloads the saved evidence and clears selections and reason for a fresh review. Checks are repeated under the existing project writer lock; staged verified copies and recovery evidence are persisted before working-file changes begin.

Successful application shows **Applied to working files — revision not yet saved**. It creates no revision and changes no source working folder. Open the destination in CAD, check references/rebuilds and make adjustments as needed. Use the normal Changes scan, engineering notes, per-file notes and **Save revision** flow. The resulting complete snapshot retains the normal destination parent and next project-wide revision number. History shows one line, **Copied from Rev NNN on <case> — your reason**, and draws a dashed line from the revision to its source in the graph (the List view says "copied from Rev NNN"). The revision's **Troubleshooting** section lists the selected files and conflict choices. **Before, applied and captured bytes** distinguishes the originally applied state from the final captured state, including later engineer adjustments. Provenance supplements the summary and notes; it does not replace them or claim a source-branch merge.

The pending status is shown only for its destination branch. Only one unfinished application is allowed there. After successful application, **Abandon pending provenance** offers explicit confirmation to record an abandoned outcome without deleting or reverting working edits. Its plan and evidence remain. A later revision does not claim abandoned provenance. If all applied changes were manually reverted, ordinary capture still requires a real difference; abandon the pending provenance explicitly if no new revision is needed.

#### Interrupted application and recovery

Cancellation, permission loss, source-object failure, working-write failure or an uncertain acknowledgement can leave an unfinished operation. cAdtree never reports a partial result as success. Reconnecting/reloading reads operation evidence from the vault independently of browser preferences. Another apply and ordinary capture are blocked until the operation is recovered or its unavailable evidence is manually inspected. Do not retry by deleting operation folders.

Choose **Recover interrupted application**, save/close CAD documents and confirm. Recovery checks every affected path. Already-restored before-states are accepted. Recognized applied bytes (or a recognized applied deletion) can be restored from verified before-state copies. Unexpected later bytes, case/directory collisions and truncated/unknown files are not blindly overwritten. Readable unexpected bytes are copied to fresh evidence storage while the live files remain untouched. The message identifies paths needing manual recovery. Inspect the retained before/applied hashes and before-state copy locations, restore affected paths manually if appropriate, then retry recovery to verify them. Unrelated files and all directories remain; any newly created empty directories are retained and may need a normal reviewed capture.

**Application reason, actions and recovery evidence** shows `vault/applications/<branch-id>/<operation-id>/`, affected paths, before/applied hashes and indexed before-state copies. Staged copies exist after successful staging. Unexpected copies use the same action index under `unexpected/<recovery-id>/`. A damaged plan or event sequence requires manual evidence inspection; there is no force-clear or automatic deletion of failed records. Restore readable valid records from an independent backup where necessary before attempting automated recovery. Evidence is retained even after recovery, abandonment and capture.

#### Durability and limits

Each operation has an additive versioned, checksummed `plan.json` plus an exclusive append-only, checksum-linked `events/` sequence. The compact plan stores endpoint identities, choices, reason and affected-file metadata; it does not duplicate a complete project inventory or create another history database. Verified `before/` and `source/` copies live beside it, outside captured working leaves. A persisted/read-back intent precedes each working change, and written bytes/deletions are verified afterwards. Before revision publication, a capture event records its exact revision ID, manifest hash, reviewed change signature and final file states. The existing verified completion record determines whether that link was consumed. Capture failure retains pending provenance; a retry of the same reviewed capture reconciles an already published revision instead of publishing another. No historical manifest or checksum rule is changed. Existing managed project adoption and workspace/home migration copy this evidence with the vault.

Preparation and execution use the existing writer lock, bounded file streams, progress and cancellation. Same-origin Web Locks do not lock CAD applications, sync software or another browser. The operation is not multi-file atomic. Checks narrow external-writer races but cannot eliminate the interval between a read and a write/delete; retained before-state evidence is essential. A real backup remains necessary. Browser APIs cannot guarantee hardware-level durability during sudden power loss.

File actions only: existing destination directories, including empty ones, remain and required parent directories are added. Source empty-folder-only changes and directory removals are deferred. File/directory and case-insensitive path collisions block readiness; folder-to-file conversions requiring directory removal remain blocked. Shared ancestry and destination baseline validation stay conservative. Ordinary Compare can remain available for healthy endpoints even when application ancestry is unavailable. There is no geometry merge, CAD parser, automatic branch closure or compatibility check.

Development checks use disposable origin-private browser storage with substituted directory pickers. `npm run test:ui -- tests/browser/application.spec.ts` runs the actual desktop/mobile apply, reload, CAD-like adjustment and capture flow; `tests/application-fixture.ts` changes only the named synthetic fixture. `npm run test:ui -- tests/browser/apply-preview.spec.ts` checks that review alone remains read-only. `npm test` includes focused failure injection, permission/cancellation/recovery, provenance publication/retry and copy/migration coverage. Native Windows pickers/permissions, physical disk failures, real CAD applications and assemblies, other browsers and physical mobile devices still require qualification. `npm run dev:synthetic` exposes the current application in the labelled populated development preview; no seed controls enter production.

### Archive and reopen design cases

Use **Settings → Design cases** to archive a non-Main case. Main always stays active. If the case is your current working branch, switch to another active branch first; cAdtree does not switch for you. Archive is an explicit organizational action, independent of applying selected changes. Applying files never archives a case or labels it merged.

Choose **Archive case**, review the confirmation and confirm. cAdtree checks the target case's connected working folder against its canonical saved baseline, including empty directories. Uncaptured changes, missing/unreadable evidence or a pending/unavailable application stop the operation. Save a normal revision or use the existing application recovery, save or explicit abandonment controls as appropriate, then try again. No working edits are saved, discarded or restored automatically. Session draft summaries, overall notes and per-file notes survive archive/reopen and branch switching; drafts still do not survive page reload, as before.

Active cases remain prominent in the Explorer. **Show archived cases** in Explorer reveals archived names as read-only navigation rows; use **Settings → Design cases → Archived cases** to find **Reopen case**. Archived revisions remain in the full graph/list with **Archived** beside their case name. Their File history, Compare, engineering notes and Copied from provenance remain available. Saved archived revisions can still be sources for applying selected changes to an active destination, creating a new case and fresh-folder recovery.

An archived case cannot receive a new capture or application in the current engine. If an already-open context becomes archived elsewhere, reopen it or explicitly choose another active branch. **Reopen case** restores Active status with the same identity, history, baseline and mapped folder; it does not switch branches or restore files. A missing connection still needs reconnection before work resumes. A child case remains independent when its parent is archived, and archived case names remain reserved. Archived folders stay in all existing folder-isolation checks.

Lifecycle changes write only separate, versioned/checksummed records in `vault/case-lifecycle/<branch-id>.<sequence>.json`. Original branch records and their ready-marker hashes, snapshots, objects, notes, origins, application evidence and folder mappings are unchanged. Existing projects without lifecycle metadata default to Active. Present malformed, unreadable, unsupported or contradictory lifecycle evidence is shown as unavailable and blocks affected working writes, rather than being assumed Active. Unassignable lifecycle-folder damage blocks working writes project-wide. Inspect or restore valid retained metadata before retrying; cAdtree provides no force-clear, automatic repair or cleanup. Adoption and workspace/home migration retain these records.

The existing project writer lock serializes lifecycle changes with app writers. Each change is reloaded, validated, persisted exclusively and read back before success. Repeated requests for the same current outcome do not add another record; a stale request for a different outcome requires refresh. A failed acknowledgement can still be recognized through verified readback. Partial records remain explicit unavailable evidence. No hardware-level atomicity or protection against external CAD/sync writers is claimed. Archiving does not change OS permissions: external tools can still edit a folder, and normal checks apply when the case is reopened. Older app builds do not enforce this lifecycle feature.

Development regression: `npm run test:ui -- tests/browser/case-lifecycle.spec.ts` exercises the actual App on desktop and mobile with disposable browser-storage fixtures. It checks archive/discovery, archived history/Compare/source review, reload/reopen, unchanged project bytes outside lifecycle metadata, and desktop session draft preservation including per-file notes. Native Windows picker/permission behavior, real CAD operation and sudden physical-disk failures are separate qualification work.

### Compare a case with Main

The design cases panel lists each active or archived case with **Compare with Main** and **Archive case** or **Reopen case**. It has no separate activity or divergence section.

Choose **Compare with Main** to open the existing saved comparison with **From = case saved baseline** and **To = Main saved baseline**, across all project files. Close it to return to the case information. This does not switch the working branch, scan folders, alter drafts, apply files, or write project records. Working edits are excluded. Existing comparison notes and metadata/content verification distinctions still apply.

If a case's or Main's current saved baseline cannot be established, **Compare with Main** is disabled; ordinary History → Compare keeps its endpoint-only rules for explicitly selected healthy saved revisions.

## Component identity and confirmed renames

New projects track each saved document with a permanent component ID. A component is one tracked file, independent of file format; it is not a body, assembly occurrence or configuration. Continue naming and saving normally. An ordinary edit, including a property-only edit, keeps its ID; byte hashes still change. cAdtree does not distinguish geometry from property changes.

The **Component identity** panel appears in **Changes** only when a rename may have happened, or when you have a pending decision. A missing file whose bytes match a new file is suggested as a possible rename, with that file already selected; multiple matches are labelled ambiguous and you choose explicitly. If a file was renamed and edited, open the **…** menu on the deleted file in **Changes**, choose **Match to a new file…**, and pick its new path if you know it is the same document. **Confirm rename** records the association for the next successful revision; **Cancel association** removes it. Leaving paths unassociated records deletion/addition. Confirmation does not physically rename files or fix CAD references. A fresh scan and baseline check at capture rejects stale decisions.

**Save As** or duplication gives the new file a distinct ID when the original remains, even with identical bytes. If an unrelated document replaced a tracked file at its existing path, open the **…** menu on that file in **Changes**, choose **Treat as new component**, and confirm. Its next successful revision gets a new ID; the previous history remains available. This can save an identity-only revision with unchanged bytes. Deletion never erases component history. A file reappearing after a saved deletion receives a new ID; linking a reappearance to an older deleted component is not offered in this release.

Use **History → File** and pick the file to follow a document across confirmed names and branches, including deleted/replaced components. It is listed once, by its latest name; a short ID is shown only to tell apart entries with the same name. Each historical revision shows its original path and existing notes. Selecting a file never switches your working branch. Files without component evidence are listed by path instead. Export always uses the selected snapshot's historical filenames: before a rename, caliper.SLDPRT; afterward, cliper.SLDPRT. An exported copy is not a registered branch.

New projects are enrolled when they are created. A project from before component tracking is not upgraded and keeps being followed by file name (Changes says "Renames aren't tracked for this project."); there is no upgrade button. Branching from an older revision without identity evidence establishes new identities at the next save. If enrollment was interrupted, **Changes** shows an error with **Retry component enrollment**, which completes it without reallocating its recorded IDs. Damaged or newer evidence is reported rather than replaced.

**Import existing project** recognizes complete managed cAdtree projects and preserves project/document IDs, saved history and uncaptured branch edits. Select the complete project container, including its vault and working folders. Importing an ordinary CAD folder creates a new project and new document IDs. Complete workspace import and relocation preserve the portable metadata; browser convenience data is unnecessary for identity reconstruction. Duplicate locations discovered inside a connected workspace are exposed explicitly and are never combined. Disconnected copies elsewhere cannot be discovered automatically.

Selective application remains path-based. Actions involving one component at different endpoint paths, different components at the same path, or unavailable identity endpoints are blocked. Unaffected actions remain available. Safe source additions carry their source component IDs through the existing application provenance. There is no automatic filename translation or complete rename-aware integration planner.

Keep the complete project when copying or moving it. Do not remove or edit vault/components. Missing/damaged evidence blocks new component-aware captures and applications; saved paths and byte comparisons remain inspectable. Older builds do not enforce these rules and may create revisions missing required identity evidence. Complete identity-metadata erasure cannot be distinguished from a genuinely legacy project. Writer locks coordinate only same-origin cAdtree sessions, not CAD programs, other computers or synchronization tools.

### Manual acceptance with disposable files

1. Create a test project, add caliper.SLDPRT to Main, and save a revision.
2. Rename it to cliper.SLDPRT in Explorer or your application, scan, choose the new path, and confirm the rename. Save another revision.
3. Select the component in History. Verify both filenames and the rename event, then export each revision into a separate folder and check its original filename.
4. Make a Save As copy while retaining the original. Save and verify two distinct component entries. Try an explicit same-path replacement and verify the older component remains selectable.
5. Close/reopen the project or import its complete container into a different disposable workspace; verify the IDs/history persist. Inspect CAD references/rebuilds separately in the native application.


## Project references and revision context

Open a project and choose **References** to browse its supporting files. The page has one search box: leave **Search references** empty to see every saved file, or type to narrow the list. The current case is not shown on References.

Search matches a reference's name, its file name, its note, who saved it, and the file it applies to or other details of the revision it was attached to (such as its summary or location). Each saved attachment version appears as a downloadable file with its save date, recorded name and the branch/revision/part associations that match the search. Whole-revision sources are labelled **Whole revision**. Confirmed renames retain their associations; a different component reusing the old filename does not inherit them.

Click a reference title to download its exact saved file. Browser download settings control the location; the original filename is suggested. Earlier versions and sources removed from current defaults remain available. An older imported source with no saved association appears as **Not attached to a saved revision yet**. Besides adding new references (below), this page has no edit, version-addition, default-selection or removal actions.

To add a reference without saving a revision, choose **Add reference…**, pick one or more files, add an optional note, and choose **Add**. Each file is copied and verified into the project (attributed to you when you are signed in) and applies to the whole project: it is included whenever you save a revision from then on, and shows **Applies to the whole project** until then. Each file is published in one step, so a file is never added without being applied. If one file fails, the files already added stay, and the message names the file that failed and any not yet added; those stay in the panel for another try. Nothing is added if you choose **Cancel**, and the button is disabled when the project is read-only. To stop a reference applying to the whole project, choose **Stop applying to the whole project** on it and confirm: it stays in the list and in earlier revisions, and revisions you save afterwards no longer include it. To tie a file to one part, attach it when you save a revision instead.

In **Changes**, scan the working folder. In **Save revision**, choose **+ Attach reference files** beside the engineering-notes option. Select one or more files, add an optional reference note for each, and choose **Whole revision** or a specific part/file in **Applies to**. Files remain in the draft until you choose **Save revision**. Removing a draft attachment leaves the original file untouched. Draft attachments and notes are kept when navigating between pages or branches during the session.

Save with the usual revision summary and engineering notes. Each reference is copied and verified, attributed to you when you are signed in, then attached to that saved revision and selected part. Existing explicit references carry forward with their notes; expand the attachment option, then **Manage references (N)** to adjust or remove those links for the new revision. Existing project defaults remain carried forward. Confirm CAD renames using the existing identity controls; deleted or replaced part associations must be reviewed before saving. With unchanged design files, adding a reference can still create a revision. Repeated saves with identical context are rejected.

If copying the references succeeds but a later revision-save step fails, the saved files remain in the draft for retry, without another upload. They may appear as unattached files in References until the revision succeeds. Earlier revisions and their attachments are never rewritten.

Inspect a saved revision in **History → Saved references** to see its references, filenames, saved dates and who saved each attachment, along with any location, explanation or part filename. Older attachments without a saved name show **Author not recorded**; the current viewer is never substituted. Click a reference title to download a verified copy of that exact saved version under its original filename. The attachment stays in the vault; browser download settings choose the destination (normally Downloads, or a save prompt when configured). A confirmed rename follows the component ID while older revisions retain their historical filenames. Older revisions without recorded references show **No references were saved with this revision.** Today's project defaults are never backfilled. Retrospective annotation of saved revisions is deferred.

All evidence is on disk under the project vault, outside branch working folders. Reconnect the complete project/home after clearing browser convenience data. Use cAdtree's complete project/workspace copy or adoption workflows to preserve all versions, associations and attachment objects. Copying only a branch working folder does not copy project history or references. Reference attachments do not appear as CAD changes and never receive component IDs.

If import/save is cancelled or interrupted, incomplete metadata remains identifiable in **Settings → Troubleshooting** and does not become a published reference or saved context. Reopen to inspect the outcome before a fresh retry, especially after a lost browser acknowledgement. Missing, corrupt or unsupported evidence is reported; it is never regenerated silently. Exact retrieval, linked captures and complete copies verify required content and refuse damaged evidence. CAD inspection and recovery remain available wherever their own saved evidence is valid. Permanent deletion and garbage collection are outside this stage.

Manual walkthrough (disposable project, supported desktop browser):

1. Open a populated project or the synthetic preview. In References, leave search empty; inspect each file's saved date, name and revision/part details, then click its title to download a copy.
2. Search by reference name, filename, note, the file it applies to, or revision description. Confirm only matching references appear and clearing the search restores all of them. Check that the working branch has not changed.
3. In a project containing multiple attachment versions, download the older saved file and compare it with the original. Confirm removed defaults remain available through their historical associations and no editing/removal controls appear on References.
4. Confirm a CAD rename, capture and compare the component ID across revisions, retaining old filenames. Make a branch from the older revision and verify its explicit links carry forward without changing the older revision.
5. Reopen after clearing browser convenience data. Copy/import/adopt the complete project or workspace and check IDs, exact versions, old context and retrieved hashes in the copy. Export an older CAD snapshot and check its original filenames.
6. On disposable copies only, remove/corrupt an attachment or context sidecar, revoke permission, and interrupt an import/capture. Verify clear errors, no dangling committed context, unchanged revision count on pre-completion rejection, usable independent CAD recovery, and a fresh retry after restoring evidence.
7. Export a copy of a saved CAD revision. Check that with **Include references** ticked the output has a `References` folder with the attachments, and that with it unticked the output contains only snapshot design files and its summary (which says reference attachments are not included).

## Export a copy of a saved revision

Select the saved revision in **History**, then choose **Export a copy**. The dialog identifies that revision's recorded project, branch and project-wide revision number, even when another branch is active. All exported bytes come from the saved snapshot, so newer working edits are excluded.

**Include references** is ticked by default. It copies the reference attachments that apply to that saved revision (those saved with the project and those linked to the exported files) into a `References` folder inside the copy, under their original file names (a clash gets `(2)`; if the snapshot already has a `References` entry, the folder is named `References (2)`). Only attachments whose saved content verifies are copied; any that cannot be are left out and listed as `Not included` in the summary and in the dialog, and the rest of the export still completes. Untick it to export the design files only; the summary then says that reference attachments are not included.

- **Complete project** preserves the snapshot's filenames, relative directories and empty directories inside a new folder such as `Actuator - Alternative - R03`.
- **Selected files** lists only files present in that snapshot. It preserves their relative paths and filenames by default and clearly marks the output as partial. CAD dependencies are not discovered or added automatically.
- **Add branch and revision to filenames** is an explicit selected-files option for standalone review. For example, `Parts/Pin.SLDPRT` becomes `Parts/Pin_Alternative_R03.SLDPRT`. Extensions are retained. Other documents may require reference repair; native CAD references are not rewritten.

Use **Choose folder…** to pick where the copy is saved (the dialog shows the folder's name), then check the proposed child folder. The file list and the summary text are behind **Show details**; open it to review every output filename before exporting. An existing label receives a proposed numbered alternative, such as `Actuator - Alternative - R03 (2)`, for confirmation. Project/branch labels and optional labelled filenames are sanitized for portability; a resulting filename collision blocks export until the selection or naming option is corrected. Original internal filenames are never silently changed in a complete export. A saved path that cannot be represented portably is rejected explicitly.

Each output includes a readable `_CADTREE_REVIEW.txt` summary (or the proposed numbered summary name if that name already belongs to a saved file). It identifies the saved revision/date/notes, original-to-exported paths, available component IDs, file sizes and SHA-256 content hashes. Configured machine addresses, directory handles and destination absolute paths are not added to the summary. Saved notes remain user-authored content.

Success appears only after the exported files, summary and directory structure have been read back and verified. A failed/cancelled attempt is identified in the dialog and retained with an incomplete marker where writing is possible. Do not distribute that incomplete folder; a retry proposes a fresh child and leaves the old attempt untouched. If failure happens before child creation, no export folder is created.

Exports are ordinary review copies. They do not create revisions or branches, change the active branch, alter working files, rewrite CAD references or change component metadata. No files are sent automatically.

## If cAdtree is unavailable: the offline guide

Your files stay yours. If the internet is down, the hosted app is gone, or cAdtree no longer exists, you can still find and recover everything with a file browser and a text editor. cAdtree writes plain-text files, and one web page, for that:

- **`_README cAdtree.txt`** in the home folder: what cAdtree is, how the folders are laid out, how to recover the latest files or any older revision by hand, how to check a file with `certutil -hashfile <file> SHA256` (Windows) or `shasum -a 256 <file>` (Mac), and a description of the on-disk records.
- **`_INDEX cAdtree.txt`** in the home folder: your workspaces and projects, with their folders and the path to each project's Map.
- **`_MAP cAdtree.txt`** in each project folder: the project's branches and design cases (with their working folders and whether they are active or archived), every revision (number, date, summary, parent), references, any interrupted attempts, and a short "how to recover" section, so a project folder copied on its own still explains itself.
- **`<revision ID>.txt`** in the project's `vault/revisions/` folder, next to that revision's `.manifest.json`: one revision in full, with every folder and file, its size, SHA-256 and the object file to copy.
- **`_RESTORE cAdtree.html`** in each project folder, next to the Map: double-click it to open it in Chrome or Edge (no internet or install needed). It rebuilds a whole revision into an empty folder, or saves single files from `vault/objects` under their original names, and checks every checksum. It is a guide only: it reads the vault and never changes it. If it ever disagrees with the vault, the vault is correct.

The newest files are ordinary folders (`working/main`, `working/<case>`). Older revisions live in `vault/objects` under hash names; the restore page rebuilds them for you, and the revision listing tells you which object is which file if you prefer to do it by hand (on Windows, turn on File name extensions first, so the renamed copy does not end in `.bin`). Rebuild the whole folder tree of a revision, not single files, because assemblies and drawings find their parts by name and relative path.

cAdtree refreshes these files after a revision is saved, a design case is created, archived or reopened, a project is created, imported or adopted, and a workspace is created or brought in. It also writes the home files when a writable home is opened. Opening or browsing a project never writes to it, so an older project gets its Map after its next save or other change. A read-only project or home, or a duplicated project, is not written. Each file shows when it was generated. If a guide file ever disagrees with the records in the vault, the vault is correct. Never edit anything in the vault by hand. You can delete the guide files at any time; cAdtree writes them again after the next change, and never reads them back.

## Real-device checklist: macOS and Linux

Run separately on a real Mac and a real Linux desktop with current Chrome or Edge over HTTPS/localhost. Use disposable folders and record OS, browser version, CAD/file types and results. Windows-host simulations of POSIX addresses do not establish native compatibility.

1. Create an empty Cadtree folder in Finder/the file manager, select it in **Start my Cadtree home**, copy its absolute address using the platform instructions above and complete the required step. Repeat opening an existing home. Cancel and deny a picker once; confirm the guidance is clear and the folder is unchanged.
2. Create a workspace and project. Add a small CAD/document set with nested folders, spaces, mixed case and Unicode names. Close the files, scan and capture. Confirm no absolute address enters portable metadata and collision protections still reject conflicting names.
3. Create a design branch from that revision. Check the actual branch folder, independent bytes and inherited component IDs. Save a branch edit and verify Main is unchanged.
4. Rename a file externally, confirm its association in Changes, capture and reopen. Verify one component history across old/new names. Confirm the UI does not rename files or repair CAD references itself.
5. Export old and new snapshots into fresh folders. Check historical filenames, bytes and counts.
6. Fully quit/reopen the browser, reconnect the same home and renew permissions. Revoke permission and retry: writes must remain blocked until explicit reconnection. Open a second physical copy with the same home/project IDs; it must request its own address. After moving the original, update its address explicitly.
7. Use **Copy folder path** in Changes, History (including a different inspected branch), and recovery. Paste into Finder's Go to Folder / the Linux location bar and check the exact containing directory opens. Test a file directly in a branch folder and a nested file. **Copy file path** must additionally include the filename. Test manual copy when clipboard permission is denied.

This change was tested on a Windows host using Node engine tests and simulated App/DOM tests. The added Chrome browser suite could not navigate to localhost in the restricted execution sandbox (`ERR_NETWORK_ACCESS_DENIED`), so no browser or native filesystem qualification is claimed for this change. macOS/Linux native pickers, permissions, disk behaviour and CAD references remain pending. Windows native picker/disk/CAD qualification was not performed either.
