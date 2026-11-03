# cAdtree — home and managed workspace guide

Your designs. Your versions. Your storage.

## Run locally

Use a current standalone Microsoft Edge or Google Chrome tab on Windows. From the source folder:

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

The hierarchy is **Cadtree home → Workspaces → Projects → Design branches and revisions**. Workspaces can represent clients, CAD tools, organisations, or other groups. They are organisational folders; no accounts, collaboration roles, or access controls are added.

1. The welcome screen introduces saved design history, separate cases and recovery. Choose **Start my Cadtree home** for a new beginning. In the native folder picker, create/select a dedicated empty folder, suggested name **Cadtree**. Unrelated populated storage is rejected. **Open my Cadtree home** opens an existing recognized home. Home management options appear after connecting a home.
2. In **Complete home setup**, enter the selected folder’s full **Cadtree home folder address**, for example `D:\Cadtree`, copied from File Explorer’s address bar. This is required before the home is connected. Cancel or Back leaves the selected folder untouched; Back starts a new native folder selection and clears the address. The browser grants folder access but does not share its full Windows address, so cAdtree cannot compare your entry with the selected folder.
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

Project cards keep technical identities and paths under **Location details**. History, Changes, Settings, and branch controls belong to an opened project.

Typical layout, relative to the selected workspace:

```text
.cadtree-workspace.json
projects/<project-name-unique-id>/
  .cadtree/                  portable project and branch locations
  vault/                     shared immutable revision history and objects
  working/main/              Main's editable CAD files
  working/<case-name-id>/    a case's independent editable CAD files
  recoveries/copy-<id>/      untracked recovered copies
```

Scan/capture starts at the active `working/.../` leaf. The enclosing project container, other cases, vault, management records, and recovery folders are not scanned as part of that leaf.

## Work with cases

Select a saved revision in History and choose **Create branch from here**. For a managed project, enter only a name and engineering reason. cAdtree allocates the working folder automatically, restores and verifies the full baseline, saves its portable binding, and activates the case. Creation adds no revision.

Use **Active branch** in the header to select the working context. Open that case's displayed folder manually in SolidWorks. Selecting a case never replaces another folder's files or changes which CAD documents are open.

The first changed capture uses the selected source revision as its parent and receives the next project-wide revision number. Each project's branch selection and each branch's draft summary, overall notes, and file notes are preserved during same-session project/workspace switching. Drafts are session convenience state and are not saved revisions; a page reload discards them. Inspecting old revisions and clicking graph ancestry labels are independent of the active branch selector.

## Recover historical files

Choose **Restore project copy** or select files and choose **Copy selected files**. Confirm the revision and file count. A managed project defaults to a fresh folder under its own `recoveries/` directory; **Choose an external destination instead** retains the explicit empty-folder option.

Copies are verified and their locations are reported. Recovery creates neither a branch nor a revision. A selected-file copy may omit CAD dependencies. Full project copying also does not rewrite CAD references.

## Reopen and reconnect

