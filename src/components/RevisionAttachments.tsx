import type { IdentityReview } from '../engine/component-identity';
import { prepareComponentRecord } from '../engine/component-identity';
import type { PendingReferenceAttachment, ReferenceLinkInput, ReferenceReview } from '../engine/references';
import type { ScanResult, VaultState } from '../engine/types';
import { formatBytes } from '../utils/format';

export interface DraftReferenceAttachment extends PendingReferenceAttachment { draftId: string }

export function RevisionAttachments({ state, scan, identityReview, review, onReview, attachments, onAttachments, busy }: {
  state: VaultState; scan: ScanResult; identityReview?: IdentityReview; review: ReferenceReview;
  onReview: (value: ReferenceReview) => void;
  attachments: DraftReferenceAttachment[]; onAttachments: (value: DraftReferenceAttachment[]) => void; busy: boolean;
}) {
  let files: { path: string; componentId: string }[] = [];
  try { files = prepareComponentRecord(state, scan, identityReview)?.files ?? []; }
  catch { /* The Changes view displays the blocking identity issue. */ }
  const baselineIds = new Set((state.components?.revisions[scan.baselineRevisionId ?? '']?.files ?? []).map(f => f.componentId));
  const options = files.map(file => ({ value: baselineIds.has(file.componentId) ? `id:${file.componentId}` : `path:${file.path}`, label: file.path }));
  const fields = (name: string, value: Pick<ReferenceLinkInput, 'explanation' | 'component'>, update: (change: Pick<ReferenceLinkInput, 'explanation' | 'component'>) => void) => {
    const selected = value.component?.kind === 'existing' ? `id:${value.component.componentId}` : value.component?.kind === 'pending' ? `path:${value.component.path}` : '';
    return <>
      <label className="field"><span>Applies to</span><select aria-label={`Applies to ${name}`} value={selected} onChange={event => update({ ...value, component: !event.target.value ? undefined : event.target.value.startsWith('id:') ? { kind: 'existing', componentId: event.target.value.slice(3) } : { kind: 'pending', path: event.target.value.slice(5) } })}>
        <option value="">Whole revision</option>
        {selected && !options.some(option => option.value === selected) ? <option value={selected}>Previous file — choose again</option> : null}
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      <label className="field"><span>Reference note (optional)</span><textarea aria-label={`Reference note for ${name}`} maxLength={8000} rows={3} value={value.explanation} placeholder="How does this reference relate to the design?" onChange={event => update({ ...value, explanation: event.target.value })} /></label>
    </>;
  };
  return <div className="revision-attachments">
    <label className="field"><span>Reference files</span><input type="file" multiple disabled={busy} onChange={event => {
      const chosen = Array.from(event.currentTarget.files ?? []).map(source => ({ draftId: crypto.randomUUID(), source, explanation: '' }));
      onAttachments([...attachments, ...chosen]);
      event.currentTarget.value = '';
    }} /></label>
    <p className="muted small">Files are copied when you save the revision. Add a note and choose where each file belongs.</p>
    {attachments.map(attachment => <fieldset className="attachment-editor" key={attachment.draftId} disabled={busy}>
      <legend>{attachment.source.name}</legend><p className="muted small">{formatBytes(attachment.source.size)} · Ready to attach</p>
      {fields(attachment.source.name, attachment, change => onAttachments(attachments.map(item => item.draftId === attachment.draftId ? { ...item, ...change } : item)))}
      <button className="text-button danger" type="button" onClick={() => onAttachments(attachments.filter(item => item.draftId !== attachment.draftId))}>Remove {attachment.source.name}</button>
    </fieldset>)}
    {review.explicit.map((link, index) => {
      const reference = state.references?.library.find(item => item.referenceId === link.referenceId);
      const name = reference?.versions.find(version => version.versionId === link.versionId)?.originalFilename ?? 'Unavailable reference';
      return <fieldset className="attachment-editor" key={`${link.referenceId}:${index}`} disabled={busy}>
        <legend>{reference?.title ?? name}</legend><p className="muted small">{name} · Saved file</p>
        {fields(`${name} ${index + 1}`, link, change => onReview({ ...review, explicit: review.explicit.map((item, i) => i === index ? { ...item, ...change } : item) }))}
        {link.locator ? <p className="small">Location: {link.locator}</p> : null}
        <button className="text-button danger" type="button" onClick={() => onReview({ ...review, explicit: review.explicit.filter((_, i) => i !== index) })}>Remove from this revision</button>
      </fieldset>;
    })}
    {state.references?.library.filter(reference => !reference.removed && reference.projectVersionId).map(reference => <p className="muted small" key={reference.referenceId}>{reference.title} · Whole revision · Carried forward</p>)}
  </div>;
}
