import type { ProducerId } from '@comblang/shared';

import {
  assertBlueprintParameterExactKeys,
  createBlueprintParameterDataBudget,
  openBlueprintParameterArray,
  openBlueprintParameterRecord,
  readBlueprintParameterBindings,
  type BlueprintParameterBinding,
} from './blueprint-parameter-validation.js';
import {
  BlueprintParameterError,
  findBlueprintParameterHandle,
  inspectBlueprintParameterHandle,
} from './blueprint-parameters.js';
import { bindArithmeticConfigurationTemplate } from './arithmetic-configuration-binding.js';
import {
  inspectArithmeticConfigurationTemplate,
  isRegisteredArithmeticNumericExpression,
} from './arithmetic-configuration-template.js';
import { bindConstantConfigurationTemplate } from './constant-configuration-binding.js';
import { inspectConstantConfigurationTemplate } from './constant-configuration-template.js';
import { bindDeciderConfigurationTemplate } from './decider-configuration-binding.js';
import { inspectDeciderConfigurationTemplate } from './decider-configuration-template.js';
import { bindSelectorConfigurationTemplate } from './selector-configuration-binding.js';
import { inspectSelectorConfigurationTemplate } from './selector-configuration-template.js';
import {
  inspectBlueprintConfigurationSet,
  type BlueprintConfigurationTemplate,
  type BoundBlueprintConfiguration,
  type BlueprintConfigurationSetEntry,
} from './blueprint-configuration-set.js';
import type { ConstantConfigurationTemplate } from './constant-configuration-template.js';
import type { ArithmeticConfigurationTemplate } from './arithmetic-configuration-template.js';
import type {
  DeciderConfigurationTemplate,
  DeciderTemplateCondition,
  DeciderTemplateOutput,
} from './decider-configuration-template.js';
import type { SelectorConfigurationTemplate } from './selector-configuration-template.js';
import type { EntityPhysicalConfiguration } from './entity.js';
import { parseNativeCircuitIr, ResolvedCircuitError } from './resolved-circuit.js';
import type {
  ArithmeticProducerConfig,
  CircuitProducerNode,
  DeciderProducerConfig,
  LogicalDeciderCondition,
  LogicalDeciderOutput,
  LogicalNetworkRef,
  NativeCircuitIr,
  SelectorProducerConfig,
} from './ir.js';

