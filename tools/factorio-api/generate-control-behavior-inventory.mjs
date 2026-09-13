import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolDirectory = new URL('./', import.meta.url);
const reviewUrl = new URL('control-behavior-review.json', toolDirectory);
const outputUrl = new URL('generated/control-behaviors.json', toolDirectory);
const catalogOutputUrl = new URL(
  '../../packages/prototypes/generated/blueprint-schema-catalog-2.1.17.json',
  toolDirectory,
);

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

const blueprintCompilerOwnedFields = new Set([
  'entity_number',
  'name',
  'position',
  'direction',
  'wires',
]);

const blueprintScalarNames = new Set([
  'any',
  'boolean',
  'double',
  'float',
  'int8',
  'int16',
  'int32',
  'int64',
  'integer',
  'number',
  'string',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
]);

function defaultFromDescription(description = '') {
  const match = description.match(
    /\bdefaults?\s+to\s+(`[^`]+`|"[^"]*"|true|false|null|-?\d+(?:\.\d+)?)/i,
  );
  if (!match) return undefined;
  const token = match[1];
  const unquoted = token.startsWith('`') ? token.slice(1, -1) : token;
  if (unquoted === 'null') return null;
  if (unquoted === 'true') return true;
  if (unquoted === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(unquoted)) return Number(unquoted);
  if (unquoted.startsWith('"')) return JSON.parse(unquoted);
  return unquoted.includes('.') ? unquoted.split('.').at(-1) : unquoted;
}

function flattenDefines(defines) {
  const result = new Map();
  function visit(entry, prefix) {
    if (entry.values !== undefined) {
      const values = sortedByName(entry.values).map((value) => ({
        kind: 'literal',
        value: value.name,
      }));
      result.set(prefix, values.length === 1 ? values[0] : { kind: 'union', options: values });
    }
    for (const child of entry.subkeys ?? []) visit(child, `${prefix}.${child.name}`);
  }
  for (const entry of defines) visit(entry, `defines.${entry.name}`);
  return result;
}

function schemaField(parameter, descriptorFor) {
  assert.equal(typeof parameter.name, 'string');
  assert.equal(typeof parameter.optional, 'boolean');
  const field = {
    name: parameter.name,
    type: descriptorFor(parameter.type, `${parameter.name}.type`),
    optional: parameter.optional,
  };
  const defaultValue = defaultFromDescription(parameter.description);
  if (defaultValue !== undefined) field.default = defaultValue;
  return field;
}

function schemaDescriptorFactory(concepts, defines) {
  const activeConcepts = new Set();
  const conceptDescriptors = new Map();

  function descriptorFor(value, path = '<schema>') {
    if (typeof value === 'string') {
      if (value === 'nil') return { kind: 'literal', value: null };
      if (blueprintScalarNames.has(value)) return { kind: 'scalar', name: value };
      if (concepts.has(value) || defines.has(value)) return { kind: 'reference', name: value };
      throw new Error(`Unknown Blueprint schema type ${JSON.stringify(value)} at ${path}.`);
    }
    assert(value && typeof value === 'object', `Expected a schema node at ${path}.`);
    const complexType = value.complex_type;
    switch (complexType) {
      case 'builtin':
        return { kind: 'scalar', name: 'table' };
      case 'type':
        assert.equal(typeof value.value, 'string', `Expected a named type at ${path}.`);
        return {
          kind: 'scalar',
          name: value.value,
        };
      case 'array':
        return { kind: 'array', items: descriptorFor(value.value, `${path}.value`) };
      case 'dictionary':
        return {
          kind: 'dictionary',
          keys: descriptorFor(value.key, `${path}.key`),
          values: descriptorFor(value.value, `${path}.value`),
        };
      case 'literal':
        assert(
          value.value === null ||
            typeof value.value === 'boolean' ||
            typeof value.value === 'number' ||
            typeof value.value === 'string',
          `Unsupported literal at ${path}.`,
        );
        return { kind: 'literal', value: value.value };
      case 'table': {
        const parameters = sortedByName(value.parameters ?? []);
        assert.equal(
          new Set(parameters.map((parameter) => parameter.name)).size,
          parameters.length,
          `Duplicate table fields at ${path}.`,
        );
        return {
          kind: 'object',
          fields: parameters.map((parameter) => schemaField(parameter, descriptorFor)),
        };
      }
      case 'tuple':
        return {
          kind: 'tuple',
          items: (value.values ?? []).map((item, index) =>
            descriptorFor(item, `${path}.values[${index}]`),
          ),
        };
      case 'union': {
        const options = (value.options ?? []).map((option, index) =>
          descriptorFor(option, `${path}.options[${index}]`),
        );
        const serialized = options.map((option) => JSON.stringify(option));
        assert.equal(
          new Set(serialized).size,
          serialized.length,
          `Duplicate union options at ${path}.`,
        );
        return {
          kind: 'union',
          options: [...options].sort((left, right) =>
            codeUnitCompare(JSON.stringify(left), JSON.stringify(right)),
          ),
        };
      }
      default:
        throw new Error(
          `Unsupported Blueprint schema node ${JSON.stringify(complexType)} at ${path}.`,
        );
    }
  }

  function conceptDescriptor(name) {
    if (conceptDescriptors.has(name)) return conceptDescriptors.get(name);
    if (activeConcepts.has(name)) return { kind: 'reference', name };
    const concept = concepts.get(name);
    if (concept !== undefined) {
      activeConcepts.add(name);
      const descriptor = descriptorFor(concept.type, `${name}.type`);
      activeConcepts.delete(name);
      conceptDescriptors.set(name, descriptor);
      return descriptor;
    }
    const define = defines.get(name);
    if (define !== undefined) return define;
    throw new Error(`Dangling Blueprint schema reference ${JSON.stringify(name)}.`);
  }

  return { descriptorFor, conceptDescriptor };
}

function collectSchemaReferences(value, result) {
  if (!value || typeof value !== 'object') return;
  if (value.kind === 'reference') {
    result.add(value.name);
    return;
  }
  if (value.kind === 'array') collectSchemaReferences(value.items, result);
  if (value.kind === 'tuple') value.items.forEach((item) => collectSchemaReferences(item, result));
  if (value.kind === 'union')
    value.options.forEach((option) => collectSchemaReferences(option, result));
  if (value.kind === 'dictionary') {
    collectSchemaReferences(value.keys, result);
    collectSchemaReferences(value.values, result);
  }
  if (value.kind === 'object')
    value.fields.forEach((field) => collectSchemaReferences(field.type, result));
}

function assertNoCompilerOwnedFields(descriptor, path) {
  if (descriptor.kind !== 'object') return;
  for (const field of descriptor.fields) {
    if (blueprintCompilerOwnedFields.has(field.name)) {
      assert.equal(field.ownership, 'compiler', `${path}.${field.name} must be compiler-owned.`);
    }
  }
}

export async function generateSchemaCatalog({ fixtureDirectory, review } = {}) {
  const selectedReview = review ?? (await readJson(reviewUrl));
  const snapshotVersion = selectedReview.snapshotVersion;
  const selectedFixtureDirectory =
    fixtureDirectory ?? new URL(`fixtures/${snapshotVersion}/`, toolDirectory);
  const manifest = await readJson(new URL('manifest.json', selectedFixtureDirectory));
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

  const concepts = new Map(runtimeApi.concepts.map((entry) => [entry.name, entry]));
  const blueprintEntity = concepts.get('BlueprintEntity');
  assert.equal(blueprintEntity?.type?.complex_type, 'table');
  const defineDescriptors = flattenDefines(runtimeApi.defines);
  const { descriptorFor, conceptDescriptor } = schemaDescriptorFactory(concepts, defineDescriptors);

  const common = descriptorFor(blueprintEntity.type, 'BlueprintEntity.type');
  for (const field of common.fields) {
    if (blueprintCompilerOwnedFields.has(field.name)) field.ownership = 'compiler';
  }
  assertNoCompilerOwnedFields(common, 'common');

  const allVariants = blueprintEntity.type.variant_parameter_groups ?? [];
  assert.equal(
    new Set(allVariants.map((variant) => variant.name)).size,
    allVariants.length,
    'Duplicate BlueprintEntity variant groups in the pinned API.',
  );
  const controlBehaviorVariants = allVariants.filter((variant) =>
    variant.parameters.some((field) => field.name === 'control_behavior'),
  );
  const variants = sortedByName(allVariants).map((variant) => ({
    name: variant.name,
    fields: sortedByName(variant.parameters).map((parameter) =>
      schemaField(parameter, descriptorFor),
    ),
    structuralStatus: 'documented',
  }));
  for (const variant of variants) {
    assert.equal(
      new Set(variant.fields.map((field) => field.name)).size,
      variant.fields.length,
      `Duplicate fields in BlueprintEntity variant ${variant.name}.`,
    );
  }
  for (const variant of variants) {
    for (const field of variant.fields) {
      assert(
        !blueprintCompilerOwnedFields.has(field.name),
        `Compiler-owned BlueprintEntity field leaked into ${variant.name}.${field.name}.`,
      );
    }
  }

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
  const controlBehaviors = sortedByName(
    runtimeApi.classes.filter((entry) => entry.name.endsWith('ControlBehavior') && !entry.abstract),
  ).map((entry) => {
    const blueprintType =
      entry.name === 'LuaSelectorCombinatorControlBehavior'
        ? 'SelectorCombinatorParameters'
        : entry.name.replace(/^Lua/, '').replace(/ControlBehavior$/, 'BlueprintControlBehavior');
    assert(
      concepts.has(blueprintType),
      `Concrete class without a Blueprint schema: ${entry.name}.`,
    );
    assert(waveByClass.has(entry.name), `No review wave for ${entry.name}.`);
    const entityVariants = variants
      .filter((variant) =>
        variant.fields.some(
          (field) => field.name === 'control_behavior' && field.type.name === blueprintType,
        ),
      )
      .map((variant) => variant.name);
    return {
      name: entry.name,
      blueprintType,
      entityVariants,
      schema: conceptDescriptor(blueprintType),
      structuralStatus: 'documented',
      implementationStatus: 'unassessed-per-field',
      nativeEvidenceStatus: 'not-captured-by-catalog',
    };
  });
  assert.equal(
    new Set(controlBehaviors.map((behavior) => behavior.name)).size,
    controlBehaviors.length,
    'Duplicate control-behavior classes in the pinned API.',
  );
  assertExpectedCounts(
    {
      classes: runtimeApi.classes.filter((entry) => entry.name.endsWith('ControlBehavior')).length,
      concrete: controlBehaviors.length,
      abstract: runtimeApi.classes.filter(
        (entry) => entry.name.endsWith('ControlBehavior') && entry.abstract,
      ).length,
      entityVariants: controlBehaviorVariants.length,
    },
    selectedReview.expectedCounts,
  );
  assert.equal(
    controlBehaviors.length,
    selectedReview.expectedCounts.concrete,
    `Reviewed concrete count changed from ${selectedReview.expectedCounts.concrete} to ${controlBehaviors.length}; inspect the API delta and update control-behavior-review.json.`,
  );
  const referenceNames = new Set();
  collectSchemaReferences(common, referenceNames);
  variants.forEach((variant) =>
    variant.fields.forEach((field) => collectSchemaReferences(field.type, referenceNames)),
  );
  controlBehaviors.forEach((behavior) => collectSchemaReferences(behavior.schema, referenceNames));
  const references = [];
  const processedReferences = new Set();
  while (true) {
    const pending = [...referenceNames]
      .filter((name) => !processedReferences.has(name))
      .sort(codeUnitCompare);
    if (pending.length === 0) break;
    for (const name of pending) {
      const type = conceptDescriptor(name);
      references.push({ name, type });
      processedReferences.add(name);
      collectSchemaReferences(type, referenceNames);
    }
  }
  references.sort((left, right) => codeUnitCompare(left.name, right.name));
  assert.deepEqual(
    [...referenceNames].sort(codeUnitCompare),
    [...processedReferences].sort(codeUnitCompare),
  );
  assert.deepEqual(
    {
      entityVariants: variants.length,
      controlBehaviors: controlBehaviors.length,
      referencedSchemas: references.length,
    },
    selectedReview.expectedSchemaCatalogCounts,
    'Reviewed Blueprint schema catalog counts changed; inspect the API delta and update control-behavior-review.json.',
  );

  return {
    format: 'comblang-blueprint-schema-catalog',
    version: 1,
    source: {
      snapshot: `fixtures/${snapshotVersion}`,
      applicationVersion: runtimeApi.application_version,
      apiVersion: runtimeApi.api_version,
      runtimeSha256: manifest.files['runtime-api.json'].sha256,
      prototypeSha256: manifest.files['prototype-api.json'].sha256,
    },
    counts: {
      entityVariants: variants.length,
      controlBehaviors: controlBehaviors.length,
      referencedSchemas: references.length,
    },
    common,
    variants,
    controlBehaviors,
    references,
    warning:
      'This catalog records the pinned BlueprintEntity API shape only. It grants no Entity construction, connector, callable, simulation, or native-conformance authority.',
  };
}

export const serializeSchemaCatalog = (catalog) => `${JSON.stringify(catalog, null, 2)}\n`;

export async function runSchemaCatalogGenerator({ check = false } = {}) {
  const serialized = serializeSchemaCatalog(await generateSchemaCatalog());
  if (check) {
    const current = await readFile(catalogOutputUrl, 'utf8');
    assert.equal(
      current,
      serialized,
      'Generated Blueprint schema catalog is stale; run npm run factorio-api:catalog.',
    );
  } else {
    await writeFile(catalogOutputUrl, serialized);
  }
  return JSON.parse(serialized).counts;
}

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
  const check = process.argv.includes('--check');
  const counts = process.argv.includes('--catalog')
    ? await runSchemaCatalogGenerator({ check })
    : await runGenerator({ check });
  console.log(JSON.stringify(counts));
}
