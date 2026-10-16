import {
  constantConfigurationFromOutputs,
  constantConfigurationLimits,
  type ConstantConfiguration,
} from '@comblang/factorio';
import type { EntityPhysicalRecord } from '@comblang/compiler/entity';
import type {
  CircuitProducerNode,
  LogicalDeciderCondition,
  NativeCircuitIr,
} from '@comblang/compiler/ir';
import type { SourceSpan } from '@comblang/shared';

import { BlueprintParameterError } from '../../compiler/src/blueprint-parameters.js';

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

export interface OccupiedAutomaticNumberValue {
  readonly value: number;
  readonly path: string;
  readonly source?: SourceSpan;
}

function refuseCoverage(path: string, message: string, source?: SourceSpan): never {
  throw new BlueprintParameterError('CP1002', path, message, source);
}

function sameConstantConfiguration(
  left: ConstantConfiguration,
  right: ConstantConfiguration,
): boolean {
  if (left.isOn !== right.isOn || left.sections.length !== right.sections.length) return false;
  for (let sectionIndex = 0; sectionIndex < left.sections.length; sectionIndex += 1) {
    const leftSection = left.sections[sectionIndex]!;
    const rightSection = right.sections[sectionIndex]!;
    if (
      leftSection.active !== rightSection.active ||
      leftSection.group !== rightSection.group ||
      leftSection.multiplier !== rightSection.multiplier ||
      leftSection.filters.length !== rightSection.filters.length
    ) {
      return false;
    }
    for (let filterIndex = 0; filterIndex < leftSection.filters.length; filterIndex += 1) {
      const leftFilter = leftSection.filters[filterIndex]!;
      const rightFilter = rightSection.filters[filterIndex]!;
      if (
        leftFilter.value !== rightFilter.value ||
        leftFilter.signal.type !== rightFilter.signal.type ||
        leftFilter.signal.name !== rightFilter.signal.name ||
        leftFilter.signal.quality !== rightFilter.signal.quality
      ) {
        return false;
      }
    }
  }
  return true;
}

function validatePhysicalEntityCoverage(ir: NativeCircuitIr): void {
  const entities = ir.entities ?? [];
  const entityById = new Map<
    string,
    { readonly entity: EntityPhysicalRecord; readonly index: number }
  >();
  for (const [index, entity] of entities.entries()) {
    if (entityById.has(entity.id)) {
      refuseCoverage(
        `$.entities[${index}]`,
        'duplicate physical Entity identity makes numeric occupancy linkage ambiguous.',
        entity.provenance.source,
      );
    }
    entityById.set(entity.id, { entity, index });
  }

  const producersByEntityId = new Map<
    string,
    { readonly producer: CircuitProducerNode; readonly index: number }[]
  >();
  for (const [index, producer] of ir.producers.entries()) {
    if (producer.entityId === undefined) continue;
    const entity = entityById.get(producer.entityId);
    if (entity === undefined) {
      refuseCoverage(
        `$.producers[${index}].entityId`,
        'linked producer refers to a missing physical Entity; numeric occupancy cannot be guaranteed.',
        producer.provenance.source,
      );
    }
    const linked = producersByEntityId.get(producer.entityId) ?? [];
    linked.push({ producer, index });
    producersByEntityId.set(producer.entityId, linked);
  }

  for (const [index, entity] of entities.entries()) {
    const path = `$.entities[${index}]`;
    const linked = producersByEntityId.get(entity.id) ?? [];
    if (linked.length === 0) {
      refuseCoverage(
        path,
        'unlinked physical Entity is outside the typed numeric occupancy census.',
        entity.provenance.source,
      );
    }
    if (linked.length !== 1) {
      refuseCoverage(
        path,
        'physical Entity is linked to more than one producer; numeric occupancy is ambiguous.',
        entity.provenance.source,
      );
    }

    const { producer, index: producerIndex } = linked[0]!;
    if (entity.configuration?.mode !== producer.kind) {
      refuseCoverage(
        `${path}.configuration`,
        `linked ${producer.kind} producer requires matching typed ${producer.kind} Entity configuration; raw, generic typed, missing, and family-mismatched configurations are unsupported.`,
        entity.provenance.source ?? producer.provenance.source,
      );
    }

    // The canonical NCIR resolver verifies exact family-config correspondence. Constant is
    // serialized from the linked physical payload itself, so retain a local fail-closed check
    // at this census boundary as well.
    if (producer.kind === 'constant' && entity.configuration?.mode === 'constant') {
      let producerConfiguration: ConstantConfiguration;
      try {
        producerConfiguration =
          producer.config.configuration ??
          constantConfigurationFromOutputs(producer.config.outputs);
      } catch (error) {
        refuseCoverage(
          `$.producers[${producerIndex}].config`,
          error instanceof Error
            ? `linked Constant producer configuration is not census-safe: ${error.message}`
            : 'linked Constant producer configuration is not census-safe.',
          producer.provenance.source,
        );
      }
      if (!sameConstantConfiguration(producerConfiguration, entity.configuration.value)) {
        refuseCoverage(
          `${path}.configuration`,
          'linked Constant physical values differ from the producer configuration used by the occupancy census.',
          entity.provenance.source ?? producer.provenance.source,
        );
      }
    }
  }
}

function canonicalInt32(value: number, path: string, source?: SourceSpan): number {
  if (!Number.isSafeInteger(value) || value < INT32_MIN || value > INT32_MAX) {
    refuseCoverage(
      path,
      'numeric producer value is not a signed int32 configuration value.',
      source,
    );
  }
  return value === 0 ? 0 : value;
}

