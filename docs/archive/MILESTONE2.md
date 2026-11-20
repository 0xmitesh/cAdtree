# Milestone 2 — independent design branches

Implemented on `codex/independent-design-branches`, based on main commit `76897f5` (including the recent label/date polish). No merge or deployment is part of this milestone.

## Result

Select any healthy saved revision in History and choose **Create branch from here**. Enter a unique branch name and engineering reason, then choose a destination parent. cAdtree creates a uniquely named child folder, restores the complete snapshot (including empty directories), verifies hashes and the final inventory, publishes the branch, connects its folder, and makes it active. Creation adds no revision or content objects. The first changed capture uses the source as its parent and the next project-wide revision number.

The header selects the active working branch and identifies its folder. Graph labels continue to highlight ancestry independently. A branch origin link and reason explain each alternative. Summaries, overall notes, and per-file notes remain separate during same-session branch switching. Switching clears the old scan immediately and reads only the selected branch’s baseline; it never restores or overwrites CAD files.

## Persistence and safety

- Existing schema-1 project, branch, and revision records retain their exact checksum rules and are never rewritten. Existing vaults continue to open.
- New publications use `branches/<id>.branch.json` and a final `<id>.ready.json` marker containing project identity, branch identity, and the record’s SHA-256. The marker is published only after copy verification and record read-back. A missing/partial marker with no committed revision remains an unfinished publication. Once committed revisions establish a branch, a missing, malformed, or mismatched marker instead retains its independently validated identity/name and folder-isolation obligations, visibly marks it damaged, and blocks new saves on that branch. Reopening never repairs or rewrites historical files. Pending records and staging attempts remain visible in Settings.
- Branch creation and capture share the project writer lock. Both reload state under the lock. Verified recovery uses its existing, separate destination lock, so it does not reacquire the project lock.
- Adapter identity and ancestry checks keep the vault and every branch working folder separate. Reconnect missing folders explicitly, one branch at a time. All branch connections are required for capture, tracked branch creation, and recovery destination checks; readonly inspection remains available.
- Failed copies are retained and identified in the error. Retrying creates another fresh child folder. No user destination is automatically deleted or reused. File writes use independent streams and existing exclusive conflict checks. Browser filesystem APIs still cannot provide an OS-level atomic directory reservation against external programs.
- IndexedDB stores only handles, folder labels, and the last active branch preference. Updating one binding retains other branches’ bindings. Clear/reopen reconstructs branch records and history from vault files; it does not infer missing folder connections.
- Capture and both recovery operations reject damaged branch-publication states when folder bindings are unavailable. A committed branch whose identity record cannot be validated blocks writes even if the caller omits its binding. Read-only history and diagnostics remain available.

## Validation

`npm test`: **54 passed**, including all original engine tests. `npm run lint` and `npm run build`: passed.

The acceptance test creates Main 001 → 002 → 003, then Cases A/B/C from 001, checks exact binary inventories and empty directories, rejects unchanged captures, and saves/continues all four histories with unique global numbers and branch-specific parents. It also creates an alternative from another alternative and confirms plain recovery creates no branch.

Additional tests cover name races, overlapping identities, missing permissions, cancelled/queued operations, corrupt source objects, partial record/ready writes, retry folders, ambiguous heads, damaged/missing origins, concurrent creation/capture, and unchanged historical checksums. Application tests run the real services through a test-only native-handle facade: separate drafts/file notes, graph highlighting, Graph/List inspection, unavailable handles, asynchronous switching guards, visible cancellation, browser-cache failure after successful publication, session integrity indicators, and reconnection after clearing convenience data. IndexedDB tests exercise transactional binding updates.

Ready-marker regressions create a branch with its own committed revision, remove or corrupt its marker, and reopen. They verify retained identity, case-insensitive name reservation, visible damage, inspectable graph/history, blocked nested destinations, capture/full/selected-recovery checks with missing bindings, and byte-identical historical records after rejected writes. Invalid marker fields/checksums and unvalidated branch records are covered separately. Existing interrupted/unpublished retry tests remain passing.

Browser visual/native-picker inspection remains blocked by the previously reported browser permission. DOM integration tests are not a replacement for native browser layout, permission, or SolidWorks testing. No screenshots or real CAD validation are claimed.

## Short manual SolidWorks sequence

1. In Edge, open `http://127.0.0.1:2500/`. Open your vault and connect Main’s working folder. Save three changed states as Main 001, 002, and 003.
2. Select Rev 001 in History. Create Case A, Case B, and Case C from that same revision, with distinct reasons. Use a separate parent outside the vault and working folders. Each creation should switch the active branch, show its new folder, and leave the revision count at three.
3. Open each case’s assembly manually in SolidWorks. Check every referenced-document path: it must resolve to the intended branch copy wherever that document is meant to be independent. Also inspect drawing references and external references. Resolve CAD references deliberately before editing; cAdtree does not rewrite them.
4. Make a different saved change in each case folder. Select the matching active branch in cAdtree, scan, add a summary/file note, and save. Expect revisions 004/005/006 (when saved in that order), each parented to 001. Confirm Main’s files still contain state 003.
5. Continue on Main and each case. Verify each scan compares against that branch’s own last saved state. Leave unsaved notes on one branch, switch twice, and confirm those notes return only on their original branch. Graph highlighting and selecting old revisions must leave the header’s active branch unchanged.
6. Reopen normally, then test Settings → Advanced record information → Clear remembered connections and reopen vault. All branches/history should remain; reconnect each folder explicitly. Try a duplicate branch name and an overlapping destination, then cancel a creation and inspect the incomplete-folder message.
7. Create another case from Case A’s saved revision. Separately restore a full project copy and selected files into empty, isolated folders; those recoveries must not add tracked branches.

**Byte-perfect copies do not prove that SolidWorks assemblies resolve references to the intended branch folder. That remains an explicit real-CAD acceptance check.**
