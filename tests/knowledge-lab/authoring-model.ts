import type { VaultState } from '../../src/engine/types';
import { buildKnowledgeIndex } from '../../src/knowledge';
import { defaultKnowledgeSchemas, type KnowledgeSchemaRegistry, type JsonObject, type KnowledgeRelationshipInput, type KnowledgeTarget } from '../../src/knowledge/records';
import { resolveRelationships } from '../../src/knowledge/records/relationships';

export interface PropertyDraft { property: string; before: string; after: string; unit: string }
export interface RecordDraft {
  schema: 'cad.design-change' | 'generic.observation';
  problem: string; change: string; status: 'proposed' | 'implemented'; rationale: string;
  properties: PropertyDraft[]; assumptions: string; observations: string;
  description: string; attributes: string;
}
export const newDraft = (): RecordDraft => ({ schema: 'cad.design-change', problem: '', change: '', status: 'proposed', rationale: '', properties: [], assumptions: '', observations: '', description: '', attributes: '' });

/** Check original number tokens, skipping quoted strings and their escapes.
 * Decimal digits and an exact exponent establish the range before Number conversion.
 * This bounds numeric magnitude; it does not guarantee exact floating-point decimals. */
function assertSafeJsonNumbers(text: string, label: string) {
  const number = /-?(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?/y;
  const limit = '9007199254740991';
  for (let i = 0; i < text.length;) {
    if (text[i] === '"') {
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') { i++; break; }
      }
      continue;
    }
    number.lastIndex = i;
    const token = number.exec(text);
    if (!token) { i++; continue; }
    i = number.lastIndex;
    const fraction = token[2] ?? '';
    const digits = (token[1] + fraction).replace(/^0+/, '');
    if (!digits) continue;
    const integerDigits = BigInt(digits.length) + BigInt(token[3] ?? '0') - BigInt(fraction.length);
    if (integerDigits < 16n) continue;
    const leading = digits.slice(0, 16).padEnd(16, '0');
    if (integerDigits > 16n || leading > limit || (leading === limit && /[1-9]/.test(digits.slice(16)))) {
      throw new Error(`${label} contains a number outside the supported safe-integer range (-${limit} to ${limit}). Use finite numbers within that range, and enter large integer identifiers as quoted strings.`);
    }
  }
}

function json(text: string, label: string) {
  assertSafeJsonNumbers(text, label);
  try { return JSON.parse(text); } catch { throw new Error(`${label} must be valid JSON. Use a number such as 6 or a quoted string such as "steel".`); }
}

export function payloadFromDraft(draft: RecordDraft): JsonObject {
  const payload: JsonObject = draft.schema === 'generic.observation'
    ? { description: draft.description, ...(draft.attributes !== '' ? { attributes: json(draft.attributes, 'Attributes') } : {}) }
    : {
      problem: draft.problem, change: { status: draft.status, description: draft.change }, rationale: draft.rationale,
      ...(draft.properties.length ? { propertyChanges: draft.properties.map((p, i) => ({ property: p.property, before: json(p.before, `Property ${i + 1} before value`), after: json(p.after, `Property ${i + 1} after value`), ...(p.unit !== '' ? { unit: p.unit } : {}) })) } : {}),
      ...(draft.assumptions !== '' ? { assumptions: [draft.assumptions] } : {}),
      ...(draft.observations !== '' ? { observations: [draft.observations] } : {}),
    };
  const schemas: KnowledgeSchemaRegistry = defaultKnowledgeSchemas;
  schemas.validate(draft.schema, 1, payload);
  return payload;
}

export interface TargetOption { key: string; label: string; target: KnowledgeTarget; unavailable?: string }

/** Eligibility is delegated to M1B-1's validator, including project/branch/identity checks. */
export function authoringTargets(state: VaultState, revisionId: string) {
  const index = buildKnowledgeIndex(state);
  const accepted = new Map(index.persistedRecords.map(r => [r.record.recordId, r]));
  const option = (label: string, target: KnowledgeTarget): TargetOption => {
    try {
      resolveRelationships([{ relation: 'context', target }], state, accepted, 'new-editor-record');
      return { key: JSON.stringify(target), label, target };
    } catch (error) { return { key: JSON.stringify(target), label, target, unavailable: error instanceof Error ? error.message : String(error) }; }
  };
  const projectId = state.project.projectId;
  const revision = index.revisions.find(r => r.revisionId === revisionId);
  const revisions = index.revisions.map(r => {
    const manifest = state.revisions.find(s => s.manifest.revisionId === r.revisionId)?.manifest;
    const branch = state.branches.find(b => b.branchId === r.branchId);
    return option(`${manifest ? `R${String(manifest.displayNumber).padStart(2, '0')}` : r.revisionId} · ${branch?.name ?? r.branchId} · ${manifest?.summary ?? ''} · ${r.revisionId}`, { kind: 'revision', projectId, revisionId: r.revisionId });
  });
  const components = (state.components?.revisions[revisionId]?.files ?? []).map(c => option(`${c.path} · ${c.componentId}`, { kind: 'component', projectId, revisionId, componentId: c.componentId }));
  const references = (revision?.referenceContext.attachments ?? []).map(a => option(`${a.originalFilename} · ${a.versionId} · ${a.locator || 'No locator'} · ${a.componentPath ?? a.scope}`, {
    kind: 'reference-version', projectId, revisionId, referenceId: a.referenceId, versionId: a.versionId, associationPointer: a.source.jsonPointer,
  }));
  const records = index.persistedRecords.map(r => {
    const summary = r.record.payload.description ?? r.record.payload.problem;
    return option(`${typeof summary === 'string' ? summary.slice(0, 80) : r.record.recordType} · ${r.record.recordType}.v${r.record.schemaVersion} · ${r.record.recordId}`, { kind: 'record', projectId, recordId: r.record.recordId });
  });
  const context = revision?.referenceContext.availability;
  return {
    revisions, components, references, records,
    componentReason: !revisionId ? 'Select a verified historical revision first.' : state.components?.status !== 'available' ? state.components?.reason ?? 'Verified component identity evidence is unavailable or not recorded.' : !components.length ? 'No verified component mapping is recorded at this revision.' : '',
    referenceReason: !revisionId ? 'Select a verified historical revision first.' : context?.status !== 'available' ? (context && 'reason' in context ? context.reason : 'Reference context is unavailable.') : !references.length ? 'This revision has no captured reference associations.' : '',
    diagnostics: index.persistedDiagnostics,
  };
}

export function selectedRelationships(state: VaultState, revisionKey: string, componentKey: string, referenceKey: string, recordKey: string, referenceRelation: 'context' | 'evidence'): KnowledgeRelationshipInput[] {
  const revisions = authoringTargets(state, '').revisions;
  const revision = revisions.find(o => o.key === revisionKey);
  const revisionId = revision?.target.kind === 'revision' ? revision.target.revisionId : '';
  const targets = authoringTargets(state, revisionId);
  const result: KnowledgeRelationshipInput[] = [];
  for (const [key, options, relation] of [
    [revisionKey, revisions, 'context'], [componentKey, targets.components, 'related'],
    [referenceKey, targets.references, referenceRelation], [recordKey, targets.records, 'related'],
  ] as const) {
    if (!key) continue;
    const target = options.find(o => o.key === key);
    if (!target || target.unavailable) throw new Error('A selected relationship is no longer available. Reload and select a verified target.');
    result.push({ relation, target: target.target });
  }
  return result;
}