/** Enumerates only typed native numeric replacement roles from canonical NCIR. */
export function collectOccupiedAutomaticNumberValues(
  ir: NativeCircuitIr,
): readonly OccupiedAutomaticNumberValue[] {
  validatePhysicalEntityCoverage(ir);

  const occurrences: OccupiedAutomaticNumberValue[] = [];
  const add = (value: number, path: string, source?: SourceSpan) => {
    const occurrence = {
      value: canonicalInt32(value, path, source),
      path,
      ...(source === undefined ? {} : { source }),
    };
    occurrences.push(Object.freeze(occurrence));
  };

  const visitDeciderCondition = (
    condition: LogicalDeciderCondition,
    path: string,
    source?: SourceSpan,
  ): void => {
    if (condition.kind === 'compare') {
      if (condition.right.kind === 'constant') {
        add(condition.right.value, `${path}.right.value`, source);
      }
      return;
    }
    condition.conditions.forEach((child, index) =>
      visitDeciderCondition(child, `${path}.conditions[${index}]`, source),
    );
  };

  ir.producers.forEach((producer, producerIndex) => {
    const path = `$.producers[${producerIndex}].config`;
    const source = producer.provenance.source;
    switch (producer.kind) {
      case 'arithmetic':
        if (producer.config.left.kind === 'constant') {
          add(producer.config.left.value, `${path}.left.value`, source);
        }
        if (producer.config.right.kind === 'constant') {
          add(producer.config.right.value, `${path}.right.value`, source);
        }
        break;
      case 'constant':
        if (producer.config.configuration === undefined) {
          // Legacy rows still project through a canonical section, whose implicit
          // multiplier occupies a native numeric field. Its source origin is the
          // whole legacy config, not a nonexistent configuration.sections path.
          for (const section of constantConfigurationFromOutputs(producer.config.outputs)
            .sections) {
            add(section.multiplier, path, source);
          }
          producer.config.outputs.forEach((output, outputIndex) =>
            add(output.value, `${path}.outputs[${outputIndex}].value`, source),
          );
          break;
        }
        producer.config.configuration.sections.forEach((section, sectionIndex) => {
          const sectionPath = `${path}.configuration.sections[${sectionIndex}]`;
          const multiplier = section.multiplier;
          if (
            Number.isSafeInteger(multiplier) &&
            multiplier >= INT32_MIN &&
            multiplier <= INT32_MAX
          ) {
            add(multiplier, `${sectionPath}.multiplier`, source);
          }
          section.filters.forEach((filter, filterIndex) =>
            add(filter.value, `${sectionPath}.filters[${filterIndex}].value`, source),
          );
        });
        break;
      case 'decider':
        visitDeciderCondition(producer.config.condition, `${path}.condition`, source);
        producer.config.outputs.forEach((output, outputIndex) => {
          if (output.mode === 'constant') {
            add(output.value, `${path}.outputs[${outputIndex}].value`, source);
          }
        });
        producer.config.elseOutputs?.forEach((output, outputIndex) => {
          if (output.mode === 'constant') {
            add(output.value, `${path}.elseOutputs[${outputIndex}].value`, source);
          }
        });
        break;
      case 'selector':
        if (producer.config.operation === 'select' && typeof producer.config.index === 'number') {
          add(producer.config.index, `${path}.index`, source);
        }
        break;
    }
  });

  return Object.freeze(occurrences);
}

function reservationInt32(value: number, index: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`reservedValues[${index}] must be a finite safe integer.`);
  }
  if (value < INT32_MIN || value > INT32_MAX) {
    throw new RangeError(`reservedValues[${index}] must be a signed int32 value.`);
  }
  return value === 0 ? 0 : value;
}

/** Selects deterministic unreserved signed-int32 defaults without scanning the domain. */
export function selectAutomaticNumberDefaults(
  reservedValues: readonly number[],
  count: number,
): readonly number[] {
  if (!Array.isArray(reservedValues)) {
    throw new TypeError('reservedValues must be an array of signed int32 values.');
  }
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError('count must be a nonnegative safe integer.');
  }

  const reserved = new Set<number>();
  reservedValues.forEach((value, index) => reserved.add(reservationInt32(value, index)));
  if (count > constantConfigurationLimits.maxNodes) {
    throw new RangeError(
      `requested defaults exceed the output budget of ${constantConfigurationLimits.maxNodes}.`,
    );
  }
  if (count === 0) return Object.freeze([]);

  const positiveReservations = [...reserved].filter((value) => value > 0).sort((a, b) => a - b);
  const negativeSteps = [...reserved]
    .filter((value) => value < 0)
    .map((value) => -value)
    .sort((a, b) => a - b);
  const selected: number[] = [];

  let positiveIndex = 0;
  let positiveCandidate = 1;
  while (selected.length < count && positiveCandidate <= INT32_MAX) {
    while (
      positiveIndex < positiveReservations.length &&
      positiveReservations[positiveIndex]! < positiveCandidate
    ) {
      positiveIndex += 1;
    }
    if (positiveReservations[positiveIndex] === positiveCandidate) {
      positiveIndex += 1;
      positiveCandidate += 1;
      continue;
    }
    selected.push(positiveCandidate);
    positiveCandidate += 1;
  }

  let negativeIndex = 0;
  let negativeStep = 1;
  while (selected.length < count && negativeStep <= -INT32_MIN) {
    while (negativeIndex < negativeSteps.length && negativeSteps[negativeIndex]! < negativeStep) {
      negativeIndex += 1;
    }
    if (negativeSteps[negativeIndex] === negativeStep) {
      negativeIndex += 1;
      negativeStep += 1;
      continue;
    }
    selected.push(-negativeStep);
    negativeStep += 1;
  }

  if (selected.length !== count) {
    throw new RangeError(
      'not enough unused signed int32 values remain for the requested defaults.',
    );
  }
  return Object.freeze(selected);
}
