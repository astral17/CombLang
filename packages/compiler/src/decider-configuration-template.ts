import { constantConfigurationLimits, int32, type SignalId } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';

import type { Comparator, LogicalNetworkRef, Quantifier } from './ir.js';
import {
  assertBlueprintParameterExactKeys,
  assertBlueprintParameterNumberValue,
  canonicalizeBlueprintParameterSignal,
  createBlueprintParameterDataBudget,
  isBlueprintParameterShaped,
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

const deciderTemplateBrand: unique symbol = Symbol('decider-configuration-template');

type TemplateSignalSlot = SignalId | BlueprintSignalParameterHandle;
type TemplateNumberSlot = number | BlueprintNumberParameterHandle;

type DeciderTemplateConditionLeft =
  | ({ readonly kind: 'signal'; readonly signal: TemplateSignalSlot } & LogicalNetworkRef)
  | ({ readonly kind: 'wildcard'; readonly value: Quantifier } & LogicalNetworkRef);

type DeciderTemplateScalarOperand =
  | { readonly kind: 'constant'; readonly value: TemplateNumberSlot }
  | ({ readonly kind: 'signal'; readonly signal: TemplateSignalSlot } & LogicalNetworkRef);

export type DeciderTemplateCondition =
  | {
      readonly kind: 'compare';
      readonly left: DeciderTemplateConditionLeft;
      readonly comparator: Comparator;
      readonly right: DeciderTemplateScalarOperand;
    }
  | { readonly kind: 'and'; readonly conditions: readonly DeciderTemplateCondition[] }
  | { readonly kind: 'or'; readonly conditions: readonly DeciderTemplateCondition[] };

type DeciderTemplateOutputSignal =
  | { readonly kind: 'signal'; readonly signal: TemplateSignalSlot }
  | { readonly kind: 'wildcard'; readonly value: Quantifier };

export type DeciderTemplateOutput =
  | {
      readonly mode: 'copy';
      readonly signal: DeciderTemplateOutputSignal;
      readonly input?: LogicalNetworkRef;
    }
  | {
      readonly mode: 'constant';
      readonly signal: DeciderTemplateOutputSignal;
      readonly value: TemplateNumberSlot;
      readonly input?: LogicalNetworkRef;
    };

export interface DeciderConfigurationTemplate {
  readonly [deciderTemplateBrand]: true;
  readonly condition: DeciderTemplateCondition;
  readonly outputs: readonly DeciderTemplateOutput[];
  readonly elseOutputs?: readonly DeciderTemplateOutput[];
}

export interface DeciderConfigurationTemplateRegistration {
  readonly session: BlueprintParameterSession;
}

interface DeciderTemplateBudget extends BlueprintParameterDataBudget {
  parameterBytes: number;
}

interface DeciderConfigurationTemplateData {
  readonly condition: DeciderTemplateCondition;
  readonly outputs: readonly DeciderTemplateOutput[];
  readonly elseOutputs?: readonly DeciderTemplateOutput[];
}

const templateRegistrations = new WeakMap<object, DeciderConfigurationTemplateRegistration>();

const comparators: readonly Comparator[] = ['>', '<', '=', '>=', '<=', '!='];
const quantifiers: readonly Quantifier[] = ['each', 'anything', 'everything'];

function fail(
  path: string,
  message: string,
  code: 'CP1000' | 'CP1001' | 'CP1002' = 'CP1000',
  span?: import('@comblang/shared').SourceSpan,
): never {
  throw new BlueprintParameterError(code, path, message, span);
}

function rejectRegisteredHandle(value: unknown, path: string): void {
  const registration = findBlueprintParameterHandle(value);
  if (registration !== undefined) {
    fail(
      path,
      'parameter references are allowed only in signal operands, constant right operands, and Signal output or constant-value slots.',
      'CP1001',
      registration.source,
    );
  }
}

function rejectParameterOutsideSlot(value: unknown, path: string): void {
  rejectRegisteredHandle(value, path);
  if (isBlueprintParameterShaped(value)) {
    fail(path, 'unregistered parameter-like object.', 'CP1001');
  }
}

function assertDeciderExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  message = 'unknown Decider template field.',
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) rejectParameterOutsideSlot(record[key], `${path}.${key}`);
  }
  assertBlueprintParameterExactKeys(record, keys, path, message);
}

