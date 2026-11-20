import { useState } from 'react';
import { Download } from 'lucide-react';
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
  if ((!evidence || evidence.status === 'legacy') && (!state.references || state.references.status === 'legacy' || evidence?.status === 'legacy')) return <p className="muted">No references were saved with this version.</p>;
  if (!evidence?.record || evidence.status !== 'available') return <Notice type="error">{evidence?.reason ?? state.references?.reason ?? 'Reference context is unavailable.'} CAD inspection and recovery use their own saved evidence.</Notice>;
  const context = evidence.record;
  const library = capturedReferenceLibrary(state, revisionId);
  return <div>
    {error ? <Notice type="error">{error}</Notice> : null}
    {state.references?.reason ? <Notice type="error">{state.references.reason}</Notice> : null}
    {context.contextOnly ? <Notice>Only the references changed in this version.</Notice> : null}
    {!context.links.length ? <p className="muted">No references associated with this version.</p> : null}
    {context.links.map((link, index) => {
      const ref = library.find(r => r.referenceId === link.referenceId);
      const version = ref?.versions.find(v => v.versionId === link.versionId);
      const title = ref?.title ?? version?.originalFilename ?? 'Unavailable reference';
      const download = async () => {
        if (!onRetrieve || !version || busy) return;
        setError(''); setBusy(true);
        try { await onRetrieve(link.referenceId, link.versionId); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      };
      return <section className="reference-card" key={index}>
        <h3>{onRetrieve ? <button type="button" className="reference-download" disabled={busy || !version} aria-label={`Download ${title}`} title={`Download ${version?.originalFilename ?? title}`} onClick={download}><Download size={17} aria-hidden="true" /><span>{title}</span></button> : title}</h3><p className="muted small">{link.origin === 'project' ? 'For this project' : 'For this version'}</p>
        <p className="file-path">{version?.originalFilename ?? 'File unavailable'}</p>
        {version ? <p className="muted small"><span>Saved {formatTimestamp(version.importedAt)}</span><br /><span>{version.savedBy ? `Saved by ${version.savedBy.displayName}` : 'Author not recorded'}</span></p> : null}
        {link.locator ? <p>Location: {link.locator}</p> : null}{link.explanation ? <p style={{ whiteSpace: 'pre-wrap' }}>{link.explanation}</p> : null}
        {link.componentPath ? <p className="file-path">Part: {link.componentPath}</p> : null}
      </section>;
    })}
    {context.links.length && onRetrieve ? <p className="muted small">Click a reference to download a copy. The original stays saved with your project.</p> : null}
  </div>;
}
