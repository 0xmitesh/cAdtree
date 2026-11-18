import { useMemo, useState } from 'react';
import { Download, Plus } from 'lucide-react';
import type { VaultState, ProgressUpdate } from '../engine/types';
import { formatTimestamp } from '../utils/format';
import { formatRevisionNumber } from '../engine/vault-service';
import { buildReferenceBrowser, filterReferenceBrowser } from '../history/reference-browser';
import { formatBytes } from '../utils/format';
import { Notice, OperationProgress } from './ui';

export interface ReferencesViewProps {
  state: VaultState;
  busy: boolean;
  progress: ProgressUpdate | null;
  onCancel: () => void;
  onRetrieve: (referenceId: string, versionId: string) => Promise<void>;
  /** Adds the chosen files to the project as references that apply to the whole project. Hidden when not provided. */
  onAdd?: (files: File[], note: string) => Promise<void>;
  /** Why adding is not possible right now (for example a read-only project); disables Add reference. */
  addBlockReason?: string;
}
export function ReferencesView(props: ReferencesViewProps) {
  return <ProjectReferencesView key={props.state.project.projectId} {...props} />;
}
function ProjectReferencesView({ state, busy, progress, onCancel, onRetrieve, onAdd, addBlockReason }: ReferencesViewProps) {
  const [query, setQuery] = useState('');
  const [branchId, setBranchId] = useState('');
  const [fileKey, setFileKey] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [addFiles, setAddFiles] = useState<File[]>([]);
  const [addNote, setAddNote] = useState('');
  const [addError, setAddError] = useState('');
  const [addPending, setAddPending] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);
  const browser = useMemo(() => buildReferenceBrowser(state), [state]);
  const references = filterReferenceBrowser(browser, branchId, fileKey, query);
  const download = async (referenceId: string, versionId: string) => {
    if (busy || downloading) return;
    setError(''); setDownloading(true);
    try { await onRetrieve(referenceId, versionId); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setDownloading(false); }
  };
  const closeAdd = () => { setAdding(false); setAddFiles([]); setAddNote(''); setAddError(''); setPickerKey(key => key + 1); };
  const submitAdd = async () => {
    if (!onAdd || !addFiles.length || addPending) return;
    setAddError(''); setAddPending(true);
    try { await onAdd(addFiles, addNote); closeAdd(); }
    catch (e) { setAddError(e instanceof Error ? e.message : String(e)); }
    finally { setAddPending(false); }
  };
  const addDisabled = busy || downloading || addPending || Boolean(addBlockReason) || browser.unavailable;
  return <div className="page references-page">
    <div className="page-heading"><div><h1>References<span className="heading-dot">.</span></h1>
      <p className="muted">Find the sources saved with your project and see where they belong.</p></div>
      {onAdd && !adding ? <button className="button primary" type="button" disabled={addDisabled} onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" /> Add reference…</button> : null}</div>
    {onAdd && !adding && addBlockReason ? <p className="muted small">{addBlockReason}</p> : null}
    {onAdd && adding ? <section className="panel reference-add" aria-label="Add reference">
      <h2>Add reference</h2>
      <label className="field"><span>Reference files</span><input key={pickerKey} type="file" multiple disabled={addPending || busy} onChange={event => setAddFiles(Array.from(event.currentTarget.files ?? []))} /></label>
      {addFiles.length ? <ul className="muted small">{addFiles.map((file, index) => <li key={`${file.name}:${index}`}>{file.name} · {formatBytes(file.size)}</li>)}</ul> : null}
      <label className="field"><span>Note (optional)</span><textarea aria-label="Note for the new references" maxLength={8000} rows={3} value={addNote} disabled={addPending || busy} placeholder="What is this reference for?" onChange={event => setAddNote(event.target.value)} /></label>
      <p className="muted small">Applies to the whole project. It is included whenever you save a revision. To tie a file to one part, attach it when you save a revision.</p>
      {addError ? <Notice type="error">{addError}</Notice> : null}
      <div className="button-row">
        <button className="button primary" type="button" disabled={!addFiles.length || addPending || busy || Boolean(addBlockReason)} onClick={() => void submitAdd()}>Add</button>
        <button className="text-button" type="button" disabled={addPending} onClick={closeAdd}>Cancel</button>
      </div>
    </section> : null}
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
    {!references.length && !browser.unavailable ? <p className="muted">{browser.entries.length ? 'No matching references. Try another branch, file or search.' : 'No references yet. Use Add reference, or attach files when you save a revision.'}</p> : null}
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
      </li>)}</ul> : reference.projectVersionId === version.versionId && !reference.removed ? <p className="muted small">Applies to the whole project. It is included in the next revision you save.</p> : <p className="muted small">Not attached to a saved revision yet.</p>}
    </section>)}
    {references.length ? <p className="muted small">Click a reference to download a copy. Whole-revision references also appear when the selected file belongs to that revision.</p> : null}
  </div>;
}
