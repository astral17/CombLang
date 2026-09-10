import { describe, expect, test } from 'vitest';

import { signal } from '@comblang/factorio';
import type { EntityBehaviorKey, EntityProfile } from './entity.js';
import { syntheticSharedTwoColorEntityProfile } from './entity-fixtures.js';
import {
  canonicalizeEntityConfiguration,
  canonicalizeEntityNativeSingleCondition,
  EntityConfigurationError,
  resolveEntityPhysicalConfiguration,
} from './entity-configuration.js';

const typed = () => ({
  mode: 'typed' as const,
  rule: 'shared-circuit-condition' as EntityBehaviorKey,
  lanes: ['shared-green', 'shared-red'],
  condition: {
    kind: 'compare-signal-constant' as const,
    signal: { type: 'virtual' as const, name: 'signal-A' },
    comparator: '>=' as const,
    constant: -7,
  },
});

describe('typed Entity configuration boundary', () => {
  test('canonicalizes a pure signal/int32 comparison and resolves physical metadata', () => {
    const configuration = canonicalizeEntityConfiguration(
      typed(),
      syntheticSharedTwoColorEntityProfile,
    );
    if (configuration.mode !== 'typed' || 'payload' in configuration)
      throw new Error('expected rule-bound typed configuration');

    expect(configuration).toEqual({
      mode: 'typed',
      rule: 'shared-circuit-condition',
      lanes: ['shared-green', 'shared-red'],
      condition: {
        kind: 'compare-signal-constant',
        signal: signal('virtual', 'signal-A'),
        comparator: '>=',
        constant: -7,
      },
    });
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.condition)).toBe(true);

    expect(
      resolveEntityPhysicalConfiguration(configuration, syntheticSharedTwoColorEntityProfile),
    ).toEqual({
      mode: 'typed',
      rule: 'shared-circuit-condition',
      feature: 'read',
      nativeField: 'control_behavior.circuit_condition',
      connector: 'shared',
      lanes: ['shared-green', 'shared-red'],
      laneMask: { red: true, green: true },
      condition: configuration.condition,
    });

    const greenOnly = canonicalizeEntityConfiguration(
      { ...typed(), lanes: ['shared-green'] },
      syntheticSharedTwoColorEntityProfile,
    );
    expect(
      resolveEntityPhysicalConfiguration(greenOnly, syntheticSharedTwoColorEntityProfile),
    ).toMatchObject({
      laneMask: { red: false, green: true },
    });
  });

  test('keeps raw and opaque v3 configurations separate from typed fields', () => {
    const raw = canonicalizeEntityConfiguration(
      { mode: 'raw', payload: { enabled: false } },
      syntheticSharedTwoColorEntityProfile,
    );
    expect(raw).toEqual({ mode: 'raw', payload: { enabled: false } });

    const opaque = canonicalizeEntityConfiguration(
      { mode: 'typed', payload: { legacy: true } },
      syntheticSharedTwoColorEntityProfile,
    );
    expect(opaque).toEqual({ mode: 'typed', payload: { legacy: true } });
    expect(Object.isFrozen(opaque)).toBe(true);
  });

  test('rejects unsafe conditions, lanes, and accessors with structured paths', () => {
    for (const name of ['signal-each', 'signal-anything', 'signal-everything']) {
      expect(() =>
        canonicalizeEntityNativeSingleCondition({
          kind: 'compare-signal-constant',
          signal: { type: 'virtual', name },
          comparator: '=',
          constant: 0,
        }),
      ).toThrowError(expect.objectContaining({ code: 'EC1001', path: '$.signal.name' }));
    }
    expect(
      canonicalizeEntityNativeSingleCondition({
        kind: 'compare-signal-constant',
        signal: { type: 'virtual', name: 'signal-custom' },
        comparator: '=',
        constant: 0,
      }).signal,
    ).toEqual(signal('virtual', 'signal-custom'));

    expect(() =>
      canonicalizeEntityConfiguration(
        { ...typed(), lanes: ['shared-red', 'shared-red'] },
        syntheticSharedTwoColorEntityProfile,
      ),
    ).toThrowError(expect.objectContaining({ code: 'EC1002', path: '$.lanes' }));

    expect(() =>
      canonicalizeEntityConfiguration(
        { ...typed(), lanes: [] },
        syntheticSharedTwoColorEntityProfile,
      ),
    ).toThrowError(expect.objectContaining({ code: 'EC1001', path: '$.lanes' }));

    const condition = {
      kind: 'compare-signal-constant',
      comparator: '=',
      constant: 0,
    } as Record<string, unknown>;
    let called = false;
    Object.defineProperty(condition, 'signal', {
      enumerable: true,
      get: () => {
        called = true;
        return signal('virtual', 'forbidden');
      },
    });
    expect(() => canonicalizeEntityNativeSingleCondition(condition)).toThrowError(
      expect.objectContaining({ code: 'EC1001', path: '$.signal' }),
    );
    expect(called).toBe(false);

    expect(
      canonicalizeEntityNativeSingleCondition({
        kind: 'compare-signal-constant',
        signal: { type: 'virtual', name: 'signal-A' },
        comparator: '=',
        constant: 2_147_483_648,
      }).constant,
    ).toBe(-2_147_483_648);
    expect(() =>
      canonicalizeEntityNativeSingleCondition({
        kind: 'compare-signal-constant',
        signal: { type: 'virtual', name: 'signal-A' },
        comparator: '=',
        constant: 1.5,
      }),
    ).toThrowError(expect.objectContaining({ code: 'EC1001', path: '$.constant' }));
  });

  test('requires verified positive evidence for non-synthetic typed use', () => {
    const profile = structuredClone(syntheticSharedTwoColorEntityProfile);
    const nonSynthetic: EntityProfile = { ...profile, synthetic: false };

    expect(() => canonicalizeEntityConfiguration(typed(), nonSynthetic)).toThrowError(
      expect.objectContaining({ code: 'EC1003', path: '$.rule' }),
    );

    const verified: EntityProfile = {
      ...nonSynthetic,
      configurationRules: nonSynthetic.configurationRules.map((rule) => ({
        ...rule,
        evidence: {
          status: 'verified',
          value: true,
          sourceIds: ['reviewed-native-v1'],
        },
      })),
    };
    expect(canonicalizeEntityConfiguration(typed(), verified).mode).toBe('typed');
  });

  test('exposes the configuration error type without generic failures', () => {
    try {
      canonicalizeEntityConfiguration({ mode: 'typed' }, syntheticSharedTwoColorEntityProfile);
      throw new Error('expected invalid configuration');
    } catch (error) {
      expect(error).toBeInstanceOf(EntityConfigurationError);
      expect(error).toMatchObject({ code: 'EC1001', path: '$.rule' });
    }
  });
});
