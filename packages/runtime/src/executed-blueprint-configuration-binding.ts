import { constantConfigurationLimits } from '@comblang/factorio';
import type { ProducerId, SourceSpan } from '@comblang/shared';
import type { CircuitProducerNode } from '@comblang/compiler/ir';

import {
  inspectBlueprintConfigurationSet,
  type BlueprintConfigurationSetEntry,
} from '../../compiler/src/blueprint-configuration-set.js';
import { replaceBlueprintConfigurationSetInNativeCircuitIr } from '../../compiler/src/blueprint-configuration-binding.js';
import { BlueprintParameterError } from '../../compiler/src/blueprint-parameters.js';
import {
  assertBlueprintParameterExactKeys,
  createBlueprintParameterDataBudget,
  openBlueprintParameterArray,
  openBlueprintParameterRecord,
  type BlueprintParameterBinding,
} from '../../compiler/src/blueprint-parameter-validation.js';

import type { ExecutedDirectPlan } from './direct-plan.js';
import type { DebugProducerEntry } from './debug-index.js';

declare const executedProducerCaptureBrand: unique symbol;

/** Opaque host-local reference issued for one exact ExecutedDirectPlan object. */
export interface ExecutedProducerCaptureReference {
  readonly [executedProducerCaptureBrand]: true;
}

interface CaptureReferenceRegistration {
  readonly execution: ExecutedDirectPlan;
  readonly captureId: string;
  readonly entry: DebugProducerEntry;
}

interface ResolvedCaptureAssignment {
  readonly key: string;
  readonly producerId: ProducerId;
}

const captureReferences = new WeakMap<object, CaptureReferenceRegistration>();

function fail(
  code: 'CP1000' | 'CP1001' | 'CP1002',
  path: string,
  message: string,
  span?: SourceSpan,
): never {
  throw new BlueprintParameterError(code, path, message, span);
}

function captureProvenance(entry: DebugProducerEntry): string {
  const source = `${entry.source.fileId}:${entry.source.start}-${entry.source.end}`;
  const instance = entry.instancePath.length === 0 ? '<root>' : entry.instancePath.join(' / ');
  return ` Producer provenance: ${source}, instance ${JSON.stringify(instance)}.`;
}

function debugEntriesForCapture(
  execution: ExecutedDirectPlan,
  captureId: string,
): readonly DebugProducerEntry[] {
  return execution.debug.scopes.flatMap((scope) =>
    scope.producers.filter((entry) => entry.descriptor.debugCaptureIds?.includes(captureId)),
  );
}

function physicalProducerForEntry(
  execution: ExecutedDirectPlan,
  entry: DebugProducerEntry,
  path: string,
): CircuitProducerNode {
  const matches = execution.circuit.ir.producers.filter((producer) => producer.id === entry.id);
  if (matches.length !== 1) {
    fail(
      'CP1001',
      path,
      `capture does not resolve to exactly one Producer in this execution's NCIR.${captureProvenance(entry)}`,
      entry.source,
    );
  }
  const producer = matches[0]!;
  if (producer.kind !== entry.producerKind) {
    fail(
      'CP1001',
      path,
      `debug capture kind ${entry.producerKind} does not match NCIR Producer kind ${producer.kind}.${captureProvenance(entry)}`,
      entry.source,
    );
  }
  return producer;
}

/** Creates an unforgeable, execution-scoped reference using only the executed debug mapping. */
export function createExecutedProducerCaptureReference(
  execution: ExecutedDirectPlan,
  captureId: string,
): ExecutedProducerCaptureReference {
  const path = '$.captures.captureId';
  if (typeof captureId !== 'string' || captureId.length === 0 || captureId.length > 128) {
    fail('CP1000', path, 'expected a non-empty bounded debug capture ID.');
  }
  const entries = debugEntriesForCapture(execution, captureId);
  if (entries.length !== 1) {
    const entry = entries[0];
    fail(
      'CP1001',
      path,
      `expected exactly one Producer debug capture in this execution; found ${entries.length}.${entry === undefined ? '' : captureProvenance(entry)}`,
      entry?.source,
    );
  }
  const entry = entries[0]!;
  physicalProducerForEntry(execution, entry, path);
  const reference = Object.freeze(Object.create(null)) as ExecutedProducerCaptureReference;
  captureReferences.set(reference, { execution, captureId, entry });
  return reference;
}

