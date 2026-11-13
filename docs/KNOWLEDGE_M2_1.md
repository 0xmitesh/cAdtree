# M2-1: deterministic knowledge retrieval

Development-only, read-only retrieval over an already reconstructed `VaultState`.
No persistence format, schema, UI, CAD history, references or existing projection code changes.

## API

Import from `src/knowledge/retrieval.ts`:

```ts
retrieveKnowledge(state: VaultState, query: KnowledgeQuery): KnowledgeRetrieval
getComponentKnowledgeTimeline(
  state: VaultState,
  query: KnowledgeQuery & { componentId: string },
): ComponentKnowledgeTimeline
```

`KnowledgeQuery` requires `projectId`. Optional filters are `sourceType`
(`m1a-derived` or `m1b-persisted`), `recordType`, `recordId`, `revisionId`,
`branchId`, `componentId`, `text`, and `relatedRecordId`. Unknown query fields,
invalid types and natural-language strings are rejected.

Filters combine with AND. Revision, branch and component must match the same
explicit historical context. `relatedRecordId` selects records with a direct
outgoing record relationship; it never traverses links to infer component ownership.
M1A types are `m1a.summary`, `m1a.problem`, `m1a.modification` and
`m1a.observations`. M1B types retain their original registered names.

`text` is a case-sensitive literal substring of original M1A text or M1B payload
string values (including nested values). It does not search keys, numbers, IDs,
hashes or envelope fields. Empty recorded fields are preserved as M1A empty fields.

```ts
const timeline = getComponentKnowledgeTimeline(reopenedVault, {
  projectId: reopenedVault.project.projectId,
  componentId: selectedVerifiedComponentId,
});
const decisions = retrieveKnowledge(reopenedVault, {
  projectId: reopenedVault.project.projectId,
  componentId: selectedVerifiedComponentId,
  recordType: 'cad.design-change',
  text: '8 mm',
});
```

## Results and provenance

`records` is a discriminated union retaining original M1A note content or the
entire original M1B envelope, with stable IDs, original source paths and JSON
pointers, recorded timestamps, exact stored hashes, applicable historical
contexts, reference associations and verification status. M1B relationship
bindings and provenance are preserved inside the original envelope. Persisted
reference relationships additionally expose their `/relationships/N` pointer,
record/publication paths and hashes. An `evidence` relationship remains an
assertion made by the record's provenance, not independently validated proof.

`contexts` provides verified project/revision/branch identities, historical
component paths and mapping hashes where applicable, existing ancestry results
and availability, file-note availability and reference-context availability.
`references` preserves exact reference/version IDs, source locators and source
context/catalog hashes. It contains selected revision context plus the citations
of matching records. Record type, record ID, related-record and text filters do
not remove revision reference context. References embedded in an individual
record identify its applicable citations and also occur in the overall collection.

Ownership filters do not redefine citation scope. An M1A file note retains its
original applicable attachments, including project/revision context; unrelated
components' context is excluded. An M1B record retains its explicitly recorded
reference relationships, even if a source lies outside its selected historical
ownership context. Such a citation keeps its own revision, branch and component
scope. A component link alone does not automatically attach broader references
to an M1B record. Context remains distinct from explicit evidence assertions.

`recordOutcome` describes matching records only:

| Value | Meaning |
| --- | --- |
| `matches` | Matching readable recorded notes/records exist. |
| `empty` | No accepted records match; inspect coverage, issues and references. |
| `unavailable` | The requested identity/scope cannot be established or its record source cannot be read. |

`coverage` independently reports `readable`, `incomplete` or `unavailable`.
Readable means the recorded metadata can be read, never that an engineering
history or requested technical fact is complete. Missing optional legacy evidence
is explicitly `not_recorded`; unavailable, unsupported or incomplete publications
degrade coverage. A zero-record result with issues is not proof of absence.

Unreadable publication headers cannot safely establish which query they would
match. Such diagnostics retain identifiable record/type/version/path fields and
are marked `unresolved-project`, even for narrow filters. This intentionally
prefers conservative uncertainty over hiding a possibly relevant match.
Unsupported or corrupted content is diagnostic data, never an accepted record.

