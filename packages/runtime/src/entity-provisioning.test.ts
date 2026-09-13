import { describe, expect, test } from 'vitest';

import { loadPrototypeDatabase, syntheticPrototypeDatabase } from '@comblang/prototypes';
import builtinPrototypeDatabase from '../../prototypes/generated/space-age-2.1.17.json';

import {
  EntityProvisioningService,
  EntityProvisioningServiceError,
} from './entity-provisioning.js';

const policy = {
  evidenceIdentity: 'provider-evidence-v1',
  policyIdentity: 'entity-fallback-policy-v1',
} as const;

describe('host Entity provisioning service', () => {
  test('builds a trusted fallback set and narrow resolver once per provider', async () => {
    const { prototypes } = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const service = new EntityProvisioningService();
    const first = service.provision(prototypes, policy);
    const second = service.provision(prototypes, structuredClone(policy));

    expect(second).toBe(first);
    expect(first.database).toEqual({ schemaVersion: 1, identity: prototypes.identity });
    expect(first.profiles.map(({ ref }) => ref.prototypeKey)).toEqual([
      'entity:assembling-machine-3',
      'entity:chemical-plant',
    ]);
    expect(first.profiles.every((profile) => profile.connectorStructure === 'unknown')).toBe(true);
    expect(first.profiles.every((profile) => profile.connectors.length === 0)).toBe(true);
    expect(first.trustedEntityReplayContext.source).toBe('provider');
    expect(first.entityPrototypeResolver.database).toEqual(first.database);
    expect(first.entityPrototypeResolver.getEntity('assembling-machine-3')).toBe(
      prototypes.getEntity('assembling-machine-3'),
    );
    expect(first.entityReplayContext).not.toHaveProperty('profiles');
    expect(first.entityReplayContext).not.toHaveProperty('entityPrototypeResolver');
    expect(Object.isFrozen(first)).toBe(true);
  });

  test('does not accept mutable providers or executable policy records', async () => {
    const { prototypes } = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const service = new EntityProvisioningService();
    const mutable = { ...prototypes };
    expect(() => service.provision(mutable, policy)).toThrowError(
      expect.objectContaining({ code: 'EPS1001', path: '$.provider' }),
    );

    const executablePolicy = {} as { evidenceIdentity: string; policyIdentity: string };
    Object.defineProperty(executablePolicy, 'evidenceIdentity', {
      enumerable: true,
      get: () => 'provider-evidence-v1',
    });
    Object.defineProperty(executablePolicy, 'policyIdentity', {
      enumerable: true,
      value: 'entity-fallback-policy-v1',
    });
    expect(() => service.provision(prototypes, executablePolicy)).toThrowError(
      expect.objectContaining({
        name: 'EntityProvisioningServiceError',
        code: 'EPS1000',
        path: '$.policy.evidenceIdentity',
      }),
    );
  });

  test('keeps legacy normalized providers usable without Entity construction authority', async () => {
    const legacy = structuredClone(syntheticPrototypeDatabase()) as {
      entities: Array<Record<string, unknown>>;
    };
    for (const entity of legacy.entities) delete entity.blueprintEligible;
    const { prototypes } = await loadPrototypeDatabase(legacy);
    const provisioned = new EntityProvisioningService().provision(prototypes, policy);

    expect(provisioned.profiles).toEqual([]);
    expect(provisioned.entityReplayContext).toMatchObject({
      source: 'provider',
      profileSetIdentity: expect.stringMatching(/^entity-profile-set-v2-sha256:[0-9a-f]{64}$/),
    });
  });

  test('provisions only explicitly eligible records from the built-in asset', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(prototypes, policy);

    expect(provisioned.profiles).toHaveLength(158);
    expect(provisioned.profiles.map(({ ref }) => ref.prototypeKey)).toContain(
      'entity:assembling-machine-3',
    );
    expect(provisioned.profiles.map(({ ref }) => ref.prototypeKey)).not.toContain('entity:grenade');
    expect(provisioned.profiles.map(({ ref }) => ref.prototypeKey)).not.toContain(
      'entity:spark-explosion',
    );
  });
});
