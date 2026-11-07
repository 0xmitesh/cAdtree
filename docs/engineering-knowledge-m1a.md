# Engineering knowledge projection — M1A

`src/knowledge/index.ts` exports `buildKnowledgeIndex(state: VaultState)` and the
types from `types.ts`. This is a synchronous, pure, in-memory projection. Pass a
state reconstructed by `openExistingVault`; the function consumes its validation
results rather than implementing a second vault validator. It never opens the
vault, writes metadata, generates timestamps, allocates engineering identities,
calls services or changes capture/publication behavior. No UI is connected yet.

```ts
import { buildKnowledgeIndex } from './src/knowledge';

const index = buildKnowledgeIndex(state);
const recordedNotes = index.records.filter(record => record.status === 'recorded');
```

## Records and source resolution

Each readable revision yields four project records: summary, problem,
modification and observations. Each stored `fileNotes` entry yields three more.
Text is copied exactly from the committed manifest; today's capture-time trimming
is outside this projection. Equal text in different fields or revisions remains
independently identifiable. Empty fields are retained as `status: 'empty'` with
their original text, meaning only that the field is empty. They do not establish
that there was no problem, change or observation.

`KnowledgeRecord.id` is the JSON tuple `[projectId, revisionId, jsonPointer]`.
The pointer addresses the exact immutable source field, so repeated paths/text
cannot collide. File-note array indices are the committed source indices; neither
notes nor manifests are reordered. Reordering the input revision/branch arrays
does not change the result for ordinary validated history.

Illustrative output excerpt (IDs and hashes abbreviated):

```json
{
  "id": "[\"project-…\",\"revision-…\",\"/fileNotes/0/modification\"]",
  "projectId": "project-…",
  "revisionId": "revision-…",
  "branchId": "branch-main",
  "scope": "file",
  "kind": "modification",
  "status": "recorded",
  "text": "Increase thickness to 8 mm.",
  "filePath": "Parts/collar.SLDPRT",
  "componentId": "component-…",
  "component": { "status": "available" },
  "source": {
    "recordPath": "revisions/revision-….manifest.json",
    "jsonPointer": "/fileNotes/0/modification",
    "manifestSha256": "…",
    "manifestPayloadSha256": "…"
  },
  "references": { "status": "available" },
  "attachments": []
}
```

`KnowledgeSource` points to a vault-relative manifest path plus an RFC 6901 JSON
pointer, with both the committed manifest-file hash and its payload hash. A caller
resolving against disk must check the committed file hash before using those
bytes. Stable source identity is provenance, not a guarantee of engineering truth.

`KnowledgeRevision` preserves recorded parent IDs, the validated direct parent,
validated ancestry and history warnings. `layoutRevisions` supplies the edges;
`ancestryOf` supplies ancestry, including the revision itself. There is no second
graph traversal. Branch entries preserve their exact starting revision, including
branches without their own saved revision. Missing or damaged origins remain
unavailable. Missing/cyclic ancestry does not invalidate otherwise readable
endpoint notes; it does prevent inventing a parent edge.

## Component and attachment evidence

A file record gets a component ID only by joining its source path to that exact
revision's available, committed component mapping. Confirmed renames therefore
preserve identity. Deleted-file notes with no entry in the committed snapshot keep
their path and unresolved component status. The projection does not borrow an ID
from the parent or a reused filename.

`KnowledgeAttachment` preserves exact reference/version IDs, historical component
ID/path, attachment hash/size/type/name, locator and explanation. Its source points
to the exact context link and carries the context-file hash, context payload hash,
boundary hash and pinned catalog ID/file hash. Versions are looked up in the
captured catalog, never the current editable library. Project/revision context
links accompany notes at that scope; component links accompany only file notes
with that verified component ID. These are context associations, not per-note
citations or assertions of support. Empty locators stay empty; pages are never
invented or interpreted.

Attachment `metadata.status: 'available'` describes verified reconstructed
metadata only. `content.status: 'unavailable'` explicitly states that current
attachment bytes are not verified by `VaultState`. Opening a vault checks object
existence, not current full hashes. Use the existing `retrieveReferenceAttachment`
path to verify the exact bytes before using content as evidence. M1A cannot detect
later byte corruption without I/O and deliberately makes no content-trust claim.

## Unavailable versus empty

| Situation | Projection |
| --- | --- |
| Stored blank note field | `empty` record; original text preserved |
| Missing optional `fileNotes` field | `fileNotes.status: not_recorded` |
| Present empty `fileNotes` array | Available list containing zero file-note records |
| Verified reference context with zero links | `references.status: available`, empty attachments; only no links were recorded |
| Pre-reference history | `references.status: not_recorded`; no assertion that references never existed |
| Evidence not reconstructed, missing context/catalog/version or missing attachment | Unavailable; no usable attachment associations |
| Global reference reconstruction failure with retained partial contexts | All reference associations unavailable, including partial contexts marked available |
| Unsupported component/reference metadata | Explicit `unsupported`; no guessed identity/evidence |
| Corrupt, unsupported or duplicate revision identity | Revision availability/warnings remain; no note records from that revision |
| Incomplete publications/corrupted vault records | Preserved in index diagnostics, never projected as notes |

## Validation and limits

Run `npx tsx --test src/knowledge/*.test.ts`, `npm test`, `npm run lint`, and
`npm run build`. The normal test script includes the new module. Tests exercise
real in-memory vault capture/reconstruction, revisions/branches, a confirmed
rename, pinned attachment versions, exact source resolution, missing/corrupt
objects and contexts, legacy/empty states, and history damage. A frozen input,
write hooks and complete vault/working-folder inventories verify zero writes and
no input mutation; returned attachment data is detached from the source state.

No permanent format, cache or search index is added. Whole-vault projection and
repeated ancestry lists favor clarity for M1A; large-history performance has not
been qualified. Current storage has no per-note reference binding, verified
attachment-content result in `VaultState`, or earlier deleted-file component
mapping at the note endpoint. Those limits remain explicit rather than guessed.