function fail(path: string, message: string, span?: import('@comblang/shared').SourceSpan): never {
  throw new BlueprintParameterError('CP1001', path, message, span);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function templateParameters(entry: BlueprintConfigurationSetEntry) {
  switch (entry.kind) {
    case 'constant':
      return inspectConstantConfigurationTemplate(entry.template, '$.template').usedParameters;
    case 'arithmetic':
      return inspectArithmeticConfigurationTemplate(entry.template, '$.template').usedParameters;
    case 'decider':
      return inspectDeciderConfigurationTemplate(entry.template, '$.template').usedParameters;
    case 'selector':
      return inspectSelectorConfigurationTemplate(entry.template, '$.template').usedParameters;
  }
}

function bindEntry(
  entry: BlueprintConfigurationSetEntry,
  bindings: readonly BlueprintParameterBinding[],
): BoundBlueprintConfiguration {
  switch (entry.kind) {
    case 'constant':
      return freezeDeep({
        key: entry.key,
        kind: entry.kind,
        config: bindConstantConfigurationTemplate(entry.template, bindings),
      });
    case 'arithmetic':
      return freezeDeep({
        key: entry.key,
        kind: entry.kind,
        config: bindArithmeticConfigurationTemplate(entry.template, bindings),
      });
    case 'decider':
      return freezeDeep({
        key: entry.key,
        kind: entry.kind,
        config: bindDeciderConfigurationTemplate(entry.template, bindings),
      });
    case 'selector':
      return freezeDeep({
        key: entry.key,
        kind: entry.kind,
        config: bindSelectorConfigurationTemplate(entry.template, bindings),
      });
  }
}

function prefixEntryError(error: unknown, entryIndex: number): never {
  if (!(error instanceof BlueprintParameterError)) throw error;
  const prefix = `$.entries[${entryIndex}]`;
  const suffix =
    error.path === '$' ? '' : error.path.startsWith('$') ? error.path.slice(1) : `.${error.path}`;
  const messagePrefix = `${error.path}: `;
  const message = error.message.startsWith(messagePrefix)
    ? error.message.slice(messagePrefix.length)
    : error.message;
  throw new BlueprintParameterError(error.code, `${prefix}${suffix}`, message, error.span);
}

export interface BlueprintConfigurationAssignment {
  readonly key: string;
  readonly producerId: ProducerId;
}

interface ValidatedAssignment {
  readonly key: string;
  readonly producerId: ProducerId;
  readonly entry: BlueprintConfigurationSetEntry;
  readonly producer: CircuitProducerNode;
  readonly producerIndex: number;
  readonly path: string;
}

function replacementFail(code: 'CP1000' | 'CP1001', path: string, message: string): never {
  throw new BlueprintParameterError(code, path, message);
}

function parseReplacementCircuit(value: unknown): NativeCircuitIr {
  try {
    return parseNativeCircuitIr(value);
  } catch (error) {
    if (error instanceof ResolvedCircuitError) {
      replacementFail('CP1001', error.path, error.detail);
    }
    if (error !== null && typeof error === 'object') {
      const validationError = error as { path?: unknown; detail?: unknown };
      if (typeof validationError.path === 'string' && validationError.path.startsWith('$.ir')) {
        replacementFail(
          'CP1001',
          validationError.path,
          typeof validationError.detail === 'string'
            ? validationError.detail
            : error instanceof Error
              ? error.message
              : 'invalid concrete NCIR data.',
        );
      }
    }
    replacementFail(
      'CP1001',
      '$.ir',
      error instanceof Error ? error.message : 'invalid concrete NCIR data.',
    );
  }
}

function validateConfigurationAssignments(
  entries: readonly BlueprintConfigurationSetEntry[],
  circuit: NativeCircuitIr,
  value: unknown,
): readonly ValidatedAssignment[] {
  const producers = new Map<
    string,
    { readonly value: CircuitProducerNode; readonly index: number }
  >();
  for (const [index, producer] of circuit.producers.entries()) {
    if (typeof producer.id !== 'string' || producer.id.length === 0) {
      replacementFail('CP1000', `$.ir.producers[${index}].id`, 'expected a non-empty Producer ID.');
    }
    if (producers.has(producer.id)) {
      replacementFail('CP1001', `$.ir.producers[${index}].id`, 'Producer IDs must be unique.');
    }
    producers.set(producer.id, { value: producer, index });
  }

  const entryByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const budget = createBlueprintParameterDataBudget();
  const assignments = openBlueprintParameterArray(value, '$.assignments', 0, budget);
  let validated: readonly ValidatedAssignment[];
  try {
    const seenKeys = new Set<string>();
    const seenProducerIds = new Set<string>();
    validated = Object.freeze(
      assignments.value.map((assignmentValue, index) => {
        const path = `$.assignments[${index}]`;
        const assignment = openBlueprintParameterRecord(assignmentValue, path, 1, budget);
        try {
          assertBlueprintParameterExactKeys(
            assignment.value,
            ['key', 'producerId'],
            path,
            'unknown configuration assignment field.',
          );
          for (const key of ['key', 'producerId'] as const) {
            if (!Object.hasOwn(assignment.value, key)) {
              replacementFail('CP1000', `${path}.${key}`, 'field is required.');
            }
          }
          const key = assignment.value.key;
          if (typeof key !== 'string' || key.trim().length === 0 || key.length > 128) {
            replacementFail(
              'CP1000',
              `${path}.key`,
              'expected a non-empty set key of at most 128 characters.',
            );
          }
          const entry = entryByKey.get(key);
          if (entry === undefined) {
            replacementFail('CP1001', `${path}.key`, `unknown configuration-set key "${key}".`);
          }
          if (seenKeys.has(key)) {
            replacementFail('CP1001', `${path}.key`, 'configuration-set keys must be unique.');
          }
          seenKeys.add(key);

          const producerId = assignment.value.producerId;
          if (
            typeof producerId !== 'string' ||
            producerId.trim().length === 0 ||
            producerId.length > 128
          ) {
            replacementFail(
              'CP1000',
              `${path}.producerId`,
              'expected a non-empty Producer ID of at most 128 characters.',
            );
          }
          if (seenProducerIds.has(producerId)) {
            replacementFail(
              'CP1001',
              `${path}.producerId`,
              'Producer IDs in assignments must be unique.',
            );
          }
          seenProducerIds.add(producerId);
          const producerEntry = producers.get(producerId);
          if (producerEntry === undefined) {
            replacementFail('CP1001', `${path}.producerId`, `unknown Producer ID "${producerId}".`);
          }
          if (producerEntry.value.kind !== entry.kind) {
            replacementFail(
              'CP1001',
              `${path}.producerId`,
              `configuration kind ${entry.kind} does not match Producer kind ${producerEntry.value.kind}.`,
            );
          }
          return Object.freeze({
            key,
            producerId: producerId as ProducerId,
            entry,
            producer: producerEntry.value,
            producerIndex: producerEntry.index,
            path,
          });
        } finally {
          assignment.release();
        }
      }),
    );
  } finally {
    assignments.release();
  }

  const assignedKeys = new Set(validated.map(({ key }) => key));
  for (const entry of entries) {
    if (!assignedKeys.has(entry.key)) {
      replacementFail(
        'CP1001',
        '$.assignments',
        `missing Producer assignment for configuration key "${entry.key}".`,
      );
    }
  }
  return validated;
}

function sameConcreteValue(
  left: unknown,
  right: unknown,
  visited = new WeakMap<object, WeakSet<object>>(),
): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftArray = Array.isArray(left);
  if (leftArray !== Array.isArray(right)) return false;
  const rightVisited = visited.get(left);
  if (rightVisited?.has(right)) return true;
  if (rightVisited === undefined) visited.set(left, new WeakSet([right]));
  else rightVisited.add(right);

  if (leftArray) {
    if (left.length !== (right as unknown[]).length) return false;
    for (let index = 0; index < left.length; index += 1) {
      const leftDescriptor = Object.getOwnPropertyDescriptor(left, String(index));
      const rightDescriptor = Object.getOwnPropertyDescriptor(right, String(index));
      if (
        leftDescriptor === undefined ||
        rightDescriptor === undefined ||
        !('value' in leftDescriptor) ||
        !('value' in rightDescriptor) ||
        !sameConcreteValue(leftDescriptor.value, rightDescriptor.value, visited)
      ) {
        return false;
      }
    }
    return true;
  }

  const leftPrototype = Object.getPrototypeOf(left);
  const rightPrototype = Object.getPrototypeOf(right);
  if (
    (leftPrototype !== Object.prototype && leftPrototype !== null) ||
    (rightPrototype !== Object.prototype && rightPrototype !== null)
  ) {
    return false;
  }
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  leftKeys.sort((a, b) => String(a).localeCompare(String(b)));
  rightKeys.sort((a, b) => String(a).localeCompare(String(b)));
  return leftKeys.every((key, index) => {
    if (key !== rightKeys[index]) return false;
    const leftDescriptor = Object.getOwnPropertyDescriptor(left, key);
    const rightDescriptor = Object.getOwnPropertyDescriptor(right, key);
    return (
      leftDescriptor !== undefined &&
      rightDescriptor !== undefined &&
      leftDescriptor.enumerable === rightDescriptor.enumerable &&
      'value' in leftDescriptor &&
      'value' in rightDescriptor &&
      sameConcreteValue(leftDescriptor.value, rightDescriptor.value, visited)
    );
  });
}