function accountParameter(
  budget: DeciderTemplateBudget,
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
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function networkId(value: unknown, path: string): NetworkId {
  rejectParameterOutsideSlot(value, path);
  if (typeof value !== 'string' || value.length === 0) {
    fail(path, 'expected a non-empty concrete Network ID.');
  }
  return value as NetworkId;
}

function networkReference(
  record: Record<string, unknown>,
  fixedKeys: readonly string[],
  path: string,
  depth: number,
  budget: DeciderTemplateBudget,
): LogicalNetworkRef {
  rejectParameterOutsideSlot(record.refKind, `${path}.refKind`);
  if (record.refKind === 'single') {
    assertDeciderExactKeys(
      record,
      [...fixedKeys, 'refKind', 'network'],
      path,
      'unknown Decider template field.',
    );
    if (!Object.hasOwn(record, 'network')) fail(`${path}.network`, 'field is required.');
    return { refKind: 'single', network: networkId(record.network, `${path}.network`) };
  }
  if (record.refKind === 'pair') {
    assertDeciderExactKeys(
      record,
      [...fixedKeys, 'refKind', 'networks'],
      path,
      'unknown Decider template field.',
    );
    if (!Object.hasOwn(record, 'networks')) fail(`${path}.networks`, 'field is required.');
    const networksPath = `${path}.networks`;
    rejectParameterOutsideSlot(record.networks, networksPath);
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
  budget: DeciderTemplateBudget,
): TemplateNumberSlot {
  const slot = lookupBlueprintParameterSlot(value, 'number', session, path);
  if (slot !== undefined) {
    accountParameter(budget, slot.registration, path);
    return slot.handle as BlueprintNumberParameterHandle;
  }
  return int32(assertBlueprintParameterNumberValue(value, path, 'safe-integer'));
}

function signalSlot(
  value: unknown,
  path: string,
  session: BlueprintParameterSession,
  budget: DeciderTemplateBudget,
): TemplateSignalSlot {
  const slot = lookupBlueprintParameterSlot(value, 'signal', session, path);
  if (slot !== undefined) {
    accountParameter(budget, slot.registration, path);
    return slot.handle as BlueprintSignalParameterHandle;
  }
  return canonicalizeBlueprintParameterSignal(value, path);
}

function quantifier(value: unknown, path: string): Quantifier {
  rejectParameterOutsideSlot(value, path);
  if (typeof value !== 'string' || !quantifiers.includes(value as Quantifier)) {
    fail(path, 'expected a concrete Decider wildcard quantifier.');
  }
  return value as Quantifier;
}

function conditionLeft(
  value: unknown,
  path: string,
  depth: number,
  budget: DeciderTemplateBudget,
  session: BlueprintParameterSession,
): DeciderTemplateConditionLeft {
  rejectRegisteredHandle(value, path);
  const opened = openBlueprintParameterRecord(value, path, depth, budget);
  try {
    const record = opened.value;
    rejectParameterOutsideSlot(record.kind, `${path}.kind`);
    if (record.kind === 'signal') {
      const reference = networkReference(record, ['kind', 'signal'], path, depth, budget);
      if (!Object.hasOwn(record, 'signal')) fail(`${path}.signal`, 'field is required.');
      return {
        kind: 'signal',
        signal: signalSlot(record.signal, `${path}.signal`, session, budget),
        ...reference,
      };
    }
    if (record.kind === 'wildcard') {
      const reference = networkReference(record, ['kind', 'value'], path, depth, budget);
      if (!Object.hasOwn(record, 'value')) fail(`${path}.value`, 'field is required.');
      return {
        kind: 'wildcard',
        value: quantifier(record.value, `${path}.value`),
        ...reference,
      };
    }
    fail(`${path}.kind`, 'expected a Signal or wildcard Decider condition operand.');
  } finally {
    opened.release();
  }
}

function scalarOperand(
  value: unknown,
  path: string,
  depth: number,
  budget: DeciderTemplateBudget,
  session: BlueprintParameterSession,
): DeciderTemplateScalarOperand {
  rejectRegisteredHandle(value, path);
  const opened = openBlueprintParameterRecord(value, path, depth, budget);
  try {
    const record = opened.value;
    rejectParameterOutsideSlot(record.kind, `${path}.kind`);
    if (record.kind === 'constant') {
      assertDeciderExactKeys(record, ['kind', 'value'], path, 'unknown Decider template field.');
      if (!Object.hasOwn(record, 'value')) fail(`${path}.value`, 'field is required.');
      return {
        kind: 'constant',
        value: numberSlot(record.value, `${path}.value`, session, budget),
      };
    }
    if (record.kind === 'signal') {
      const reference = networkReference(record, ['kind', 'signal'], path, depth, budget);
      if (!Object.hasOwn(record, 'signal')) fail(`${path}.signal`, 'field is required.');
      return {
        kind: 'signal',
        signal: signalSlot(record.signal, `${path}.signal`, session, budget),
        ...reference,
      };
    }
    fail(`${path}.kind`, 'expected a constant or Signal Decider operand.');
  } finally {
    opened.release();
  }
}

function condition(
  value: unknown,
  path: string,
  depth: number,
  budget: DeciderTemplateBudget,
  session: BlueprintParameterSession,
): DeciderTemplateCondition {
  rejectRegisteredHandle(value, path);
  const opened = openBlueprintParameterRecord(value, path, depth, budget);
  try {
    const record = opened.value;
    rejectParameterOutsideSlot(record.kind, `${path}.kind`);
    if (record.kind === 'and' || record.kind === 'or') {
      assertDeciderExactKeys(
        record,
        ['kind', 'conditions'],
        path,
        'unknown Decider template field.',
      );
      if (!Object.hasOwn(record, 'conditions')) fail(`${path}.conditions`, 'field is required.');
      const conditionsPath = `${path}.conditions`;
      rejectParameterOutsideSlot(record.conditions, conditionsPath);
      const entries = openBlueprintParameterArray(
        record.conditions,
        conditionsPath,
        depth + 1,
        budget,
      );
      try {
        return {
          kind: record.kind,
          conditions: Object.freeze(
            entries.value.map((entry, index) =>
              condition(entry, `${conditionsPath}[${index}]`, depth + 2, budget, session),
            ),
          ),
        };
      } finally {
        entries.release();
      }
    }
    if (record.kind === 'compare') {
      assertDeciderExactKeys(
        record,
        ['kind', 'left', 'comparator', 'right'],
        path,
        'unknown Decider template field.',
      );
      for (const key of ['left', 'comparator', 'right'] as const) {
        if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, 'field is required.');
      }
      rejectParameterOutsideSlot(record.comparator, `${path}.comparator`);
      if (!comparators.includes(record.comparator as Comparator)) {
        fail(`${path}.comparator`, 'expected a supported Decider comparator.');
      }
      return {
        kind: 'compare',
        left: conditionLeft(record.left, `${path}.left`, depth + 1, budget, session),
        comparator: record.comparator as Comparator,
        right: scalarOperand(record.right, `${path}.right`, depth + 1, budget, session),
      };
    }
    fail(`${path}.kind`, 'expected a compare, and, or Decider condition.');
  } finally {
    opened.release();
  }
}

function outputSignal(
  value: unknown,
  path: string,
  depth: number,
  budget: DeciderTemplateBudget,
  session: BlueprintParameterSession,
): DeciderTemplateOutputSignal {
  rejectRegisteredHandle(value, path);
  const opened = openBlueprintParameterRecord(value, path, depth, budget);
  try {
    const record = opened.value;
    rejectParameterOutsideSlot(record.kind, `${path}.kind`);
    if (record.kind === 'signal') {
      assertDeciderExactKeys(record, ['kind', 'signal'], path, 'unknown Decider template field.');
      if (!Object.hasOwn(record, 'signal')) fail(`${path}.signal`, 'field is required.');
      return {
        kind: 'signal',
        signal: signalSlot(record.signal, `${path}.signal`, session, budget),
      };
    }
    if (record.kind === 'wildcard') {
      assertDeciderExactKeys(record, ['kind', 'value'], path, 'unknown Decider template field.');
      if (!Object.hasOwn(record, 'value')) fail(`${path}.value`, 'field is required.');
      return { kind: 'wildcard', value: quantifier(record.value, `${path}.value`) };
    }
    fail(`${path}.kind`, 'expected a Signal or wildcard Decider output.');
  } finally {
    opened.release();
  }
}

function outputNetworkReference(
  value: unknown,
  path: string,
  depth: number,
  budget: DeciderTemplateBudget,
): LogicalNetworkRef {
  rejectRegisteredHandle(value, path);
  const opened = openBlueprintParameterRecord(value, path, depth, budget);
  try {
    return networkReference(opened.value, [], path, depth, budget);
  } finally {
    opened.release();
  }
}

function output(
  value: unknown,
  path: string,
  depth: number,
  budget: DeciderTemplateBudget,
  session: BlueprintParameterSession,
): DeciderTemplateOutput {
  rejectRegisteredHandle(value, path);
  const opened = openBlueprintParameterRecord(value, path, depth, budget);
  try {
    const record = opened.value;
    rejectParameterOutsideSlot(record.mode, `${path}.mode`);
    if (record.mode !== 'copy' && record.mode !== 'constant') {
      fail(`${path}.mode`, 'expected copy or constant Decider output mode.');
    }
    assertDeciderExactKeys(
      record,
      ['mode', 'signal', 'value', 'input'],
      path,
      'unknown Decider template field.',
    );
    if (!Object.hasOwn(record, 'signal')) fail(`${path}.signal`, 'field is required.');
    if (Object.hasOwn(record, 'input') && record.input === undefined) {
      fail(`${path}.input`, 'optional Decider output input must be omitted when unused.');
    }
    const signalValue = outputSignal(record.signal, `${path}.signal`, depth + 1, budget, session);
    const input =
      record.input === undefined
        ? undefined
        : outputNetworkReference(record.input, `${path}.input`, depth + 1, budget);
    if (record.mode === 'constant') {
      if (!Object.hasOwn(record, 'value')) fail(`${path}.value`, 'field is required.');
      return {
        mode: 'constant',
        signal: signalValue,
        value: numberSlot(record.value, `${path}.value`, session, budget),
        ...(input === undefined ? {} : { input }),
      };
    }
    if (Object.hasOwn(record, 'value')) {
      rejectParameterOutsideSlot(record.value, `${path}.value`);
      fail(`${path}.value`, 'copy output must not contain a value.');
    }
    return { mode: 'copy', signal: signalValue, ...(input === undefined ? {} : { input }) };
  } finally {
    opened.release();
  }
}

function outputRows(
  value: unknown,
  path: string,
  depth: number,
  budget: DeciderTemplateBudget,
  session: BlueprintParameterSession,
): readonly DeciderTemplateOutput[] {
  rejectRegisteredHandle(value, path);
  const entries = openBlueprintParameterArray(value, path, depth, budget);
  try {
    return Object.freeze(
      entries.value.map((entry, index) =>
        output(entry, `${path}[${index}]`, depth + 1, budget, session),
      ),
    );
  } finally {
    entries.release();
  }
}

/** Creates a bounded immutable symbolic Decider config above the concrete NCIR seam. */
export function createDeciderConfigurationTemplate(
  session: BlueprintParameterSession,
  value: unknown,
): DeciderConfigurationTemplate {
  assertBlueprintParameterSession(session, '$.session');
  const budget: DeciderTemplateBudget = {
    ...createBlueprintParameterDataBudget(),
    parameterBytes: 0,
  };
  rejectRegisteredHandle(value, '$');
  const root = openBlueprintParameterRecord(value, '$', 0, budget);
  let skeleton: DeciderConfigurationTemplateData;
  try {
    assertDeciderExactKeys(
      root.value,
      ['condition', 'outputs', 'elseOutputs'],
      '$',
      'unknown Decider template field.',
    );
    if (!Object.hasOwn(root.value, 'condition')) fail('$.condition', 'field is required.');
    if (!Object.hasOwn(root.value, 'outputs')) fail('$.outputs', 'field is required.');
    const elseOutputs =
      root.value.elseOutputs === undefined
        ? undefined
        : outputRows(root.value.elseOutputs, '$.elseOutputs', 1, budget, session);
    skeleton = {
      condition: condition(root.value.condition, '$.condition', 1, budget, session),
      outputs: outputRows(root.value.outputs, '$.outputs', 1, budget, session),
      ...(elseOutputs === undefined ? {} : { elseOutputs }),
    };
  } finally {
    root.release();
  }

  const templateBytes = new TextEncoder().encode(
    JSON.stringify(skeleton, (_key, child: unknown) => {
      const parameter = findBlueprintParameterHandle(child);
      if (parameter === undefined) return child;
      return parameter.kind === 'number'
        ? 0
        : { type: 'virtual', name: 'signal-template-placeholder' };
    }),
  ).byteLength;
  if (templateBytes + budget.parameterBytes > constantConfigurationLimits.maxBytes) {
    fail('$', `template exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`);
  }
  const template = freezeDeep({ [deciderTemplateBrand]: true as const, ...skeleton });
  templateRegistrations.set(template, Object.freeze({ session }));
  return template;
}

/** Authenticates a template and returns the nominal parameter owner for its binder. */
export function inspectDeciderConfigurationTemplate(
  value: unknown,
  path: string,
): DeciderConfigurationTemplateRegistration {
  if (value === null || typeof value !== 'object') {
    throw new BlueprintParameterError(
      'CP1002',
      path,
      'value is not a registered Decider template.',
    );
  }
  const registration = templateRegistrations.get(value);
  if (registration === undefined) {
    throw new BlueprintParameterError(
      'CP1002',
      path,
      'value is not a registered Decider template.',
    );
  }
  return registration;
}
