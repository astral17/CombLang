import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { classifyBlueprintDocument, parseLosslessJson } from '@comblang/blueprint';
import {
  createTrustedEntityReplayContext,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import type { EntityProfile, EntityProfileId } from '@comblang/compiler/entity';
import { loadPrototypeDatabase, syntheticPrototypeDatabase } from '@comblang/prototypes';
import { expect, test } from 'vitest';

import { importCanonicalBlueprintSource } from './blueprint-source-import.js';

const guidePath = fileURLToPath(
  new URL('../../../docs/blueprint-source-import.md', import.meta.url),
);

function fencedExample(guide: string, heading: string, language: string): string {
  const headingStart = guide.indexOf(heading);
  if (headingStart < 0) throw new Error(`Missing example heading ${heading}.`);
  const section = guide.slice(headingStart);
  const fence = `\`\`\`${language}`;
  const start = section.indexOf(fence);
  if (start < 0) throw new Error(`Missing ${language} example after ${heading}.`);
  const contentStart = section.indexOf('\n', start) + 1;
  const end = section.indexOf('\n```', contentStart);
  if (contentStart === 0 || end < 0)
    throw new Error(`Unclosed ${language} example after ${heading}.`);
  return section.slice(contentStart, end).trimEnd();
}

async function trustedConstantEnvironment() {
  const database = structuredClone(syntheticPrototypeDatabase()) as {
    entities: Array<Record<string, unknown>>;
  };
  database.entities.push({
    key: 'entity:constant-combinator',
    name: 'constant-combinator',
    type: 'constant-combinator',
    blueprintEligible: true,
    tileWidth: 1,
    tileHeight: 1,
    circuit: {
      read: false,
      enableDisable: false,
      readContents: false,
      setFilters: false,
      setRequests: false,
      setRecipe: false,
      readRecipe: false,
      readFinishedCraft: false,
      outputSignals: false,
    },
  });
  const { prototypes } = await loadPrototypeDatabase(database);
  const databaseRef = { schemaVersion: prototypes.schemaVersion, identity: prototypes.identity };
  const profile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      database: databaseRef,
      prototypeKey: 'entity:constant-combinator',
      profileId: 'profile:blueprint-source-import-documentation' as EntityProfileId,
    },
    prototypeType: 'constant-combinator',
  };
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: databaseRef,
    source: 'synthetic',
    evidenceIdentity: 'blueprint-source-import-documentation-test-evidence',
    policyIdentity: 'blueprint-source-import-documentation-test-policy',
    profiles: [profile],
  });
  return { prototypes, trustedEntityReplayContext };
}

test('the documented native JSON example imports and matches its generated source fence', async () => {
  const guide = readFileSync(guidePath, 'utf8');
  const nativeJson = fencedExample(guide, '## Minimal supported document', 'json');
  const documentedSource = fencedExample(guide, '### Generated source', 'ts');
  const classification = classifyBlueprintDocument(parseLosslessJson(nativeJson));
  expect(classification.kind).toBe('blueprint');

  const result = importCanonicalBlueprintSource(
    nativeJson,
    { path: 'guide/constant.factorio.ts' },
    await trustedConstantEnvironment(),
  );

  expect(result.state).toBe('verified');
  if (result.state !== 'verified') throw new Error('Expected the guide example to verify.');
  expect(result.verification).toEqual({ state: 'verified', entityCount: 1, networkCount: 2 });
  expect(result.correspondence.entities).toMatchObject([
    { entityNumber: 1, family: 'constant', placementSpan: expect.any(Object) },
  ]);
  expect(result.source.text.trimEnd()).toBe(documentedSource);
  expect(result.source.text).toContain('signal-A');
  expect(result.source.text).toContain('value:5');
  expect(result.source.text).toContain('.at(0,0,0)');
});
