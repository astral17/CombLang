import {
  constantConfigurationFromOutputs,
  constantConfigurationLimits,
  type ConstantConfiguration,
  type SignalId,
} from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';

import type {
  PlanArithmeticOperand,
  PlanDeciderCondition,
} from '../../compiler/src/direct-plan-schema.js';
import {
  assertBlueprintParameterFromSession,
  assertBlueprintParameterSession,
  BlueprintParameterError,
  findBlueprintParameterHandle,
  type BlueprintNumberParameterHandle,
  type BlueprintParameterSession,
} from '../../compiler/src/blueprint-parameters.js';
import {
  inspectRegisteredBlueprintNumericExpression,
  isRegisteredBlueprintNumericExpression,
} from '../../compiler/src/blueprint-numeric-expression-bridge.js';
import type { BlueprintNumericExpression } from '../../compiler/src/blueprint-numeric-expression.js';
import {
  inspectArithmeticConfigurationTemplate,
  type ArithmeticConfigurationTemplate,
  type ArithmeticTemplateOperand,
} from '../../compiler/src/arithmetic-configuration-template.js';
import {
  inspectConstantConfigurationTemplate,
  type ConstantConfigurationTemplate,
} from '../../compiler/src/constant-configuration-template.js';
import {
  inspectDeciderConfigurationTemplate,
  type DeciderConfigurationTemplate,
  type DeciderTemplateCondition,
} from '../../compiler/src/decider-configuration-template.js';
import {
  inspectSelectorConfigurationTemplate,
  type SelectorConfigurationTemplate,
} from '../../compiler/src/selector-configuration-template.js';
import type { CombinatorDescriptor } from './elaboration-values.js';

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

export type PreinstallationNumericRoot =
  number | BlueprintNumberParameterHandle | BlueprintNumericExpression;

interface PreinstallationNumericSlotBase {
  readonly producerIndex: number;
  readonly fieldPath: string;
  readonly source: SourceSpan;
  readonly root: PreinstallationNumericRoot;
}

export type PreinstallationNumericSlot =
  | (PreinstallationNumericSlotBase & {
      readonly family: 'constant';
      readonly role: 'multiplier';
      readonly numericDomain: 'finite-number';
    })
  | (PreinstallationNumericSlotBase & {
      readonly family: 'constant';
      readonly role: 'filter-value';
      readonly numericDomain: 'int32';
    })
  | (PreinstallationNumericSlotBase & {
      readonly family: 'arithmetic';
      readonly role: 'operand';
      readonly numericDomain: 'int32';
    })
  | (PreinstallationNumericSlotBase & {
      readonly family: 'decider';
      readonly role: 'condition-threshold';
      readonly numericDomain: 'int32';
    })
  | (PreinstallationNumericSlotBase & {
      readonly family: 'decider';
      readonly role: 'output-value';
      readonly numericDomain: 'int32';
    })
  | (PreinstallationNumericSlotBase & {
      readonly family: 'selector';
      readonly role: 'select-index';
      readonly numericDomain: 'int32';
    });

type NumericDomain = PreinstallationNumericSlot['numericDomain'];
type NumericFamily = PreinstallationNumericSlot['family'];
type NumericRole = PreinstallationNumericSlot['role'];

interface ProducerTraversal {
  readonly session: BlueprintParameterSession;
  readonly producerIndex: number;
  readonly producerPath: string;
  readonly source: SourceSpan;
  readonly slots: PreinstallationNumericSlot[];
  readonly budget: { nodes: number };
}

type DeciderDescriptor = Extract<CombinatorDescriptor, { readonly kind: 'decider' }>;
type DeciderOutput = NonNullable<DeciderDescriptor['output']>;
type NumericArithmeticOperand = PlanArithmeticOperand | ArithmeticTemplateOperand;

function refuse(
  path: string,
  message: string,
  source?: SourceSpan,
  code: 'CP1001' | 'CP1002' = 'CP1002',
): never {
  throw new BlueprintParameterError(code, path, message, source);
}

