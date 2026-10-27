import { signal, signalKey, type SignalId } from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';

import {
  canonicalBlueprintParameterHandle,
  BlueprintParameterError,
  type BlueprintParameterHandle,
  type BlueprintParameterSession,
} from '../../compiler/src/blueprint-parameters.js';
import {
  inspectArithmeticConfigurationTemplate,
  type ArithmeticConfigurationTemplate,
} from '../../compiler/src/arithmetic-configuration-template.js';
import {
  inspectConstantConfigurationTemplate,
  type ConstantRecipeIngredientResolution,
  type ConstantConfigurationTemplate,
} from '../../compiler/src/constant-configuration-template.js';
import { inspectBlueprintRecipeIngredientReference } from '../../compiler/src/blueprint-recipe-ingredient-reference.js';
import {
  inspectDeciderConfigurationTemplate,
  type DeciderConfigurationTemplate,
} from '../../compiler/src/decider-configuration-template.js';
import {
  inspectSelectorConfigurationTemplate,
  type SelectorConfigurationTemplate,
} from '../../compiler/src/selector-configuration-template.js';
import type { CapturedBlueprintParameter } from './blueprint-parameter-capture.js';
import type { CombinatorDescriptor } from './elaboration-values.js';

interface CapturedTemplate<T> {
  readonly template: T;
  readonly source: SourceSpan;
}

interface CapturedArithmeticTemplate extends CapturedTemplate<ArithmeticConfigurationTemplate> {
  readonly rawTemplate: ArithmeticConfigurationTemplate;
  readonly ownerDescriptor: Extract<CombinatorDescriptor, { readonly kind: 'arithmetic' }>;
}

export interface SourceSignalTemplateContext {
  readonly requiredParameters: readonly BlueprintParameterHandle[];
  bindingsForConstantTemplate(
    template: ConstantConfigurationTemplate,
  ): readonly { readonly parameter: BlueprintParameterHandle; readonly value: SignalId }[];
  bindingsForRecipeIngredientReferences(
    template: ConstantConfigurationTemplate,
  ): readonly ConstantRecipeIngredientResolution[];
  bindingsForSelectorTemplate(
    template: SelectorConfigurationTemplate,
  ): readonly { readonly parameter: BlueprintParameterHandle; readonly value: SignalId }[];
  bindingsForArithmeticTemplate(
    template: ArithmeticConfigurationTemplate,
  ): readonly { readonly parameter: BlueprintParameterHandle; readonly value: SignalId }[];
  placeholderFor(parameter: BlueprintParameterHandle): string | undefined;
}

function fail(path: string, message: string, source?: SourceSpan): never {
  throw new BlueprintParameterError('CP1002', path, message, source);
}

function dataSignal(value: unknown): SignalId | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const type = Object.getOwnPropertyDescriptor(value, 'type');
  const name = Object.getOwnPropertyDescriptor(value, 'name');
  const quality = Object.getOwnPropertyDescriptor(value, 'quality');
  if (
    type === undefined ||
    name === undefined ||
    !('value' in type) ||
    !('value' in name) ||
    (quality !== undefined && !('value' in quality)) ||
    typeof type.value !== 'string' ||
    typeof name.value !== 'string' ||
    (quality !== undefined && typeof quality.value !== 'string')
  ) {
    return undefined;
  }
  try {
    const candidate = {
      type: type.value as SignalId['type'],
      name: name.value,
      ...(quality === undefined ? {} : { quality: quality.value as string }),
    };
    signalKey(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

function collectLiteralSignalNames(
  value: unknown,
  names: Set<string>,
  seen: WeakSet<object>,
): void {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
  if (canonicalBlueprintParameterHandle(value) !== undefined) return;
  if (inspectBlueprintRecipeIngredientReference(value) !== undefined) return;
  if (seen.has(value)) return;
  seen.add(value);
  const candidate = dataSignal(value);
  if (candidate !== undefined) {
    names.add(candidate.name);
    return;
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) collectLiteralSignalNames(descriptor.value, names, seen);
  }
}

function collectSignalParameters(
  value: unknown,
  used: Set<BlueprintParameterHandle>,
  seen: WeakSet<object>,
): void {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
  const parameter = canonicalBlueprintParameterHandle(value);
  if (parameter !== undefined) {
    if (parameter.kind === 'signal') used.add(parameter);
    return;
  }
  if (inspectBlueprintRecipeIngredientReference(value) !== undefined) return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) collectSignalParameters(descriptor.value, used, seen);
  }
}

