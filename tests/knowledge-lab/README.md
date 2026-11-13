# Knowledge Explorer (development only, M2-2)

Run `npm run dev:knowledge-lab`, then open http://127.0.0.1:2727/tests/knowledge-lab.html.
This entry is separate from the application and is not included in the default production build.

- **Load synthetic project** creates a deterministic, disposable in-memory VaultState. All identities, checksums and integrity states are simulated. It includes a component association without file notes, historical paths, two branches, empty fields, legacy evidence, an unavailable reference context, an unsupported manifest and diagnostics. No document bytes exist for these simulated references.
- **Open local project vault** requests browser read permission. Select the vault containing `project.json`, or a managed project folder containing `vault/project.json`. Inspection uses `openExistingVault` with a read-only guard. Ordinary inspection cannot enable authoring. Handles and authorizations are not persisted.
- **Select disposable test vault** is a separate read-only folder selection. Review the displayed project name, project ID and destination; confirm the selected folder is a disposable test copy, then deliberately press **Enable writes to this test vault**. Native read/write permission is requested only at that point. Denial leaves inspection read-only. The browser hides absolute paths, and the application cannot independently prove a user-selected folder is disposable.
- The two authoring forms use the existing `createKnowledgeRecord` API. CAD records support original text, proposed/implemented change, rationale, property before/after JSON values and units, and optional assumption/observation text blocks. Generic observations support a description and optional JSON object attributes. An optional text block is preserved as one string-array entry, including whitespace/newlines. Additional domain types still use the existing registry; new authoring forms can be added separately.
- Selectors link to verified saved revisions, historical component identities, exact captured reference/version associations and previously accepted knowledge records. One target of each kind may be selected per new record. Changing the historical revision clears component/reference selections. Eligibility is delegated to M1B-1; unavailable targets are excluded and their evidence problems explained. An evidence link is an assertion of relevance, not proof.
- Writes are additionally constrained to the selected vault's `knowledge/` subtree. CAD working folders cannot be selected as vaults without valid vault identity, and are never write destinations. The session offers no editing/deletion API. Creation errors clear authorization and require inspection before retry, including lost acknowledgements that may already have published a record.
- Successful creation reconstructs the vault before showing success. The persisted-record inspector shows complete payload, relationships, provenance, type/schema/storage versions, source paths, hashes and exact canonical envelope JSON. Its canonical text is reconstructed from validated storage, and tests compare it with the actual saved file bytes. Unsupported/corrupt/incomplete records appear as diagnostics, never accepted facts. Metadata checksum verification is distinct from unchecked attachment bytes and unvalidated engineering claims.
- Use **Reload vault** to reconstruct again and clear write authorization. Use **Close project**, then reopen through the picker, to verify persistence; authoring requires fresh selection/authorization. Draft forms are not persisted. The synthetic preview has no authoring or simulated persistent saves.
- Revision, branch and component filters intersect. Record type filters only engineering note records; revision evidence remains inspectable. Whole-vault branches and diagnostics remain visible. A component selection shows only that component's notes and associations, with complete revision metadata separately inspectable.
- Exact source paths, RFC 6901 pointers and recorded provenance checksums are expandable. These are metadata pointers, not file navigation links. Attachment bytes are never retrieved or marked verified. Reference associations provide context and do not prove engineering claims.

Validation:

```powershell
npm run test:knowledge-lab
npx tsx --test src/knowledge/*.test.ts
npm run lint
npm run build
$env:CADTREE_TEST_PORT = '2727'
$env:CADTREE_BROWSER_CHANNEL = 'chrome'
npx playwright test tests/browser/knowledge-lab.spec.ts
```

The browser check requires localhost access from the test process. The unit/integration tests use disposable filesystem adapters and native-handle facades. They cover both forms, actual immutable publication/reconstruction, close/reopen checksum preservation, relationship availability, validation rejection, permission denial/revocation, closed-session races, lost publication acknowledgements, and unchanged CAD/metadata inventories. They do not grant write access to real projects.

M1B-2 files: `explorer.tsx`, `load-vault.ts`, `style.css`, this README, and the new `vault-session.ts`, `authoring-model.ts`, `authoring.tsx`, `persisted-inspector.tsx`, `authoring-fixture.ts`, `vault-session.test.ts`, `authoring.test.tsx`. M1A/M1B-1 source and storage formats are unchanged.

## M2-2: retrieval workflow