function sourceSnapshot(source: SourceSpan | undefined, path: string): SourceSpan {
  if (
    source === undefined ||
    typeof source.fileId !== 'string' ||
    !Number.isSafeInteger(source.start) ||
    !Number.isSafeInteger(source.end) ||
    source.start < 0 ||
    source.end < source.start
  ) {
    refuse(path, 'producer source span is malformed.');
  }
  return Object.isFrozen(source) ? source : Object.freeze({ ...source });
}

function assertTemplateOwner(
  templateSession: BlueprintParameterSession,
  traversal: ProducerTraversal,
  path: string,
): void {
  if (templateSession !== traversal.session) {
    refuse(
      path,
      'configuration template belongs to a different parameter session.',
      traversal.source,
      'CP1001',
    );
  }
}

function validateRoot(
  root: unknown,
  domain: NumericDomain,
  traversal: ProducerTraversal,
  path: string,
): asserts root is PreinstallationNumericRoot {
  if (typeof root === 'number') {
    const valid =
      domain === 'finite-number'
        ? Number.isFinite(root)
        : Number.isSafeInteger(root) && root >= INT32_MIN && root <= INT32_MAX;
    if (!valid) {
      refuse(
        path,
        domain === 'finite-number'
          ? 'Constant multiplier root must be finite.'
          : 'literal root must be a signed int32 value.',
        traversal.source,
      );
    }
    return;
  }

  const parameter = findBlueprintParameterHandle(root);
  if (parameter !== undefined) {
    if (parameter.kind !== 'number') {
      refuse(path, 'numeric slot contains a non-numeric parameter handle.', traversal.source);
    }
    assertBlueprintParameterFromSession(traversal.session, root, path);
    return;
  }
  if (isRegisteredBlueprintNumericExpression(root)) {
    inspectRegisteredBlueprintNumericExpression(traversal.session, root, path);
    return;
  }
  refuse(
    path,
    'numeric slot root is not a literal, authentic number parameter, or registered expression.',
    traversal.source,
  );
}

function consume(traversal: ProducerTraversal, path: string, depth = 0): void {
  traversal.budget.nodes += 1;
  if (traversal.budget.nodes > constantConfigurationLimits.maxNodes) {
    refuse(
      path,
      `producer inventory exceeds the per-producer node limit of ${constantConfigurationLimits.maxNodes}.`,
      traversal.source,
    );
  }
  if (depth > constantConfigurationLimits.maxDepth) {
    refuse(
      path,
      `producer inventory exceeds the depth limit of ${constantConfigurationLimits.maxDepth}.`,
      traversal.source,
    );
  }
}

function forEachBounded<T>(
  traversal: ProducerTraversal,
  values: readonly T[],
  path: string,
  visit: (value: T, index: number) => void,
): void {
  if (!Array.isArray(values)) refuse(path, 'expected an ordered producer array.', traversal.source);
  for (let index = 0; index < values.length; index += 1) {
    if (!Object.hasOwn(values, index)) {
      refuse(`${path}[${index}]`, 'sparse producer arrays are unsupported.', traversal.source);
    }
    consume(traversal, `${path}[${index}]`);
    visit(values[index]!, index);
  }
}

function pushSlot<F extends NumericFamily>(
  traversal: ProducerTraversal,
  family: F,
  role: Extract<PreinstallationNumericSlot, { readonly family: F }>['role'],
  numericDomain: Extract<PreinstallationNumericSlot, { readonly family: F }>['numericDomain'],
  fieldPath: string,
  root: unknown,
  depth = 0,
): void {
  consume(traversal, fieldPath, depth);
  validateRoot(root, numericDomain, traversal, fieldPath);
  traversal.slots.push(
    Object.freeze({
      producerIndex: traversal.producerIndex,
      family,
      role,
      numericDomain,
      fieldPath,
      source: traversal.source,
      root,
    }) as PreinstallationNumericSlot,
  );
}

