import { constantConfigurationLimits, int32, signal, type SignalId } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';

import type { ArithmeticOperation, LogicalNetworkRef } from './ir.js';
import {
  assertBlueprintParameterExactKeys,
  assertBlueprintParameterNumberValue,
  canonicalizeBlueprintParameterSignal,
  createBlueprintParameterDataBudget,
  lookupBlueprintParameterSlot,
  openBlueprintParameterArray,
  openBlueprintParameterRecord,
  type BlueprintParameterDataBudget,
} from './blueprint-parameter-validation.js';
import {
  assertBlueprintParameterSession,
  BlueprintParameterError,
  findBlueprintParameterHandle,
  type BlueprintNumberParameterHandle,
  type BlueprintParameterSession,
  type BlueprintSignalParameterHandle,
} from './blueprint-parameters.js';

const arithmeticTemplateBrand: unique symbol = Symbol('arithmetic-configuration-template');

export type ArithmeticTemplateOperand =
  | { readonly kind: 'constant'; readonly value: number | BlueprintNumberParameterHandle }
  | ({
      readonly kind: 'signal';
      readonly signal: SignalId | BlueprintSignalParameterHandle;
    } & LogicalNetworkRef)
  | ({ readonly kind: 'each' } & LogicalNetworkRef);

export type ArithmeticTemplateOutput =
  | { readonly kind: 'signal'; readonly signal: SignalId | BlueprintSignalParameterHandle }
  | { readonly kind: 'each' };

export interface ArithmeticConfigurationTemplate {
  readonly [arithmeticTemplateBrand]: true;
  readonly left: ArithmeticTemplateOperand;
  readonly operation: ArithmeticOperation;
  readonly right: ArithmeticTemplateOperand;
  readonly output: ArithmeticTemplateOutput;
}

interface ArithmeticConfigurationTemplateData {
  readonly left: ArithmeticTemplateOperand;
  readonly operation: ArithmeticOperation;
  readonly right: ArithmeticTemplateOperand;
  readonly output: ArithmeticTemplateOutput;
}

export interface ArithmeticConfigurationTemplateRegistration {
  readonly session: BlueprintParameterSession;
}

interface ArithmeticTemplateBudget extends BlueprintParameterDataBudget {
  parameterBytes: number;
}

const arithmeticTemplateRegistrations = new WeakMap<
  object,
  ArithmeticConfigurationTemplateRegistration
>();

const operations: readonly ArithmeticOperation[] = [
  'add',
  'subtract',
  'multiply',
  'divide',
  'modulo',
  'power',
  'left-shift',
  'right-shift',
  'bit-and',
  'bit-or',
  'bit-xor',
];

function fail(path: string, message: string, code: 'CP1000' | 'CP1001' = 'CP1000'): never {
  throw new BlueprintParameterError(code, path, message);
}

