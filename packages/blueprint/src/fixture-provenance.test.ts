import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import {
  classifyBlueprintDocument,
  decodeBlueprintExchange,
  encodeBlueprintExchange,
  LosslessJsonArray,
  LosslessJsonObject,
  stringifyLosslessJson,
  type BlueprintSemanticHeader,
} from './index.js';

interface FixtureRecord {
  readonly id: string;
  readonly origin: 'self-generated' | 'factorio-export';
  readonly factorioVersion: string | null;
  readonly environment: string;
  readonly path: string;
  readonly encodedExchangeSha256: string;
  readonly decodedJsonSha256: string;
  readonly reviewStatus: string;
  readonly expectedSemanticHeader?: BlueprintSemanticHeader;
}

interface FixtureManifest {
  readonly schemaVersion: number;
  readonly fixtures: readonly FixtureRecord[];
  readonly externalEvidence: {
    readonly status: string;
    readonly receivedPath: string;
  };
}

const fixtureRoot = new URL('../../../fixtures/blueprint-exchange/', import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL('manifest.json', fixtureRoot), 'utf8'),
) as FixtureManifest;
const selfGenerated = manifest.fixtures.find(
  (fixture) => fixture.id === 'self-generated-minimal-blueprint',
);

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function readExchange(url: URL): Promise<string> {
  return (await readFile(url, 'utf8')).replace(/\r?\n$/, '');
}

describe('blueprint fixture provenance', () => {
  test('keeps the checked-in generated fixture explicitly internal', async () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(selfGenerated).toMatchObject({
      origin: 'self-generated',
      factorioVersion: null,
      reviewStatus: 'internal-only-not-native-evidence',
    });
    expect(
      manifest.fixtures.filter((fixture) => fixture.origin === 'factorio-export'),
    ).toHaveLength(1);
    expect(manifest.externalEvidence).toMatchObject({
      status: 'codec-framing-reviewed',
      receivedPath: 'factorio-2.1.10/plain-circuit.txt',
    });
    if (selfGenerated === undefined)
      throw new Error('Self-generated fixture manifest entry is missing.');

    const exchange = await readExchange(new URL(selfGenerated.path, fixtureRoot));
    expect(sha256(exchange)).toBe(selfGenerated.encodedExchangeSha256);
    const decoded = await decodeBlueprintExchange(exchange);
    const decodedJson = stringifyLosslessJson(decoded);
    expect(sha256(decodedJson)).toBe(selfGenerated.decodedJsonSha256);
    const projection = classifyBlueprintDocument(decoded);
    expect(projection.kind).toBe('blueprint');
    if (projection.kind !== 'blueprint')
      throw new Error('Generated fixture root changed unexpectedly.');
    expect(projection.semantic.label).toBe('self-generated-only');
  });

  test('pins the supplied Factorio 2.1.10 export as framing evidence', async () => {
    const external = manifest.fixtures.find(
      (fixture) => fixture.id === 'user-supplied-factorio-2.1.10-plain-circuit',
    );
    if (external === undefined || external.expectedSemanticHeader === undefined) {
      throw new Error(
        'Record the supplied Factorio export facts and semantic header in the manifest.',
      );
    }
    expect(external).toMatchObject({
      origin: 'factorio-export',
      factorioVersion: '2.1.10',
      reviewStatus: 'codec-framing-reviewed',
      path: 'factorio-2.1.10/plain-circuit.txt',
    });

    const exchange = await readExchange(new URL(external.path, fixtureRoot));
    expect(sha256(exchange)).toBe(external.encodedExchangeSha256);
    const decoded = await decodeBlueprintExchange(exchange);
    const originalJson = stringifyLosslessJson(decoded);
    expect(sha256(originalJson)).toBe(external.decodedJsonSha256);
    const projection = classifyBlueprintDocument(decoded);
    expect(projection.kind).toBe('blueprint');
    if (projection.kind !== 'blueprint')
      throw new Error('Supplied Factorio export root is not a blueprint.');
    expect(projection.semantic).toEqual(external.expectedSemanticHeader);
    const blueprint = projection.document.get('blueprint');
    expect(blueprint).toBeInstanceOf(LosslessJsonObject);
    if (!(blueprint instanceof LosslessJsonObject))
      throw new Error('Blueprint root changed shape.');
    const entities = blueprint.get('entities');
    const wires = blueprint.get('wires');
    expect(entities).toBeInstanceOf(LosslessJsonArray);
    expect(wires).toBeInstanceOf(LosslessJsonArray);
    if (!(entities instanceof LosslessJsonArray) || !(wires instanceof LosslessJsonArray)) {
      throw new Error('Native entity or wire list changed shape.');
    }
    expect(entities.items).toHaveLength(2);
    expect(wires.items).toHaveLength(1);

    const reencoded = await encodeBlueprintExchange(decoded);
    const redecoded = await decodeBlueprintExchange(reencoded);
    expect(stringifyLosslessJson(redecoded)).toBe(originalJson);
    const reprojected = classifyBlueprintDocument(redecoded);
    expect(reprojected.kind).toBe('blueprint');
    if (reprojected.kind !== 'blueprint') throw new Error('Re-encoded supplied root changed kind.');
    expect(reprojected.semantic).toEqual(external.expectedSemanticHeader);
  });
});
