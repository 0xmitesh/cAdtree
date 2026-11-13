import type { VaultState } from '../../src/engine/types';
import { canonicalJson } from '../../src/knowledge/records/json';

export function PersistedInspector({ state, savedId, synthetic = false }: { state: VaultState; savedId?: string; synthetic?: boolean }) {
  const evidence = state.knowledge;
  return <section className="kl-panel" aria-label="Persisted knowledge records">
    <h2>Persisted knowledge records · whole vault ({evidence?.records.length ?? 0})</h2>
    <p className="muted">{synthetic ? 'SYNTHETIC: simulated envelopes and checksums; no records were saved to a vault.' : 'These are separate from derived M1A revision notes. Records are displayed from reconstructed vault storage.'}</p>
    {!evidence?.records.length && <p>No accepted persisted records in this snapshot.</p>}
    {evidence?.status === 'unavailable' && <p className="kl-warning">Knowledge storage is unavailable for trusted retrieval. See diagnostics below.</p>}
    {evidence?.records.map(entry => <article className="kl-attachment" key={entry.record.recordId} aria-label={`Persisted record ${entry.record.recordId}`}>
      <h3>{entry.record.recordType} · schema v{entry.record.schemaVersion}</h3>
      <p><code>{entry.record.recordId}</code>{savedId === entry.record.recordId && <strong> · Just saved and reconstructed</strong>}</p>
      <p>Project: <code>{entry.record.projectId}</code> · Recorded: {entry.record.createdAt} · Storage format v{entry.record.formatVersion}</p>
      <div className="kl-evidence-grid"><p>Metadata: <strong>{synthetic ? 'Simulated checksum' : 'Checksum verified'}</strong></p><p>Attachment bytes: <strong>Not checked</strong></p><p>Engineering claims: <strong>Not independently validated</strong></p></div>
      <details open={savedId === entry.record.recordId}><summary>Complete payload</summary><pre>{JSON.stringify(entry.record.payload, null, 2)}</pre></details>
      <details><summary>Relationships and exact provenance bindings</summary><pre>{JSON.stringify(entry.record.relationships, null, 2)}</pre></details>
      <details><summary>Recording provenance and optional author</summary><pre>{JSON.stringify({ provenance: entry.record.provenance, ...(entry.record.author ? { author: entry.record.author } : {}) }, null, 2)}</pre></details>
      <details><summary>Stored source paths, hashes and verification status</summary><pre>{JSON.stringify({ source: entry.source, integrity: entry.record.integrity, verification: entry.verification }, null, 2)}</pre></details>
      <details><summary>{synthetic ? 'Canonical record JSON — simulated' : 'Canonical record JSON — reconstructed from saved metadata'}</summary><pre className="kl-canonical">{canonicalJson(entry.record)}</pre></details>
    </article>)}
    <h3>Persisted knowledge diagnostics ({evidence?.diagnostics.length ?? 0})</h3>
    {evidence?.diagnostics.map((d, i) => <article className="kl-attachment" aria-label={`Knowledge diagnostic ${d.recordId ?? d.recordPath}`} key={i}>
      <p><strong>{d.status}</strong> · {d.recordType ?? 'Unknown record type'} · schema {d.schemaVersion ?? 'unknown'}</p><p><code>{d.recordId ?? 'Unidentified record'} · {d.recordPath}</code></p><p>{d.reason}</p><details><summary>Diagnostic metadata (untrusted record excluded)</summary><pre>{JSON.stringify(d, null, 2)}</pre></details>
    </article>)}
  </section>;
}
