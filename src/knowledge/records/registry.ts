import { canonicalJson, nonblank, object, shape } from './json';
import type { CadDesignChangePayload, GenericObservationPayload, JsonObject } from './types';

export class UnsupportedKnowledgeSchemaError extends Error {
  constructor(recordType: string, version: number) {
    super(`Unsupported knowledge payload schema: ${recordType}.v${version}.`);
    this.name = 'UnsupportedKnowledgeSchemaError';
  }
}

export type PayloadValidator<T extends JsonObject = JsonObject> = (payload: unknown) => payload is T;

export class KnowledgeSchemaRegistry {
  private readonly validators = new Map<string, PayloadValidator>();

  register<T extends JsonObject>(recordType: string, version: number, validator: PayloadValidator<T>): this {
    if (typeof recordType !== 'string' || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(recordType) || !Number.isSafeInteger(version) || version < 1 || typeof validator !== 'function') throw new Error('Invalid knowledge schema registration.');
    const key = JSON.stringify([recordType, version]);
    if (this.validators.has(key)) throw new Error('A registered knowledge schema cannot be overwritten. Introduce a new schema version.');
    this.validators.set(key, validator);
    return this;
  }

  validate(recordType: string, version: number, payload: unknown): asserts payload is JsonObject {
    const validator = this.validators.get(JSON.stringify([recordType, version]));
    if (!validator) throw new UnsupportedKnowledgeSchemaError(recordType, version);
    // Validators see a disposable copy, cannot normalize/mutate persisted user content.
    const json = canonicalJson(payload);
    if (!object(payload) || validator(JSON.parse(json)) !== true) throw new Error(`Invalid payload for ${recordType}.v${version}.`);
  }
}

const strings = (value: unknown) => Array.isArray(value) && value.every(nonblank);

export const validateCadDesignChange: PayloadValidator<CadDesignChangePayload> = (payload): payload is CadDesignChangePayload => {
  if (!shape(payload, ['problem', 'change', 'rationale'], ['propertyChanges', 'assumptions', 'observations']) || !nonblank(payload.problem) || !nonblank(payload.rationale)) return false;
  if (!shape(payload.change, ['status', 'description']) || (payload.change.status !== 'proposed' && payload.change.status !== 'implemented') || !nonblank(payload.change.description)) return false;
  if (Object.hasOwn(payload, 'assumptions') && !strings(payload.assumptions)) return false;
  if (Object.hasOwn(payload, 'observations') && !strings(payload.observations)) return false;
  return !Object.hasOwn(payload, 'propertyChanges') || (Array.isArray(payload.propertyChanges) && payload.propertyChanges.every(p =>
    shape(p, ['property', 'before', 'after'], ['unit']) && nonblank(p.property) && (!Object.hasOwn(p, 'unit') || nonblank(p.unit))));
};

export const validateGenericObservation: PayloadValidator<GenericObservationPayload> = (payload): payload is GenericObservationPayload =>
  shape(payload, ['description'], ['attributes']) && nonblank(payload.description) &&
  (!Object.hasOwn(payload, 'attributes') || object(payload.attributes));

export function createKnowledgeSchemaRegistry() {
  return new KnowledgeSchemaRegistry()
    .register('cad.design-change', 1, validateCadDesignChange)
    .register('generic.observation', 1, validateGenericObservation);
}

export const defaultKnowledgeSchemas = createKnowledgeSchemaRegistry();