function addConstantSections(
  traversal: ProducerTraversal,
  sections: ConstantConfiguration['sections'] | ConstantConfigurationTemplate['sections'],
  path: string,
): void {
  forEachBounded(traversal, sections, path, (section, sectionIndex) => {
    const sectionPath = `${path}[${sectionIndex}]`;
    pushSlot(
      traversal,
      'constant',
      'multiplier',
      'finite-number',
      `${sectionPath}.multiplier`,
      section.multiplier,
      1,
    );
    forEachBounded(traversal, section.filters, `${sectionPath}.filters`, (filter, filterIndex) =>
      pushSlot(
        traversal,
        'constant',
        'filter-value',
        'int32',
        `${sectionPath}.filters[${filterIndex}].value`,
        filter.value,
        2,
      ),
    );
  });
}

function addConstantSlots(
  traversal: ProducerTraversal,
  producer: Extract<CombinatorDescriptor, { readonly kind: 'constant' }>,
): void {
  if ('pendingConfiguration' in producer) {
    const path = `${traversal.producerPath}.pendingConfiguration`;
    const registration = inspectConstantConfigurationTemplate(producer.pendingConfiguration, path);
    assertTemplateOwner(registration.session, traversal, path);
    addConstantSections(traversal, producer.pendingConfiguration.sections, `${path}.sections`);
    return;
  }

  const configuration = producer.configuration;
  if (configuration !== undefined) {
    addConstantSections(
      traversal,
      configuration.sections,
      `${traversal.producerPath}.configuration.sections`,
    );
    return;
  }

  const outputsPath = `${traversal.producerPath}.outputs`;
  const outputs = producer.outputs;
  if (outputs === undefined) {
    refuse(outputsPath, 'legacy Constant outputs are missing.', traversal.source);
  }
  let projected: ConstantConfiguration;
  try {
    projected = constantConfigurationFromOutputs(outputs);
  } catch (error) {
    refuse(
      outputsPath,
      error instanceof Error
        ? `legacy Constant outputs are not inventory-safe: ${error.message}`
        : 'legacy Constant outputs are not inventory-safe.',
      traversal.source,
    );
  }
  const section = projected.sections[0];
  if (section === undefined) {
    refuse(
      outputsPath,
      'legacy Constant projection did not produce its implicit section.',
      traversal.source,
    );
  }
  pushSlot(
    traversal,
    'constant',
    'multiplier',
    'finite-number',
    outputsPath,
    section.multiplier,
    1,
  );
  forEachBounded(traversal, outputs, outputsPath, (output, index) =>
    pushSlot(
      traversal,
      'constant',
      'filter-value',
      'int32',
      `${outputsPath}[${index}].value`,
      output.value,
      2,
    ),
  );
}

function addArithmeticOperand(
  traversal: ProducerTraversal,
  operand: NumericArithmeticOperand,
  path: string,
): void {
  if (operand.kind === 'constant') {
    if (!('value' in operand)) {
      refuse(`${path}.value`, 'concrete Arithmetic operand value is missing.', traversal.source);
    }
    pushSlot(traversal, 'arithmetic', 'operand', 'int32', `${path}.value`, operand.value, 1);
  }
}

function addArithmeticSlots(
  traversal: ProducerTraversal,
  producer: Extract<CombinatorDescriptor, { readonly kind: 'arithmetic' }>,
): void {
  if ('pendingConfiguration' in producer) {
    const path = `${traversal.producerPath}.pendingConfiguration`;
    const registration = inspectArithmeticConfigurationTemplate(
      producer.pendingConfiguration,
      path,
    );
    assertTemplateOwner(registration.session, traversal, path);
    addArithmeticOperand(traversal, producer.pendingConfiguration.left, `${path}.left`);
    addArithmeticOperand(traversal, producer.pendingConfiguration.right, `${path}.right`);
    return;
  }
  addArithmeticOperand(traversal, producer.left, `${traversal.producerPath}.left`);
  addArithmeticOperand(traversal, producer.right, `${traversal.producerPath}.right`);
}

