import { constantConfigurationLimits } from '@comblang/factorio';
import type { NetworkId, ProducerId, SourceSpan } from '@comblang/shared';
import type { CircuitProducerNode } from '@comblang/compiler/ir';

import {
  inspectBlueprintConfigurationSet,
  createBlueprintConfigurationSet,
  type BlueprintConfigurationSetEntry,
} from '../../compiler/src/blueprint-configuration-set.js';
import {
  createArithmeticConfigurationTemplate,
  inspectArithmeticConfigurationTemplate,
  type ArithmeticConfigurationTemplate,
  type ArithmeticTemplateOperand,
} from '../../compiler/src/arithmetic-configuration-template.js';
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
import type { ExecutedElaborationWithBlueprintParameters } from './elaboration-program.js';
import { executedDirectPlanMatchesPlan } from './executed-direct-plan-pairing.js';

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

function isDataRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable;
  });
}

function hasExactDataKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function sameSourceSpan(left: unknown, right: unknown): boolean {
  if (!isDataRecord(left) || !isDataRecord(right)) return false;
  return left.fileId === right.fileId && left.start === right.start && left.end === right.end;
}

function stableData(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableData).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableData(record[key])}`)
    .join(',')}}`;
}

function producerCapturesFor(execution: ExecutedDirectPlan, captureId: string) {
  return execution.debug.scopes.flatMap((scope) =>
    scope.producers.filter((entry) => entry.descriptor.debugCaptureIds?.includes(captureId)),
  );
}

function resolveCapturedNetwork(
  sourcePlan: ExecutedElaborationWithBlueprintParameters['plan'],
  execution: ExecutedDirectPlan,
  name: string,
  path: string,
  source: SourceSpan,
): NetworkId {
  const declarations = sourcePlan.networks.filter((network) => network.name === name);
  const debugEntries = execution.debug.scopes.flatMap((scope) =>
    scope.networks.filter((entry) => entry.planName === name),
  );
  const debugIds = new Set(debugEntries.map(({ id }) => id));
  if (declarations.length !== 1 || debugEntries.length === 0 || debugIds.size !== 1) {
    fail(
      'CP1001',
      path,
      `Network ${JSON.stringify(name)} must resolve to one declaration and one physical debug Network ID; found ${declarations.length} declarations and ${debugIds.size} IDs.`,
      source,
    );
  }
  // Ownership may move after the producer is created; its recorded input still
  // refers to the same physical Network. A moved source alias is not a missing ID.
  const debugId = debugEntries[0]!.id;
  const physicalNetworks = execution.circuit.ir.networks.filter(({ id }) => id === debugId);
  if (physicalNetworks.length !== 1) {
    fail(
      'CP1001',
      path,
      `Network ${JSON.stringify(name)} does not identify exactly one NCIR Network.`,
      source,
    );
  }
  return debugId;
}

function resolveCapturedOperand(
  operand: ArithmeticTemplateOperand,
  sourcePlan: ExecutedElaborationWithBlueprintParameters['plan'],
  execution: ExecutedDirectPlan,
  path: string,
  source: SourceSpan,
): ArithmeticTemplateOperand {
  if (operand.kind === 'constant') return operand;
  if (operand.refKind === 'single') {
    return {
      ...operand,
      network: resolveCapturedNetwork(
        sourcePlan,
        execution,
        operand.network,
        `${path}.network`,
        source,
      ),
    };
  }
  if (operand.refKind === 'pair') {
    return {
      ...operand,
      networks: Object.freeze([
        resolveCapturedNetwork(
          sourcePlan,
          execution,
          operand.networks[0],
          `${path}.networks[0]`,
          source,
        ),
        resolveCapturedNetwork(
          sourcePlan,
          execution,
          operand.networks[1],
          `${path}.networks[1]`,
          source,
        ),
      ]) as readonly [NetworkId, NetworkId],
    };
  }
  return fail('CP1000', `${path}.refKind`, 'expected a single or pair Network reference.', source);
}