Metadata checksums establish source integrity. Attachment bytes are
`not_checked`; original M1A content availability remains unavailable until a
separate verification mechanism checks bytes. Engineering claims remain
`not_verified`. Retrieval uses the supplied reconstructed snapshot and cannot
detect later filesystem changes without reopening it.

## Component timelines and determinism

Timeline events are saved snapshot occurrences across all matching branches,
including unchanged and reference-only revisions. Identity and historical paths
come from existing committed component mappings and the existing relationship
resolver. Confirmed renames preserve the same component ID; unrelated components
sharing a filename remain separate. Missing, ambiguous or unsupported mappings
never fall back to paths. A project-level note, revision-only link, reference-only
link or record-to-record link is never promoted to a component assertion.

Ancestry comes from the existing M1A/history projection and strict engine ancestry
check, with existing revision binding validation. A readable endpoint can remain
available while its ancestry is explicitly unavailable. No new graph or identity
algorithm is introduced.

Events sort by recorded revision capture completion time, then branch ID,
revision ID and component ID. Records sort by their recorded timestamp, source
type and ID. M1B uses its actual `createdAt`, which may be much later than the
historical revision it explicitly references; placement in that revision's event
does not backdate the record. Unknown/unzoned timestamps sort last with explicit
limitations. Recorded times do not prove engineering event dates.

Unordered reconstructed collections are normalized with code-point comparison;
committed array ordering and its JSON pointers remain untouched. Published M1B
records sort by bounded record/source identity keys, never by serializing payload
wrappers. Valid maximum-depth stored envelopes remain retrievable, and duplicate
accepted identities are reported as unavailable rather than selected by order.
An M1A-only query does not inspect the M1B record collection.

One M1A projection is prepared per query. The existing relationship validator has
a query-local resolver factory accepting that projection, with revision/branch
lookup maps and reusable bindings. Its original publication/reconstruction entry
point delegates to the same checks. Retrieval caches revision/component contexts
and strict engine ancestry successes, checking the longest existing projected
lineages first. A failed descendant never invalidates or certifies its ancestors.
All preparation expires with the query; no durable index exists.

Results are detached copies. Retrieval takes no filesystem adapter, performs no
I/O and does not mutate source state. It has no network, clock-generation or
storage dependency.

## Synthetic example

`docs/M2-1-component-history.json` is an actual compact result generated from
`tests/knowledge-retrieval-fixture.ts`, which publishes and reopens an in-memory
vault through existing cAdtree APIs. It is a review artifact, not a storage format.

It predates the 11 Nov 2026 ID format change and uses historical `knowledge-<uuid>` record IDs.

The component starts as `collar.SLDPRT` on Main, is explicitly renamed to
`collar_plate.SLDPRT`, and also appears as `collar.SLDPRT` on the alternative
branch forked from the first revision. Main has a later reference-only revision.
An unrelated new component subsequently uses `collar.SLDPRT` on Main and is
excluded from the selected component's knowledge.

The example includes five snapshots on two branches, M1A file notes, a persisted
CAD design-change, a generic observation and a multi-context observation. Its
seven reference associations include revision context and explicit evidence
relationships: version 1 at `Page 4, figure 2`, and version 2 at
`Page 7, figure 1`. Each carries its original path, pointer and hashes. All IDs in
the example are real synthetic publication IDs, not filename-derived identities.

## Files and validation

Initial M2-1 files:

- `src/knowledge/retrieval.ts`: pure API and timeline assembly.
- `src/knowledge/retrieval-types.ts`: query, result, context and uncertainty types.
- `src/knowledge/retrieval.test.ts`: 13 focused tests.
- `tests/knowledge-retrieval-fixture.ts`: disposable real-publication fixture.
- This document and `docs/M2-1-component-history.json`.

Review corrections modify only `src/knowledge/retrieval.ts`, the reference-list
comment in `src/knowledge/retrieval-types.ts`,
`src/knowledge/records/relationships.ts` and this document, adding
`src/knowledge/retrieval-corrections.test.ts` and
`tests/knowledge-retrieval-benchmark.ts`. The original M1A projection, canonical
serializer, envelopes, stored records, Explorer and synthetic example are unchanged.