function addPlanCondition(
  traversal: ProducerTraversal,
  condition: PlanDeciderCondition,
  path: string,
  depth: number,
): void {
  consume(traversal, path, depth);
  switch (condition.kind) {
    case 'compare-each':
    case 'compare-signal':
    case 'compare-wildcard':
      pushSlot(
        traversal,
        'decider',
        'condition-threshold',
        'int32',
        `${path}.constant`,
        condition.constant,
        depth + 1,
      );
      return;
    case 'compare-signals':
    case 'compare-wildcard-signal':
      return;
    case 'and':
    case 'or':
      forEachBounded(traversal, condition.conditions, `${path}.conditions`, (child, index) =>
        addPlanCondition(traversal, child, `${path}.conditions[${index}]`, depth + 1),
      );
      return;
    default:
      refuse(`${path}.kind`, 'unknown Decider condition kind.', traversal.source);
  }
}

function addTemplateCondition(
  traversal: ProducerTraversal,
  condition: DeciderTemplateCondition,
  path: string,
  depth: number,
): void {
  consume(traversal, path, depth);
  if (condition.kind === 'compare') {
    if (condition.right.kind === 'constant') {
      pushSlot(
        traversal,
        'decider',
        'condition-threshold',
        'int32',
        `${path}.right.value`,
        condition.right.value,
        depth + 1,
      );
    }
    return;
  }
  forEachBounded(traversal, condition.conditions, `${path}.conditions`, (child, index) =>
    addTemplateCondition(traversal, child, `${path}.conditions[${index}]`, depth + 1),
  );
}

function addDeciderOutput(traversal: ProducerTraversal, output: DeciderOutput, path: string): void {
  switch (output.kind) {
    case 'each-constant':
    case 'signal-constant':
      pushSlot(traversal, 'decider', 'output-value', 'int32', `${path}.value`, output.value, 1);
      return;
    case 'each':
    case 'wildcard':
    case 'signal':
      return;
    default:
      refuse(`${path}.kind`, 'unknown Decider output row kind.', traversal.source);
  }
}

function addDeciderOutputRows(traversal: ProducerTraversal, producer: DeciderDescriptor): void {
  const path = traversal.producerPath;
  if (producer.outputs !== undefined) {
    forEachBounded(traversal, producer.outputs, `${path}.outputs`, (output, index) =>
      addDeciderOutput(traversal, output, `${path}.outputs[${index}]`),
    );
  } else if (producer.output !== undefined && producer.elseOutputs === undefined) {
    addDeciderOutput(traversal, producer.output, `${path}.output`);
  }
  if (producer.elseOutputs !== undefined) {
    forEachBounded(traversal, producer.elseOutputs, `${path}.elseOutputs`, (output, index) =>
      addDeciderOutput(traversal, output, `${path}.elseOutputs[${index}]`),
    );
  }
}

function addDeciderSlots(traversal: ProducerTraversal, producer: DeciderDescriptor): void {
  if ('pendingConfiguration' in producer) {
    const path = `${traversal.producerPath}.pendingConfiguration`;
    const registration = inspectDeciderConfigurationTemplate(producer.pendingConfiguration, path);
    assertTemplateOwner(registration.session, traversal, path);
    const template = producer.pendingConfiguration;
    if (template.outputs.length !== 0 || template.elseOutputs !== undefined) {
      refuse(
        path,
        'pending Decider template must contain only the authentic condition.',
        traversal.source,
      );
    }
    addTemplateCondition(traversal, template.condition, `${path}.condition`, 0);
  } else {
    addPlanCondition(traversal, producer.condition, `${traversal.producerPath}.condition`, 0);
  }
  addDeciderOutputRows(traversal, producer);
}

function isSignalId(value: unknown): value is SignalId {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    'name' in value &&
    typeof value.name === 'string'
  );
}

