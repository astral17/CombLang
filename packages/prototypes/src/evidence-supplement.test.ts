import { describe, expect, test } from 'vitest';

import { applyEntityCircuitSupplement } from './circuit-supplement.js';
import { loadPrototypeEvidence } from './evidence-loader.js';
import { syntheticPrototypeDatabase } from './fixtures.js';
import { loadPrototypeDatabase } from './provider.js';
import { validatePrototypeDatabase } from './validation.js';

function fixture() {
  const full = validatePrototypeDatabase(syntheticPrototypeDatabase());
  const partial = {
    ...full,
    capabilities: { ...full.capabilities, entityCircuitCapabilities: false },
    entities: full.entities.map(({ circuit: _circuit, ...entity }) => entity),
  };
  const entries = full.entities.map(({ key, type, circuit }) => ({ key, type, circuit }));
  return { partial, entries };
}

function manifest(identity: string, circuitClaims: readonly unknown[]) {
  return {
    schemaVersion: 1,
    kind: 'comblang-prototype-evidence',
    databaseIdentity: identity,
    structureEvidence: [],
    sources: [
      {
        id: 'native-review',
        kind: 'reviewed-native-behavior',
        artifactSha256: `sha256:${'a'.repeat(64)}`,
      },
    ],
    circuitClaims,
  };
}

describe('evidence interoperability with circuit supplements', () => {
  test('distinguishes verified, verified false, unverified and unknown after a partial supplement', async () => {
    const { partial, entries } = fixture();
    const base = await loadPrototypeDatabase(partial);
    const supplemented = await applyEntityCircuitSupplement(partial, {
      schemaVersion: 1,
      baseIdentity: base.prototypes.identity,
      entities: [entries[0]],
    });
    const supplementedLoaded = await loadPrototypeDatabase(supplemented);
    const loaded = await loadPrototypeEvidence(
      supplemented,
      manifest(supplementedLoaded.prototypes.identity, [
        {
          fact: { entity: entries[0]!.key, field: 'read' },
          value: true,
          evidence: ['native-review'],
        },
        {
          fact: { entity: entries[0]!.key, field: 'setFilters' },
          value: false,
          evidence: ['native-review'],
        },
      ]),
    );

    expect(loaded.index.circuit(entries[0]!.key, 'read')).toMatchObject({
      status: 'verified',
      value: true,
    });
    expect(loaded.index.circuit(entries[0]!.key, 'setFilters')).toMatchObject({
      status: 'verified',
      value: false,
    });
    expect(loaded.index.circuit(entries[0]!.key, 'outputSignals')).toEqual({
      status: 'unverified',
      entity: entries[0]!.key,
      field: 'outputSignals',
      value: true,
    });
    expect(loaded.index.circuit(entries[1]!.key, 'read')).toEqual({
      status: 'unknown',
      entity: entries[1]!.key,
      field: 'read',
    });
  });

  test('rejects an evidence manifest after a different supplement changes database identity', async () => {
    const { partial, entries } = fixture();
    const base = await loadPrototypeDatabase(partial);
    const first = await applyEntityCircuitSupplement(partial, {
      schemaVersion: 1,
      baseIdentity: base.prototypes.identity,
      entities: [entries[0]],
    });
    const firstLoaded = await loadPrototypeDatabase(first);
    const final = await applyEntityCircuitSupplement(first, {
      schemaVersion: 1,
      baseIdentity: firstLoaded.prototypes.identity,
      entities: [entries[1]],
    });

    await expect(
      loadPrototypeEvidence(
        final,
        manifest(firstLoaded.prototypes.identity, [
          {
            fact: { entity: entries[0]!.key, field: 'read' },
            value: true,
            evidence: ['native-review'],
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'PE1004', path: 'databaseIdentity' });
  });

  test('rejects conflicting or absent facts without mutating either input', async () => {
    const { partial, entries } = fixture();
    const base = await loadPrototypeDatabase(partial);
    const supplemented = await applyEntityCircuitSupplement(partial, {
      schemaVersion: 1,
      baseIdentity: base.prototypes.identity,
      entities: [entries[0]],
    });
    const supplementedLoaded = await loadPrototypeDatabase(supplemented);
    const databaseBefore = JSON.stringify(supplemented);
    const conflicting = manifest(supplementedLoaded.prototypes.identity, [
      {
        fact: { entity: entries[0]!.key, field: 'read' },
        value: false,
        evidence: ['native-review'],
      },
    ]);
    const conflictingBefore = JSON.stringify(conflicting);
    await expect(loadPrototypeEvidence(supplemented, conflicting)).rejects.toMatchObject({
      code: 'PE1006',
      path: 'circuitClaims[0].value',
    });
    expect(JSON.stringify(supplemented)).toBe(databaseBefore);
    expect(JSON.stringify(conflicting)).toBe(conflictingBefore);

    const absent = manifest(supplementedLoaded.prototypes.identity, [
      {
        fact: { entity: entries[1]!.key, field: 'read' },
        value: true,
        evidence: ['native-review'],
      },
    ]);
    const absentBefore = JSON.stringify(absent);
    await expect(loadPrototypeEvidence(supplemented, absent)).rejects.toMatchObject({
      code: 'PE1005',
      path: 'circuitClaims[0].fact.entity',
    });
    expect(JSON.stringify(supplemented)).toBe(databaseBefore);
    expect(JSON.stringify(absent)).toBe(absentBefore);
  });
});