/** Converts source-captured Arithmetic templates to one atomic, execution-paired NCIR replacement. */
export function bindCapturedSourceArithmeticTemplates(
  source: ExecutedElaborationWithBlueprintParameters,
  execution: ExecutedDirectPlan,
  bindingsValue: readonly BlueprintParameterBinding[] = [],
) {
  if (!isDataRecord(source) || !Array.isArray(source.arithmeticTemplates)) {
    fail('CP1000', '$.source', 'expected a source execution with captured Arithmetic templates.');
  }
  if (!executedDirectPlanMatchesPlan(execution, source.plan)) {
    fail(
      'CP1001',
      '$.execution',
      'canonical execution was not created from this exact source Direct Plan.',
    );
  }
  if (execution.circuit.ir.format !== 'comblang-ncir') {
    fail('CP1001', '$.execution.circuit.ir', 'expected a canonical NCIR execution.');
  }

  const planProducerByCapture = new Map<
    string,
    { index: number; descriptor: (typeof source.plan.producers)[number] }
  >();
  source.plan.producers.forEach((descriptor, index) => {
    for (const captureId of descriptor.debugCaptureIds ?? []) {
      if (planProducerByCapture.has(captureId)) {
        planProducerByCapture.set(captureId, { index: -1, descriptor });
      } else {
        planProducerByCapture.set(captureId, { index, descriptor });
      }
    }
  });

  const seenCaptures = new Set<string>();
  const captures = source.arithmeticTemplates.map((candidate, index) => {
    const path = `$.arithmeticTemplates[${index}]`;
    if (
      !isDataRecord(candidate) ||
      !hasExactDataKeys(candidate, ['captureId', 'template', 'source'])
    ) {
      fail('CP1000', path, 'malformed captured Arithmetic template.');
    }
    const captureId = candidate.captureId;
    if (typeof captureId !== 'string' || captureId.length === 0 || captureId.length > 128) {
      fail('CP1000', `${path}.captureId`, 'expected a non-empty bounded Producer capture ID.');
    }
    if (seenCaptures.has(captureId)) {
      fail(
        'CP1001',
        `${path}.captureId`,
        'Arithmetic capture IDs must be unique.',
        candidate.source as SourceSpan,
      );
    }
    seenCaptures.add(captureId);

    const planProducer = planProducerByCapture.get(captureId);
    if (
      planProducer === undefined ||
      planProducer.index < 0 ||
      planProducer.descriptor.kind !== 'arithmetic'
    ) {
      fail(
        'CP1001',
        `${path}.captureId`,
        'capture must identify exactly one source Arithmetic Producer.',
        candidate.source as SourceSpan,
      );
    }
    const debugEntries = producerCapturesFor(execution, captureId);
    if (
      debugEntries.length !== 1 ||
      debugEntries[0]!.producerKind !== 'arithmetic' ||
      stableData(debugEntries[0]!.descriptor) !== stableData(planProducer.descriptor)
    ) {
      fail(
        'CP1001',
        `${path}.captureId`,
        'capture does not identify exactly one matching physical Arithmetic Producer.',
        candidate.source as SourceSpan,
      );
    }
    const debugEntry = debugEntries[0]!;
    if (!sameSourceSpan(candidate.source, planProducer.descriptor.source)) {
      fail(
        'CP1001',
        `${path}.source`,
        'captured provenance does not match its source Arithmetic Producer.',
        planProducer.descriptor.source,
      );
    }
    const registration = inspectArithmeticConfigurationTemplate(
      candidate.template,
      `${path}.template`,
    );
    if (registration.session !== source.session) {
      fail(
        'CP1001',
        `${path}.template`,
        'captured template belongs to a different parameter session.',
        candidate.source as SourceSpan,
      );
    }
    const captureReference = createExecutedProducerCaptureReference(execution, captureId);
    const template = candidate.template as ArithmeticConfigurationTemplate;
    const resolvedTemplate = createArithmeticConfigurationTemplate(source.session, {
      left: resolveCapturedOperand(
        template.left,
        source.plan,
        execution,
        `${path}.template.left`,
        candidate.source as SourceSpan,
      ),
      operation: template.operation,
      right: resolveCapturedOperand(
        template.right,
        source.plan,
        execution,
        `${path}.template.right`,
        candidate.source as SourceSpan,
      ),
      output: template.output,
    });
    return {
      index: planProducer.index,
      entry: {
        key: captureId,
        kind: 'arithmetic' as const,
        template: resolvedTemplate,
      },
      capture: { key: captureId, captureId: captureReference },
      producerId: debugEntry.id,
    };
  });

  captures.sort((left, right) => left.index - right.index);
  const seenProducerIds = new Set<ProducerId>();
  for (const capture of captures) {
    if (seenProducerIds.has(capture.producerId)) {
      fail(
        'CP1001',
        '$.arithmeticTemplates',
        'multiple templates identify the same physical Producer.',
      );
    }
    seenProducerIds.add(capture.producerId);
  }
  const configurationSet = createBlueprintConfigurationSet(
    source.session,
    captures.map(({ entry }) => entry),
  );
  return bindExecutedPlanConfigurationSet(
    execution,
    configurationSet,
    captures.map(({ capture }) => capture),
    bindingsValue,
  );
}
