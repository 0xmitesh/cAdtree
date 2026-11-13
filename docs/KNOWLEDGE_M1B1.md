# M1B-1: Extensible local knowledge records

Implemented locally on `experiment/knowledge-lab`. No push, commit, PR or merge. Existing uncommitted Knowledge Explorer files and package scripts are preserved. No UI, authentication, revision format or CAD working-file changes.

## Files

| File | Responsibility |
| --- | --- |
| `src/knowledge/records/types.ts` | Universal envelope, domain payload types, typed targets, durable provenance bindings and reconstruction results |
| `src/knowledge/records/json.ts` | Lossless plain-JSON checks and deterministic serialization |
| `src/knowledge/records/registry.ts` | Runtime validators and versioned schema registration |
| `src/knowledge/records/envelope.ts` | Envelope validation, format compatibility and body checksum |
| `src/knowledge/records/relationships.ts` | Project/revision/component/reference/record relationship validation using reconstructed evidence |
| `src/knowledge/records/store.ts` | Create, reconstruct and read; append-only publication and isolated diagnostics |
| `src/knowledge/records/index.ts` | Public API exports |
| `src/knowledge/records.test.ts` | Focused synthetic integration and failure tests |
| `src/engine/types.ts` | Optional `VaultState.knowledge` collection |
| `src/engine/vault-service.ts` | Read-only knowledge reconstruction after existing component/reference reconstruction; optional schema registry |
| `src/knowledge/types.ts`, `src/knowledge/index.ts` | Separate `persistedRecords` and `persistedDiagnostics` collections; original M1A algorithms unchanged |
| `docs/M1B-1-examples.json` | Two complete API results generated using a disposable in-memory vault |

Note: `docs/M1B-1-examples.json` predates the 11 Nov 2026 ID format change and uses historical `knowledge-<uuid>` record IDs and full-hex publication markers; they are not valid in the current format.

## Actual envelope and examples

| Field | Meaning |
| --- | --- |
| `formatVersion: 1` | Storage envelope version; independent of payload schema version |
| `recordId` | Permanent record ID `YYYYMMDD-HHMMSS-xxxxxx` (`src/engine/ids.ts`); allocated by default, optionally supplied for a controlled import |
| `recordType`, `schemaVersion` | Validator key, e.g. `cad.design-change` + `1` represents `cad.design-change.v1` |
| `projectId` | Owning cAdtree project |
| `createdAt` | Current recording time assigned inside the writer lock; never copied from a historical revision |
| `author?` | Optional supplied `{ id, displayName? }`; omitted when unknown |
| `payload` | Validated domain-specific JSON object |
| `relationships` | Explicit relation/target pairs plus engine-resolved, checksummed historical source bindings |
| `provenance` | `user-entered`, `imported` with source/optional locator, or `machine-extracted` with source/method/optional locator |
| `integrity` | SHA-256 of the canonical body excluding `integrity`, and the `directory-marker-v1` publication scheme |

The full examples include real computed checksums, permanent identities, timestamps and exact source/publication paths. Their vault is disposable and in memory; they are demonstrations, not real engineering evidence. The JSON file pretty-prints API results. Checksums refer to canonical record envelopes, not the containing examples document.

The CAD example payload is:

```json
{
  "problem": "  Collar bends under axial load.\n",
  "change": {
    "status": "proposed",
    "description": "Increase thickness from 6 mm to 8 mm."
  },
  "rationale": "Reduce bending. Prototype validation is pending.",
  "propertyChanges": [
    { "property": "plate thickness", "before": 6, "after": 8, "unit": "mm" }
  ],
  "assumptions": ["Load is axial."],
  "observations": ["No engineering validation recorded."]
}
```

It links to the exact saved revision, verified component ID at that revision, and the captured reference version/context pointer. Original locator, explanation, context/catalog hashes and historical component path are retained. Changing a reference library's current version does not retarget the record.

The generic example uses the same storage engine with:

```json
{
  "description": "  Packaging inspection notes.\n",
  "attributes": { "sampleCount": 12, "damaged": 0, "location": "Bench A" }
}
```

