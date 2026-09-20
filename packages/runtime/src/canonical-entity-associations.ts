import type {
  DirectElaborationPlan,
  DirectPlanProducer,
} from '@comblang/compiler/direct-plan-schema';
import type { EntityId, EntityPlanRecord } from '@comblang/compiler/entity';
import { constantConfigurationFromOutputs } from '@comblang/factorio';
import {
  resolveEntityReplayProfile,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';

type EntityFamily =
  'constant-combinator' | 'arithmetic-combinator' | 'decider-combinator' | 'selector-combinator';
type ProducerKind = 'constant' | 'arithmetic' | 'decider' | 'selector';

const producerFamilies: Readonly<Record<ProducerKind, EntityFamily>> = {
  constant: 'constant-combinator',
  arithmetic: 'arithmetic-combinator',
  decider: 'decider-combinator',
  selector: 'selector-combinator',
};

export class CanonicalEntityAssociationError extends Error {
  readonly code = 'RT7100';

  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = 'CanonicalEntityAssociationError';
  }
}

export interface CanonicalEntityAssociations {
  readonly entities: ReadonlyMap<EntityId, EntityPlanRecord>;
  readonly linked: ReadonlyMap<EntityId, number>;
  readonly selectorLinks: readonly (readonly [EntityId, number])[];
}

function invalid(path: string, detail: string): never {
  throw new CanonicalEntityAssociationError(path, detail);
}

function producerFamily(kind: string): EntityFamily | undefined {
  return Object.hasOwn(producerFamilies, kind) ? producerFamilies[kind as ProducerKind] : undefined;
}

function configurationFamily(mode: unknown): EntityFamily | undefined {
  if (mode === 'constant' || mode === 'arithmetic' || mode === 'decider' || mode === 'selector')
    return `${mode}-combinator` as EntityFamily;
  return undefined;
}

function stableJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) throw new TypeError('cyclic canonical Decider data.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry, seen)).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key], seen)}`)
      .join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function validateDeciderOrigins(
  producer: Extract<DirectPlanProducer, { readonly kind: 'decider' }>,
  index: number,
): void {
  const path = `$.producers[${index}]`;
  if (!Array.isArray(producer.outputs))
    invalid(`${path}.outputs`, 'linked Entity Decider outputs are required.');
  if (!Array.isArray(producer.outputOrigins))
    invalid(`${path}.outputOrigins`, 'linked Entity Decider output origins are required.');
  if (producer.outputs.length === 0 && (producer.elseOutputs?.length ?? 0) === 0)
    invalid(`${path}.outputs`, 'a linked Entity Decider must contain at least one output row.');
  if (producer.outputOrigins.length !== producer.outputs.length)
    invalid(`${path}.outputOrigins`, 'Decider output origins must align with output rows.');
  producer.outputOrigins.forEach((origin, ordinal) => {
    if (origin.branch !== 'normal' || origin.ordinal !== ordinal)
      invalid(
        `${path}.outputOrigins[${ordinal}]`,
        'Decider output origins must use dense normal ordinals.',
      );
  });
  if (producer.elseOutputs === undefined) {
    if (producer.elseOutputOrigins !== undefined)
      invalid(`${path}.elseOutputOrigins`, 'else output origins require else outputs.');
  } else {
    if (producer.elseOutputs.length === 0)
      invalid(`${path}.elseOutputs`, 'empty elseOutputs must be omitted.');
    if (!Array.isArray(producer.elseOutputOrigins))
      invalid(`${path}.elseOutputOrigins`, 'else output origins are required.');
    if (producer.elseOutputOrigins.length !== producer.elseOutputs.length)
      invalid(`${path}.elseOutputOrigins`, 'Decider output origins must align with else rows.');
    producer.elseOutputOrigins.forEach((origin, ordinal) => {
      if (origin.branch !== 'else' || origin.ordinal !== ordinal)
        invalid(
          `${path}.elseOutputOrigins[${ordinal}]`,
          'Decider output origins must use dense else ordinals.',
        );
    });
  }
  const expected = producer.outputs.length > 0 ? producer.outputs[0] : producer.elseOutputs![0];
  if (stableJson(producer.output) !== stableJson(expected))
    invalid(`${path}.output`, 'Decider output must equal the first canonical branch row.');
}

function expectedEntityConfiguration(producer: DirectPlanProducer): unknown {
  if (producer.kind === 'constant') {
    return {
      mode: 'constant',
      value: producer.configuration ?? constantConfigurationFromOutputs(producer.outputs),
    };
  }
  if (producer.kind === 'arithmetic') {
    return {
      mode: 'arithmetic',
      left: producer.left,
      operation: producer.operation,
      right: producer.right,
      output: producer.output,
    };
  }
  if (producer.kind === 'decider') {
    return {
      mode: 'decider',
      condition: producer.condition,
      outputs: producer.outputs ?? [producer.output],
      ...(producer.elseOutputs === undefined ? {} : { elseOutputs: producer.elseOutputs }),
    };
  }
  return producer.operation === 'select'
    ? {
        mode: 'selector',
        operation: 'select',
        input: producer.input,
        selectMax: producer.selectMax,
        index: producer.index,
      }
    : {
        mode: 'selector',
        operation: 'count',
        input: producer.input,
        output: producer.output,
      };
}

/** Validates the canonical Entity-to-producer boundary before allocation. */
export function validateCanonicalEntityAssociations(
  plan: DirectElaborationPlan,
  context: TrustedEntityReplayContext,
): CanonicalEntityAssociations {
  const entities = new Map<EntityId, EntityPlanRecord>();
  for (const [index, entity] of plan.entities.entries()) {
    if (entity === null || typeof entity !== 'object' || typeof entity.id !== 'string')
      invalid(`$.entities[${index}]`, 'Entity records require a string id.');
    if (entities.has(entity.id as EntityId))
      invalid(`$.entities[${index}].id`, 'Entity IDs must be unique.');
    entities.set(entity.id as EntityId, entity);
  }

  const linked = new Map<EntityId, number>();
  for (const [index, producer] of plan.producers.entries()) {
    if (producer === null || typeof producer !== 'object')
      invalid(`$.producers[${index}]`, 'Producer must be a record.');
    const entityId = producer.entityId;
    if (entityId === undefined) continue;
    if (typeof entityId !== 'string')
      invalid(`$.producers[${index}].entityId`, 'linked Entity IDs must be strings.');
    if (linked.has(entityId as EntityId))
      invalid(`$.producers[${index}].entityId`, 'an Entity may have only one linked producer.');
    if (!entities.has(entityId as EntityId))
      invalid(`$.producers[${index}].entityId`, 'linked Entity does not exist.');
    if (producer.placement !== undefined)
      invalid(`$.producers[${index}].placement`, 'a linked producer must omit placement.');

    const entity = entities.get(entityId as EntityId)!;
    const family = producerFamily(producer.kind);
    if (family === undefined)
      invalid(`$.producers[${index}].kind`, 'linked producer has an unknown family.');
    const profile = resolveEntityReplayProfile(entity.profile, context);
    if (profile.prototypeType !== family)
      invalid(
        `$.entities[${entityId}].profile`,
        `linked Entity profile must identify the ${family} family (got ${JSON.stringify(profile.prototypeType)} for ${profile.ref.prototypeKey}).`,
      );
    if (profile.ref.prototypeKey !== `entity:${family}`)
      invalid(
        `$.entities[${entityId}].profile`,
        `linked Entity profile must use the exact entity:${family} base key.`,
      );
    if (
      family === 'selector-combinator' &&
      profile.ref.prototypeKey !== 'entity:selector-combinator'
    )
      invalid(
        `$.entities[${entityId}].profile`,
        'linked Selector Entity profile must use the exact entity:selector-combinator base key.',
      );

    const configuredFamily = configurationFamily(entity.configuration?.mode);
    if (configuredFamily === undefined)
      invalid(
        `$.entities[${entityId}].configuration`,
        'linked Entity must declare a supported combinator configuration.',
      );
    if (configuredFamily !== family)
      invalid(
        `$.entities[${entityId}].configuration`,
        'linked Entity configuration family does not match its producer.',
      );
    if (stableJson(entity.configuration) !== stableJson(expectedEntityConfiguration(producer)))
      invalid(
        `$.entities[${entityId}].configuration`,
        'linked Entity configuration must exactly equal its Producer configuration.',
      );
    linked.set(entityId as EntityId, index);
  }

  if ([...linked.values()].some((index) => plan.producers[index]?.kind === 'decider')) {
    plan.producers.forEach((producer, index) => {
      if (producer.kind === 'decider') validateDeciderOrigins(producer, index);
    });
  }

  for (const [index, entity] of plan.entities.entries()) {
    const family = configurationFamily(entity.configuration?.mode);
    if (family !== undefined && !linked.has(entity.id))
      invalid(
        `$.entities[${index}].configuration`,
        'configured Entity must have one linked producer in the same family.',
      );
  }

  return {
    entities,
    linked,
    selectorLinks: [...linked.entries()].filter(
      ([, index]) => plan.producers[index]?.kind === 'selector',
    ),
  };
}
