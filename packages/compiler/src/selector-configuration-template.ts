import { constantConfigurationLimits, int32, type SignalId } from '@comblang/factorio';
import type { NetworkId, SourceSpan } from '@comblang/shared';

import { freezeConfigurationData } from './blueprint-configuration-utils.js';
import type { LogicalNetworkRef } from './ir.js';
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
  type BlueprintParameterHandle,
  type BlueprintNumberParameterHandle,
  type BlueprintParameterSession,
  type BlueprintSignalParameterHandle,
} from './blueprint-parameters.js';

const selectorTemplateBrand: unique symbol = Symbol('selector-configuration-template');

type SelectorTemplateIndex =
  number | SignalId | BlueprintNumberParameterHandle | BlueprintSignalParameterHandle;

interface SelectorTemplateBase {
  readonly [selectorTemplateBrand]: true;
  readonly input: LogicalNetworkRef;
}

type SelectorConfigurationTemplateData<T = SelectorConfigurationTemplate> = T extends unknown
  ? Omit<T, typeof selectorTemplateBrand>
  : never;

export type SelectorConfigurationTemplate =
  | (SelectorTemplateBase & {
      readonly operation: 'select';
      readonly selectMax: boolean;
      readonly index: SelectorTemplateIndex;
    })
  | (SelectorTemplateBase & {
      readonly operation: 'count';
      readonly output: SignalId | BlueprintSignalParameterHandle;
    });

export interface SelectorConfigurationTemplateRegistration {
  readonly session: BlueprintParameterSession;
  readonly usedParameters: readonly BlueprintParameterHandle[];
}

interface SelectorTemplateBudget extends BlueprintParameterDataBudget {
  parameterBytes: number;
}

const templateRegistrations = new WeakMap<object, SelectorConfigurationTemplateRegistration>();

function fail(
  path: string,
  message: string,
  code: 'CP1000' | 'CP1001' | 'CP1002' = 'CP1000',
  span?: SourceSpan,
): never {
  throw new BlueprintParameterError(code, path, message, span);
}

function rejectRegisteredHandle(value: unknown, path: string): void {
  const registration = findBlueprintParameterHandle(value);
  if (registration !== undefined) {
    fail(
      path,
      'parameter references are allowed only in Selector index or count-output slots.',
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

function assertSelectorExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) rejectParameterOutsideSlot(record[key], `${path}.${key}`);
  }
  assertBlueprintParameterExactKeys(record, keys, path, 'unknown Selector template field.');
}