function resolveCaptureAssignments(
  execution: ExecutedDirectPlan,
  entries: readonly BlueprintConfigurationSetEntry[],
  value: unknown,
): readonly ResolvedCaptureAssignment[] {
  const path = '$.captures';
  const budget = createBlueprintParameterDataBudget();
  const opened = openBlueprintParameterArray(value, path, 0, budget);
  try {
    if (opened.value.length > constantConfigurationLimits.maxNodes) {
      fail(
        'CP1000',
        path,
        `capture assignments exceed the node limit of ${constantConfigurationLimits.maxNodes}.`,
      );
    }
    const entryByKey = new Map(entries.map((entry) => [entry.key, entry]));
    const seenKeys = new Set<string>();
    const seenCaptureIds = new Set<string>();
    const seenProducerIds = new Set<ProducerId>();
    const resolved = opened.value.map((valueAtIndex, index) => {
      const itemPath = `${path}[${index}]`;
      const openedRecord = openBlueprintParameterRecord(valueAtIndex, itemPath, 1, budget);
      try {
        assertBlueprintParameterExactKeys(
          openedRecord.value,
          ['key', 'captureId'],
          itemPath,
          'unknown capture assignment field.',
        );
        for (const key of ['key', 'captureId'] as const) {
          if (!Object.hasOwn(openedRecord.value, key)) {
            fail('CP1000', `${itemPath}.${key}`, 'field is required.');
          }
        }

        const key = openedRecord.value.key;
        if (typeof key !== 'string' || key.trim().length === 0 || key.length > 128) {
          fail(
            'CP1000',
            `${itemPath}.key`,
            'expected a non-empty configuration key of at most 128 characters.',
          );
        }
        const configuration = entryByKey.get(key);
        if (configuration === undefined) {
          fail(
            'CP1001',
            `${itemPath}.key`,
            `unknown configuration-set key ${JSON.stringify(key)}.`,
          );
        }
        if (seenKeys.has(key)) {
          fail('CP1001', `${itemPath}.key`, 'configuration-set keys must be unique.');
        }
        seenKeys.add(key);

        const referenceValue = openedRecord.value.captureId;
        if (referenceValue === null || typeof referenceValue !== 'object') {
          fail(
            'CP1000',
            `${itemPath}.captureId`,
            'expected an execution-scoped Producer capture reference.',
          );
        }
        const reference = captureReferences.get(referenceValue);
        if (reference === undefined) {
          fail(
            'CP1000',
            `${itemPath}.captureId`,
            'expected an execution-scoped Producer capture reference.',
          );
        }
        if (reference.execution !== execution) {
          fail(
            'CP1001',
            `${itemPath}.captureId`,
            `capture reference belongs to a different ExecutedDirectPlan.${captureProvenance(reference.entry)}`,
            reference.entry.source,
          );
        }
        if (seenCaptureIds.has(reference.captureId)) {
          fail(
            'CP1001',
            `${itemPath}.captureId`,
            `Producer capture ${JSON.stringify(reference.captureId)} is assigned more than once.${captureProvenance(reference.entry)}`,
            reference.entry.source,
          );
        }
        seenCaptureIds.add(reference.captureId);

        const matches = debugEntriesForCapture(execution, reference.captureId);
        if (matches.length !== 1 || matches[0] !== reference.entry) {
          fail(
            'CP1001',
            `${itemPath}.captureId`,
            `capture no longer resolves uniquely through this execution's debug index.${captureProvenance(reference.entry)}`,
            reference.entry.source,
          );
        }
        const producer = physicalProducerForEntry(
          execution,
          reference.entry,
          `${itemPath}.captureId`,
        );
        if (producer.kind !== configuration.kind) {
          fail(
            'CP1001',
            `${itemPath}.captureId`,
            `configuration kind ${configuration.kind} does not match captured Producer kind ${producer.kind}.${captureProvenance(reference.entry)}`,
            reference.entry.source,
          );
        }
        if (seenProducerIds.has(reference.entry.id)) {
          fail(
            'CP1001',
            `${itemPath}.captureId`,
            `multiple captures assign the same physical Producer.${captureProvenance(reference.entry)}`,
            reference.entry.source,
          );
        }
        seenProducerIds.add(reference.entry.id);
        return Object.freeze({ key, producerId: reference.entry.id });
      } finally {
        openedRecord.release();
      }
    });

    const assignedKeys = new Set(resolved.map(({ key }) => key));
    for (const entry of entries) {
      if (!assignedKeys.has(entry.key)) {
        fail(
          'CP1001',
          path,
          `missing Producer capture assignment for configuration key ${JSON.stringify(entry.key)}.`,
        );
      }
    }
    return Object.freeze(resolved);
  } finally {
    opened.release();
  }
}

/** Binds a registered configuration set to Producers captured by one exact executed plan. */
export function bindExecutedPlanConfigurationSet(
  execution: ExecutedDirectPlan,
  setValue: unknown,
  capturesValue: unknown,
  bindingsValue: readonly BlueprintParameterBinding[] = [],
) {
  const registration = inspectBlueprintConfigurationSet(setValue, '$.set');
  const assignments = resolveCaptureAssignments(execution, registration.entries, capturesValue);
  return replaceBlueprintConfigurationSetInNativeCircuitIr(
    setValue,
    execution.circuit.ir,
    assignments,
    bindingsValue,
  );
}
