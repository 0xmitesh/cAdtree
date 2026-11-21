import { useMemo, useState } from 'react';
import type { FileSystemDirectoryAdapter } from '../engine/fs-adapter';
import { RealFileSystemAdapter } from '../engine/fs-adapter';
import { prepareReviewExport, suggestReviewExportFolder, type ReviewExportPlan, type ReviewExportResult } from '../engine/review-export';
import type { ProgressUpdate, VaultState } from '../engine/types';
import { pickDirectory } from '../utils/folder-access';
import { Modal, Notice, OperationProgress } from './ui';

export type ExportReviewAction = (plan: ReviewExportPlan, parent: FileSystemDirectoryAdapter, folderName: string) => Promise<ReviewExportResult>;

export function ReviewExportDialog({ state, revisionId, initialPaths = [], busy: parentBusy, progress, onExport, onClose, onCancel }: {
  state: VaultState; revisionId: string; initialPaths?: string[]; busy: boolean;
  progress: ProgressUpdate | null; onExport: ExportReviewAction; onClose: () => void; onCancel: () => void;
}) {
  const revision = state.revisions.find(r => r.manifest.revisionId === revisionId);
  const [kind, setKind] = useState<'complete' | 'selected'>('complete');
  const [selected, setSelected] = useState(() => new Set(initialPaths.filter(p => revision?.manifest.files.some(f => f.path === p))));
  const [labelFilenames, setLabelFilenames] = useState(false);
  const [includeReferences, setIncludeReferences] = useState(true);
  const [destination, setDestination] = useState<{ parent: FileSystemDirectoryAdapter; folderName: string } | null>(null);
  const [error, setError] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<ReviewExportResult | null>(null);
  const busy = parentBusy || choosing || exporting;
  const preview = useMemo(() => {
    try { return { plan: prepareReviewExport(state, revisionId, { kind, selectedPaths: [...selected], labelFilenames: kind === 'selected' && labelFilenames, includeReferences }), error: '' }; }
    catch (e) { return { plan: undefined, error: e instanceof Error ? e.message : String(e) }; }
  }, [state, revisionId, kind, selected, labelFilenames, includeReferences]);
  const plan = preview.plan;
  const chooseDestination = async () => {
    if (!plan || busy) return;
    setError('');
    setChoosing(true);
    try {
      const parent = new RealFileSystemAdapter(await pickDirectory('readwrite'));
      setDestination({ parent, folderName: await suggestReviewExportFolder(parent, plan.folderName) });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setChoosing(false); }
  };
  const runExport = async () => {
    if (!plan || !destination || busy) return;
    setError('');
    setExporting(true);
    try { setResult(await onExport(plan, destination.parent, destination.folderName)); }
    catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // The retained attempt is never reused. Show the next proposal for an
      // explicit retry, including when another writer took the reviewed name.
      try { setDestination({ parent: destination.parent, folderName: await suggestReviewExportFolder(destination.parent, plan.folderName) }); }
      catch { setDestination(null); }
    } finally { setExporting(false); }
  };
  return <Modal title="Export a copy" busy={busy} onClose={onClose}>
    <p><strong>{plan ? `${plan.projectName} · ${plan.branchName} · ${plan.revisionLabel}` : revision?.manifest.summary}</strong></p>
    <p>Exports the saved files exactly as they were saved. Open documents and newer changes are not included.</p>
    <fieldset disabled={busy || Boolean(result)}>
      <legend>Export contents</legend>
      <label className="export-choice"><span><input type="radio" name="review-export-kind" checked={kind === 'complete'} onChange={() => { setKind('complete'); setError(''); }} /> Complete project</span></label>
      <label className="export-choice"><span><input type="radio" name="review-export-kind" checked={kind === 'selected'} onChange={() => { setKind('selected'); setError(''); }} /> Selected files</span></label>
      {kind === 'selected' ? <>
        <Notice>This is a partial copy. Other files these documents depend on are not added automatically.</Notice>
        <div className="change-table" role="group" aria-label="Files in this version">
          {revision?.manifest.files.map(file => <label className="export-choice" key={file.path}><span className="file-path"><input type="checkbox" aria-label={`Export ${file.path}`} checked={selected.has(file.path)} onChange={() => setSelected(previous => {
            const next = new Set(previous); next.has(file.path) ? next.delete(file.path) : next.add(file.path); return next;
          })} /> {file.path}</span></label>)}
        </div>
        <label className="export-choice"><span><input type="checkbox" checked={labelFilenames} onChange={e => setLabelFilenames(e.target.checked)} /> Add case and version to filenames</span></label>
        <p className="muted small">Labelled filenames suit a copy you share on its own. If other documents link to a renamed file, those links may need fixing; cAdtree does not change links inside your documents.</p>
      </> : <p>Keeps every saved file name and folder as it was, including empty folders.</p>}
      <label className="export-choice"><span><input type="checkbox" checked={includeReferences} onChange={e => { setIncludeReferences(e.target.checked); setError(''); }} /> Include references</span></label>
      <p className="muted small">{includeReferences
        ? (plan ? (plan.references.length ? `${plan.references.length} reference attachment${plan.references.length === 1 ? '' : 's'} will be copied into a ${plan.referencesDirectory} folder.` : 'No reference attachments apply to this version.') : '')
        : 'Reference attachments will not be copied.'}</p>
      {preview.error ? <Notice type="error">{preview.error}</Notice> : null}
      {plan ? <>
        <p>Proposed folder: <strong className="file-path">{destination?.folderName ?? plan.folderName}/</strong></p>
        <p>Save in: <strong>{destination?.parent.name ?? 'No folder chosen yet'}</strong></p>
        {destination && destination.folderName !== plan.folderName ? <Notice>The original label is already in use. This fresh numbered folder is proposed for your confirmation.</Notice> : null}
        <details className="disclosure">
          <summary>Show details</summary>
          <p><strong>Files to copy ({plan.files.length})</strong></p>
          {plan.files.map(file => <p className="file-path" key={file.path}>{file.path === file.exportedPath ? file.path : `${file.path} → ${file.exportedPath}`}</p>)}
          {plan.references.map(ref => <p className="file-path" key={ref.versionId}>{ref.exportedPath} — reference attachment</p>)}
          <p className="file-path">{plan.summaryName} — summary of this copy</p>
          <p><strong>Summary file contents</strong></p>
          <pre className="file-path" style={{ whiteSpace: 'pre-wrap' }}>{plan.summaryText}</pre>
        </details>
      </> : null}
      <button type="button" className="button secondary" disabled={!plan} onClick={() => void chooseDestination()}>{destination ? 'Change folder…' : 'Choose folder…'}</button>
    </fieldset>
    {error ? <Notice type="error">{error}</Notice> : null}
    {busy && !choosing ? progress ? <OperationProgress progress={progress} onCancel={onCancel} /> : <button className="button secondary" onClick={onCancel}>Cancel export</button> : null}
    {result ? <Notice type="success">Copy ready and checked: {destination?.parent.name}/{result.folderName}/. {result.filesCount} saved files{result.referencesCount ? `, ${result.referencesCount} reference attachment${result.referencesCount === 1 ? '' : 's'}` : ''} and {result.summaryName}.</Notice> : null}
    {result?.referencesSkipped.length ? <Notice>{result.referencesSkipped.map(s => `Not included: ${s.label}: ${s.reason}`).join(' ')} The summary file lists them.</Notice> : null}
    <div className="modal-actions">
      <button type="button" className="button secondary" disabled={busy} onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
      {!result ? <button type="button" className="button primary" disabled={busy || !plan || !destination} onClick={() => void runExport()}>{exporting ? 'Exporting…' : 'Export a copy'}</button> : null}
    </div>
  </Modal>;
}