function accountParameter(
  budget: SelectorTemplateBudget,
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

function networkId(value: unknown, path: string): NetworkId {
  rejectParameterOutsideSlot(value, path);
  if (typeof value !== 'string' || value.length === 0) {
    fail(path, 'expected a non-empty concrete Network ID.');
  }
  return value as NetworkId;
}

function networkReference(
  value: unknown,
  path: string,
  depth: number,
  budget: SelectorTemplateBudget,
): LogicalNetworkRef {
  rejectRegisteredHandle(value, path);
  const opened = openBlueprintParameterRecord(value, path, depth, budget);
  try {
    const record = opened.value;
    rejectParameterOutsideSlot(record.refKind, `${path}.refKind`);
    if (record.refKind === 'single') {
      assertSelectorExactKeys(record, ['refKind', 'network'], path);
      if (!Object.hasOwn(record, 'network')) fail(`${path}.network`, 'field is required.');
      return { refKind: 'single', network: networkId(record.network, `${path}.network`) };
    }
    if (record.refKind === 'pair') {
      assertSelectorExactKeys(record, ['refKind', 'networks'], path);
      if (!Object.hasOwn(record, 'networks')) fail(`${path}.networks`, 'field is required.');
      const networksPath = `${path}.networks`;
      rejectParameterOutsideSlot(record.networks, networksPath);
      const pair = openBlueprintParameterArray(record.networks, networksPath, depth + 1, budget);
      try {
        if (pair.value.length !== 2) {
          fail(networksPath, 'a pair network reference must contain exactly two IDs.');
        }
        const first = networkId(pair.value[0], `${networksPath}[0]`);
        const second = networkId(pair.value[1], `${networksPath}[1]`);
        if (first === second) fail(networksPath, 'a pair network reference needs distinct IDs.');
        return {
          refKind: 'pair',
          networks: Object.freeze([first, second]) as readonly [NetworkId, NetworkId],
        };
      } finally {
        pair.release();
      }
    }
    fail(`${path}.refKind`, 'expected a concrete single or pair network reference.');
  } finally {
    opened.release();
  }
}

function numberSlot(
  value: unknown,
  path: string,
  session: BlueprintParameterSession,
  budget: SelectorTemplateBudget,
): number | BlueprintNumberParameterHandle {
  const slot = lookupBlueprintParameterSlot(value, 'number', session, path);
  if (slot !== undefined) {
    accountParameter(budget, slot.registration, path);
    budget.usedParameters.add(slot.handle);
    return slot.handle as BlueprintNumberParameterHandle;
  }
  return int32(assertBlueprintParameterNumberValue(value, path, 'safe-integer'));
}

function signalSlot(
  value: unknown,
  path: string,
  session: BlueprintParameterSession,
  budget: SelectorTemplateBudget,
): SignalId | BlueprintSignalParameterHandle {
  const slot = lookupBlueprintParameterSlot(value, 'signal', session, path);
  if (slot !== undefined) {
    accountParameter(budget, slot.registration, path);
    budget.usedParameters.add(slot.handle);
    return slot.handle as BlueprintSignalParameterHandle;
  }
  return canonicalizeBlueprintParameterSignal(value, path);
}

function selectIndex(
  value: unknown,
  path: string,
  session: BlueprintParameterSession,
  budget: SelectorTemplateBudget,
): SelectorTemplateIndex {
  const registration = findBlueprintParameterHandle(value);
  if (registration?.kind === 'number') return numberSlot(value, path, session, budget);
  if (registration?.kind === 'signal') return signalSlot(value, path, session, budget);
  if (isBlueprintParameterShaped(value)) {
    // A forged handle is not interpreted as a concrete SignalId.
    lookupBlueprintParameterSlot(value, 'number', session, path);
  }
  if (typeof value === 'number') {
    return int32(assertBlueprintParameterNumberValue(value, path, 'safe-integer'));
  }
  return canonicalizeBlueprintParameterSignal(value, path);
}

/** Creates a bounded immutable symbolic template for the current Selector union. */
export function createSelectorConfigurationTemplate(
  session: BlueprintParameterSession,
  value: unknown,
): SelectorConfigurationTemplate {
  assertBlueprintParameterSession(session, '$.session');
  const budget: SelectorTemplateBudget = {
    ...createBlueprintParameterDataBudget(),
    parameterBytes: 0,
  };
  rejectRegisteredHandle(value, '$');
  const root = openBlueprintParameterRecord(value, '$', 0, budget);
  let skeleton: SelectorConfigurationTemplateData;
  try {
    rejectParameterOutsideSlot(root.value.operation, '$.operation');
    if (root.value.operation === 'select') {
      assertSelectorExactKeys(root.value, ['operation', 'input', 'selectMax', 'index'], '$');
      for (const key of ['input', 'selectMax', 'index'] as const) {
        if (!Object.hasOwn(root.value, key)) fail(`$.${key}`, 'field is required.');
      }
      rejectParameterOutsideSlot(root.value.selectMax, '$.selectMax');
      if (typeof root.value.selectMax !== 'boolean') {
        fail('$.selectMax', 'expected a concrete boolean.');
      }
      skeleton = {
        operation: 'select',
        input: networkReference(root.value.input, '$.input', 1, budget),
        selectMax: root.value.selectMax,
        index: selectIndex(root.value.index, '$.index', session, budget),
      };
    } else if (root.value.operation === 'count') {
      assertSelectorExactKeys(root.value, ['operation', 'input', 'output'], '$');
      for (const key of ['input', 'output'] as const) {
        if (!Object.hasOwn(root.value, key)) fail(`$.${key}`, 'field is required.');
      }
      skeleton = {
        operation: 'count',
        input: networkReference(root.value.input, '$.input', 1, budget),
        output: signalSlot(root.value.output, '$.output', session, budget),
      };
    } else {
      fail('$.operation', 'expected the concrete Selector operation select or count.');
    }
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
  const template = freezeConfigurationData({ [selectorTemplateBrand]: true as const, ...skeleton });
  templateRegistrations.set(
    template,
    Object.freeze({ session, usedParameters: Object.freeze([...budget.usedParameters]) }),
  );
  return template;
}

/** Authenticates a template and returns the nominal parameter owner for its binder. */
export function inspectSelectorConfigurationTemplate(
  value: unknown,
  path: string,
): SelectorConfigurationTemplateRegistration {
  if (value === null || typeof value !== 'object') {
    throw new BlueprintParameterError(
      'CP1002',
      path,
      'value is not a registered Selector template.',
    );
  }
  const registration = templateRegistrations.get(value);
  if (registration === undefined) {
    throw new BlueprintParameterError(
      'CP1002',
      path,
      'value is not a registered Selector template.',
    );
  }
  return registration;
}
