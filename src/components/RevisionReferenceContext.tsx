import { useState } from 'react';
import type { VaultState } from '../engine/types';
import { capturedReferenceLibrary } from '../engine/references';
import { formatTimestamp } from '../utils/format';
import { Notice } from './ui';

export function RevisionReferenceContext({ state, revisionId, onRetrieve }: {
  state: VaultState; revisionId: string; onRetrieve?: (referenceId: string, versionId: string) => Promise<void>;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const evidence = state.references?.contexts[revisionId];
  if ((!evidence || evidence.status === 'legacy') && (!state.references || state.references.status === 'legacy' || evidence?.status === 'legacy')) return <p className="muted">No reference context recorded.</p>;
  if (!evidence?.record || evidence.status !== 'available') return <Notice type="error">{evidence?.reason ?? state.references?.reason ?? 'Reference context is unavailable.'} CAD inspection and recovery use their own saved evidence.</Notice>;
  const context = evidence.record;
  const library = capturedReferenceLibrary(state, revisionId);
  return <div>
    {error ? <Notice type="error">{error}</Notice> : null}
    {state.references?.reason ? <Notice type="error">{state.references.reason}</Notice> : null}
    {context.contextOnly ? <Notice>Reference-context-only revision. No design-file bytes changed.</Notice> : null}
    {!context.links.length ? <p className="muted">No references associated with this revision.</p> : null}
    {context.links.map((link, index) => {
      const ref = library.find(r => r.referenceId === link.referenceId);
      const version = ref?.versions.find(v => v.versionId === link.versionId);
      return <section className="reference-card" key={index}>
        <h3>{ref?.title ?? link.referenceId}</h3><p className="muted small">{link.origin === 'project' ? 'Inherited project reference' : 'Selected for this revision'}</p>
        <p className="file-path">{version?.originalFilename ?? 'Attachment metadata unavailable'}</p>
        <p className="file-path small">Reference: {link.referenceId}<br />Exact version: {link.versionId}{version ? <><br />SHA-256: {version.sha256}<br />Imported {formatTimestamp(version.importedAt)} (not document creation date)</> : null}</p>
        {link.locator ? <p>Locator: {link.locator}</p> : null}{link.explanation ? <p style={{ whiteSpace: 'pre-wrap' }}>Explanation: {link.explanation}</p> : null}
        {link.componentId ? <p className="file-path">Component: {link.componentId}<br />Filename at capture: {link.componentPath}</p> : null}
        {onRetrieve ? <button className="button" disabled={busy || !version} onClick={async () => { setError(''); setBusy(true); try { await onRetrieve(link.referenceId, link.versionId); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }}>Retrieve exact attachment</button> : null}
      </section>;
    })}
    <p className="muted small">Locators and explanations are user-authored pointers, not verified quotations or evidence of requirement compliance. Attachments are excluded from review exports.</p>
  </div>;
}