function templateSlotMatches(templateValue: unknown, concreteValue: unknown): boolean {
  if (isRegisteredArithmeticNumericExpression(templateValue)) {
    return typeof concreteValue === 'number';
  }
  const parameter = findBlueprintParameterHandle(templateValue);
  if (parameter === undefined) return sameConcreteValue(templateValue, concreteValue);
  return parameter.kind === 'number'
    ? typeof concreteValue === 'number'
    : concreteValue !== null && typeof concreteValue === 'object' && !Array.isArray(concreteValue);
}

function networkReferenceMatches(
  template: LogicalNetworkRef,
  concrete: LogicalNetworkRef,
): boolean {
  if (template.refKind !== concrete.refKind) return false;
  return template.refKind === 'single' && concrete.refKind === 'single'
    ? template.network === concrete.network
    : template.refKind === 'pair' &&
        concrete.refKind === 'pair' &&
        template.networks[0] === concrete.networks[0] &&
        template.networks[1] === concrete.networks[1];
}

function arithmeticTemplateMatches(
  template: ArithmeticConfigurationTemplate,
  concrete: ArithmeticProducerConfig,
): boolean {
  const operandMatches = (
    expected: ArithmeticConfigurationTemplate['left'],
    actual: ArithmeticProducerConfig['left'],
  ): boolean => {
    if (expected.kind !== actual.kind) return false;
    if (expected.kind === 'constant' && actual.kind === 'constant') {
      return templateSlotMatches(expected.value, actual.value);
    }
    if (expected.kind === 'signal' && actual.kind === 'signal') {
      return (
        networkReferenceMatches(expected, actual) &&
        templateSlotMatches(expected.signal, actual.signal)
      );
    }
    return (
      expected.kind === 'each' &&
      actual.kind === 'each' &&
      networkReferenceMatches(expected, actual)
    );
  };
  if (template.operation !== concrete.operation || !operandMatches(template.left, concrete.left)) {
    return false;
  }
  if (
    !operandMatches(template.right, concrete.right) ||
    template.output.kind !== concrete.output.kind
  ) {
    return false;
  }
  return (
    template.output.kind === 'each' ||
    (concrete.output.kind === 'signal' &&
      templateSlotMatches(template.output.signal, concrete.output.signal))
  );
}

