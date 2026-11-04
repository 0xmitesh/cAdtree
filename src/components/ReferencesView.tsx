import { useState } from 'react';
import type { VaultState, ProgressUpdate } from '../engine/types';
import type { AttachmentSource, ReferenceMetadata, ProjectReference } from '../engine/references';
import { referenceWriteBlock } from '../engine/references';
import { formatBytes, formatTimestamp } from '../utils/format';
import { Modal, Notice, OperationProgress } from './ui';

export interface ReferencesViewProps {
  state: VaultState;
  busy: boolean;
  progress: ProgressUpdate | null;
  onCancel: () => void;
  onImport: (file: AttachmentSource, metadata: ReferenceMetadata, referenceId?: string) => Promise<void>;
  onUpdate: (referenceId: string, changes: Partial<ReferenceMetadata> & { projectVersionId?: string | null; removed?: boolean }) => Promise<void>;
  onRetrieve: (referenceId: string, versionId: string) => Promise<void>;
}
export function ReferencesView(props: ReferencesViewProps) {
  const [query, setQuery] = useState('');
  const [showRemoved, setShowRemoved] = useState(false);
  const [editor, setEditor] = useState<{ kind: 'import' | 'version' | 'edit'; reference?: ProjectReference } | null>(null);
  const [error, setError] = useState('');
  const block = referenceWriteBlock(props.state);
  const run = async (action: () => Promise<void>) => {
    setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const references = (props.state.references?.library ?? []).filter(r => (showRemoved || !r.removed) &&
    [r.title, ...r.tags, ...r.versions.map(v => v.originalFilename)].join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="page">
    <div className="page-heading"><div><h1>References<span className="heading-dot">.</span></h1>
      <p className="muted">Original sources behind this project. Attachments stay outside design working folders.</p></div>
      <button className="button primary" disabled={props.busy || Boolean(block)} onClick={() => setEditor({ kind: 'import' })}>Import reference</button></div>
    {block ? <Notice type="error">{block} CAD history and recovery remain available where their evidence is valid.</Notice> : null}
    {error ? <Notice type="error">{error}</Notice> : null}
    {props.busy ? <OperationProgress progress={props.progress} onCancel={props.onCancel} /> : null}
    <label className="field"><span>Search references</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Title, filename or tag" /></label>
    <label className="recovery-external-choice"><input type="checkbox" checked={showRemoved} onChange={e => setShowRemoved(e.target.checked)} /> Show removed references</label>
    {!references.length ? <p className="muted">No matching references. Import a requirement, image or transcript to keep its original bytes with this project.</p> : null}
    {references.map(reference => <ReferenceCard key={reference.referenceId} reference={reference} disabled={props.busy || Boolean(block)}
      onEdit={() => setEditor({ kind: 'edit', reference })} onVersion={() => setEditor({ kind: 'version', reference })}
      onRetrieve={versionId => run(() => props.onRetrieve(reference.referenceId, versionId))}
      onUpdate={changes => run(() => props.onUpdate(reference.referenceId, changes))} />)}
    <p className="muted small">Project context pins the chosen version for future captures. Saved revisions retain their own context. Removing a reference from current context keeps all versions and historical links.</p>
    {editor ? <ReferenceEditor key={`${editor.kind}:${editor.reference?.referenceId ?? ''}`} kind={editor.kind} reference={editor.reference} busy={props.busy}
      onClose={() => setEditor(null)} onSave={async (file, metadata) => {
        if (editor.kind === 'edit') await props.onUpdate(editor.reference!.referenceId, metadata);
        else await props.onImport(file!, metadata, editor.reference?.referenceId);
        setEditor(null);
      }} /> : null}
  </div>;
}
function ReferenceCard({ reference: r, disabled, onEdit, onVersion, onRetrieve, onUpdate }: {
  reference: ProjectReference; disabled: boolean; onEdit: () => void; onVersion: () => void;
  onRetrieve: (versionId: string) => Promise<void>;
  onUpdate: (changes: { projectVersionId?: string | null; removed?: boolean }) => Promise<void>;
}) {
  const [versionId, setVersionId] = useState(r.versions.at(-1)!.versionId);
  const v = r.versions.find(v => v.versionId === versionId) ?? r.versions.at(-1)!;
  return <section className="panel reference-card">
    <div className="panel-heading"><h2>{r.title}{r.removed ? ' (removed from current context)' : ''}</h2>
      <div className="button-row"><button className="button" disabled={disabled} onClick={onEdit}>Edit details</button><button className="button" disabled={disabled} onClick={onVersion}>Add new version</button></div></div>
    <p style={{ whiteSpace: 'pre-wrap' }}>{r.description}</p><p className="muted small">Tags: {r.tags.join(', ') || 'None'}</p>
    <label className="field"><span>Attachment version — {r.title}</span><select value={v.versionId} onChange={e => setVersionId(e.target.value)}>
      {r.versions.map((v, index) => <option key={v.versionId} value={v.versionId}>Version {index + 1}: {v.originalFilename}</option>)}
    </select></label>
    <p className="file-path">{v.originalFilename}</p><p className="muted small">{v.fileType} · {formatBytes(v.size)} · Imported {formatTimestamp(v.importedAt)} (import time, not document creation date)</p>
    <p className="file-path small">Reference: {r.referenceId}<br />Version: {v.versionId}<br />SHA-256: {v.sha256}</p>
    <div className="button-row"><button className="button" disabled={disabled} onClick={() => void onRetrieve(v.versionId)}>Retrieve exact attachment</button>
      <button className="button" disabled={disabled} onClick={() => void onUpdate({ removed: false, projectVersionId: v.versionId })}>{r.projectVersionId === v.versionId ? 'Project context: this version' : 'Use this version in project context'}</button>
      {r.projectVersionId ? <button className="button" disabled={disabled} onClick={() => void onUpdate({ projectVersionId: null })}>Stop inheriting in future revisions</button> : null}
      <button className="button" disabled={disabled} onClick={() => void onUpdate({ removed: !r.removed })}>{r.removed ? 'Restore to library' : 'Remove from current context'}</button></div>
  </section>;
}
function ReferenceEditor({ kind, reference, busy, onClose, onSave }: {
  kind: 'import' | 'version' | 'edit'; reference?: ProjectReference; busy: boolean; onClose: () => void;
  onSave: (file: File | null, metadata: ReferenceMetadata) => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState(reference?.title ?? '');
  const [description, setDescription] = useState(reference?.description ?? '');
  const [tags, setTags] = useState(reference?.tags.join(', ') ?? '');
  const [error, setError] = useState('');
  return <Modal title={kind === 'edit' ? 'Edit reference details' : kind === 'version' ? 'Add new reference version' : 'Import reference'} busy={busy} onClose={onClose}>
    <form onSubmit={async e => { e.preventDefault(); setError(''); try { await onSave(file, { title, description, tags: tags.split(',') }); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }}>
      {kind !== 'edit' ? <label className="field"><span>Original attachment</span><input type="file" required disabled={busy} onChange={e => { const f = e.target.files?.[0] ?? null; setFile(f); if (!title && f) setTitle(f.name); }} /></label> : null}
      <label className="field"><span>Title</span><input required maxLength={500} value={title} disabled={busy} onChange={e => setTitle(e.target.value)} /></label>
      <label className="field"><span>Description</span><textarea value={description} maxLength={10000} disabled={busy} onChange={e => setDescription(e.target.value)} /></label>
      <label className="field"><span>Tags (comma separated)</span><input value={tags} disabled={busy} onChange={e => setTags(e.target.value)} /></label>
      <p className="muted small">Original bytes are copied and verified locally. Import time is recorded separately from any document date. No content is parsed. Adding a version preserves every earlier version and does not advance project context automatically.</p>
      {error ? <Notice type="error">{error}</Notice> : null}
      <div className="button-row"><button className="button" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !title.trim() || (kind !== 'edit' && !file)}>{kind === 'edit' ? 'Save details' : 'Copy and verify attachment'}</button></div>
    </form>
  </Modal>;
}
