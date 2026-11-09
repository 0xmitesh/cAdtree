import { useMemo, useRef, useState } from 'react';
import type { VaultState } from '../../src/engine/types';
import { buildKnowledgeIndex, type KnowledgeAttachment, type KnowledgeAvailability } from '../../src/knowledge';
import { syntheticKnowledgeState } from './fixture';
import { pickVaultDirectory } from './load-vault';
import { KnowledgeVaultSession } from './vault-session';
import { KnowledgeAuthoring } from './authoring';
import { PersistedInspector } from './persisted-inspector';
import type { CreateKnowledgeRecordInput } from '../../src/knowledge/records';
import { componentAvailability, filterKnowledge, revisionComponents } from './view-model';
import { emptyRetrievalFilters } from './retrieval-model';
import { RetrievalExplorer } from './retrieval';

function Evidence({ label, value }: { label: string; value: KnowledgeAvailability }) {
  return <div className="kl-evidence"><span>{label}</span><strong data-status={value.status}>{value.status === 'not_recorded' ? 'not recorded' : value.status}</strong>{'reason' in value && <p>{value.reason}</p>}</div>;
}

function Source({ value }: { value: object }) {
  const pointer = value as { recordPath?: string; jsonPointer?: string };
  return <details className="kl-source"><summary>Inspect exact metadata source{pointer.recordPath && <> · <code>{pointer.recordPath}#{pointer.jsonPointer}</code></>}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}

function Attachment({ attachment: a }: { attachment: KnowledgeAttachment }) {
  return <article className="kl-attachment" aria-label={`Reference ${a.versionId}`}>
    <h4>{a.originalFilename}</h4>
    <dl><dt>Reference / version</dt><dd><code>{a.referenceId} / {a.versionId}</code></dd>
      <dt>Association</dt><dd>{a.scope} · origin: {a.origin}</dd>
      <dt>Component / historical path</dt><dd><code>{a.componentId ?? 'No component association'} {a.componentPath}</code></dd>
      <dt>Source locator</dt><dd>{a.locator || 'No locator recorded'}</dd>
      <dt>Context</dt><dd>{a.explanation || 'No explanation recorded'}</dd>
      <dt>Version metadata</dt><dd>{a.fileType} · {a.size} bytes · SHA-256 <code>{a.sha256}</code></dd></dl>
    <Evidence label="Association metadata" value={a.metadata} />
    <Evidence label="Attachment bytes" value={a.content} />
    <Source value={a.source} />
  </article>;
}

export function KnowledgeExplorer() {
  const [loaded, setLoaded] = useState<{ state: VaultState; synthetic: boolean; session?: KnowledgeVaultSession; disposable?: boolean } | null>(null);
  const [consent, setConsent] = useState(false);
  const [savedId, setSavedId] = useState<string>();
  const [filters, setFilters] = useState({ ...emptyRetrievalFilters });
  const [retrievalReady, setRetrievalReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [message, setMessage] = useState('Load the synthetic project or select an existing local vault.');
  const index = useMemo(() => loaded ? buildKnowledgeIndex(loaded.state) : null, [loaded]);
  const view = useMemo(() => loaded && index ? filterKnowledge(loaded.state, index, filters) : null, [loaded, index, filters]);
  const install = (state: VaultState, synthetic: boolean, session?: KnowledgeVaultSession, disposable = false) => {
    loaded?.session?.close();
    setLoaded({ state, synthetic, session, disposable }); setFilters({ ...emptyRetrievalFilters }); setRetrievalReady(true); setConsent(false); setSavedId(undefined);
    setMessage(synthetic ? 'Synthetic project loaded. Identities, checksums and evidence states are simulated.' : 'Local vault metadata reconstructed with read access. Attachment bytes have not been verified.');
  };
  const open = async (disposable = false) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setRetrievalReady(false);
    loaded?.session?.disableWrites(); setConsent(false);
    try {
      const selected = await KnowledgeVaultSession.inspect(await pickVaultDirectory());
      install(selected.state, false, selected.session, disposable);
      if (disposable) setMessage('Test vault selected read-only. Confirm its destination, then explicitly enable writes.');
    }
    catch (error) { setRetrievalReady(retrievalReady); setMessage(error instanceof Error && error.name === 'AbortError' ? 'Folder selection cancelled. Current view retained.' : error instanceof Error ? error.message : String(error)); }
    finally { pending.current = false; setBusy(false); }
  };
  const reload = async () => {
    if (!loaded?.session || pending.current) return;
    pending.current = true;
    loaded.session.disableWrites(); setConsent(false); setSavedId(undefined); setBusy(true); setRetrievalReady(false); setFilters({ ...emptyRetrievalFilters });
    try { setLoaded({ ...loaded, state: await loaded.session.reload() }); setRetrievalReady(true); setMessage('Vault reloaded from storage. Write authorization has been cleared.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { pending.current = false; setBusy(false); }
  };
  const authorize = async () => {
    if (!loaded?.session || !loaded.disposable || pending.current) return;
    pending.current = true;
    setBusy(true); setRetrievalReady(false);
    try { await loaded.session.authorizeDisposable(consent); setLoaded({ ...loaded, state: await loaded.session.reload() }); setRetrievalReady(true); setMessage('Writes enabled for this selected disposable vault only.'); }
    catch (error) {
      loaded.session.disableWrites(); setConsent(false); setMessage(error instanceof Error ? error.message : String(error));
      try { setLoaded({ ...loaded, state: await loaded.session.reload() }); setRetrievalReady(true); }
      catch { setRetrievalReady(false); /* Manual Reload vault remains available after read-only recovery fails. */ }
    }
    finally { pending.current = false; setBusy(false); }
  };
  const create = async (input: Omit<CreateKnowledgeRecordInput, 'projectId' | 'recordId'>) => {
    if (!loaded?.session || !loaded.disposable) throw new Error('Select and authorize a disposable vault first.');
    if (pending.current) throw new Error('A vault operation is already in progress.');
    pending.current = true; setBusy(true);
    try { const result = await loaded.session.create(input); setLoaded({ ...loaded, state: result.state }); setRetrievalReady(true); setFilters({ ...emptyRetrievalFilters }); setSavedId(result.recordId); setMessage(`Record ${result.recordId} persisted and reconstructed from the selected vault.`); }
    catch (error) {
      setConsent(false);
      try { setLoaded({ ...loaded, state: await loaded.session.reload() }); setRetrievalReady(true); } catch { setRetrievalReady(false); /* Keep the raw inspected snapshot, with retrieval invalidated. */ }
      setMessage(error instanceof Error ? error.message : String(error)); throw error;
    } finally { pending.current = false; setBusy(false); }
  };
  return <main className="knowledge-lab">
    <header className="kl-header"><div><p className="eyebrow">cAdtree / development only</p><h1>Knowledge Explorer<span className="heading-dot">.</span></h1><p className="muted">Inspect engineering knowledge and author records in disposable test vaults.</p></div><span className="kl-pill">{loaded?.session?.writeEnabled ? 'Test vault writes enabled' : 'Read-only'}</span></header>
    <section className="kl-panel" aria-label="Load knowledge">
      <div className="kl-actions"><button disabled={busy} onClick={() => { if (!pending.current) install(syntheticKnowledgeState(), true); }}>Load synthetic project</button><button disabled={busy} onClick={() => open()}>Open local project vault</button><button disabled={busy} onClick={() => open(true)}>Select disposable test vault</button>
        {loaded?.session && <button disabled={busy} onClick={reload}>Reload vault</button>}
        {loaded && <button disabled={busy} onClick={() => { if (pending.current) return; loaded.session?.close(); setLoaded(null); setRetrievalReady(false); setFilters({ ...emptyRetrievalFilters }); setConsent(false); setSavedId(undefined); setMessage('Project closed. Reopening requires folder selection and fresh write authorization.'); }}>Close project</button>}
      </div>
      <p className="muted">Open a vault containing project.json, or a project folder containing vault/project.json. Inspection is read-only. The synthetic preview cannot persist records.</p>
      <p role="status" aria-live="polite">{message}</p>
    </section>
    {loaded && index && view && <>
      <section className="kl-panel" aria-label="Project identity"><h2>{loaded.state.project.name}</h2><p>Project ID: <code>{index.projectId}</code></p><p>{loaded.synthetic ? 'SYNTHETIC · simulated reconstructed metadata; no attachment bytes exist.' : 'LOCAL · reconstructed vault metadata; document content is unverified.'}</p><p className="muted">Reference associations provide context, not proof of an engineering claim. Empty note fields do not establish that no problem exists.</p><details><summary>Inspect project identity</summary><pre>{JSON.stringify(loaded.state.project, null, 2)}</pre></details></section>
      <RetrievalExplorer state={loaded.state} index={index} synthetic={loaded.synthetic} ready={retrievalReady && !busy} filters={filters} onChange={setFilters} />
      {loaded.session && <section className="kl-panel kl-author" aria-label="Write authorization">
        <h2>{loaded.disposable ? 'Disposable test vault authorization' : 'Read-only local inspection'}</h2>
        <p>Project: <strong>{loaded.session.projectName}</strong> · <code>{loaded.session.projectId}</code></p><p>Selected destination: <code>{loaded.session.destination}</code></p>
        <p className="muted">The browser exposes the selected folder name, not its absolute path. Use a disposable project copy. Only knowledge records can be appended; CAD working folders are never written.</p>
        {loaded.disposable ? <>
          <label className="kl-consent"><input type="checkbox" disabled={busy || loaded.session.writeEnabled} checked={consent} onChange={e => setConsent(e.target.checked)} />I confirm this selected vault is a disposable test copy.</label>
          <div className="kl-actions"><button disabled={busy || !consent || loaded.session.writeEnabled} onClick={authorize}>Enable writes to this test vault</button><button disabled={busy || !loaded.session.writeEnabled} onClick={() => { loaded.session?.disableWrites(); setConsent(false); setMessage('Write authorization cleared. Inspection is read-only.'); }}>Return to read-only</button></div>
        </> : <p>To author records, use “Select disposable test vault” and explicitly authorize that separate selection.</p>}
      </section>}
      {loaded.session && loaded.disposable && <KnowledgeAuthoring key={loaded.session.instanceId} state={loaded.state} enabled={loaded.session.writeEnabled} busy={busy} onCreate={create} />}
      <PersistedInspector state={loaded.state} savedId={savedId} synthetic={loaded.synthetic} />
      <section className="kl-panel" aria-label="Branches"><h2>Branches · whole vault</h2><div className="kl-branches">{index.branches.map(b => <article key={b.branchId}><h3>{loaded.state.branches.find(s => s.branchId === b.branchId)?.name ?? b.branchId}</h3><p><code>{b.branchId}</code></p><p>Recorded starting revision: <code>{b.startingRevisionId ?? 'None (root branch)'}</code></p><Evidence label="Starting revision evidence" value={b.origin} /></article>)}</div></section>
      <h2>Original M1A projection inspector</h2><p className="muted">Raw reconstructed revision evidence below follows revision, branch, component and M1A type selections. Literal text, source and record-link matching apply to the retrieval results above.</p>
      <section aria-label="Revision knowledge" className="kl-revisions">
        {!view.revisions.length && <p className="kl-panel">No revisions match these filters.</p>}
        {view.revisions.map(r => {
          const records = view.records.filter(n => n.revisionId === r.revisionId);
          const attachments = r.referenceContext.attachments.filter(a => !filters.component || a.componentId === filters.component);
          const components = revisionComponents(loaded.state, index, r.revisionId).filter(c => !filters.component || c.componentId === filters.component);
          return <article className="kl-panel" key={r.revisionId} aria-label={`Revision ${r.revisionId}`}>
            <h2>{r.revisionId} <span className="muted">/ {r.branchId}</span></h2>
            <dl><dt>Recorded parent</dt><dd><code>{r.history.recordedParentRevisionId ?? 'None'}</code></dd><dt>Validated parent</dt><dd><code>{r.history.validatedParentRevisionId ?? 'No validated parent edge'}</code></dd><dt>Verified ancestry (includes self)</dt><dd><code>{r.history.ancestry.join(' ← ')}</code></dd></dl>
            {r.history.warnings.map((w, i) => <p className="kl-warning" key={i}>{w}</p>)}
            <div className="kl-evidence-grid"><Evidence label="Revision notes" value={r.notes} /><Evidence label="File notes" value={r.fileNotes} /><Evidence label="Reference context" value={r.referenceContext.availability} /></div>
            <details><summary>Inspect complete projected revision metadata</summary><pre>{JSON.stringify(r, null, 2)}</pre></details>
            <h3>Component identities & historical paths</h3>
            <Evidence label="Component mapping" value={componentAvailability(loaded.state, index, r.revisionId)} />
            {components.length ? <ul>{components.map(c => <li key={c.path}><code>{c.componentId}</code> · <code>{c.path}</code></li>)}</ul> : <p className="muted">No usable component mapping in this selection. Identity is never inferred from the path.</p>}
            <h3>Revision-level reference associations ({attachments.length})</h3><p className="muted">Includes associations captured without file-specific notes.</p>
            {attachments.map((a, i) => <Attachment attachment={a} key={i} />)}
            {!attachments.length && <p>{r.referenceContext.availability.status === 'available' ? 'No associations in this selection.' : 'Reference associations cannot be established; see evidence status above.'}</p>}
            <h3>Engineering note records ({records.length})</h3>
            {!records.length && <p className="muted">No note records in this selection.</p>}
            <div className="kl-records">{records.map(n => <article className="kl-record" key={n.id} aria-label={`${n.kind} ${n.filePath ?? 'project'}`}><p className="eyebrow">{n.kind} · {n.scope} · {n.status}</p><p className="kl-text">{n.status === 'empty' ? '(Empty recorded field)' : n.text}</p>{n.filePath && <p>Historical path: <code>{n.filePath}</code></p>}{n.componentId && <p>Component: <code>{n.componentId}</code></p>}{n.component && <Evidence label="Component identity" value={n.component} />}<Evidence label="Reference evidence" value={n.references} /><p>{n.attachments.length} contextual associations on this record</p><Source value={n.source} /><details><summary>Inspect complete projected note record</summary><pre>{JSON.stringify(n, null, 2)}</pre></details></article>)}</div>
          </article>;
        })}
      </section>
      <section className="kl-panel" aria-label="Knowledge diagnostics"><h2>Knowledge diagnostics · whole vault ({index.diagnostics.length})</h2>{index.diagnostics.length ? <ul>{index.diagnostics.map((d, i) => <li key={i}><code>{d.source}</code> — {d.reason}</li>)}</ul> : <p>No knowledge diagnostics reported.</p>}</section>
    </>}
  </main>;
}