function deciderConditionMatches(
  template: DeciderTemplateCondition,
  concrete: LogicalDeciderCondition,
): boolean {
  if (template.kind !== concrete.kind) return false;
  if (template.kind === 'and' || template.kind === 'or') {
    return (
      (concrete.kind === 'and' || concrete.kind === 'or') &&
      template.conditions.length === concrete.conditions.length &&
      template.conditions.every((condition, index) =>
        deciderConditionMatches(condition, concrete.conditions[index]!),
      )
    );
  }
  if (concrete.kind !== 'compare' || template.comparator !== concrete.comparator) return false;
  const leftMatches =
    template.left.kind === 'signal'
      ? concrete.left.kind === 'signal' &&
        networkReferenceMatches(template.left, concrete.left) &&
        templateSlotMatches(template.left.signal, concrete.left.signal)
      : concrete.left.kind === 'wildcard' &&
        template.left.value === concrete.left.value &&
        networkReferenceMatches(template.left, concrete.left);
  if (!leftMatches || template.right.kind !== concrete.right.kind) return false;
  if (template.right.kind === 'constant' && concrete.right.kind === 'constant') {
    return templateSlotMatches(template.right.value, concrete.right.value);
  }
  return (
    template.right.kind === 'signal' &&
    concrete.right.kind === 'signal' &&
    networkReferenceMatches(template.right, concrete.right) &&
    templateSlotMatches(template.right.signal, concrete.right.signal)
  );
}

function deciderOutputMatches(
  template: DeciderTemplateOutput,
  concrete: LogicalDeciderOutput,
): boolean {
  if (template.mode !== concrete.mode || template.signal.kind !== concrete.signal.kind)
    return false;
  const signalMatches =
    template.signal.kind === 'signal' && concrete.signal.kind === 'signal'
      ? templateSlotMatches(template.signal.signal, concrete.signal.signal)
      : template.signal.kind === 'wildcard' &&
        concrete.signal.kind === 'wildcard' &&
        template.signal.value === concrete.signal.value;
  if (!signalMatches) return false;
  const templateInput = template.input;
  const concreteInput = concrete.input;
  if (
    (templateInput === undefined) !== (concreteInput === undefined) ||
    (templateInput !== undefined &&
      concreteInput !== undefined &&
      !networkReferenceMatches(templateInput, concreteInput))
  ) {
    return false;
  }
  return (
    template.mode === 'copy' ||
    (concrete.mode === 'constant' && templateSlotMatches(template.value, concrete.value))
  );
}

function deciderTemplateMatches(
  template: DeciderConfigurationTemplate,
  concrete: DeciderProducerConfig,
): boolean {
  if (
    !deciderConditionMatches(template.condition, concrete.condition) ||
    template.outputs.length !== concrete.outputs.length ||
    !template.outputs.every((output, index) =>
      deciderOutputMatches(output, concrete.outputs[index]!),
    ) ||
    (template.elseOutputs === undefined) !== (concrete.elseOutputs === undefined)
  ) {
    return false;
  }
  return (
    template.elseOutputs === undefined ||
    (concrete.elseOutputs !== undefined &&
      template.elseOutputs.length === concrete.elseOutputs.length &&
      template.elseOutputs.every((output, index) =>
        deciderOutputMatches(output, concrete.elseOutputs![index]!),
      ))
  );
}