The existing scope controls now also select M1A/M1B source, literal case-sensitive
text and an optional outgoing direct record link. Values are stable reconstructed
IDs; historical filenames are labels. Component and revision eligibility uses
the existing M1B relationship resolver with a prepared M1A projection. Unsupported
or unavailable identities are excluded from trusted choices and exposed through
retrieval issues. The source/type/text/link controls apply to API retrieval;
the original M1A inspector below remains a separate raw metadata view with scope
and M1A type filtering. There is only one set of controls.

`retrieval-model.ts` translates controls into `KnowledgeQuery` and formats choices.
`retrieval.tsx` calls the approved `retrieveKnowledge()` or, when a component is
selected, `getComponentKnowledgeTimeline()`. It does not implement matching,
sorting, identity inference, ancestry, citation grouping or evidence verification.

Component events are saved snapshots, including reference-only revisions, not
claims of confirmed geometry changes. Cards retain historical paths, recorded
timestamps, original note text or persisted payloads, source distinctions and
expandable relationships/provenance. Unknown registered record types fall back to
their recorded title and complete original payload; there is no schema builder.

Each event displays M2-1's exact reference union. A Main record can cite evidence
from an alternative branch: it appears on the Main record and its owning event,
while its source revision/branch remain those of the alternative. Independent
revision context stays distinct from explicit `evidence` relationships. Expand a
citation to inspect reference/version IDs, original filename, locator, scope,
source context pointer/hashes and the citing record's relationship pointer/hashes.
These are plain metadata, not working-folder navigation links.

The compact status displays `recordOutcome`, `coverage`, record/reference counts,
and component-identity availability when selected. Issues and original API
limitations are expandable. Empty results do not establish that nothing happened;
incomplete or unavailable evidence can conceal matches. Metadata checksums do not
verify attachment bytes or engineering claims. The UI does not retrieve documents.

Results are derived synchronously from the current reconstructed state and query,
with no separate cached result store or persisted controls. Opening/switching,
reloading, authorizing or saving temporarily hides results. Reload clears controls
and authoring authorization; a failed reload keeps retrieval unavailable until a
successful reload or selection. Closing removes the view. Successful creation
refreshes retrieval from the newly reconstructed storage. Ordinary inspection
needs no write authorization, permission escalation or additional filesystem access.

The existing synthetic fixture now includes both simulated schemas, original
component paths, two branches and a cross-branch evidence relationship, alongside
legacy/unavailable/unsupported evidence. Its envelopes use the existing schemas,
bindings and checksums, but are explicitly simulated; no publication or filesystem
write occurs. The synthetic persisted inspector labels its metadata accordingly.
Real-vault integration tests use disposable actual capture/publication/reconstruction.

Focused UI regressions in `retrieval.test.tsx` cover control/API equivalence,
verified IDs including unrelated same-name components, rename paths, timeline
ordering, reference-only snapshots, cross-branch citation/source inspection,
empty/incomplete/unavailable states, pending/failed reloads, project switching,
close, deterministic fixtures, zero writes and zero permission escalation.
Existing authoring tests also verify that CAD/generic saves refresh retrieval.
The browser spec adds filtered Main-event/alternative-citation inspection and empty
search behavior. No production navigation, approved algorithm, storage format,
backend or dependency changes are made.

Current limitations: matching is literal over recorded strings; selectors exclude
untrusted identities; global unavailable evidence can conservatively mark narrow
queries incomplete. Large result sets are rendered inline without pagination or
virtualization. Browser folder access still requires a supported Chrome/Edge
environment and an explicitly selected local vault. The browser hides absolute
paths and the application cannot independently establish that a selected vault is
disposable. All M1B-2 authoring restrictions continue to apply.

M2-2 files:

- Added `retrieval.tsx`, `retrieval-model.ts` and `retrieval.test.tsx` in this directory.
- Updated `explorer.tsx`, `fixture.ts`, `persisted-inspector.tsx`, `style.css`,
  `authoring.test.tsx`, this README, and `tests/browser/knowledge-lab.spec.ts`.

Validation: 26 Explorer/authoring tests and 164 knowledge/retrieval/engine/history
regressions pass, as do TypeScript, production build and whitespace checks.
The build retains existing Vite warnings. Approved `src/knowledge` and engine/history
implementations, storage formats and dependency/server configuration are unchanged.
In-app browser verification at the URL above confirmed structured filtering,
Main-event ownership with alternative-branch citation metadata, exact version/
pointer/hash inspection, empty-search uncertainty and no console errors. The CLI
Playwright attempt was blocked before application assertions: its health check
could not reuse localhost, and an isolated temporary config reached
`page.goto` but returned `ERR_NETWORK_ACCESS_DENIED`. This is a test-environment
network restriction, separate from the working in-app browser flow. No repository
server configuration was changed to work around it.
