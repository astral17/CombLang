import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolDirectory = new URL('./', import.meta.url);
const reviewUrl = new URL('control-behavior-review.json', toolDirectory);
const outputUrl = new URL('generated/control-behaviors.json', toolDirectory);

export const codeUnitCompare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const sortedByName = (values) =>
  [...values].sort((left, right) => codeUnitCompare(left.name, right.name));

export const sha256 = (contents) => createHash('sha256').update(contents).digest('hex');

const readJson = async (url) => JSON.parse(await readFile(url, 'utf8'));

export async function verifyFileHash(url, expectedHash) {
  const contents = await readFile(url);
  const actualHash = sha256(contents);
  if (actualHash !== expectedHash) {
    throw new Error(
      `Factorio API snapshot hash mismatch for ${fileURLToPath(url)}: expected ${expectedHash}, received ${actualHash}.`,
    );
  }
  return contents;
}

function inherited(classes, entry, field) {
  const parentValues = entry.parent ? inherited(classes, classes.get(entry.parent), field) : [];
  const byName = new Map(parentValues.map((item) => [item.name, item]));
  for (const item of entry[field] ?? []) {
    byName.set(item.name, { ...item, declaredOn: entry.name });
  }
  return sortedByName(byName.values());
}

function assertExpectedCounts(actual, expected) {
  for (const key of ['classes', 'concrete', 'abstract', 'entityVariants']) {
    assert.equal(
      actual[key],
      expected[key],
      `Reviewed ${key} count changed from ${expected[key]} to ${actual[key]}; inspect the API delta and update control-behavior-review.json.`,
    );
  }
}