function constantTemplateMatches(
  template: ConstantConfigurationTemplate,
  concrete: import('@comblang/factorio').ConstantConfiguration,
): boolean {
  return (
    template.isOn === concrete.isOn &&
    template.sections.length === concrete.sections.length &&
    template.sections.every((section, sectionIndex) => {
      const concreteSection = concrete.sections[sectionIndex]!;
      return (
        section.active === concreteSection.active &&
        section.group === concreteSection.group &&
        templateSlotMatches(section.multiplier, concreteSection.multiplier) &&
        section.filters.length === concreteSection.filters.length &&
        section.filters.every((filter, filterIndex) => {
          const concreteFilter = concreteSection.filters[filterIndex]!;
          return (
            templateSlotMatches(filter.signal, concreteFilter.signal) &&
            templateSlotMatches(filter.value, concreteFilter.value)
          );
        })
      );
    })
  );
}

function selectorTemplateMatches(
  template: SelectorConfigurationTemplate,
  concrete: SelectorProducerConfig,
): boolean {
  if (
    template.operation !== concrete.operation ||
    !networkReferenceMatches(template.input, concrete.input)
  ) {
    return false;
  }
  return template.operation === 'select' && concrete.operation === 'select'
    ? template.selectMax === concrete.selectMax &&
        templateSlotMatches(template.index, concrete.index)
    : template.operation === 'count' &&
        concrete.operation === 'count' &&
        templateSlotMatches(template.output, concrete.output);
}

function producerConfigMatchesTemplate(
  producer: CircuitProducerNode,
  template: BlueprintConfigurationTemplate,
  path: string,
): boolean {
  if (producer.kind !== templateKind(template)) {
    replacementFail('CP1001', `${path}.config`, 'replacement kind does not match Producer kind.');
  }
  switch (producer.kind) {
    case 'constant':
      if (!('sections' in template)) break;
      if (producer.config.configuration === undefined) {
        replacementFail(
          'CP1001',
          `${path}.config`,
          'legacy Constant output rows cannot be replaced by an exact configuration.',
        );
      }
      return constantTemplateMatches(template, producer.config.configuration);
    case 'arithmetic':
      if (!('left' in template)) break;
      return arithmeticTemplateMatches(template, producer.config);
    case 'decider':
      if (!('condition' in template)) break;
      return deciderTemplateMatches(template, producer.config);
    case 'selector':
      if (!('input' in template)) break;
      return selectorTemplateMatches(template, producer.config);
  }
  replacementFail('CP1001', `${path}.config`, 'replacement kind does not match Producer kind.');
}

function templateKind(
  template: BlueprintConfigurationTemplate,
): BlueprintConfigurationSetEntry['kind'] {
  if ('sections' in template) return 'constant';
  if ('left' in template) return 'arithmetic';
  if ('condition' in template) return 'decider';
  return 'selector';
}

function boundConfigMatchesTemplate(
  replacement: BoundBlueprintConfiguration,
  template: BlueprintConfigurationTemplate,
): boolean {
  if (replacement.kind !== templateKind(template)) return false;
  switch (replacement.kind) {
    case 'constant':
      return 'sections' in template && constantTemplateMatches(template, replacement.config);
    case 'arithmetic':
      return 'left' in template && arithmeticTemplateMatches(template, replacement.config);
    case 'decider':
      return 'condition' in template && deciderTemplateMatches(template, replacement.config);
    case 'selector':
      return 'input' in template && selectorTemplateMatches(template, replacement.config);
  }
}

function concreteEntityConfiguration(
  replacement: BoundBlueprintConfiguration,
): EntityPhysicalConfiguration {
  switch (replacement.kind) {
    case 'constant':
      return { mode: 'constant', value: replacement.config };
    case 'arithmetic':
      return { mode: 'arithmetic', ...replacement.config };
    case 'decider':
      return { mode: 'decider', ...replacement.config };
    case 'selector':
      return { mode: 'selector', ...replacement.config };
  }
}

function producerWithReplacement(
  producer: CircuitProducerNode,
  replacement: BoundBlueprintConfiguration,
): CircuitProducerNode {
  switch (producer.kind) {
    case 'constant':
      if (replacement.kind !== 'constant') break;
      return { ...producer, config: { configuration: replacement.config } };
    case 'arithmetic':
      if (replacement.kind !== 'arithmetic') break;
      return { ...producer, config: replacement.config };
    case 'decider':
      if (replacement.kind !== 'decider') break;
      return { ...producer, config: replacement.config };
    case 'selector':
      if (replacement.kind !== 'selector') break;
      return { ...producer, config: replacement.config };
  }
  replacementFail('CP1001', '$.assignments', 'replacement kind does not match Producer kind.');
}

