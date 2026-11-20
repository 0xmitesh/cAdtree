# R6 - Skip unchanged reference updates

Based on merged main `6d43a31` (PR #32). Scope is R6 only.

References still displays **Project context: this version** for the attachment
version already pinned to future revisions, but that button is now disabled.
Choosing a different attachment version exposes the existing enabled **Use this
version in project context** action. Existing busy/evidence guards remain.

`updateProjectReference` rereads the current library under the existing project
writer lock, normalizes the requested metadata and applies the existing context/
removed-state rules. If the resulting reference is unchanged, it returns that
current state without allocating a catalogue, writing files or publishing an
empty completion directory. This also covers unchanged details and equivalent
trimmed titles/deduplicated tags. Concurrent duplicate selections see the latest
state inside the lock, so a real version change publishes once.

Cancellation, project identity, missing-reference and version validation remain.
Actual changes still publish through the existing validated catalogue path.
Attachment import/version creation is untouched: identical bytes can still have
distinct reference/version identities. Saved revisions retain their exact old
reference context; selecting a future default does not create a CAD revision.

## Verification

- All **323 app tests** passed, including three new regressions. Engine tests
  verify zero writes and an identical complete vault inventory for repeated and
  normalized updates, one publication for queued duplicate version changes,
  immutable saved reference context, and unchanged working files. Invalid and
  cancelled requests leave the vault unchanged.
- The actual-App regression checks the disabled selected state causes no reads
  or writes, another version remains actionable, and a successful change adds
  one catalogue while retaining both attachment versions and the CAD revisions.
- TypeScript and the production build passed.
- Current-App Chrome at **1100 x 1244** and **390 x 844** verified native disabled
  clicks, keyboard skipping, identical managed-home contents for a selected
  version, successful selection of another version, catalogue/revision counts,
  no overflow and no page errors. Screenshots use disposable sample state.

No labels or workflows outside this reference selection are changed. No storage
format change or history cleanup is needed. Existing redundant catalogues are
retained; this prevents new redundant records. R7-R11 remain outside scope, and
the local demo changes remain separate.
