import { describe, expect, test } from 'vitest';

import { parsePrototypeEvidenceManifest, type PrototypeEvidenceManifestV1 } from './evidence.js';

const identity = `comblang-prototypes-v1-sha256:${'a'.repeat(64)}`;
const digest = (character: string) => `sha256:${character.repeat(64)}`;

function manifest(): PrototypeEvidenceManifestV1 {
  return {
    schemaVersion: 1,
    kind: 'comblang-prototype-evidence',
    databaseIdentity: identity,
    structureEvidence: ['runtime-structure', 'raw-structure'],
    sources: [
      { id: 'native-review', kind: 'reviewed-native-behavior', artifactSha256: digest('c') },
      { id: 'raw-structure', kind: 'data-raw-structure', artifactSha256: digest('a') },
      { id: 'synthetic-fixture', kind: 'synthetic', artifactSha256: digest('d') },
      { id: 'runtime-structure', kind: 'runtime-structure', artifactSha256: digest('b') },
    ],
    circuitClaims: [
      {
        fact: { entity: 'entity:lamp', field: 'read' },
        value: false,
        evidence: ['native-review'],
      },
    ],
  };
}

describe('prototype evidence manifest parser', () => {
  test('copies, canonically orders and deeply freezes accepted manifests', () => {
    const input = structuredClone(manifest()) as unknown as {
      sources: Array<{ id: string }>;
      circuitClaims: Array<{ evidence: string[] }>;
    };
    const parsed = parsePrototypeEvidenceManifest(input);

    expect(parsed.sources.map(({ id }) => id)).toEqual([
      'native-review',
      'raw-structure',
      'runtime-structure',
      'synthetic-fixture',
    ]);
    expect(parsed.structureEvidence).toEqual(['raw-structure', 'runtime-structure']);
    expect(parsed.circuitClaims[0]!.value).toBe(false);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.sources)).toBe(true);
    expect(Object.isFrozen(parsed.sources[0])).toBe(true);
    expect(Object.isFrozen(parsed.circuitClaims[0])).toBe(true);
    expect(Object.isFrozen(parsed.circuitClaims[0]!.fact)).toBe(true);
    expect(Object.isFrozen(parsed.circuitClaims[0]!.evidence)).toBe(true);

    input.sources[0]!.id = 'changed';
    input.circuitClaims[0]!.evidence[0] = 'changed';
    expect(parsed.sources[0]!.id).toBe('native-review');
    expect(parsed.circuitClaims[0]!.evidence).toEqual(['native-review']);
  });

  test.each([
    [null, 'PE1001', '<manifest>'],
    [{ ...manifest(), schemaVersion: 2 }, 'PE1000', 'schemaVersion'],
    [{ ...manifest(), kind: 'other' }, 'PE1000', 'kind'],
    [{ ...manifest(), databaseIdentity: 'stale' }, 'PE1001', 'databaseIdentity'],
    [
      { ...manifest(), sources: [{ ...manifest().sources[0]!, kind: 'other' }] },
      'PE1000',
      'sources[0].kind',
    ],
    [
      { ...manifest(), sources: [{ ...manifest().sources[0]!, artifactSha256: 'sha256:ABC' }] },
      'PE1001',
      'sources[0].artifactSha256',
    ],
    [
      { ...manifest(), sources: [{ ...manifest().sources[0]!, id: 'C:\\temp\\evidence' }] },
      'PE1001',
      'sources[0].id',
    ],
    [
      { ...manifest(), sources: [{ ...manifest().sources[0]!, url: 'https://example.test' }] },
      'PE1001',
      'sources[0].url',
    ],
    [
      {
        ...manifest(),
        sources: [...manifest().sources, { ...manifest().sources[0]! }],
      },
      'PE1002',
      'sources[4].id',
    ],
    [
      {
        ...manifest(),
        circuitClaims: [...manifest().circuitClaims, { ...manifest().circuitClaims[0]! }],
      },
      'PE1002',
      'circuitClaims[1].fact',
    ],
    [
      {
        ...manifest(),
        circuitClaims: [
          { ...manifest().circuitClaims[0]!, evidence: ['native-review', 'native-review'] },
        ],
      },
      'PE1002',
      'circuitClaims[0].evidence[1]',
    ],
    [{ ...manifest(), structureEvidence: ['missing-source'] }, 'PE1003', 'structureEvidence[0]'],
    [
      { ...manifest(), structureEvidence: ['raw-structure', 'raw-structure'] },
      'PE1002',
      'structureEvidence[1]',
    ],
    [
      {
        ...manifest(),
        circuitClaims: [{ ...manifest().circuitClaims[0]!, evidence: ['missing-source'] }],
      },
      'PE1003',
      'circuitClaims[0].evidence[0]',
    ],
  ])('rejects malformed manifest at %s', (input, code, path) => {
    expect(() => parsePrototypeEvidenceManifest(input)).toThrowError(
      expect.objectContaining({
        name: 'PrototypeEvidenceError',
        code,
        path,
      }),
    );
  });

  test('requires exact fields and non-empty claim evidence', () => {
    expect(() =>
      parsePrototypeEvidenceManifest({
        ...manifest(),
        circuitClaims: [
          {
            ...manifest().circuitClaims[0]!,
            fact: { entity: 'entity:lamp', field: 'not-a-capability' },
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'PE1000', path: 'circuitClaims[0].fact.field' }),
    );

    expect(() =>
      parsePrototypeEvidenceManifest({
        ...manifest(),
        circuitClaims: [{ ...manifest().circuitClaims[0]!, evidence: [] }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PE1001', path: 'circuitClaims[0].evidence' }));
  });
});
