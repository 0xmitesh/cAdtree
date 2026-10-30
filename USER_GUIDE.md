# cAdtree — managed workspace guide

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

## Start a workspace and import a project

1. Choose **Create workspace**, enter a name, and select an empty directory. Use **Open workspace** for a previously created workspace. A populated unrelated directory is never adopted automatically.
2. Choose **Add project**. Enter the project name and choose the original CAD source folder. Save and close its CAD documents first. Click **Import project** explicitly.
3. Wait for copying, destination verification, and source-stability checks. cAdtree retains the original and shows **Continue working in this copy** with the new location.
4. Open that managed Main copy manually in SolidWorks. Check component, drawing, and external-reference paths before editing. The managed copy is now the project cAdtree tracks; editing the original will not update it.
5. In Changes, review the scan, enter a summary, and save the first revision explicitly. Importing creates no revision.

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

The first changed capture uses the selected source revision as its parent and receives the next project-wide revision number. Each case's summaries and engineering/file notes stay separate during same-session branch switching. Inspecting old revisions and clicking graph ancestry labels are independent of the active branch selector.

## Recover historical files

Choose **Restore project copy** or select files and choose **Copy selected files**. Confirm the revision and file count. A managed project defaults to a fresh folder under its own `recoveries/` directory; **Choose an external destination instead** retains the explicit empty-folder option.

Copies are verified and their locations are reported. Recovery creates neither a branch nor a revision. A selected-file copy may omit CAD dependencies. Full project copying also does not rewrite CAD references.

## Reopen and reconnect

Choose **Open workspace** once and select the root. cAdtree reads the on-disk project records and resolves all intact branch folders through that authorized root. Renew browser permission when requested. Browser convenience data may remember the root and selected project/case, but it is not the project catalogue.

After clearing browser data, select the workspace root again. Do not locate each managed case separately. Missing, moved, inaccessible, or invalidly mapped folders remain disconnected; cAdtree does not recreate them or guess another location by its name. Restore the recorded location or permission, then use **Reconnect workspace** / **Refresh workspace**. Usable history remains inspectable while writes are blocked.

## Bring an existing M1/M2 project into the workspace

1. Open/select the target workspace.
2. Expand **Advanced: external projects**, choose **Open external projects**, and open the existing vault. Connect its current Main and case working folders once through the legacy branch selector and folder controls.
3. Return to Projects and choose **Bring into workspace**. Confirm the verified copy of its vault and every connected current working folder.
4. Continue at the displayed managed location. Historical IDs, record bytes, notes, and revision numbers are preserved, and uncaptured working edits survive. Original folders remain untouched.

If the same project identity is encountered at several locations, choose the location explicitly. Histories are not merged or represented as unrelated projects. Editing both retained copies concurrently is unsupported.

## Incomplete or damaged operations

Cancellation, read failures, unstable source files, and failed writes leave identified incomplete destinations. They are not presented as ready projects/cases. Retry uses fresh storage and never deletes the old directory automatically. If final publication cannot be confirmed, reopen first before retrying.

An established branch with a broken publication marker remains visible as damaged, keeps its identity/name reserved, and remains part of folder-isolation checks. Its historical records are not repaired or rewritten automatically. Settings explains integrity failures and interrupted attempts.

## Qualifications still needed

Native picker/permission behavior, browser restart, loaded-session offline operation, visual layout, and large-project performance require qualification in the actual target browser. SolidWorks assembly/drawing reference resolution requires real CAD testing. Begin with disposable self-contained files and keep real production folders out of development fixtures.

Byte-perfect storage and recovery do not prove SolidWorks reference correctness. Prepare a self-contained CAD source with the CAD application's own workflow where needed; this MVP does not discover or rewrite proprietary references.