No engineering-specific fields exist in the common envelope. Strings, whitespace, newlines, array order, numeric values and units are preserved. Non-finite numbers, undefined values, cycles, accessors and non-JSON objects are rejected rather than silently transformed. Object keys are sorted for deterministic checksums; nesting is limited to 64 levels. Built-in schemas reject unknown fields, so changes require a new schema version.

## Registry and extension

`KnowledgeSchemaRegistry` maps the exact `(recordType, schemaVersion)` pair to a synchronous runtime predicate. The built-in registry supports `cad.design-change.v1` and `generic.observation.v1`. Registration cannot replace a previously registered key. Validators receive disposable JSON copies and cannot normalize persisted input through mutation. They are trusted application code, not dynamically loaded user plugins.

```ts
import {
  createKnowledgeSchemaRegistry, createKnowledgeRecord, readKnowledgeRecord,
  type JsonObject,
} from '../src/knowledge/records';
import { openExistingVault } from '../src/engine/vault-service';

const schemas = createKnowledgeSchemaRegistry();
schemas.register('lab.measurement', 1, (p): p is JsonObject =>
  p !== null && typeof p === 'object' && !Array.isArray(p) &&
  'measurement' in p && typeof p.measurement === 'number');

const stored = await createKnowledgeRecord(vault, {
  projectId,
  recordType: 'lab.measurement',
  schemaVersion: 1,
  payload: { measurement: 12.5 },
  relationships: [],
  provenance: { kind: 'user-entered' },
}, schemas);

await readKnowledgeRecord(vault, projectId, stored.record.recordId, schemas);
await openExistingVault(vault, { knowledgeSchemas: schemas });
```

No persistence changes are needed. Pass the same registry to create/read/open, or explicitly register application-wide types on the exported `defaultKnowledgeSchemas` at startup. Without the required validator, a valid published record is reported as unsupported and kept on disk. It is never interpreted using a different version's validator. Stored payload schemas and storage format evolution are separate concerns; no automatic migrations run.

## Relationships and evidence

Supported relations are `related`, `context` and `evidence`. Every target carries the same explicit project ID as the record. Targets are:

- `revision`: exact revision ID. Requires one usable committed revision and its owning project branch. Uses the existing M1A/history projection; it does not invent ancestry or require unrelated branches to be healthy.
- `component`: exact revision ID + component ID. Requires the reconstructed verified mapping and snapshot membership. The engine records the historical path and mapping checksum. Paths cannot establish identity. Confirmed later renames retain the original binding.
- `reference-version`: revision ID + reference ID + exact version ID + `associationPointer` such as `/links/0`. Requires that exact association in the reconstructed revision context, including associations captured without file notes. The pointer disambiguates repeated references with different locators/scopes. Durable version metadata and context/catalog provenance are retained; transient M1A availability messages are not stored.
- `record`: another already accepted knowledge record in the same project, bound to its exact envelope version and publication hashes. Self-links, missing/unpublished/unsupported targets and cycles are unavailable. Reconstruction resolves dependencies before accepting dependent records, regardless of filename ordering.

Bindings are re-resolved and compared during publication and every reconstruction. A damaged target makes the dependent knowledge record unavailable without deleting either record.

`provenance` declares origin; it is not a signature or author authentication. A CAD change marked `implemented` is still a recorded assertion. An `evidence` relationship is an explicit assertion of relevance, not automatic proof. Returned entries always distinguish:

```json
{
  "metadata": "checksum_verified",
  "attachmentBytes": "not_checked",
  "claims": "not_verified"
}
```

This milestone does not implement independent engineering validation. It does not call attachment-byte retrieval/verification or promote imported/machine-extracted claims to verified facts.

## Persistence, reconstruction and compatibility

Records live at `knowledge/records/<recordId>.json`, separately from immutable CAD manifests. Each append uses the existing project writer lock, canonical serialization, exclusive file creation, SHA-256 readback and a fresh project/relationship evidence check. Final publication creates an **empty directory** at `knowledge/completed/<recordId>.<recordSha256>.done`, reusing cAdtree's directory publication pattern. No marker file is created before writing its contents.