Validation commands:

```text
npx tsx --test src/knowledge/*.test.ts src/engine/engine.test.ts src/engine/references*.test.ts src/engine/component-identity.test.ts src/engine/branch-service.test.ts src/history/*.test.ts
npm run test:knowledge-lab
npm test
npm run lint
npm run build
git diff --check
```

Review-correction validation: all 17 retrieval tests passed (13 existing plus
four correction tests). Full `npm test` passed 386/386, including M1A/M1B,
revision/branch, component, reference, history and component UI regressions.
Explorer/authoring tests passed 21/21. `npm run lint` (TypeScript), production
build, `git diff --check` and individual whitespace checks for new/untracked
files passed. The build still reports Vite native-loader, bundle-size and mixed
static/dynamic-import warnings. A 90-file baseline hash check found only the
three intended source changes (`retrieval.ts`, its types comment and the shared
relationship helper); the other 87 protected pre-existing files remained identical.

Regression coverage includes all note kinds, both persisted schemas, exact source
resolution, two branches, confirmed rename, unrelated same-name components,
reference-only history, pinned versions/locators, direct record links,
project-note exclusion, unavailable/unsupported/ambiguous identities, corrupt and
future-schema publications, interrupted publication, missing bytes and ancestry,
empty versus incomplete queries, reopening, tied timestamps, reordered input,
frozen state, detached output and unchanged vault/CAD inventories with zero writes.

## Independent-review corrections

- F1: the component predicate had been applied to citations as though it proved
  record ownership. Ownership now remains governed by verified relationships;
  applicable M1A context and explicit M1B citations retain their original scope,
  exact versions/locators/hashes, and unverified bytes/claims status. Tests cover
  all three scopes, unrelated component exclusion, combined filters, a record
  without explicit citations, and explicit cross-branch source attribution.
- F2: sorting serialized the entire published-record wrapper, adding a level to
  the canonical serializer's depth budget. Sorting now uses stable ID/source
  keys. A genuinely published/reopened envelope whose wrapper exceeds depth 64
  retrieves alongside shallow records, including nested literal filtering and
  reversed input order. Its original bytes, envelope and hashes remain identical.
  Invalid publications and duplicate accepted identities remain unavailable.
- F3: each binding formerly rebuilt M1A, including repeated ancestors. A prepared
  resolver reuses the single projection and the same validation rules, with
  temporary lookup/binding/context/ancestry caches. The scaling regression uses
  actual saved revisions and counts note-object reads at 10/50/100 revisions to
  detect repeated projections, with no hardware-dependent timing threshold.

Run the reproducible measurement separately from tests:

```text
npx tsx tests/knowledge-retrieval-benchmark.ts
```

Same Windows/Node v24.19.0 environment and benchmark script before and after the
correction. Each stage captures a fresh disposable one-component history through
the real engine, reopens snapshots at 10/50/100 revisions, and reports the median
of three queries. Capture/reconstruction time is excluded. Each revision contains
three file-note fields. Measurements are observations, not performance guarantees.

| Revisions | Projection before/after (ms) | Literal before (ms) | Literal after (ms) | Component before (ms) | Component after (ms) |
| --- | --- | --- | --- | --- | --- |
| 10 | 0.37 / 0.35 | 18.06 | 1.57 | 18.32 | 1.36 |
| 50 | 1.01 / 1.16 | 1334.88 | 6.01 | 1302.94 | 6.32 |
| 100 | 2.08 / 2.46 | 10956.71 | 11.36 | 11276.15 | 11.39 |

## Limits

This is an in-memory metadata scan for local histories. The 100-revision synthetic
benchmark does not establish performance for very large vaults or large fan-outs;
the existing projection and returned ancestry arrays still carry history-size
costs. There is no semantic search, transitive link traversal,
numeric measurement query, attachment text search or technical fact evaluation.
Unavailable global evidence can conservatively mark a narrower query incomplete.
The existing Explorer remains unchanged; M2-2 has not begun.
