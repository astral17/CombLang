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
  inspectDeciderConfigurationTemplate,
  type DeciderConfigurationTemplate,
  type DeciderTemplateCondition,
  type DeciderTemplateOutput,
} from './decider-configuration-template.js';
import type {
  DeciderProducerConfig,
  LogicalDeciderCondition,
  LogicalDeciderOutput,
  LogicalDeciderOutputSignal,
  LogicalNetworkRef,
} from './ir.js';

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

/** Resolves a Decider template atomically to a fresh concrete configuration for NCIR. */
export function bindDeciderConfigurationTemplate(
  templateValue: unknown,
  bindingsValue: readonly BlueprintParameterBinding[] = [],
): DeciderProducerConfig {
  const { session } = inspectDeciderConfigurationTemplate(templateValue, '$.template');
  const template = templateValue as DeciderConfigurationTemplate;
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
      'Decider constant values must be safe integers.',
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

  const resolveLeft = (
    left: Extract<DeciderTemplateCondition, { kind: 'compare' }>['left'],
    path: string,
  ) =>
    left.kind === 'signal'
      ? {
          kind: 'signal' as const,
          signal: resolveSignal(left.signal, `${path}.signal`),
          ...cloneNetworkReference(left),
        }
      : { kind: 'wildcard' as const, value: left.value, ...cloneNetworkReference(left) };

  const resolveOperand = (
    operand: Extract<DeciderTemplateCondition, { kind: 'compare' }>['right'],
    path: string,
  ) =>
    operand.kind === 'constant'
      ? { kind: 'constant' as const, value: resolveNumber(operand.value, `${path}.value`) }
      : {
          kind: 'signal' as const,
          signal: resolveSignal(operand.signal, `${path}.signal`),
          ...cloneNetworkReference(operand),
        };

  const resolveCondition = (
    node: DeciderTemplateCondition,
    path: string,
  ): LogicalDeciderCondition => {
    if (node.kind === 'and' || node.kind === 'or') {
      return {
        kind: node.kind,
        conditions: node.conditions.map((child, index) =>
          resolveCondition(child, `${path}.conditions[${index}]`),
        ),
      };
    }
    return {
      kind: 'compare',
      left: resolveLeft(node.left, `${path}.left`),
      comparator: node.comparator,
      right: resolveOperand(node.right, `${path}.right`),
    };
  };

  const resolveOutputSignal = (
    value: Extract<DeciderTemplateOutput, { mode: 'copy' }>['signal'],
    path: string,
  ): LogicalDeciderOutputSignal =>
    value.kind === 'wildcard'
      ? { kind: 'wildcard', value: value.value }
      : { kind: 'signal', signal: resolveSignal(value.signal, `${path}.signal`) };

  const resolveOutput = (value: DeciderTemplateOutput, path: string): LogicalDeciderOutput => {
    const signal = resolveOutputSignal(value.signal, `${path}.signal`);
    const input = value.input === undefined ? undefined : cloneNetworkReference(value.input);
    if (value.mode === 'copy') {
      return { mode: 'copy', signal, ...(input === undefined ? {} : { input }) };
    }
    return {
      mode: 'constant',
      signal,
      value: resolveNumber(value.value, `${path}.value`),
      ...(input === undefined ? {} : { input }),
    };
  };

  const concrete: DeciderProducerConfig = {
    condition: resolveCondition(template.condition, '$.condition'),
    outputs: template.outputs.map((entry, index) => resolveOutput(entry, `$.outputs[${index}]`)),
    ...(template.elseOutputs === undefined
      ? {}
      : {
          elseOutputs: template.elseOutputs.map((entry, index) =>
            resolveOutput(entry, `$.elseOutputs[${index}]`),
          ),
        }),
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