/** Replaces only explicitly assigned concrete Producer configurations on a detached NCIR copy. */
export function replaceBlueprintConfigurationSetInNativeCircuitIr(
  setValue: unknown,
  circuit: NativeCircuitIr,
  assignmentsValue: unknown,
  bindingsValue: readonly BlueprintParameterBinding[] = [],
): NativeCircuitIr {
  const validatedCircuit = parseReplacementCircuit(circuit);
  const setRegistration = inspectBlueprintConfigurationSet(setValue, '$.set');
  const assignments = validateConfigurationAssignments(
    setRegistration.entries,
    validatedCircuit,
    assignmentsValue,
  );
  const bound = bindBlueprintConfigurationSet(setValue, bindingsValue);
  const boundByKey = new Map(bound.map((entry) => [entry.key, entry]));
  const replacementsByProducerId = new Map<string, BoundBlueprintConfiguration>();
  const entityConfigurations = new Map<string, EntityPhysicalConfiguration>();

  for (const assignment of assignments) {
    const replacement = boundByKey.get(assignment.key);
    if (replacement === undefined) {
      replacementFail('CP1001', `${assignment.path}.key`, 'configuration result is missing.');
    }
    const producerPath = `$.ir.producers[${assignment.producerIndex}]`;
    if (
      !producerConfigMatchesTemplate(assignment.producer, assignment.entry.template, producerPath)
    ) {
      replacementFail(
        'CP1001',
        `${assignment.path}.key`,
        'registered template does not match the Producer outside parameterized slots.',
      );
    }
    if (!boundConfigMatchesTemplate(replacement, assignment.entry.template)) {
      replacementFail(
        'CP1001',
        `${assignment.path}.key`,
        'bound replacement changes a fixed configuration field or Network reference.',
      );
    }
    replacementsByProducerId.set(assignment.producerId, replacement);

    if (assignment.producer.entityId !== undefined) {
      entityConfigurations.set(
        assignment.producer.entityId,
        concreteEntityConfiguration(replacement),
      );
    }
  }

  const producers = validatedCircuit.producers.map((producer) => {
    const replacement = replacementsByProducerId.get(producer.id);
    return replacement === undefined ? producer : producerWithReplacement(producer, replacement);
  });
  const entities = validatedCircuit.entities.map((entity) => {
    const configuration = entityConfigurations.get(entity.id);
    return configuration === undefined ? entity : { ...entity, configuration };
  });
  return parseReplacementCircuit({
    ...validatedCircuit,
    producers,
    entities,
  });
}

/** Binds every leaf as one transaction and returns only the complete immutable result. */
export function bindBlueprintConfigurationSet(
  setValue: unknown,
  bindingsValue: readonly BlueprintParameterBinding[] = [],
): readonly BoundBlueprintConfiguration[] {
  const registration = inspectBlueprintConfigurationSet(setValue, '$.set');
  const parsedBindings = readBlueprintParameterBindings(registration.session, bindingsValue);
  const allUsed = new Set<object>();
  const entryParameters = registration.entries.map((entry) => {
    const parameters = templateParameters(entry);
    for (const parameter of parameters) allUsed.add(parameter);
    return new Set<object>(parameters);
  });

  for (const binding of parsedBindings) {
    if (allUsed.has(binding.parameter)) continue;
    const parameter = inspectBlueprintParameterHandle(binding.parameter, '$.bindings');
    fail(
      '$.bindings',
      `parameter "${parameter.label}" is not used by this configuration set.`,
      parameter.source,
    );
  }

  const bound: BoundBlueprintConfiguration[] = [];
  for (const [entryIndex, entry] of registration.entries.entries()) {
    const usedParameters = entryParameters[entryIndex]!;
    const entryBindings: BlueprintParameterBinding[] = parsedBindings
      .filter((binding) => usedParameters.has(binding.parameter))
      .map(({ parameter, value }) => ({ parameter, value }));
    try {
      bound.push(bindEntry(entry, entryBindings));
    } catch (error) {
      prefixEntryError(error, entryIndex);
    }
  }

  return Object.freeze(bound);
}