Choose **Return to Cadtree** (or the remembered home folder's name), or **Open my Cadtree home** and select the home once. cAdtree reads its on-disk workspace catalogue, projects, and all intact branch locations. Renew browser permission when requested. The saved home address is reused when available. If it is missing, complete the required address step before connecting; cancelling leaves the on-disk home untouched. IndexedDB remembers handles, local addresses and last context; it is not the authoritative catalogue.

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

## Copy folder and file paths

Home setup uses the native folder picker followed by a required Windows address entry. The address must be a nonempty absolute drive or supported UNC path; quotes, spaces, Unicode, and drive roots are accepted. Once configured, managed workspaces, projects, and branches use that home root automatically, without separate address prompts. Edit a moved or mistaken root under **My workspaces → Home options → Edit home folder address**. This is the canonical setting for managed descendants.

This address never authorizes or redirects filesystem operations. The browser cannot verify the typed absolute root against its handle; check it describes the same home. The descendant mappings and actual file existence are validated before copying. The setting stays in this browser/device, associated with the home identity and selected folder handle, and never enters portable records. A migrated workspace never inherits its old external absolute path. External recovery locations without known roots never receive invented paths. Clearing browser convenience data also clears these settings. If preference storage fails, an entered address remains usable for this session with a warning; it must be entered again after reopening. If a copy unexpectedly has no configured address, the same required setup dialog appears and completes the pending copy after successful setup.

Beside a file in Changes, the copy icon (**Copy folder path**) copies the full absolute path of its immediate containing folder, without the filename. For `Parts\Bracket.SLDPRT`, it copies the `Parts` folder; for a file directly in the branch working folder, it copies that working folder. Paste this into Explorer’s address bar and manually open the file. **More path actions → Copy full file path** includes the filename instead.

Without a saved root, the **Set up folder-path copying** dialog offers **Cancel** or **Save and copy**. Saving completes the original request. Canceling leaves your workspace usable and copies nothing. **Folder path copied** appears only after clipboard success; denied/unavailable access offers a selectable plain path for manual copying with Ctrl+C.

Revision details identify **Current file on [branch]** beside the folder-copy action. This refers to the revision's recorded branch, even if another branch is active, and locates its current working copy rather than historical bytes. The secondary full-file action uses that same branch. Missing/inaccessible files or folders produce an unavailable message; cAdtree does not guess another branch or recreate missing folders.

For exact historical bytes, restore a full or selected-file copy. After a managed recovery succeeds, expand **Restored files — copy paths** for shortcuts to those restored files. External recovery folders have no known full Windows location, so cAdtree explains that limit instead of inventing a path. Vault objects are never presented as editable CAD-file locations.

Shortcuts copy plain text only. They do not open Explorer, launch SolidWorks, switch branches, save revisions, or change CAD files.

## Qualifications still needed

Automated Chrome tests exercise real browser filesystem handles in origin-private storage, actual IndexedDB persistence, reload/reconnection, cleared-convenience rediscovery, loaded-session offline scan/capture, dialog focus, and desktop/mobile layouts. The directory picker is replaced in those tests. Native OS picker/permission renewal, a full browser-process restart with local-disk handles, large-project performance, and real SolidWorks assembly/drawing reference resolution still require manual qualification. Cold offline app startup remains deferred. Begin with disposable self-contained files and keep real production folders out of development fixtures.

Byte-perfect storage and recovery do not prove SolidWorks reference correctness. Prepare a self-contained CAD source with the CAD application's own workflow where needed; this MVP does not discover or rewrite proprietary references.


### Compact project navigation

The project name appears above History, Changes, and Settings. History shows a small **Current branch** confirmation beside its description; choose a branch in Explorer to switch working folders. **Active branch** remains available in Changes and Settings. Selecting a saved revision or highlighting graph ancestry only changes the history inspection; it does not switch working folders.

Drag the desktop sidebar’s right edge to resize it. You can also focus **Resize sidebar** with Tab and use Left/Right arrows, Home (minimum), or End (maximum). Width is remembered locally and bounded to leave room for the main content. The tree keeps its position and scrolls independently above the project navigation. Narrow screens retain **Browse folders**.

Working-folder locations and **Reconnect workspace** are available under Settings → Folder connections. When a connection is missing, an actionable message appears in the project view. Errors, integrity warnings, incomplete operations, and progress remain visible when relevant.


### Home options

After connecting a home, **Home options** appears beside **Create workspace** and provides **Edit home folder address**, **Import existing workspace**, and **Switch Cadtree home**. It is absent from the welcome screen. Import-specific copy and original-file protections are explained inside the import flow. Switching homes moves no files and deletes no home. Each home retains its own address. There is no permanent management block beneath the workspace cards.

### File history

Use **File history** beside the Current branch indicator in History. **All files** keeps the existing complete project history. Select a project-relative path to see its addition, byte modifications, deletion, and reintroduction across Main and cases. Files deleted from the latest snapshot remain in this dropdown; the same filename in two directories represents two distinct paths. Renames appear as deletion/addition. Reverting to earlier bytes remains a separate modification.

In file history, the existing branch buttons filter the selected branch's recorded ancestry. Click the selected button again or **Show all branches** to clear the filter. In All files, those buttons retain their existing ancestry highlighting behavior. Neither filtering, file selection, nor revision inspection changes the active working branch. Select a branch in Explorer to change the working folder. File selection resets when you open a different project.

The graph follows actual parents and skips unchanged snapshots. Dashed **Inherited state** or **Inherited absence** nodes preserve branch origins and are counted separately from change events. An unchanged parent opened through a deleted file's **View in parent revision** shortcut is also context only. Revision numbers remain project-wide, so gaps are expected. Branch labels identify where the recorded revision belongs; file-state labels may point to an earlier revision when a case has not changed the file since then.

The details panel keeps the project summary, revision number and branch, and adds the selected file's status and any notes recorded for it at that revision. Recovery still copies from a complete saved project snapshot into a fresh destination. Deleted files must be recovered from an earlier snapshot, never from their deletion event. Missing, damaged, cyclic, or ambiguous parent evidence is labelled **History unavailable**, rather than inferred as deletion or unchanged content. Byte changes do not necessarily indicate geometry changes. No CAD parsing, new records, or storage changes are involved.

Development regression: `npm run test:ui -- tests/browser/file-history.spec.ts` runs the actual App against isolated browser-storage fixtures created by `tests/file-history-seed.ts` through the existing engine. The fixture covers ten Main snapshots with four pin events, an older fork, unchanged captures, a revert, deleted historical paths, and deletion/reintroduction. It is development-only and is not included in production. The existing `npm run dev:synthetic` preview also exposes File history with its multi-workspace samples; `tests/preview.tsx` remains an isolated component harness.

### Compare two saved revisions

In History, inspect a saved revision and choose **Compare** in its details. **To** starts with that inspected revision. **From** starts with its recorded parent when that parent is available; otherwise choose a baseline. Each selector identifies the project revision number, branch and summary. Any two saved revisions from this project can be compared, including nonadjacent revisions and different cases. **Swap** reverses the direction. Selecting endpoints and closing the dialog leave the working branch, history selection, file filter, graph/list mode and recovery selection intact. Opening another project resets comparison state.

Results describe **From → To**. Added files exist only in To; deleted files exist only in From; modified files share a relative path but have different content hashes; unchanged files share a path and hash. Timestamps do not create changes. Changed files appear first, and unchanged files can be expanded. File paths remain distinct even when their basenames match. Renames remain deletion/addition. Comparing a revision with itself is valid and shows no differences.

If opened from File history, comparison initially focuses on that selected path. The scope is labelled explicitly; choose **Show all files** for the complete project or **Focus on selected file** to return. A path absent in both endpoints is explained. **Project directory changes** always covers the complete project, including empty folders, independently of file scope.

**Overall engineering notes** shows the complete project notes for both endpoints in labelled From/To panels and remains available in file scope. It starts expanded and can be collapsed. Each file's From/To panels also show presence, saved size, optional content hashes, and per-file notes recorded at that endpoint, labelled by revision. Missing overall or per-file notes are stated explicitly. These notes do not summarize intervening changes. Comparison reads saved manifests and hashes only; it does not scan working folders, verify all stored binary contents, analyze geometry, or assess CAD compatibility. Previously verified contents are labelled separately from verified metadata. Missing, damaged or ambiguous selected endpoints show an explicit unavailable result. Two healthy endpoints can still be compared when intervening ancestry is unavailable.

Comparison is read-only: it cannot apply, merge or recover files. Close it to use the existing recovery controls if needed. Complete project snapshots, portable records and storage formats remain unchanged.

Development regression: `npm run test:ui -- tests/browser/comparison.spec.ts` loads the actual App using `tests/comparison-seed.ts`. The isolated browser-storage fixture contains an older five-file case and a twenty-file Main revision, endpoint notes, equal basenames, deleted historical files and empty folders. The test fingerprints the managed home before and after comparison interactions. The fixture is development-only and is not included in production. `npm run dev:synthetic` also provides Compare in the existing populated preview.

### Review and apply selected case changes

Inspect a saved revision in History and choose **Review changes to apply**. **Source** is that revision. **Destination** is the active working branch's latest trustworthy saved baseline (including its inherited origin before its first capture). **Base** is their nearest shared ancestor, established through validated parent relationships. Revision numbers, branches and summaries identify all three. Opening and closing the review does not switch the working branch or change history inspection. Ordinary **Compare** remains read-only and separate.

Start with no files selected. Choose source additions, modifications and explicit deletions. Source-unchanged paths preserve Destination, including newer destination versions and Main-only additions. Identical endpoint states need no application. Renames remain deletion/addition; equal basenames in different directories remain distinct. Byte hashes describe content, not geometry or CAD compatibility.

For independently changed paths, explicitly choose **Keep destination**, **Use source state**, or **Leave unresolved**. Source deletion choices say **DELETE destination file**. Unselected conflicts retain Destination; selected unresolved conflicts block readiness. Deselecting a conflict clears its decision. Enter an **Engineering reason for proposed application**. Review **Selected actions**, **Proposed files**, overall engineering notes and each path's saved file states/notes. Notes are labelled Base/Source/Destination and describe those endpoints rather than every intervening change. Metadata verification is distinct from binary-content verification.

Choose **Prepare application**. If a previously read-only connection needs write access, the explicit Prepare/Recover action requests permission; denied access stops without a working-file change. cAdtree resolves and validates branch connections, then scans the complete destination against its saved baseline, including directory changes. If it contains uncaptured edits, stop: save a normal revision first, then refresh History and review a fresh plan. Preparation never discards edits or captures them automatically. Current uncaptured edits are excluded from the saved-state plan and are not authorized for replacement.

The final confirmation identifies the project, destination branch, connected working location, saved baseline, source revision, exact additions/replacements/deletions, retained conflict decisions and reason. Save and close relevant CAD documents, acknowledge the confirmation, then choose **Apply confirmed changes**. Back to review requires preparation and acknowledgement again. A changed baseline, mapping or reviewed plan is rejected. **Refresh saved states** reloads the saved evidence and clears selections and reason for a fresh review. Checks are repeated under the existing project writer lock; staged verified copies and recovery evidence are persisted before working-file changes begin.

Successful application shows **Applied to working files — revision not yet saved**. It creates no revision and changes no source working folder. Open the destination in CAD, check references/rebuilds and make adjustments as needed. Use the normal Changes scan, engineering notes, per-file notes and **Save revision** flow. The resulting complete snapshot retains the normal destination parent and next project-wide revision number. Its **Applied from** disclosure identifies the source revision/branch, selected files, reason and conflict choices. **Before, applied and captured bytes** distinguishes the originally applied state from the final captured state, including later engineer adjustments. Provenance supplements the summary and notes; it does not replace them or claim a source-branch merge.

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

Active cases remain prominent in the working-branch selector and Explorer. **Show archived cases** in Explorer reveals archived names as read-only navigation rows; use **Settings → Design cases → Archived cases** to find **Reopen case**. Archived revisions remain in the full graph/list with **Archived** beside their case name. Their File history, Compare, engineering notes and Applied from provenance remain available. Saved archived revisions can still be sources for applying selected changes to an active destination, creating a new case and fresh-folder recovery.

An archived case cannot receive a new capture or application in the current engine. If an already-open context becomes archived elsewhere, reopen it or explicitly choose another active branch. **Reopen case** restores Active status with the same identity, history, baseline and mapped folder; it does not switch branches or restore files. A missing connection still needs reconnection before work resumes. A child case remains independent when its parent is archived, and archived case names remain reserved. Archived folders stay in all existing folder-isolation checks.

Lifecycle changes write only separate, versioned/checksummed records in `vault/case-lifecycle/<branch-id>.<sequence>.json`. Original branch records and their ready-marker hashes, snapshots, objects, notes, origins, application evidence and folder mappings are unchanged. Existing projects without lifecycle metadata default to Active. Present malformed, unreadable, unsupported or contradictory lifecycle evidence is shown as unavailable and blocks affected working writes, rather than being assumed Active. Unassignable lifecycle-folder damage blocks working writes project-wide. Inspect or restore valid retained metadata before retrying; cAdtree provides no force-clear, automatic repair or cleanup. Adoption and workspace/home migration retain these records.

The existing project writer lock serializes lifecycle changes with app writers. Each change is reloaded, validated, persisted exclusively and read back before success. Repeated requests for the same current outcome do not add another record; a stale request for a different outcome requires refresh. A failed acknowledgement can still be recognized through verified readback. Partial records remain explicit unavailable evidence. No hardware-level atomicity or protection against external CAD/sync writers is claimed. Archiving does not change OS permissions: external tools can still edit a folder, and normal checks apply when the case is reopened. Older app builds do not enforce this lifecycle feature.

Development regression: `npm run test:ui -- tests/browser/case-lifecycle.spec.ts` exercises the actual App on desktop and mobile with disposable browser-storage fixtures. It checks archive/discovery, archived history/Compare/source review, reload/reopen, unchanged project bytes outside lifecycle metadata, and desktop session draft preservation including per-file notes. Native Windows picker/permission behavior, real CAD operation and sudden physical-disk failures are separate qualification work.

### Case activity and divergence

In **Settings → Design cases**, expand **Saved activity and divergence** for an active or archived case. It shows the original saved revision and branch, the latest save belonging to this case with its saved date, its own save count, current Main, and their nearest validated shared ancestor. A case with no saves says **No revisions saved on this case yet — inherits Rev …**; creating a case does not invent a saved revision.

**Main** and **Case history** counts follow recorded parent steps after the shared ancestor, excluding the ancestor. They are independent of the selected File history filter and project-wide revision numbers. A nested case can inherit saved steps from another case, so its case-history count can exceed the saves belonging directly to it. Activity means saved revisions, not uncaptured edits, visits, scans, or archive/reopen dates. Counts describe saved history, not file differences or engineering compatibility. Applying selected files creates no merge ancestry and does not reduce these counts; a later normal Save revision adds its ordinary parent step. cAdtree makes no inactivity or integration judgment.

Choose **Compare with Main** to open the existing saved comparison with **From = case saved baseline** and **To = Main saved baseline**, across all project files. Close it to return to the case information. This does not switch the working branch, scan folders, alter drafts, apply files, or write project records. Working edits are excluded. Existing comparison notes and metadata/content verification distinctions still apply.

Missing, damaged, ambiguous or cyclic evidence is explained as **Unavailable**, never as zero divergence. Independently trustworthy origin, endpoint and ownership information remains visible where possible. When the current saved endpoints can be established independently, comparison remains available even if ancestry cannot be validated. If a current baseline identity itself cannot be established, Compare with Main is disabled; ordinary History → Compare retains its endpoint-only rules for explicitly selected healthy saved revisions.
