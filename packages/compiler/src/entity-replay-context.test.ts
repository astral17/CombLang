import { describe, expect, test } from 'vitest';

import {
  cloneEntityReplayContextTransport,
  createTrustedEntityReplayContext,
  EntityReplayContextError,
  entityReplayContextIdentity,
  entityReplayContextRef,
  entityReplayContextTransport,
  resolveEntityReplayContext,
  resolveEntityReplayProfile,
  type TrustedEntityReplayContext,
} from './entity-replay-context.js';
import {
  syntheticSharedTwoColorEntityProfile,
  syntheticZeroPortEntityProfile,
} from './entity-fixtures.js';

function context(profiles = [syntheticZeroPortEntityProfile]): TrustedEntityReplayContext {
  return createTrustedEntityReplayContext({
    database: syntheticZeroPortEntityProfile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'comblang-synthetic-evidence-v1',
    policyIdentity: 'comblang-entity-policy-v1',
    profiles,
  });
}

describe('trusted Entity replay context', () => {
  test('binds a profile set and resolves each Entity profile independently', () => {
    const trusted = context([syntheticZeroPortEntityProfile, syntheticSharedTwoColorEntityProfile]);
    const reference = entityReplayContextRef(trusted);

    expect(resolveEntityReplayContext(reference, trusted)).toBe(trusted);
    expect(resolveEntityReplayProfile(syntheticZeroPortEntityProfile.ref, trusted)).toBe(
      trusted.profiles[0],
    );
    expect(resolveEntityReplayProfile(syntheticSharedTwoColorEntityProfile.ref, trusted)).toBe(
      trusted.profiles[1],
    );
    expect(reference).not.toHaveProperty('profileIdentity');
    expect(reference).toHaveProperty('profileSetIdentity', trusted.profileSetIdentity);
    expect(Object.isFrozen(trusted)).toBe(true);
    expect(Object.isFrozen(trusted.database)).toBe(true);
    expect(JSON.parse(JSON.stringify(trusted))).not.toHaveProperty('provider');
  });

  test('rejects missing, stale, and prototype-mismatched profile references', () => {
    const trusted = context([syntheticZeroPortEntityProfile, syntheticSharedTwoColorEntityProfile]);
    expect(() =>
      resolveEntityReplayProfile(
        { ...syntheticZeroPortEntityProfile.ref, profileId: 'profile:missing-v1' },
        trusted,
      ),
    ).toThrowError(expect.objectContaining({ code: 'ER1002', path: '$.profileId' }));
    expect(() =>
      resolveEntityReplayProfile(
        { ...syntheticZeroPortEntityProfile.ref, prototypeKey: 'entity:other' },
        trusted,
      ),
    ).toThrowError(expect.objectContaining({ code: 'ER1001', path: '$.prototypeKey' }));
  });

  test('rejects database, profile-set, evidence, and policy mismatches', () => {
    const trusted = context();
    const reference = entityReplayContextRef(trusted);

    expect(() =>
      resolveEntityReplayContext(
        { ...reference, database: { ...reference.database, identity: 'database-v2' } },
        trusted,
      ),
    ).toThrowError(expect.objectContaining({ code: 'ER1001', path: '$.database' }));
    expect(() =>
      resolveEntityReplayContext(
        { ...reference, profileSetIdentity: 'profile-set-other' },
        trusted,
      ),
    ).toThrowError(expect.objectContaining({ code: 'ER1001', path: '$.profileSetIdentity' }));
    expect(() =>
      resolveEntityReplayContext({ ...reference, evidenceIdentity: 'evidence-v2' }, trusted),
    ).toThrowError(expect.objectContaining({ code: 'ER1001', path: '$.evidenceIdentity' }));
    expect(() =>
      resolveEntityReplayContext({ ...reference, policyIdentity: 'policy-v2' }, trusted),
    ).toThrowError(expect.objectContaining({ code: 'ER1001', path: '$.policyIdentity' }));
  });

  test('creates cloneable transport and changes cache identity for profile sets and environment pins', () => {
    const oneProfile = context();
    const twoProfiles = context([
      syntheticZeroPortEntityProfile,
      syntheticSharedTwoColorEntityProfile,
    ]);
    const transport = entityReplayContextTransport(oneProfile);
    const clone = cloneEntityReplayContextTransport(structuredClone(transport));

    expect(clone).toEqual(transport);
    expect(Object.keys(transport)).toEqual([
      'protocolVersion',
      'source',
      'database',
      'profileSetIdentity',
      'evidenceIdentity',
      'policyIdentity',
    ]);
    expect(entityReplayContextIdentity(transport)).not.toBe(
      entityReplayContextIdentity(entityReplayContextTransport(twoProfiles)),
    );
    expect(() =>
      cloneEntityReplayContextTransport({
        ...transport,
        get policyIdentity() {
          throw new Error('getter must not run');
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'ER1000', path: '$.policyIdentity' }));
  });

  test('includes the explicit callable projection in profile-set identity', () => {
    const callable = context([syntheticSharedTwoColorEntityProfile]);
    const withoutProjection = JSON.parse(
      JSON.stringify(syntheticSharedTwoColorEntityProfile),
    ) as Record<string, unknown>;
    delete withoutProjection.callProjection;
    const nonCallable = context([withoutProjection as never]);

    expect(callable.profileSetIdentity).not.toBe(nonCallable.profileSetIdentity);
  });

  test('reports structured errors at the identity boundary', () => {
    try {
      resolveEntityReplayContext({}, {} as never);
      throw new Error('expected context reference validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(EntityReplayContextError);
      expect(error).toMatchObject({ code: 'ER1000', path: '$' });
    }
  });
});
