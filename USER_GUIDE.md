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

1. Choose **Create Cadtree home**. In the native folder picker, create/select a dedicated empty folder, suggested name **Cadtree**. Unrelated populated storage is rejected. **Open Cadtree home** opens an existing recognized home.
2. On **All workspaces**, choose **Create workspace** and enter a readable name. cAdtree allocates a unique child folder automatically. No second parent picker is needed. Repeated display names receive independent identities and folders.
3. **Open workspace** opens its projects. Use **Switch workspace** in the header to move between connected workspaces, or **All workspaces** to return home. Switching never removes another workspace's registration.
4. The home shows actual discovered project counts and connection state. Missing, damaged, duplicate, and incomplete locations remain visible; no identity is guessed from a folder name.

```text
Cadtree/
  .cadtree-home.json                 portable home identity
  .cadtree-home/workspaces/          checked registrations and publication markers
  Personal SolidWorks-<unique-id>/   workspace identity and projects
  Client ABC-<unique-id>/
  AutoCAD-<unique-id>/
```

## Import a project inside a workspace

**Add project** is the primary action inside a workspace. Project cards keep technical identities and paths under **Location details**. History, Changes, Settings, the active branch selector, and the working-folder banner belong to an opened project.

1. Choose **Add project**. Enter a project name and select the original CAD source folder. Save and close its CAD documents first. Click **Import project** explicitly.
2. Wait for copying, destination verification, and source-stability checks. cAdtree retains the original and shows **Continue working in this copy** with the new location.
3. Open that managed Main copy manually in SolidWorks. Check component, drawing, and external-reference paths before editing. Editing the original will not update the managed copy.
4. In Changes, review the scan, enter a summary, and save the first revision explicitly. Importing creates no revision.

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

