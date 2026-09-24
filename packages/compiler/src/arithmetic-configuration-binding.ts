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
  inspectBlueprintParameterHandle,
} from './blueprint-parameters.js';
import {
  inspectArithmeticConfigurationTemplate,
  type ArithmeticConfigurationTemplate,
  type ArithmeticTemplateOperand,
  type ArithmeticTemplateOutput,
} from './arithmetic-configuration-template.js';
import type { ArithmeticProducerConfig, LogicalNetworkRef } from './ir.js';

function fail(
  path: string,
  message: string,
  span?: SourceSpan,
  code: 'CP1000' | 'CP1001' | 'CP1002' = 'CP1000',
): never {
  throw new BlueprintParameterError(code, path, message, span);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function cloneNetworkReference(reference: LogicalNetworkRef): LogicalNetworkRef {
  return reference.refKind === 'single'
    ? { refKind: 'single', network: reference.network }
    : { refKind: 'pair', networks: [reference.networks[0], reference.networks[1]] };
}

/** Resolves one Arithmetic template completely before returning concrete config for NCIR. */
export function bindArithmeticConfigurationTemplate(
  templateValue: unknown,
  bindingsValue: readonly BlueprintParameterBinding[] = [],
): ArithmeticProducerConfig {
  const { session } = inspectArithmeticConfigurationTemplate(templateValue, '$.template');
  const template = templateValue as ArithmeticConfigurationTemplate;
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
      'Arithmetic literal values must be safe integers.',
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

  const resolveOperand = (operand: ArithmeticTemplateOperand, path: string) => {
    if (operand.kind === 'constant') {
      return {
        kind: 'constant' as const,
        value: resolveNumber(operand.value, `${path}.value`),
      };
    }
    if (operand.kind === 'each') {
      return { kind: 'each' as const, ...cloneNetworkReference(operand) };
    }
    return {
      kind: 'signal' as const,
      signal: resolveSignal(operand.signal, `${path}.signal`),
      ...cloneNetworkReference(operand),
    };
  };

  const resolveOutput = (output: ArithmeticTemplateOutput) =>
    output.kind === 'each'
      ? { kind: 'each' as const }
      : { kind: 'signal' as const, signal: resolveSignal(output.signal, '$.output.signal') };

  const concrete: ArithmeticProducerConfig = {
    left: resolveOperand(template.left, '$.left'),
    operation: template.operation,
    right: resolveOperand(template.right, '$.right'),
    output: resolveOutput(template.output),
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