The marker's SHA-256 binds the complete original UTF-8 record bytes; `integrity.bodySha256` binds all envelope content except the integrity object. Reconstruction checks publication uniqueness, marker emptiness, byte checksum, canonical encoding, envelope/project identity, exact schema and relationship provenance. It never modifies, repairs or deletes source bytes.

`PublishedKnowledgeRecord.source` resolves the exact record path, root JSON pointer (`""`), storage/payload versions, body/file hashes and publication directory. `readKnowledgeRecord` reconstructs afresh rather than trusting an old in-memory object. A missing ID returns `undefined`; an identified incomplete, unsupported or damaged record throws. Details remain in `VaultState.knowledge.diagnostics`.

Missing final markers and partial native files are incomplete and reserve their IDs. Competing/nonempty/missing markers, corrupt bytes, invalid payloads and broken relationships are unavailable. Unsupported versions retain their identities, versions and original paths in diagnostics. A lost publication acknowledgement may mean the record was already published: `KnowledgePublicationError` carries its identity/path and a conservative `publicationMayExist` flag. Reopen to inspect; do not overwrite or automatically allocate a duplicate retry.

Knowledge diagnostics are independent of CAD's corrupted/incomplete record collections. Store status `available` means the namespace was scanned; individual diagnostics can still exist. Valid independent knowledge records remain available when another record fails. Uninspectable storage yields an unavailable knowledge store. Existing vaults without `knowledge/` stay valid and are not upgraded by a read. Damaged knowledge does not block CAD capture or full recovery.

The additive M1A collections are `persistedRecords` and `persistedDiagnostics`. Original derived `records`, source identities, revisions, branches, diagnostics and F1 revision-level reference associations keep their existing behavior. The projection stays pure and returns detached copies. Knowledge Explorer work is preserved; a persisted-record UI is deferred to M1B-2.

## Validation

The focused suite covers CAD/generic creation and reopening, new domain registration, numbers/units/original text, project/revision/component/reference/record bindings, invalid/cross-project targets, confirmed renames, exact pinned versions, unsupported schema/format preservation, duplicate identities/concurrent writers, corrupt/forged/cyclic records, incomplete native files, readback failure, interruption before/after publication, read-only reconstruction, unchanged CAD/reference/working inventories and CAD recovery with damaged knowledge storage.

Commands used:

```powershell
npx tsx --test src/knowledge/*.test.ts src/engine/engine.test.ts src/engine/references*.test.ts src/engine/component-identity.test.ts src/history/*.test.ts
npm run test:knowledge-lab
npm run lint
npm run build
```

Results: 108 knowledge/engine/reference/component/history tests passed (including 14 new M1B-1 tests), all 7 existing explorer tests passed, TypeScript passed, and the production build passed. The 14 M1B-1 tests were also rerun after the final input-validation correction and passed. Both complete example envelopes were independently validated against the current registry and their publication checksums. `git diff --check` passed. The production build retains the existing Vite configuration/chunk-size/import warnings.

## Limits

- Create/reconstruct/read only; no edits, corrections, deletion, interrupted-record resumption, migrations or cross-device conflict handling.
- Same-origin Web Locks/in-process fallback match existing cAdtree coordination. External OS writers and synchronized copies are not mutually locked. Checksums detect changes; they do not provide signatures, tamper-proof storage, authenticated authors or independent engineering proof. Filesystem crash durability remains that of the existing adapter/publication mechanism.
- Record relationships require an existing accepted target; reference-version links require an already captured revision context. Historical mapping/context loss conservatively hides dependent records; no identities or citations are inferred.
- Full metadata scans and in-memory JSON validation are intentionally simple. No large-store optimization, binary record payloads, derived search index, chunks, embeddings, RAG, OCR, AI provider, database or cloud dependency is introduced.
- The schemas define validated structure, not physical correctness, unit conversion, revision equivalence or source-document truth. Creation time uses the local system clock; optional author/provenance fields are declarations.