Choose **Reconnect Cadtree** (or the remembered home folder's name), or **Open Cadtree home** and select the home once. cAdtree reads its on-disk workspace catalogue, projects, and all intact branch locations. Renew browser permission when requested. IndexedDB remembers handles, optional paths and last context; it is not the authoritative catalogue.

After clearing browser convenience data, select the home again. Do not locate each workspace, project, or case separately. Missing, moved, inaccessible, or invalidly mapped folders remain unavailable; cAdtree never recreates or rebinds them by name. Restore the recorded location or permission, then use **Refresh home**, **Refresh workspace**, or **Reconnect workspace**. Usable history remains inspectable while writes are blocked.

## Bring existing workspaces such as cam 2 or autocad into Cadtree

1. Open the target Cadtree home and choose **Bring existing workspace into Cadtree**.
2. Select the existing workspace folder once. Save/close CAD documents and avoid editing that workspace during copying.
3. cAdtree coordinates same-origin writers, validates the projects and stored historical content, copies the complete workspace tree to a fresh child folder, and rechecks both copies before publishing it.
4. Continue work only in the displayed **Cadtree/<new managed folder>/** location. Originals remain untouched. Workspace/project/branch identities, historical record bytes, checksums, notes, relative project layouts, recovery folders, empty directories, and uncaptured working edits are preserved. No revision is invented.

An already published workspace identity is not copied again. Selecting its retained original while its home is connected offers the managed workspace or explicit inspection of the original. These locations are never silently merged or shown as independent identities. **Other locations → Inspect external workspaces → Open workspace** remains available for external workspaces without migrating them. External project/vault access remains under **Advanced: external projects**.

An interrupted migration retains a registered incomplete destination. Retrying allocates a fresh folder and keeps the earlier attempt under that workspace's **Location details**. An ambiguous/corrupt publication or duplicate established identity must be inspected before another copy can be made. cAdtree does not delete, repair, or clean up user storage automatically.

## Bring an existing M1/M2 project into the workspace

1. Open/select the target workspace.
2. Expand **Advanced: external projects**, choose **Open external projects**, and open the existing vault. Connect its current Main and case working folders once through the legacy branch selector and folder controls.
3. Return to Workspace and choose **Bring into workspace**. Confirm the verified copy of its vault and every connected current working folder.
4. Continue at the displayed managed location. Historical IDs, record bytes, notes, and revision numbers are preserved, and uncaptured working edits survive. Original folders remain untouched.

If the same project identity is encountered at several locations, choose the location explicitly. Histories are not merged or represented as unrelated projects. Editing both retained copies concurrently is unsupported.

## Incomplete or damaged operations

Cancellation, read failures, unstable source files, and failed writes leave identified incomplete destinations. They are not presented as ready projects/cases. Retry uses fresh storage and never deletes the old directory automatically. If final publication cannot be confirmed, reopen first before retrying.

An established branch with a broken publication marker remains visible as damaged, keeps its identity/name reserved, and remains part of folder-isolation checks. Its historical records are not repaired or rewritten automatically. Settings explains integrity failures and interrupted attempts.

## Copy folder and file paths

Home/workspace creation, opening, and reconnection use native folder pickers/permissions and never open Windows-path setup automatically. Setup appears only on the first unconfigured copy request or through **Configure path shortcuts** on the home, workspace options, or project Settings. For managed descendants, copy the **Cadtree home** folder's full Explorer address, for example `D:\Cadtree`, into **Cadtree home folder path**. One local home setting covers all its workspaces. Quoted paths, drive roots, spaces, Unicode, and UNC syntax are accepted; network-share operation is not qualified.

This optional field never authorizes or redirects filesystem operations. The browser cannot verify the typed absolute root against its handle; check it describes the same home. The descendant mappings and actual file existence are validated before copying. The setting stays in this browser/device, keyed by home identity, and never enters portable records. External workspace settings remain separate where valid. A migrated workspace never inherits its old external absolute path. External project/recovery locations without known roots never receive invented paths. Clearing browser convenience data also clears these settings.

Beside a file in Changes, the copy icon (**Copy folder path**) copies the full absolute path of its immediate containing folder, without the filename. For `Parts\Bracket.SLDPRT`, it copies the `Parts` folder; for a file directly in the branch working folder, it copies that working folder. Paste this into Explorer’s address bar and manually open the file. **More path actions → Copy full file path** includes the filename instead.

Without a saved root, the **Set up folder-path copying** dialog offers **Cancel** or **Save and copy**. Saving completes the original request. Canceling leaves your workspace usable and copies nothing. **Folder path copied** appears only after clipboard success; denied/unavailable access offers a selectable plain path for manual copying with Ctrl+C.

Revision details identify **Current file on [branch]** beside the folder-copy action. This refers to the revision's recorded branch, even if another branch is active, and locates its current working copy rather than historical bytes. The secondary full-file action uses that same branch. Missing/inaccessible files or folders produce an unavailable message; cAdtree does not guess another branch or recreate missing folders.

For exact historical bytes, restore a full or selected-file copy. After a managed recovery succeeds, expand **Restored files — copy paths** for shortcuts to those restored files. External recovery folders have no known full Windows location, so cAdtree explains that limit instead of inventing a path. Vault objects are never presented as editable CAD-file locations.

Shortcuts copy plain text only. They do not open Explorer, launch SolidWorks, switch branches, save revisions, or change CAD files.

## Qualifications still needed

Automated Chrome tests exercise real browser filesystem handles in origin-private storage, actual IndexedDB persistence, reload/reconnection, cleared-convenience rediscovery, loaded-session offline scan/capture, dialog focus, and desktop/mobile layouts. The directory picker is replaced in those tests. Native OS picker/permission renewal, a full browser-process restart with local-disk handles, large-project performance, and real SolidWorks assembly/drawing reference resolution still require manual qualification. Cold offline app startup remains deferred. Begin with disposable self-contained files and keep real production folders out of development fixtures.

Byte-perfect storage and recovery do not prove SolidWorks reference correctness. Prepare a self-contained CAD source with the CAD application's own workflow where needed; this MVP does not discover or rewrite proprietary references.
