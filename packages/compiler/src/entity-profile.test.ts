import { describe, expect, test } from 'vitest';

import {
  canonicalEntityProfileJson,
  canonicalizeEntityProfile,
  EntityProfileError,
} from './entity-profile.js';
import {
  syntheticAmbiguousMultiConnectorEntityProfile,
  syntheticSharedTwoColorEntityProfile,
  syntheticZeroPortEntityProfile,
} from './entity-fixtures.js';

function jsonCopy(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

describe('Entity capability profile boundary', () => {
  test('canonicalizes equivalent connector, lane, feature, and evidence order', () => {
    const input = jsonCopy(syntheticSharedTwoColorEntityProfile);
    input.connectors.reverse();
    input.connectors[0].lanes.reverse();
    input.features.reverse();
    input.features[0].allowedLanes.reverse();
    const forward = canonicalEntityProfileJson(syntheticSharedTwoColorEntityProfile);
    const reordered = canonicalEntityProfileJson(input);
    expect(reordered).toBe(forward);
  });

  test('accepts trusted prototype type metadata and keeps legacy omission unknown', () => {
    const input = jsonCopy(syntheticZeroPortEntityProfile) as Record<string, unknown>;
    input.prototypeType = 'assembling-machine';
    const canonical = canonicalizeEntityProfile(input);

    expect(canonical.prototypeType).toBe('assembling-machine');
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(canonicalizeEntityProfile(syntheticZeroPortEntityProfile)).not.toHaveProperty(
      'prototypeType',
    );
    expect(canonicalEntityProfileJson(input)).not.toBe(
      canonicalEntityProfileJson(syntheticZeroPortEntityProfile),
    );
  });

  test('rejects malformed or misplaced prototype type metadata without invoking accessors', () => {
    const wrongScalar = jsonCopy(syntheticZeroPortEntityProfile) as Record<string, unknown>;
    wrongScalar.prototypeType = 42;
    expect(() => canonicalizeEntityProfile(wrongScalar)).toThrowError(
      expect.objectContaining({ code: 'EP1001', path: '$.prototypeType' }),
    );

    const misplaced = jsonCopy(syntheticZeroPortEntityProfile) as {
      ref: Record<string, unknown>;
    };
    misplaced.ref.prototypeType = 'container';
    expect(() => canonicalizeEntityProfile(misplaced)).toThrowError(
      expect.objectContaining({ code: 'EP1000', path: '$.ref.prototypeType' }),
    );

    let called = false;
    const accessor = jsonCopy(syntheticZeroPortEntityProfile) as Record<string, unknown>;
    Object.defineProperty(accessor, 'prototypeType', {
      enumerable: true,
      get: () => {
        called = true;
        return 'container';
      },
    });
    expect(() => canonicalizeEntityProfile(accessor)).toThrowError(
      expect.objectContaining({ code: 'EP1001', path: '$.prototypeType' }),
    );
    expect(called).toBe(false);

    const symbol = Symbol('prototypeType');
    const symbolField = jsonCopy(syntheticZeroPortEntityProfile) as Record<
      string | symbol,
      unknown
    >;
    Object.defineProperty(symbolField, symbol, { enumerable: true, value: 'container' });
    expect(() => canonicalizeEntityProfile(symbolField)).toThrowError(
      expect.objectContaining({ code: 'EP1000', path: '$[Symbol(prototypeType)]' }),
    );
  });

  test('accepts one explicit callable input/output projection and keeps it data-only', () => {
    const canonical = canonicalizeEntityProfile(syntheticSharedTwoColorEntityProfile);

    expect(canonical.callProjection).toEqual({
      input: { connector: 'shared', lane: 'shared-red', color: 'red' },
      output: { connector: 'shared', lane: 'shared-green', color: 'green' },
    });
    expect(Object.isFrozen(canonical.callProjection)).toBe(true);
    expect(Object.isFrozen(canonical.callProjection?.input)).toBe(true);
    expect(Object.isFrozen(canonical.callProjection?.output)).toBe(true);
  });

  test('omits callable projection when it is absent instead of inferring one', () => {
    const canonical = canonicalizeEntityProfile(syntheticZeroPortEntityProfile);

    expect(canonical).not.toHaveProperty('callProjection');

    const explicitUndefined = jsonCopy(syntheticZeroPortEntityProfile);
    explicitUndefined.callProjection = undefined;
    expect(() => canonicalizeEntityProfile(explicitUndefined)).toThrowError(
      expect.objectContaining({ code: 'EP1001', path: '$.callProjection' }),
    );
  });

  test('rejects an ambiguous projection that reuses one physical endpoint', () => {
    const input = jsonCopy(syntheticSharedTwoColorEntityProfile);
    input.callProjection.output = input.callProjection.input;

    expect(() => canonicalizeEntityProfile(input)).toThrowError(
      expect.objectContaining({ code: 'EP1000', path: '$.callProjection' }),
    );
  });

  test.each([
    ['input', 'output', '$.callProjection.input.connector'],
    ['output', 'input', '$.callProjection.output.connector'],
  ])(
    'rejects a call endpoint with incompatible %s connector direction',
    (endpoint, direction, path) => {
      const input = jsonCopy(syntheticSharedTwoColorEntityProfile);
      input.configurationRules = [];
      input.connectors[0].direction = direction;

      expect(() => canonicalizeEntityProfile(input)).toThrowError(
        expect.objectContaining({ code: 'EP1002', path }),
      );
    },
  );

  test.each([
    ['connector', '$.callProjection.input.connector', 'missing-connector'],
    ['lane', '$.callProjection.output.lane', 'missing-lane'],
  ])('rejects a call endpoint with an unknown %s', (kind, path, value) => {
    const input = jsonCopy(syntheticSharedTwoColorEntityProfile);
    if (kind === 'connector') input.callProjection.input.connector = value;
    else input.callProjection.output.lane = value;

    expect(() => canonicalizeEntityProfile(input)).toThrowError(
      expect.objectContaining({ code: 'EP1002', path }),
    );
  });

  test('rejects unknown fields and noncanonical colors in callable projection data', () => {
    const unknownField = jsonCopy(syntheticSharedTwoColorEntityProfile);
    unknownField.callProjection.extra = true;
    expect(() => canonicalizeEntityProfile(unknownField)).toThrowError(
      expect.objectContaining({ code: 'EP1000', path: '$.callProjection.extra' }),
    );

    const wrongColor = jsonCopy(syntheticSharedTwoColorEntityProfile);
    wrongColor.callProjection.output.color = 'red';
    expect(() => canonicalizeEntityProfile(wrongColor)).toThrowError(
      expect.objectContaining({ code: 'EP1002', path: '$.callProjection.output.color' }),
    );
  });

  test('deeply freezes the canonical snapshot and isolates caller mutation', () => {
    const input = jsonCopy(syntheticSharedTwoColorEntityProfile);
    const canonical = canonicalizeEntityProfile(input);
    input.connectors[0].lanes[0].color = 'green';
    input.features[0].allowedLanes.reverse();

    expect(canonical.connectors[0]?.lanes.find(({ key }) => key === 'shared-red')?.color).toBe(
      'red',
    );
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(canonical.ref)).toBe(true);
    expect(Object.isFrozen(canonical.connectors[0])).toBe(true);
    expect(Object.isFrozen(canonical.connectors[0]?.lanes)).toBe(true);
    expect(Object.isFrozen(canonical.features[0])).toBe(true);
  });

  test('rejects accessors without invoking the getter', () => {
    let called = false;
    const ref = {
      database: jsonCopy(syntheticZeroPortEntityProfile.ref.database),
      profileId: syntheticZeroPortEntityProfile.ref.profileId,
    } as Record<string, unknown>;
    Object.defineProperty(ref, 'prototypeKey', {
      configurable: true,
      enumerable: true,
      get: () => {
        called = true;
        return 'entity:forbidden';
      },
    });
    const input = { ...jsonCopy(syntheticZeroPortEntityProfile), ref };

    expect(() => canonicalizeEntityProfile(input)).toThrowError(
      expect.objectContaining({ code: 'EP1001', path: '$.ref.prototypeKey' }),
    );
    expect(called).toBe(false);
  });

  test('rejects duplicate connector keys and native endpoints with paths', () => {
    const duplicateConnector = jsonCopy(syntheticSharedTwoColorEntityProfile);
    duplicateConnector.connectors.push(duplicateConnector.connectors[0]);
    expect(() => canonicalizeEntityProfile(duplicateConnector)).toThrowError(
      expect.objectContaining({ code: 'EP1000', path: '$.connectors' }),
    );

    const duplicateEndpoint = jsonCopy(syntheticSharedTwoColorEntityProfile);
    duplicateEndpoint.connectors[0].lanes.push({
      key: 'shared-red-copy',
      color: 'red',
      nativeEndpoint: {
        endpoint: {
          connector: 'shared',
          lane: 'shared-red-copy',
          color: 'red',
        },
        nativeConnector: 1,
      },
    });
    expect(() => canonicalizeEntityProfile(duplicateEndpoint)).toThrowError(
      expect.objectContaining({ code: 'EP1000', path: '$.connectors[0].lanes' }),
    );

    const crossConnectorEndpoint = jsonCopy(syntheticAmbiguousMultiConnectorEntityProfile);
    crossConnectorEndpoint.connectors[0].lanes[1].nativeEndpoint = {
      endpoint: { connector: 'left', lane: 'left-green', color: 'green' },
      nativeConnector: 1,
    };
    crossConnectorEndpoint.connectors[1].lanes[0].nativeEndpoint = {
      endpoint: { connector: 'right', lane: 'right-green', color: 'green' },
      nativeConnector: 1,
    };
    expect(() => canonicalizeEntityProfile(crossConnectorEndpoint)).toThrowError(
      expect.objectContaining({
        code: 'EP1000',
        path: '$.connectors[1].lanes[0].nativeEndpoint',
      }),
    );
  });

  test('rejects invalid mappings and missing profile-level default metadata', () => {
    const invalidMapping = jsonCopy(syntheticSharedTwoColorEntityProfile);
    invalidMapping.connectors[0].lanes[0].nativeEndpoint.endpoint.color = 'green';
    expect(() => canonicalizeEntityProfile(invalidMapping)).toThrowError(
      expect.objectContaining({
        code: 'EP1002',
        path: '$.connectors[0].lanes[0].nativeEndpoint.endpoint',
      }),
    );

    expect(canonicalizeEntityProfile(syntheticAmbiguousMultiConnectorEntityProfile)).toMatchObject({
      defaultReadProjection: null,
    });
    const missingDefault = jsonCopy(syntheticAmbiguousMultiConnectorEntityProfile);
    delete missingDefault.defaultReadProjection;
    expect(() => canonicalizeEntityProfile(missingDefault)).toThrowError(
      expect.objectContaining({ code: 'EP1001', path: '$.defaultReadProjection' }),
    );

    const verifiedSynthetic = jsonCopy(syntheticSharedTwoColorEntityProfile);
    verifiedSynthetic.configurationRules = [
      {
        key: 'native-enable',
        kind: 'native-single-condition',
        feature: 'read',
        nativeField: 'control_behavior.circuit_condition',
        modes: ['typed'],
        evidence: { status: 'verified', value: true, sourceIds: ['reviewed-native'] },
      },
    ];
    expect(() => canonicalizeEntityProfile(verifiedSynthetic)).toThrowError(
      expect.objectContaining({ code: 'EP1003', path: '$.configurationRules[0].evidence.status' }),
    );
  });

  test('keeps capability evidence mixed and configuration-mode specific', () => {
    const mixed = jsonCopy(syntheticSharedTwoColorEntityProfile);
    mixed.synthetic = false;
    mixed.configurationRules = [
      {
        key: 'native-unknown',
        kind: 'native-single-condition',
        feature: 'read',
        nativeField: 'control_behavior.circuit_condition',
        modes: ['raw'],
        evidence: { status: 'unknown' },
      },
      {
        key: 'native-unverified',
        kind: 'native-single-condition',
        feature: 'read',
        nativeField: 'control_behavior.circuit_condition',
        modes: ['raw', 'typed'],
        evidence: { status: 'unverified', value: false },
      },
      {
        key: 'native-reviewed',
        kind: 'native-single-condition',
        feature: 'read',
        nativeField: 'control_behavior.circuit_condition',
        modes: ['typed'],
        evidence: { status: 'verified', value: false, sourceIds: ['native-review-v1'] },
      },
    ];
    const canonical = canonicalizeEntityProfile(mixed);
    expect(canonical.configurationRules.map(({ evidence }) => evidence.status)).toEqual([
      'verified',
      'unknown',
      'unverified',
    ]);
    expect(canonical.configurationRules[2]?.evidence).toEqual({
      status: 'unverified',
      value: false,
    });
  });

  test('exposes structured profile errors instead of generic failures', () => {
    try {
      canonicalizeEntityProfile({});
      throw new Error('expected profile validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(EntityProfileError);
      expect(error).toMatchObject({ code: 'EP1001', path: '$.ref' });
    }
  });
});