export async function generateInventory({ fixtureDirectory, review } = {}) {
  const selectedReview = review ?? (await readJson(reviewUrl));
  const snapshotVersion = selectedReview.snapshotVersion;
  const selectedFixtureDirectory =
    fixtureDirectory ?? new URL(`fixtures/${snapshotVersion}/`, toolDirectory);
  const manifestUrl = new URL('manifest.json', selectedFixtureDirectory);
  const manifest = await readJson(manifestUrl);

  assert.equal(manifest.format, 'comblang-factorio-api-snapshot');
  assert.equal(manifest.applicationVersion, snapshotVersion);

  const verifiedFiles = new Map();
  for (const [name, descriptor] of Object.entries(manifest.files)) {
    verifiedFiles.set(
      name,
      await verifyFileHash(new URL(name, selectedFixtureDirectory), descriptor.sha256),
    );
  }

  const runtimeApi = JSON.parse(verifiedFiles.get('runtime-api.json').toString('utf8'));
  const prototypeApi = JSON.parse(verifiedFiles.get('prototype-api.json').toString('utf8'));
  for (const api of [runtimeApi, prototypeApi]) {
    assert.equal(api.application, manifest.application);
    assert.equal(api.application_version, manifest.applicationVersion);
    assert.equal(api.api_version, manifest.apiVersion);
  }
  assert.equal(runtimeApi.stage, 'runtime');
  assert.equal(prototypeApi.stage, 'prototype');

  const classes = new Map(runtimeApi.classes.map((entry) => [entry.name, entry]));
  const concepts = new Map(runtimeApi.concepts.map((entry) => [entry.name, entry]));
  const blueprintEntity = concepts.get('BlueprintEntity');
  assert.equal(blueprintEntity?.type?.complex_type, 'table');

  const waveByClass = new Map();
  for (const [wave, names] of Object.entries(selectedReview.waves)) {
    for (const name of names) {
      assert(
        !waveByClass.has(name),
        `Control behavior ${name} occurs in more than one review wave.`,
      );
      waveByClass.set(name, wave);
    }
  }

  const behaviors = sortedByName(
    runtimeApi.classes.filter((entry) => entry.name.endsWith('ControlBehavior')),
  ).map((entry) => {
    const expectedBlueprintType =
      entry.name === 'LuaSelectorCombinatorControlBehavior'
        ? 'SelectorCombinatorParameters'
        : entry.name.replace(/^Lua/, '').replace(/ControlBehavior$/, 'BlueprintControlBehavior');
    const blueprintType = concepts.has(expectedBlueprintType) ? expectedBlueprintType : null;
    const entityVariants = (blueprintEntity.type.variant_parameter_groups ?? []).filter((variant) =>
      variant.parameters.some(
        (field) => field.name === 'control_behavior' && field.type === blueprintType,
      ),
    );
    const wave = waveByClass.get(entry.name);
    assert(wave, `No review wave for ${entry.name}; inspect the new API class.`);
    assert(
      entry.abstract || blueprintType,
      `Concrete class without a reviewed Blueprint type: ${entry.name}.`,
    );

    return {
      name: entry.name,
      abstract: Boolean(entry.abstract),
      parent: entry.parent ?? null,
      wave,
      blueprintType,
      entityVariants: entityVariants.map((variant) => variant.name).sort(codeUnitCompare),
      ownRuntimeAttributes: sortedByName(entry.attributes ?? []),
      effectiveRuntimeAttributes: inherited(classes, entry, 'attributes'),
      effectiveRuntimeMethods: inherited(classes, entry, 'methods'),
      blueprintSchema: blueprintType ? concepts.get(blueprintType).type : null,
      entityVariantSchemas: sortedByName(entityVariants),
      implementationStatus: 'unassessed-per-field',
      nativeEvidenceStatus: 'not-captured-by-this-inventory',
      notes:
        entry.name === 'LuaSelectorCombinatorControlBehavior'
          ? [
              'Blueprint control_behavior uses SelectorCombinatorParameters directly; do not invent SelectorCombinatorBlueprintControlBehavior.',
            ]
          : [],
    };
  });

  assert.equal(
    behaviors.length,
    waveByClass.size,
    'The review manifest contains a stale or missing control-behavior class.',
  );

  const discoveredConcepts = new Map();
  function collectConcepts(value) {
    if (typeof value === 'string' && concepts.has(value) && !discoveredConcepts.has(value)) {
      const concept = concepts.get(value);
      discoveredConcepts.set(value, concept);
      collectConcepts(concept.type);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collectConcepts);
      return;
    }
    if (value && typeof value === 'object') {
      for (const key of [
        'type',
        'value',
        'key',
        'values',
        'options',
        'parameters',
        'variant_parameter_groups',
        'elements',
      ]) {
        if (value[key] !== undefined) collectConcepts(value[key]);
      }
    }
  }

  collectConcepts('BlueprintEntity');
  for (const behavior of behaviors) {
    collectConcepts(behavior.blueprintType);
    behavior.effectiveRuntimeAttributes.forEach((attribute) => {
      collectConcepts(attribute.read_type);
      collectConcepts(attribute.write_type);
    });
    behavior.effectiveRuntimeMethods.forEach((method) => {
      collectConcepts(method.parameters);
      collectConcepts(method.return_values);
    });
  }

  const counts = {
    classes: behaviors.length,
    concrete: behaviors.filter((entry) => !entry.abstract).length,
    abstract: behaviors.filter((entry) => entry.abstract).length,
    entityVariants: new Set(behaviors.flatMap((entry) => entry.entityVariants)).size,
    referencedConcepts: discoveredConcepts.size,
  };
  assertExpectedCounts(counts, selectedReview.expectedCounts);

  return {
    format: 'comblang-control-behavior-inventory',
    version: 1,
    source: {
      snapshot: `fixtures/${snapshotVersion}`,
      applicationVersion: runtimeApi.application_version,
      apiVersion: runtimeApi.api_version,
      runtimeSha256: manifest.files['runtime-api.json'].sha256,
      prototypeSha256: manifest.files['prototype-api.json'].sha256,
    },
    counts,
    warning:
      'API structure is not a blueprint round-trip or circuit-behavior proof. Matching names are schema associations, not automatic field mappings. Runtime observation members are not exportable settings.',
    behaviors,
    referencedConcepts: sortedByName(discoveredConcepts.values()),
  };
}

export const serializeInventory = (inventory) => `${JSON.stringify(inventory, null, 2)}\n`;

export async function runGenerator({ check = false } = {}) {
  const serialized = serializeInventory(await generateInventory());
  if (check) {
    const current = await readFile(outputUrl, 'utf8');
    assert.equal(
      current,
      serialized,
      'Generated Factorio API inventory is stale; run npm run factorio-api:inventory.',
    );
  } else {
    await writeFile(outputUrl, serialized);
  }
  return JSON.parse(serialized).counts;
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const counts = await runGenerator({ check: process.argv.includes('--check') });
  console.log(JSON.stringify(counts));
}