/**
 * Allocates the one native ID placeholder pool for this source owner. Missing-default
 * Signal declarations are accepted only in direct Constant filter and Selector
 * parameter slots; their
 * placeholders materialize the private template base and are never defaults.
 */
export function createSourceSignalTemplateContext(
  session: BlueprintParameterSession,
  declarations: readonly CapturedBlueprintParameter[],
  producers: readonly CombinatorDescriptor[],
  templates: {
    readonly constants: readonly CapturedTemplate<ConstantConfigurationTemplate>[];
    readonly arithmetics: readonly CapturedArithmeticTemplate[];
    readonly deciders: readonly CapturedTemplate<DeciderConfigurationTemplate>[];
    readonly selectors: readonly CapturedTemplate<SelectorConfigurationTemplate>[];
  },
): SourceSignalTemplateContext | undefined {
  const usedSignals = new Set<BlueprintParameterHandle>();
  const directConstantSignalSlots = new Set<BlueprintParameterHandle>();
  const directSelectorSignalSlots = new Set<BlueprintParameterHandle>();
  const directArithmeticSignalSlots = new Set<BlueprintParameterHandle>();
  const unsupportedSignalUses = new Set<BlueprintParameterHandle>();

  for (const capture of templates.constants) {
    const inspected = inspectConstantConfigurationTemplate(capture.template, '$.constant');
    if (inspected.session !== session) {
      fail('$.constant', 'template belongs to a different parameter session.', capture.source);
    }
    for (const parameter of inspected.usedParameters) {
      if (parameter.kind === 'signal') usedSignals.add(parameter);
    }
    for (const reference of inspected.recipeIngredientReferences) {
      directConstantSignalSlots.add(reference.parameter);
    }
    for (const section of capture.template.sections) {
      for (const filter of section.filters) {
        const parameter = canonicalBlueprintParameterHandle(filter.signal);
        if (parameter?.kind === 'signal') directConstantSignalSlots.add(parameter);
      }
    }
  }
  for (const capture of templates.arithmetics) {
    const inspected = inspectArithmeticConfigurationTemplate(capture.template, '$.arithmetic');
    if (inspected.session !== session) {
      fail('$.arithmetic', 'template belongs to a different parameter session.', capture.source);
    }
    const outputParameter =
      capture.template.output.kind === 'signal'
        ? canonicalBlueprintParameterHandle(capture.template.output.signal)
        : undefined;
    const operandSignalParameters = new Set<BlueprintParameterHandle>();
    for (const operand of [capture.template.left, capture.template.right]) {
      if (operand.kind !== 'signal') continue;
      const parameter = canonicalBlueprintParameterHandle(operand.signal);
      if (parameter?.kind === 'signal') operandSignalParameters.add(parameter);
    }
    if (outputParameter?.kind === 'signal') directArithmeticSignalSlots.add(outputParameter);
    for (const parameter of inspected.usedParameters) {
      if (parameter.kind === 'signal') {
        usedSignals.add(parameter);
        if (parameter !== outputParameter || operandSignalParameters.has(parameter)) {
          unsupportedSignalUses.add(parameter);
        }
      }
    }
  }
  for (const capture of templates.deciders) {
    const inspected = inspectDeciderConfigurationTemplate(capture.template, '$.decider');
    if (inspected.session !== session) {
      fail('$.decider', 'template belongs to a different parameter session.', capture.source);
    }
    for (const parameter of inspected.usedParameters) {
      if (parameter.kind === 'signal') {
        usedSignals.add(parameter);
        unsupportedSignalUses.add(parameter);
      }
    }
  }
  for (const capture of templates.selectors) {
    const inspected = inspectSelectorConfigurationTemplate(capture.template, '$.selector');
    if (inspected.session !== session) {
      fail('$.selector', 'template belongs to a different parameter session.', capture.source);
    }
    for (const parameter of inspected.usedParameters) {
      if (parameter.kind === 'signal') {
        usedSignals.add(parameter);
      }
    }
    const directSlot =
      capture.template.operation === 'select'
        ? canonicalBlueprintParameterHandle(capture.template.index)
        : canonicalBlueprintParameterHandle(capture.template.output);
    if (directSlot?.kind === 'signal') directSelectorSignalSlots.add(directSlot);
  }
  for (const producer of producers) {
    if (producer.kind === 'constant') continue;
    const unsupported = new Set<BlueprintParameterHandle>();
    const matchingSelectorCapture =
      producer.kind === 'selector' && 'pendingConfiguration' in producer
        ? templates.selectors.find(({ template }) => template === producer.pendingConfiguration)
        : undefined;
    const matchingArithmeticCapture =
      producer.kind === 'arithmetic' && 'pendingConfiguration' in producer
        ? templates.arithmetics.find(
            ({ rawTemplate, ownerDescriptor }) =>
              rawTemplate === producer.pendingConfiguration && ownerDescriptor === producer,
          )
        : undefined;
    if (
      matchingSelectorCapture !== undefined &&
      producer.kind === 'selector' &&
      'pendingConfiguration' in producer
    ) {
      // Only the exact captured template may account for the supported parameter slots.
      // Continue scanning the rest of the descriptor so unrelated handle uses remain refused.
      const { pendingConfiguration: _pendingConfiguration, ...descriptor } = producer;
      collectSignalParameters(descriptor, unsupported, new WeakSet());
    } else if (
      matchingArithmeticCapture !== undefined &&
      producer.kind === 'arithmetic' &&
      'pendingConfiguration' in producer
    ) {
      const { pendingConfiguration: _pendingConfiguration, ...descriptor } = producer;
      collectSignalParameters(descriptor, unsupported, new WeakSet());
    } else {
      collectSignalParameters(producer, unsupported, new WeakSet());
    }
    for (const parameter of unsupported) {
      usedSignals.add(parameter);
      unsupportedSignalUses.add(parameter);
    }
  }

  if (usedSignals.size === 0) return undefined;

  const declarationsByHandle = new Map(declarations.map((entry) => [entry.handle, entry] as const));
  const missingUsed = declarations.filter(
    ({ handle, registration }) =>
      registration.kind === 'signal' &&
      registration.defaultValue === undefined &&
      usedSignals.has(handle),
  );
  for (const { handle, registration } of missingUsed) {
    if (
      (!directConstantSignalSlots.has(handle) &&
        !directSelectorSignalSlots.has(handle) &&
        !directArithmeticSignalSlots.has(handle)) ||
      unsupportedSignalUses.has(handle) ||
      registration.source === undefined
    ) {
      fail(
        '$.parameters',
        `Signal declaration "${registration.label}" without a default is supported only in a direct Constant filter signal/ingredient slot, Selector select-index, Selector count-output, or Arithmetic output Signal slot.`,
        registration.source,
      );
    }
  }
  if (missingUsed.length === 0) return undefined;

  const reservedNames = new Set<string>();
  const seen = new WeakSet<object>();
  for (const producer of producers) {
    const arithmeticCapture =
      producer.kind === 'arithmetic' && 'pendingConfiguration' in producer
        ? templates.arithmetics.find(
            ({ rawTemplate, ownerDescriptor }) =>
              rawTemplate === producer.pendingConfiguration && ownerDescriptor === producer,
          )
        : undefined;
    if (
      arithmeticCapture !== undefined &&
      producer.kind === 'arithmetic' &&
      'pendingConfiguration' in producer
    ) {
      const { pendingConfiguration: _pendingConfiguration, ...descriptor } = producer;
      collectLiteralSignalNames(descriptor, reservedNames, seen);
      collectLiteralSignalNames(arithmeticCapture.template, reservedNames, seen);
    } else {
      collectLiteralSignalNames(producer, reservedNames, seen);
    }
  }
  for (const { registration } of declarations) {
    if (registration.kind === 'signal' && registration.defaultValue !== undefined) {
      reservedNames.add((registration.defaultValue as SignalId).name);
    }
  }

  const placeholders = new Map<BlueprintParameterHandle, string>();
  for (const { handle } of declarations) {
    if (handle.kind !== 'signal' || !usedSignals.has(handle)) continue;
    let allocated: string | undefined;
    for (let candidate = 0; candidate < 10; candidate += 1) {
      const name = `parameter-${candidate}`;
      if (!reservedNames.has(name)) {
        reservedNames.add(name);
        allocated = name;
        break;
      }
    }
    if (allocated === undefined) {
      const registration = declarationsByHandle.get(handle)!.registration;
      fail(
        '$.parameters',
        'native Signal placeholder pool parameter-0 through parameter-9 is exhausted.',
        registration.source,
      );
    }
    placeholders.set(handle, allocated);
  }

  const requiredParameters = Object.freeze(missingUsed.map(({ handle }) => handle));
  const bindings = new Map(
    requiredParameters.map((parameter) => [
      parameter,
      signal('item', placeholders.get(parameter)!),
    ]),
  );
  return Object.freeze({
    requiredParameters,
    placeholderFor(parameter: BlueprintParameterHandle) {
      return placeholders.get(parameter);
    },
    bindingsForConstantTemplate(template: ConstantConfigurationTemplate) {
      const inspected = inspectConstantConfigurationTemplate(template, '$.constant');
      if (inspected.session !== session) {
        fail('$.constant', 'template belongs to a different parameter session.');
      }
      return Object.freeze(
        inspected.usedParameters.flatMap((parameter) => {
          const value = bindings.get(parameter);
          return value === undefined ? [] : [Object.freeze({ parameter, value })];
        }),
      );
    },
    bindingsForRecipeIngredientReferences(template: ConstantConfigurationTemplate) {
      const inspected = inspectConstantConfigurationTemplate(template, '$.constant');
      if (inspected.session !== session) {
        fail('$.constant', 'template belongs to a different parameter session.');
      }
      const results = new Map<
        BlueprintParameterHandle,
        Map<number, ConstantRecipeIngredientResolution>
      >();
      let ordinal = 0;
      for (const reference of inspected.recipeIngredientReferences) {
        if (!bindings.has(reference.parameter)) continue;
        let byIndex = results.get(reference.parameter);
        if (byIndex === undefined) {
          byIndex = new Map();
          results.set(reference.parameter, byIndex);
        }
        if (!byIndex.has(reference.index)) {
          byIndex.set(
            reference.index,
            Object.freeze({
              parameter: reference.parameter,
              index: reference.index,
              status: 'present',
              signal: signal('item', `parameter-ingredient-${ordinal++}`),
              amount: 0,
            }),
          );
        }
      }
      return Object.freeze([...results.values()].flatMap((byIndex) => [...byIndex.values()]));
    },
    bindingsForSelectorTemplate(template: SelectorConfigurationTemplate) {
      const inspected = inspectSelectorConfigurationTemplate(template, '$.selector');
      if (inspected.session !== session) {
        fail('$.selector', 'template belongs to a different parameter session.');
      }
      return Object.freeze(
        inspected.usedParameters.flatMap((parameter) => {
          const value = bindings.get(parameter);
          return value === undefined ? [] : [Object.freeze({ parameter, value })];
        }),
      );
    },
    bindingsForArithmeticTemplate(template: ArithmeticConfigurationTemplate) {
      const inspected = inspectArithmeticConfigurationTemplate(template, '$.arithmetic');
      if (inspected.session !== session) {
        fail('$.arithmetic', 'template belongs to a different parameter session.');
      }
      return Object.freeze(
        inspected.usedParameters.flatMap((parameter) => {
          const value = bindings.get(parameter);
          return value === undefined ? [] : [Object.freeze({ parameter, value })];
        }),
      );
    },
  });
}
