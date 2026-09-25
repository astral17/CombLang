import type { ConstantConfiguration } from '@comblang/factorio';

import type {
  ArithmeticProducerConfig,
  DeciderProducerConfig,
  SelectorProducerConfig,
} from './ir.js';
import {
  assertBlueprintParameterExactKeys,
  createBlueprintParameterDataBudget,
  openBlueprintParameterArray,
  openBlueprintParameterRecord,
} from './blueprint-parameter-validation.js';
import {
  assertBlueprintParameterSession,
  BlueprintParameterError,
  type BlueprintParameterHandle,
  type BlueprintParameterSession,
} from './blueprint-parameters.js';
import {
  inspectArithmeticConfigurationTemplate,
  type ArithmeticConfigurationTemplate,
} from './arithmetic-configuration-template.js';
import {
  inspectConstantConfigurationTemplate,
  type ConstantConfigurationTemplate,
} from './constant-configuration-template.js';
import {
  inspectDeciderConfigurationTemplate,
  type DeciderConfigurationTemplate,
} from './decider-configuration-template.js';
import {
  inspectSelectorConfigurationTemplate,
  type SelectorConfigurationTemplate,
} from './selector-configuration-template.js';

const configurationSetBrand: unique symbol = Symbol('blueprint-configuration-set');

export type BlueprintConfigurationKind = 'constant' | 'arithmetic' | 'decider' | 'selector';

export type BlueprintConfigurationTemplate =
  | ConstantConfigurationTemplate
  | ArithmeticConfigurationTemplate
  | DeciderConfigurationTemplate
  | SelectorConfigurationTemplate;

export type BlueprintConfigurationSetEntry =
  | {
      readonly key: string;
      readonly kind: 'constant';
      readonly template: ConstantConfigurationTemplate;
    }
  | {
      readonly key: string;
      readonly kind: 'arithmetic';
      readonly template: ArithmeticConfigurationTemplate;
    }
  | {
      readonly key: string;
      readonly kind: 'decider';
      readonly template: DeciderConfigurationTemplate;
    }
  | {
      readonly key: string;
      readonly kind: 'selector';
      readonly template: SelectorConfigurationTemplate;
    };

export interface BlueprintConfigurationSet {
  readonly [configurationSetBrand]: true;
  readonly entries: readonly BlueprintConfigurationSetEntry[];
}

export interface BlueprintConfigurationSetRegistration {
  readonly session: BlueprintParameterSession;
  readonly entries: readonly BlueprintConfigurationSetEntry[];
}

type InspectedTemplate = {
  readonly kind: BlueprintConfigurationKind;
  readonly session: BlueprintParameterSession;
  readonly usedParameters: readonly BlueprintParameterHandle[];
};

const configurationSetRegistrations = new WeakMap<object, BlueprintConfigurationSetRegistration>();
const supportedKinds: readonly BlueprintConfigurationKind[] = [
  'constant',
  'arithmetic',
  'decider',
  'selector',
];
const maxConfigurationKeyLength = 128;

function fail(code: 'CP1000' | 'CP1001' | 'CP1002', path: string, message: string): never {
  throw new BlueprintParameterError(code, path, message);
}

function inspectTemplate(value: unknown, path: string): InspectedTemplate {
  const inspectors = [
    ['constant', inspectConstantConfigurationTemplate],
    ['arithmetic', inspectArithmeticConfigurationTemplate],
    ['decider', inspectDeciderConfigurationTemplate],
    ['selector', inspectSelectorConfigurationTemplate],
  ] as const;
  for (const [kind, inspect] of inspectors) {
    try {
      const registration = inspect(value, path);
      return { kind, ...registration };
    } catch (error) {
      if (!(error instanceof BlueprintParameterError) || error.code !== 'CP1002') throw error;
    }
  }
  fail('CP1002', path, 'value is not a registered configuration template.');
}

/** Creates an authenticated, bounded ordered group of same-session leaf templates. */
export function createBlueprintConfigurationSet(
  session: BlueprintParameterSession,
  entriesValue: unknown,
): BlueprintConfigurationSet {
  assertBlueprintParameterSession(session, '$.session');
  const budget = createBlueprintParameterDataBudget();
  const opened = openBlueprintParameterArray(entriesValue, '$.entries', 0, budget);
  let entries: readonly BlueprintConfigurationSetEntry[];
  try {
    const keys = new Set<string>();
    entries = Object.freeze(
      opened.value.map((entryValue, index) => {
        const path = `$.entries[${index}]`;
        const entry = openBlueprintParameterRecord(entryValue, path, 1, budget);
        try {
          assertBlueprintParameterExactKeys(
            entry.value,
            ['key', 'kind', 'template'],
            path,
            'unknown configuration-set entry field.',
          );
          for (const key of ['key', 'kind', 'template'] as const) {
            if (!Object.hasOwn(entry.value, key))
              fail('CP1000', `${path}.${key}`, 'field is required.');
          }

          const key = entry.value.key;
          if (
            typeof key !== 'string' ||
            key.trim().length === 0 ||
            key.length > maxConfigurationKeyLength
          ) {
            fail(
              'CP1000',
              `${path}.key`,
              `expected a non-empty key of at most ${maxConfigurationKeyLength} characters.`,
            );
          }
          if (keys.has(key)) fail('CP1000', `${path}.key`, 'configuration keys must be unique.');
          keys.add(key);

          const kind = entry.value.kind;
          if (
            typeof kind !== 'string' ||
            !supportedKinds.includes(kind as BlueprintConfigurationKind)
          ) {
            fail('CP1000', `${path}.kind`, 'expected a supported configuration kind.');
          }
          const actual = inspectTemplate(entry.value.template, `${path}.template`);
          if (actual.kind !== kind) {
            fail(
              'CP1001',
              `${path}.kind`,
              `expected a ${kind} template, received a ${actual.kind} template.`,
            );
          }
          if (actual.session !== session) {
            fail(
              'CP1001',
              `${path}.template`,
              'template belongs to a different parameter session.',
            );
          }
          return Object.freeze({
            key,
            kind: kind as BlueprintConfigurationKind,
            template: entry.value.template as BlueprintConfigurationTemplate,
          }) as BlueprintConfigurationSetEntry;
        } finally {
          entry.release();
        }
      }),
    );
  } finally {
    opened.release();
  }

  const configurationSet = Object.freeze({
    [configurationSetBrand]: true as const,
    entries,
  });
  configurationSetRegistrations.set(configurationSet, Object.freeze({ session, entries }));
  return configurationSet;
}

/** Returns immutable registration data only for an exact configuration set created above. */
export function inspectBlueprintConfigurationSet(
  value: unknown,
  path: string,
): BlueprintConfigurationSetRegistration {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    fail('CP1002', path, 'value is not a registered configuration set.');
  }
  const registration = configurationSetRegistrations.get(value);
  if (registration === undefined)
    fail('CP1002', path, 'value is not a registered configuration set.');
  return registration;
}

export type BoundBlueprintConfiguration =
  | { readonly key: string; readonly kind: 'constant'; readonly config: ConstantConfiguration }
  | { readonly key: string; readonly kind: 'arithmetic'; readonly config: ArithmeticProducerConfig }
  | { readonly key: string; readonly kind: 'decider'; readonly config: DeciderProducerConfig }
  | { readonly key: string; readonly kind: 'selector'; readonly config: SelectorProducerConfig };