function addSelectorTemplateSlots(
  traversal: ProducerTraversal,
  template: SelectorConfigurationTemplate,
): void {
  const path = `${traversal.producerPath}.pendingConfiguration`;
  const registration = inspectSelectorConfigurationTemplate(template, path);
  assertTemplateOwner(registration.session, traversal, path);
  if (template.operation !== 'select') return;

  const index = template.index;
  if (typeof index === 'number') {
    pushSlot(traversal, 'selector', 'select-index', 'int32', `${path}.index`, index, 1);
    return;
  }
  const parameter = findBlueprintParameterHandle(index);
  if (parameter !== undefined) {
    assertBlueprintParameterFromSession(traversal.session, index, `${path}.index`);
    if (parameter.kind === 'number') {
      pushSlot(traversal, 'selector', 'select-index', 'int32', `${path}.index`, index, 1);
    }
    return;
  }
  if (isRegisteredBlueprintNumericExpression(index)) {
    pushSlot(traversal, 'selector', 'select-index', 'int32', `${path}.index`, index, 1);
    return;
  }
  if (!isSignalId(index)) {
    refuse(`${path}.index`, 'unsupported Selector template index root.', traversal.source);
  }
}

function addSelectorSlots(
  traversal: ProducerTraversal,
  producer: Extract<CombinatorDescriptor, { readonly kind: 'selector' }>,
): void {
  if ('pendingConfiguration' in producer) {
    addSelectorTemplateSlots(traversal, producer.pendingConfiguration);
    return;
  }
  if (producer.operation === 'count') return;

  const path = `${traversal.producerPath}.index`;
  if (typeof producer.index === 'number') {
    pushSlot(traversal, 'selector', 'select-index', 'int32', path, producer.index, 1);
  } else if (!isSignalId(producer.index)) {
    const parameter = findBlueprintParameterHandle(producer.index);
    if (parameter !== undefined) {
      assertBlueprintParameterFromSession(traversal.session, producer.index, path);
    }
    refuse(
      path,
      parameter === undefined
        ? 'concrete Selector index must be a number or Signal ID.'
        : 'concrete Selector descriptor contains an unresolved parameter handle.',
      traversal.source,
    );
  }
}

/**
 * Enumerates typed numeric replacement roots on producer descriptors before installation.
 * This PRODUCER-scoped inventory neither certifies generic/raw/unlinked physical Entity fields
 * nor authorizes allocation; roots remain unresolved for existing family binders and evaluators.
 */
export function collectPreinstallationNumericSlots(
  session: BlueprintParameterSession,
  producers: readonly CombinatorDescriptor[],
): readonly PreinstallationNumericSlot[] {
  assertBlueprintParameterSession(session, '$.session');
  const slots: PreinstallationNumericSlot[] = [];

  for (let producerIndex = 0; producerIndex < producers.length; producerIndex += 1) {
    if (!Object.hasOwn(producers, producerIndex)) {
      refuse(`$.producers[${producerIndex}]`, 'sparse producer arrays are unsupported.');
    }
    const producer = producers[producerIndex];
    if (producer === undefined) {
      refuse(`$.producers[${producerIndex}]`, 'producer descriptor is missing.');
    }
    const producerPath = `$.producers[${producerIndex}]`;
    const source = sourceSnapshot(producer.source, `${producerPath}.source`);
    const traversal: ProducerTraversal = {
      session,
      producerIndex,
      producerPath,
      source,
      slots,
      budget: { nodes: 0 },
    };

    switch (producer.kind) {
      case 'constant':
        addConstantSlots(traversal, producer);
        break;
      case 'arithmetic':
        addArithmeticSlots(traversal, producer);
        break;
      case 'decider':
        addDeciderSlots(traversal, producer);
        break;
      case 'selector':
        addSelectorSlots(traversal, producer);
        break;
      default:
        refuse(`${producerPath}.kind`, 'unknown producer family.', source);
    }
  }

  return Object.freeze(slots);
}
