import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import type { VaultState, ProgressUpdate } from '../engine/types';
import { formatTimestamp } from '../utils/format';
import { formatRevisionNumber } from '../engine/vault-service';
import { buildReferenceBrowser, filterReferenceBrowser } from '../history/reference-browser';
import { Notice, OperationProgress } from './ui';

export interface ReferencesViewProps {
  state: VaultState;
  busy: boolean;
  progress: ProgressUpdate | null;
  onCancel: () => void;
  onRetrieve: (referenceId: string, versionId: string) => Promise<void>;
}
export function ReferencesView(props: ReferencesViewProps) {
  return <ProjectReferencesView key={props.state.project.projectId} {...props} />;
}
function ProjectReferencesView({ state, busy, progress, onCancel, onRetrieve }: ReferencesViewProps) {
  const [query, setQuery] = useState('');
  const [branchId, setBranchId] = useState('');
  const [fileKey, setFileKey] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const browser = useMemo(() => buildReferenceBrowser(state), [state]);
  const references = filterReferenceBrowser(browser, branchId, fileKey, query);
  const download = async (referenceId: string, versionId: string) => {
    if (busy || downloading) return;
    setError(''); setDownloading(true);
    try { await onRetrieve(referenceId, versionId); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setDownloading(false); }
  };
  return <div className="page references-page">
    <div className="page-heading"><div><h1>References<span className="heading-dot">.</span></h1>
      <p className="muted">Find the sources saved with your project and see where they belong.</p></div></div>
    <div className="reference-filters" role="group" aria-label="Filter references">
      <label className="field"><span>Branch</span><select value={branchId} onChange={event => setBranchId(event.target.value)}>
        <option value="">All branches</option>
        {state.branches.map(branch => <option key={branch.branchId} value={branch.branchId}>{branch.name}{state.caseLifecycles?.[branch.branchId]?.status === 'archived' ? ' (archived)' : ''}</option>)}
      </select></label>
      <label className="field"><span>Part / file</span><select value={fileKey} onChange={event => setFileKey(event.target.value)}>
        <option value="">All parts / files</option>
        {browser.files.map(file => <option key={file.value} value={file.value}>{file.label}</option>)}
      </select></label>
      <label className="field reference-search"><span>Search references</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by title, filename, description or revision" /></label>
    </div>
    {browser.unavailable ? <Notice type="error">Some saved references could not be read. Reconnect the project folder or check its saved records.</Notice> : null}
    {error ? <Notice type="error">{error}</Notice> : null}
    {busy ? <OperationProgress progress={progress} onCancel={onCancel} /> : null}
    <p className="muted small" role="status">{browser.unavailable ? 'References unavailable' : `${references.length} reference file${references.length === 1 ? '' : 's'}`}</p>
    {!references.length && !browser.unavailable ? <p className="muted">{browser.entries.length ? 'No matching references. Try another branch, file or search.' : 'No references yet. References attached to your revisions will appear here.'}</p> : null}
    {references.map(({ reference, version, uses }) => <section className="panel reference-card" key={`${reference.referenceId}:${version.versionId}`}>
      <h2><button className="reference-download" type="button" disabled={busy || downloading || browser.unavailable} aria-label={`Download ${reference.title} (${version.originalFilename})`} onClick={() => void download(reference.referenceId, version.versionId)}>
        <Download size={18} aria-hidden="true" /><span>{reference.title}</span>
      </button></h2>
      <p className="file-path">{version.originalFilename}</p>
      <p className="muted small"><span>Saved {formatTimestamp(version.importedAt)}</span><br /><span>{version.savedBy ? `Saved by ${version.savedBy.displayName}` : 'Author not recorded'}</span></p>
      {reference.description ? <p style={{ whiteSpace: 'pre-wrap' }}>{reference.description}</p> : null}
      {reference.tags.length ? <p className="muted small">Tags: {reference.tags.join(', ')}</p> : null}
      {uses.length ? <ul className="reference-uses" aria-label={`Where ${version.originalFilename} is used`}>{uses.map((use, index) => <li key={`${use.revisionId}:${index}`}>
        <strong>{use.branchName} · {formatRevisionNumber(use.displayNumber)}</strong>
        <span>{use.summary}</span>
        <span>{use.partPath ? `Part: ${use.partPath}` : 'Whole revision'}</span>
        {use.locator ? <span>Location: {use.locator}</span> : null}
        {use.explanation ? <span>{use.explanation}</span> : null}
      </li>)}</ul> : <p className="muted small">Not attached to a saved revision yet.</p>}
    </section>)}
    {references.length ? <p className="muted small">Click a reference to download a copy. Whole-revision references also appear when the selected file belongs to that revision.</p> : null}
  </div>;
}
