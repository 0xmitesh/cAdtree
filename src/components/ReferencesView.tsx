import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Download, Plus } from 'lucide-react';
import type { VaultState, ProgressUpdate } from '../engine/types';
import { formatBytes, formatTimestamp } from '../utils/format';
import { formatRevisionNumber } from '../engine/vault-service';
import { buildReferenceBrowser, filterReferenceBrowser } from '../history/reference-browser';
import { Notice, OperationProgress } from './ui';

/** A failed or cancelled add. `remaining` are the files that were not added, so they can stay in the panel for another try. */
export class AddReferencesError extends Error {
  constructor(message: string, readonly remaining: File[]) { super(message); this.name = 'AddReferencesError'; }
}
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
  /** Stops a whole-project reference from being carried into new revisions (it stays in the library). Hidden when not provided. */
  onStopApplying?: (referenceId: string) => Promise<void>;
}
export function ReferencesView(props: ReferencesViewProps) {
  return <ProjectReferencesView key={props.state.project.projectId} {...props} />;
}
function ProjectReferencesView({ state, busy, progress, onCancel, onRetrieve, onAdd, addBlockReason, onStopApplying }: ReferencesViewProps) {
  const [query, setQuery] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [addFiles, setAddFiles] = useState<File[]>([]);
  const [addNote, setAddNote] = useState('');
  const [addError, setAddError] = useState('');
  const [addPending, setAddPending] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);
  const [confirmStop, setConfirmStop] = useState('');
  const [stopError, setStopError] = useState('');
  const addButton = useRef<HTMLButtonElement>(null);
  const wasAdding = useRef(false);
  const blockId = useId();
  // Closing the panel (Cancel or after adding) returns focus to the button that opened it.
  useEffect(() => { if (wasAdding.current && !adding) addButton.current?.focus(); wasAdding.current = adding; }, [adding]);
  const browser = useMemo(() => buildReferenceBrowser(state), [state]);
  const references = filterReferenceBrowser(browser, query);
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
    catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
      // Files that were added stay out of the list, so another try cannot add them twice.
      if (e instanceof AddReferencesError) { setAddFiles(e.remaining); setPickerKey(key => key + 1); }
    }
    finally { setAddPending(false); }
  };
  const stop = async (referenceId: string) => {
    if (!onStopApplying || busy || downloading) return;
    setStopError('');
    try { await onStopApplying(referenceId); setConfirmStop(''); }
    catch (e) { setStopError(e instanceof Error ? e.message : String(e)); }
  };
  const addDisabled = busy || downloading || addPending || Boolean(addBlockReason) || browser.unavailable;
  return <div className="page references-page">
    <div className="page-heading"><div><h1>References<span className="heading-dot">.</span></h1>
      <p className="muted">Find the sources saved with your project and see where they belong.</p></div>
      {onAdd && !adding ? <button ref={addButton} className="button primary" type="button" disabled={addDisabled} aria-describedby={addBlockReason ? blockId : undefined} onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" /> Add reference…</button> : null}</div>
    {onAdd && !adding && addBlockReason ? <p id={blockId} className="muted small">{addBlockReason}</p> : null}
    {onAdd && adding ? <section className="panel reference-add" aria-label="Add reference">
      <h2>Add reference</h2>
      <label className="field"><span>Reference files</span><input key={pickerKey} type="file" multiple disabled={addPending || busy} onChange={event => setAddFiles(Array.from(event.currentTarget.files ?? []))} /></label>
      {addFiles.length ? <ul className="muted small">{addFiles.map((file, index) => <li key={`${file.name}:${index}`}>{file.name} · {formatBytes(file.size)}</li>)}</ul> : null}
      <label className="field"><span>Note (optional)</span><textarea maxLength={8000} rows={3} value={addNote} disabled={addPending || busy} placeholder="What is this reference for?" onChange={event => setAddNote(event.target.value)} /></label>
      <p className="muted small">Applies to the whole project. It is included whenever you save a version. To tie a file to one part, attach it when you save a version.</p>
      {addError ? <Notice type="error">{addError}</Notice> : null}
      <div className="button-row">
        <button className="button primary" type="button" disabled={!addFiles.length || addPending || busy || Boolean(addBlockReason)} onClick={() => void submitAdd()}>Add</button>
        <button className="text-button" type="button" disabled={addPending} onClick={closeAdd}>Cancel</button>
      </div>
    </section> : null}
    <label className="field reference-search"><span>Search references</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by name, file, note or the file it applies to" /></label>
    {browser.unavailable ? <Notice type="error">Some saved references could not be read. Reconnect the project folder or check its saved records.</Notice> : null}
    {error ? <Notice type="error">{error}</Notice> : null}
    {stopError ? <Notice type="error">{stopError}</Notice> : null}
    {busy ? <OperationProgress progress={progress} onCancel={onCancel} /> : null}
    <p className="muted small" role="status">{browser.unavailable ? 'References unavailable' : `${references.length} reference file${references.length === 1 ? '' : 's'}`}</p>
    {!references.length && !browser.unavailable ? <p className="muted">{browser.entries.length ? 'No matching references. Try another search.' : 'No references yet. Use Add reference, or attach files when you save a version.'}</p> : null}
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
        <span>{use.partPath ? `Part: ${use.partPath}` : 'Whole version'}</span>
        {use.locator ? <span>Location: {use.locator}</span> : null}
        {use.explanation ? <span>{use.explanation}</span> : null}
      </li>)}</ul> : reference.projectVersionId === version.versionId && !reference.removed ? <p className="muted small">Applies to the whole project. It is included in the next version you save.</p> : <p className="muted small">Not attached to a saved version yet.</p>}
      {onStopApplying && reference.projectVersionId === version.versionId && !reference.removed ? (confirmStop === reference.referenceId
        ? <div className="reference-stop" role="group" aria-label={`Stop applying ${reference.title} to the whole project`}>
          <p className="small">Stop applying {reference.title} to the whole project? Versions you save from now on will not include it. It stays here, and earlier versions keep it.</p>
          <div className="button-row">
            <button className="button primary" type="button" disabled={busy || Boolean(addBlockReason)} onClick={() => void stop(reference.referenceId)}>Stop applying</button>
            <button className="text-button" type="button" disabled={busy} onClick={() => setConfirmStop('')}>Keep</button>
          </div>
        </div>
        : <button className="text-button" type="button" disabled={busy || downloading || Boolean(addBlockReason)} aria-label={`Stop applying ${reference.title} to the whole project`} onClick={() => { setStopError(''); setConfirmStop(reference.referenceId); }}>Stop applying to the whole project</button>) : null}
    </section>)}
    {references.length ? <p className="muted small">Click a reference to download a copy.</p> : null}
  </div>;
}
