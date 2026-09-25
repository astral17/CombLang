import { int32, type SignalId } from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';

import {
  assertBlueprintParameterNumberValue,
  canonicalizeBlueprintParameterSignal,
  lookupBlueprintParameterSlot,
  readBlueprintParameterBindings,
  type BlueprintParameterBinding,
} from './blueprint-parameter-validation.js';
import {
  BlueprintParameterError,
  findBlueprintParameterHandle,
  inspectBlueprintParameterHandle,
} from './blueprint-parameters.js';
import {
  inspectSelectorConfigurationTemplate,
  type SelectorConfigurationTemplate,
} from './selector-configuration-template.js';
import type { LogicalNetworkRef, SelectorProducerConfig } from './ir.js';

function fail(
  path: string,
  message: string,
  span?: SourceSpan,
  code: 'CP1000' | 'CP1001' | 'CP1002' = 'CP1000',
): never {
  throw new BlueprintParameterError(code, path, message, span);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function cloneNetworkReference(reference: LogicalNetworkRef): LogicalNetworkRef {
  return reference.refKind === 'single'
    ? { refKind: 'single', network: reference.network }
    : { refKind: 'pair', networks: [reference.networks[0], reference.networks[1]] };
}

/** Resolves a Selector template completely to a fresh concrete config for NCIR. */
export function bindSelectorConfigurationTemplate(
  templateValue: unknown,
  bindingsValue: readonly BlueprintParameterBinding[] = [],
): SelectorProducerConfig {
  const { session } = inspectSelectorConfigurationTemplate(templateValue, '$.template');
  const template = templateValue as SelectorConfigurationTemplate;
  const bindings = readBlueprintParameterBindings(session, bindingsValue);
  const explicit = new Map<object, unknown>();
  for (const binding of bindings) explicit.set(binding.parameter, binding.value);

  const used = new Set<object>();
  const resolvedNumbers = new Map<object, number>();
  const resolvedSignals = new Map<object, SignalId>();

  const resolveNumber = (value: unknown, path: string): number => {
    const slot = lookupBlueprintParameterSlot(value, 'number', session, path);
    if (slot === undefined) {
      return int32(assertBlueprintParameterNumberValue(value, path, 'safe-integer'));
    }
    used.add(slot.handle);
    if (resolvedNumbers.has(slot.handle)) return resolvedNumbers.get(slot.handle)!;
    const supplied = explicit.has(slot.handle);
    const resolved = supplied ? explicit.get(slot.handle) : slot.registration.defaultValue;
    if (resolved === undefined) {
      if (supplied) fail(path, 'a binding value cannot be undefined.', slot.registration.source);
      fail(
        path,
        `parameter "${slot.registration.label}" has no binding or default.`,
        slot.registration.source,
        'CP1002',
      );
    }
    const number = assertBlueprintParameterNumberValue(
      resolved,
      path,
      'safe-integer',
      slot.registration.source,
      'Selector indices must be safe integers.',
    );
    const normalized = int32(number);
    resolvedNumbers.set(slot.handle, normalized);
    return normalized;
  };

  const resolveSignal = (value: unknown, path: string): SignalId => {
    const slot = lookupBlueprintParameterSlot(value, 'signal', session, path);
    if (slot === undefined) return canonicalizeBlueprintParameterSignal(value, path);
    used.add(slot.handle);
    if (resolvedSignals.has(slot.handle)) return resolvedSignals.get(slot.handle)!;
    const supplied = explicit.has(slot.handle);
    const resolved = supplied ? explicit.get(slot.handle) : slot.registration.defaultValue;
    if (resolved === undefined) {
      if (supplied) fail(path, 'a binding value cannot be undefined.', slot.registration.source);
      fail(
        path,
        `parameter "${slot.registration.label}" has no binding or default.`,
        slot.registration.source,
        'CP1002',
      );
    }
    const normalized = canonicalizeBlueprintParameterSignal(
      resolved,
      path,
      slot.registration.source,
    );
    resolvedSignals.set(slot.handle, normalized);
    return normalized;
  };

  const resolveIndex = (value: unknown, path: string): number | SignalId => {
    const registration = findBlueprintParameterHandle(value);
    if (registration?.kind === 'number') return resolveNumber(value, path);
    if (registration?.kind === 'signal') return resolveSignal(value, path);
    if (typeof value === 'number') {
      return int32(assertBlueprintParameterNumberValue(value, path, 'safe-integer'));
    }
    return canonicalizeBlueprintParameterSignal(value, path);
  };

  const concrete: SelectorProducerConfig =
    template.operation === 'select'
      ? {
          operation: 'select',
          input: cloneNetworkReference(template.input),
          selectMax: template.selectMax,
          index: resolveIndex(template.index, '$.index'),
        }
      : {
          operation: 'count',
          input: cloneNetworkReference(template.input),
          output: resolveSignal(template.output, '$.output'),
        };

  for (const [parameter] of explicit) {
    if (!used.has(parameter)) {
      const registration = inspectBlueprintParameterHandle(parameter, '$.bindings');
      fail(
        '$.bindings',
        `parameter "${registration.label}" is not used by this template.`,
        registration.source,
        'CP1001',
      );
    }
  }

  return freezeDeep(concrete);
}