function addParameterBudget(
  budget: ArithmeticTemplateBudget,
  registration: { readonly kind: string; readonly label: string; readonly defaultValue?: unknown },
  path: string,
): void {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      kind: registration.kind,
      label: registration.label,
      ...(registration.defaultValue === undefined
        ? {}
        : { defaultValue: registration.defaultValue }),
    }),
  ).byteLength;
  budget.parameterBytes += bytes;
  if (budget.parameterBytes > constantConfigurationLimits.maxBytes) {
    fail(path, `template exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`);
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function networkId(value: unknown, path: string): NetworkId {
  if (typeof value !== 'string' || value.length === 0) {
    fail(path, 'expected a non-empty concrete Network ID.');
  }
  return value as NetworkId;
}

function readNetworkReference(
  record: Record<string, unknown>,
  kind: 'signal' | 'each',
  path: string,
  depth: number,
  budget: ArithmeticTemplateBudget,
): LogicalNetworkRef {
  if (record.refKind === 'single') {
    assertBlueprintParameterExactKeys(
      record,
      ['kind', ...(kind === 'signal' ? ['signal'] : []), 'refKind', 'network'],
      path,
      'unknown Arithmetic template field.',
    );
    return {
      refKind: 'single',
      network: networkId(record.network, `${path}.network`),
    };
  }
  if (record.refKind === 'pair') {
    assertBlueprintParameterExactKeys(
      record,
      ['kind', ...(kind === 'signal' ? ['signal'] : []), 'refKind', 'networks'],
      path,
      'unknown Arithmetic template field.',
    );
    const networksPath = `${path}.networks`;
    const pair = openBlueprintParameterArray(record.networks, networksPath, depth + 1, budget);
    try {
      if (pair.value.length !== 2) {
        fail(networksPath, 'a pair network reference must contain exactly two IDs.');
      }
      return {
        refKind: 'pair',
        networks: Object.freeze([
          networkId(pair.value[0], `${networksPath}[0]`),
          networkId(pair.value[1], `${networksPath}[1]`),
        ]) as readonly [NetworkId, NetworkId],
      };
    } finally {
      pair.release();
    }
  }
  fail(`${path}.refKind`, 'expected a concrete single or pair network reference.');
}

function numberSlot(
  value: unknown,
  path: string,
  session: BlueprintParameterSession,
  budget: ArithmeticTemplateBudget,
): number | BlueprintNumberParameterHandle {
  const slot = lookupBlueprintParameterSlot(value, 'number', session, path);
  if (slot !== undefined) {
    addParameterBudget(budget, slot.registration, path);
    return slot.handle as BlueprintNumberParameterHandle;
  }
  return int32(assertBlueprintParameterNumberValue(value, path, 'safe-integer'));
}

function signalSlot(
  value: unknown,
  path: string,
  session: BlueprintParameterSession,
  budget: ArithmeticTemplateBudget,
): SignalId | BlueprintSignalParameterHandle {
  const slot = lookupBlueprintParameterSlot(value, 'signal', session, path);
  if (slot !== undefined) {
    addParameterBudget(budget, slot.registration, path);
    return slot.handle as BlueprintSignalParameterHandle;
  }
  return canonicalizeBlueprintParameterSignal(value, path);
}

function arithmeticOperand(
  value: unknown,
  path: string,
  depth: number,
  budget: ArithmeticTemplateBudget,
  session: BlueprintParameterSession,
): ArithmeticTemplateOperand {
  const opened = openBlueprintParameterRecord(value, path, depth, budget);
  try {
    const record = opened.value;
    if (record.kind === 'constant') {
      assertBlueprintParameterExactKeys(
        record,
        ['kind', 'value'],
        path,
        'unknown Arithmetic template field.',
      );
      if (!Object.hasOwn(record, 'value')) fail(`${path}.value`, 'field is required.');
      return {
        kind: 'constant',
        value: numberSlot(record.value, `${path}.value`, session, budget),
      };
    }
    if (record.kind === 'signal') {
      if (record.refKind !== 'single' && record.refKind !== 'pair') {
        fail(`${path}.refKind`, 'expected a concrete single or pair network reference.');
      }
      const reference = readNetworkReference(record, 'signal', path, depth, budget);
      return {
        kind: 'signal',
        signal: signalSlot(record.signal, `${path}.signal`, session, budget),
        ...reference,
      };
    }
    if (record.kind === 'each') {
      if (record.refKind !== 'single' && record.refKind !== 'pair') {
        fail(`${path}.refKind`, 'expected a concrete single or pair network reference.');
      }
      return {
        kind: 'each',
        ...readNetworkReference(record, 'each', path, depth, budget),
      };
    }
    fail(`${path}.kind`, 'expected a constant, signal, or each Arithmetic operand.');
  } finally {
    opened.release();
  }
}

function arithmeticOutput(
  value: unknown,
  path: string,
  depth: number,
  budget: ArithmeticTemplateBudget,
  session: BlueprintParameterSession,
): ArithmeticTemplateOutput {
  const opened = openBlueprintParameterRecord(value, path, depth, budget);
  try {
    if (opened.value.kind === 'each') {
      assertBlueprintParameterExactKeys(
        opened.value,
        ['kind'],
        path,
        'unknown Arithmetic template field.',
      );
      return { kind: 'each' };
    }
    if (opened.value.kind === 'signal') {
      assertBlueprintParameterExactKeys(
        opened.value,
        ['kind', 'signal'],
        path,
        'unknown Arithmetic template field.',
      );
      if (!Object.hasOwn(opened.value, 'signal')) fail(`${path}.signal`, 'field is required.');
      return {
        kind: 'signal',
        signal: signalSlot(opened.value.signal, `${path}.signal`, session, budget),
      };
    }
    fail(`${path}.kind`, 'expected a signal or each Arithmetic output.');
  } finally {
    opened.release();
  }
}

/** Creates a bounded immutable symbolic Arithmetic config without changing NCIR types. */
export function createArithmeticConfigurationTemplate(
  session: BlueprintParameterSession,
  value: unknown,
): ArithmeticConfigurationTemplate {
  assertBlueprintParameterSession(session, '$.session');
  const budget: ArithmeticTemplateBudget = {
    ...createBlueprintParameterDataBudget(),
    parameterBytes: 0,
  };
  const root = openBlueprintParameterRecord(value, '$', 0, budget);
  let skeleton: ArithmeticConfigurationTemplateData;
  try {
    assertBlueprintParameterExactKeys(
      root.value,
      ['left', 'operation', 'right', 'output'],
      '$',
      'unknown Arithmetic template field.',
    );
    for (const key of ['left', 'operation', 'right', 'output']) {
      if (!Object.hasOwn(root.value, key)) fail(`$.${key}`, 'field is required.');
    }
    if (!operations.includes(root.value.operation as ArithmeticOperation)) {
      fail('$.operation', 'expected a supported Arithmetic operation.');
    }
    skeleton = {
      left: arithmeticOperand(root.value.left, '$.left', 1, budget, session),
      operation: root.value.operation as ArithmeticOperation,
      right: arithmeticOperand(root.value.right, '$.right', 1, budget, session),
      output: arithmeticOutput(root.value.output, '$.output', 1, budget, session),
    };
  } finally {
    root.release();
  }

  const templateBytes = new TextEncoder().encode(
    JSON.stringify(skeleton, (_key, child: unknown) => {
      const parameter = findBlueprintParameterHandle(child);
      if (parameter === undefined) return child;
      return parameter.kind === 'number' ? 0 : signal('virtual', 'signal-template-placeholder');
    }),
  ).byteLength;
  if (templateBytes + budget.parameterBytes > constantConfigurationLimits.maxBytes) {
    fail('$', `template exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`);
  }
  const template = freezeDeep({
    [arithmeticTemplateBrand]: true as const,
    ...skeleton,
  });
  arithmeticTemplateRegistrations.set(template, Object.freeze({ session }));
  return template;
}

/** Verifies template provenance before the corresponding atomic binder traverses it. */
export function inspectArithmeticConfigurationTemplate(
  value: unknown,
  path: string,
): ArithmeticConfigurationTemplateRegistration {
  if (value === null || typeof value !== 'object') {
    throw new BlueprintParameterError(
      'CP1002',
      path,
      'value is not a registered Arithmetic template.',
    );
  }
  const registration = arithmeticTemplateRegistrations.get(value);
  if (registration === undefined) {
    throw new BlueprintParameterError(
      'CP1002',
      path,
      'value is not a registered Arithmetic template.',
    );
  }
  return registration;
}
