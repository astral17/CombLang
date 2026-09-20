import { describe, expect, test } from 'vitest';
import { blueprintSchemaCatalog } from './blueprint-schema-loader.js';
import { resolveBlueprintEntitySchema } from './blueprint-schema-resolution.js';
import {
  validateBlueprintEntityFragment,
  validateBlueprintEntityFragmentAgainstSchema,
  type BlueprintSchemaValidationLimits,
} from './blueprint-schema-validation.js';
import type {
  BlueprintSchemaCatalog,
  BlueprintSchemaDescriptor,
  BlueprintSchemaField,
} from './blueprint-schema.js';

function field(name: string, type: BlueprintSchemaDescriptor): BlueprintSchemaField {
  return { name, type, optional: true };
}

function syntheticSchema(
  fields: readonly BlueprintSchemaField[],
  references: readonly { name: string; type: BlueprintSchemaDescriptor }[] = [],
) {
  const object = { kind: 'object' as const, fields };
  return {
    kind: 'resolved' as const,
    lookup: 'blueprint-entity-schema' as const,
    prototypeType: 'synthetic',
    structuralStatus: 'documented-variant' as const,
    common: { kind: 'object' as const, fields: [] },
    commonFields: [],
    variantFields: fields,
    fields,
    references,
    object,
  };
}

interface DescriptorGraphCharacterization {
  readonly descriptorKinds: readonly BlueprintSchemaDescriptor['kind'][];
  readonly scalarNames: readonly string[];
  readonly reachableReferences: readonly string[];
  readonly referenceCycles: readonly (readonly string[])[];
}

function characterizeDescriptorGraph(
  roots: readonly BlueprintSchemaDescriptor[],
  catalog: Pick<BlueprintSchemaCatalog, 'references'>,
): DescriptorGraphCharacterization {
  const references = new Map(
    catalog.references.map((reference) => [reference.name, reference.type]),
  );
  const descriptorKinds = new Set<BlueprintSchemaDescriptor['kind']>();
  const scalarNames = new Set<string>();
  const reachableReferences = new Set<string>();
  const referenceStack: string[] = [];
  const referenceCycles: string[][] = [];

  const visit = (descriptor: BlueprintSchemaDescriptor): void => {
    descriptorKinds.add(descriptor.kind);
    switch (descriptor.kind) {
      case 'scalar':
        scalarNames.add(descriptor.name);
        return;
      case 'literal':
        return;
      case 'array':
        visit(descriptor.items);
        return;
      case 'tuple':
        descriptor.items.forEach(visit);
        return;
      case 'union':
        descriptor.options.forEach(visit);
        return;
      case 'dictionary':
        visit(descriptor.keys);
        visit(descriptor.values);
        return;
      case 'object':
        descriptor.fields.forEach((field) => visit(field.type));
        descriptor.variant?.groups.forEach((group) =>
          group.fields.forEach((field) => visit(field.type)),
        );
        return;
      case 'reference': {
        const target = references.get(descriptor.name);
        if (target === undefined) {
          throw new Error(`Missing Blueprint schema reference ${JSON.stringify(descriptor.name)}.`);
        }
        const cycleStart = referenceStack.indexOf(descriptor.name);
        if (cycleStart >= 0) {
          referenceCycles.push([...referenceStack.slice(cycleStart), descriptor.name]);
          return;
        }
        if (reachableReferences.has(descriptor.name)) return;
        reachableReferences.add(descriptor.name);
        referenceStack.push(descriptor.name);
        visit(target);
        referenceStack.pop();
        return;
      }
    }
  };

  roots.forEach(visit);
  return {
    descriptorKinds: [...descriptorKinds].sort(),
    scalarNames: [...scalarNames].sort(),
    reachableReferences: [...reachableReferences].sort(),
    referenceCycles: referenceCycles.map((cycle) => [...cycle]),
  };
}

function characterizeEntityVariants(catalog: BlueprintSchemaCatalog) {
  const common = catalog.common;
  if (common.kind !== 'object') throw new Error('Expected a common object descriptor.');
  return catalog.variants.map((variant) => {
    const graph = characterizeDescriptorGraph(
      [common, ...variant.fields.map((field) => field.type)],
      catalog,
    );
    return {
      name: variant.name,
      fieldNames: [...common.fields, ...variant.fields].map((field) => field.name).sort(),
      ...graph,
    };
  });
}

const schemaFamilyFixtures = [
  {
    family: 'logistics',
    prototypeType: 'logistic-container',
    fragment: {
      request_filters: {
        request_from_buffers: false,
        trash_not_requested: false,
        sections: [
          {
            active: true,
            index: 0,
            group: 'logistics',
            multiplier: 1,
            filters: [
              { index: 0, name: 'iron-plate', type: 'item', count: 1, request_from: 'all' },
            ],
          },
        ],
      },
    },
    invalidFragment: {
      request_filters: {
        sections: [
          {
            filters: [{ index: -1, name: 'iron-plate', type: 'item', count: 1 }],
          },
        ],
      },
    },
    badPath: '$.request_filters.sections[0].filters[0].index',
  },
  {
    family: 'belts',
    prototypeType: 'transport-belt',
    fragment: {
      control_behavior: {
        circuit_enabled: true,
        circuit_read_hand_contents: false,
        circuit_contents_read_mode: 'hold',
        connect_to_logistic_network: true,
        input_networks: { red: true, green: false },
        output_networks: { red: false, green: true },
      },
    },
    invalidFragment: {
      control_behavior: { circuit_contents_read_mode: 'invalid' },
    },
    badPath: '$.control_behavior.circuit_contents_read_mode',
  },
  {
    family: 'displays',
    prototypeType: 'display-panel',
    fragment: {
      always_show: false,
      show_in_chart: true,
      text: 'status',
      icon: { type: 'virtual', name: 'signal-A' },
      control_behavior: {
        parameters: [
          {
            text: 'message',
            icon: { name: 'signal-B' },
            condition: {
              comparator: '=',
              constant: 0,
              first_signal: { type: 'virtual', name: 'signal-A' },
            },
          },
        ],
      },
    },
    invalidFragment: {
      control_behavior: {
        parameters: [{ text: 'message', condition: { comparator: '??' } }],
      },
    },
    badPath: '$.control_behavior.parameters[0].condition.comparator',
  },
  {
    family: 'train stops',
    prototypeType: 'train-stop',
    fragment: {
      station: 'Main station',
      priority: 0,
      manual_trains_limit: 2,
      color: { r: 0.2, g: 0.4, b: 0.6, a: 1 },
      control_behavior: {
        circuit_enabled: true,
        connect_to_logistic_network: false,
        input_networks: { red: true, green: false },
        output_networks: { red: false, green: true },
        read_from_train: true,
        read_stopped_train: false,
        read_trains_count: true,
        send_to_train: false,
        set_priority: false,
        set_trains_limit: true,
        train_stopped_signal: { type: 'virtual', name: 'signal-A' },
      },
    },
    invalidFragment: { priority: 256 },
    badPath: '$.priority',
  },
  {
    family: 'filters',
    prototypeType: 'inserter',
    fragment: {
      filter_mode: 'whitelist',
      use_filters: true,
      override_stack_size: 1,
      pickup_position: { x: 0, y: -1 },
      drop_position: { x: 0, y: 1 },
      filters: [{ index: 0, name: 'iron-plate', quality: 'normal' }],
    },
    invalidFragment: { filters: [{ index: -1, name: 'iron-plate' }] },
    badPath: '$.filters[0].index',
  },
  {
    family: 'recipes',
    prototypeType: 'assembling-machine',
    fragment: {
      recipe: 'iron-gear-wheel',
      recipe_quality: 'normal',
      control_behavior: {
        circuit_enabled: false,
        read_contents: true,
        set_recipe: true,
        input_networks: { red: true, green: true },
        output_networks: { red: false, green: true },
      },
    },
    invalidFragment: { recipe_quality: 0 },
    badPath: '$.recipe_quality',
  },
  {
    family: 'transport settings',
    prototypeType: 'loader',
    fragment: {
      belt_stack_size_override: 2,
      type: 'output',
      filter_mode: 'whitelist',
      filters: [{ index: 0, name: 'iron-plate' }],
    },
    invalidFragment: { type: 'sideways' },
    badPath: '$.type',
  },
] as const;

describe('Blueprint Entity schema validation', () => {
  test('characterizes every generated Entity variant and its complete descriptor closure', () => {
    const characterization = characterizeEntityVariants(blueprintSchemaCatalog);
    expect(blueprintSchemaCatalog.counts).toEqual({
      entityVariants: 62,
      controlBehaviors: 37,
      referencedSchemas: 116,
    });
    expect(characterization).toHaveLength(blueprintSchemaCatalog.counts.entityVariants);
    expect(characterization.map(({ name }) => name)).toEqual(
      blueprintSchemaCatalog.variants.map(({ name }) => name),
    );
    for (const entry of characterization) {
      const variant = blueprintSchemaCatalog.variants.find(({ name }) => name === entry.name);
      if (variant === undefined) throw new Error(`Missing characterization for ${entry.name}.`);
      const resolved = resolveBlueprintEntitySchema({ type: variant.name }, blueprintSchemaCatalog);
      expect(entry.fieldNames).toEqual(resolved.fields.map((field) => field.name).sort());
      expect(entry.descriptorKinds).toEqual([
        'array',
        'dictionary',
        'literal',
        'object',
        'reference',
        'scalar',
        'tuple',
        'union',
      ]);
      expect(entry.reachableReferences.length).toBeGreaterThan(0);
    }
    const reachableReferences = new Set(
      characterization.flatMap(({ reachableReferences: refs }) => refs),
    );
    expect([...reachableReferences].sort()).toEqual(
      blueprintSchemaCatalog.references.map(({ name }) => name).sort(),
    );

    const scalarNames = new Set(characterization.flatMap(({ scalarNames: names }) => names));
    expect([...scalarNames].sort()).toEqual([
      'EquipmentIDAndQualityIDPair',
      'LuaEquipment',
      'LuaEquipmentPrototype',
      'LuaItem',
      'LuaItemPrototype',
      'LuaItemStack',
      'LuaQualityPrototype',
      'boolean',
      'double',
      'float',
      'int32',
      'number',
      'string',
      'table',
      'uint16',
      'uint32',
      'uint8',
    ]);
    const scalarStatuses = [...scalarNames].map((name) => {
      const witness = name === 'boolean' ? false : name === 'string' ? 'value' : 0;
      const result = validateBlueprintEntityFragmentAgainstSchema(
        { value: witness },
        syntheticSchema([{ name: 'value', type: { kind: 'scalar', name }, optional: true }]),
      );
      return [name, result.status] as const;
    });
    expect(
      scalarStatuses
        .filter(([, status]) => status === 'valid')
        .map(([name]) => name)
        .sort(),
    ).toEqual([
      'boolean',
      'double',
      'float',
      'int32',
      'number',
      'string',
      'table',
      'uint16',
      'uint32',
      'uint8',
    ]);
    expect(
      scalarStatuses
        .filter(([, status]) => status === 'unassessed')
        .map(([name]) => name)
        .sort(),
    ).toEqual([
      'EquipmentIDAndQualityIDPair',
      'LuaEquipment',
      'LuaEquipmentPrototype',
      'LuaItem',
      'LuaItemPrototype',
      'LuaItemStack',
      'LuaQualityPrototype',
    ]);
    expect(scalarStatuses.some(([, status]) => status === 'invalid')).toBe(false);
  });

  test('terminates and records cycles in named reference graphs', () => {
    const catalog = {
      references: [
        {
          name: 'A',
          type: {
            kind: 'object' as const,
            fields: [
              { name: 'next', type: { kind: 'reference' as const, name: 'B' }, optional: true },
            ],
          },
        },
        {
          name: 'B',
          type: {
            kind: 'object' as const,
            fields: [
              { name: 'next', type: { kind: 'reference' as const, name: 'A' }, optional: true },
            ],
          },
        },
      ],
    } as unknown as BlueprintSchemaCatalog;
    expect(characterizeDescriptorGraph([{ kind: 'reference', name: 'A' }], catalog)).toMatchObject({
      reachableReferences: ['A', 'B'],
      referenceCycles: [['A', 'B', 'A']],
    });
  });

  test.each(schemaFamilyFixtures)(
    'validates the $family schema fixture and reports its bad value path',
    ({ prototypeType, fragment, invalidFragment, badPath }) => {
      expect(validateBlueprintEntityFragment(fragment, { type: prototypeType })).toEqual({
        status: 'valid',
        structuralStatus: 'documented',
      });
      expect(
        validateBlueprintEntityFragment(invalidFragment, { type: prototypeType }),
      ).toMatchObject({
        status: 'invalid',
        structuralStatus: 'documented',
        path: badPath,
      });
    },
  );

  test('accepts documented partial fragments and common-only prototypes', () => {
    expect(
      validateBlueprintEntityFragment(
        {
          recipe: 'iron-gear-wheel',
          control_behavior: { read_contents: false },
        },
        { type: 'assembling-machine' },
      ),
    ).toEqual({ status: 'valid', structuralStatus: 'documented' });

    expect(validateBlueprintEntityFragment({}, { type: 'beacon' })).toEqual({
      status: 'valid',
      structuralStatus: 'documented',
    });
  });

  test('treats Blueprint SignalID objects as structural data', () => {
    expect(
      validateBlueprintEntityFragment(
        { control_behavior: { working_signal: { name: 'signal-A' } } },
        { type: 'assembling-machine' },
      ),
    ).toEqual({ status: 'valid', structuralStatus: 'documented' });
    expect(
      validateBlueprintEntityFragment(
        {
          control_behavior: {
            working_signal: { type: 'virtual', name: 'signal-A', quality: 'legendary' },
          },
        },
        { type: 'assembling-machine' },
      ),
    ).toEqual({ status: 'valid', structuralStatus: 'documented' });
    expect(
      validateBlueprintEntityFragment(
        { control_behavior: { working_signal: { type: 'unsupported', name: 'signal-A' } } },
        { type: 'assembling-machine' },
      ),
    ).toMatchObject({
      status: 'invalid',
      path: '$.control_behavior.working_signal.type',
    });
    expect(
      validateBlueprintEntityFragment(
        { control_behavior: { working_signal: { name: 'signal-A', quality: 3 } } },
        { type: 'assembling-machine' },
      ),
    ).toMatchObject({
      status: 'unassessed',
      path: '$.control_behavior.working_signal.quality',
    });
  });

  test('selects exact SelectorCombinator variants without flattening their fields', () => {
    expect(
      validateBlueprintEntityFragment(
        {
          control_behavior: {
            operation: 'select',
            select_max: false,
            index_constant: 0,
          },
        },
        { type: 'selector-combinator' },
      ),
    ).toEqual({ status: 'valid', structuralStatus: 'documented' });
    expect(
      validateBlueprintEntityFragment(
        { control_behavior: { select_max: true, index_constant: 0 } },
        { type: 'selector-combinator' },
      ),
    ).toEqual({ status: 'valid', structuralStatus: 'documented' });
    expect(
      validateBlueprintEntityFragment(
        { control_behavior: { operation: 'count', count_signal: { name: 'signal-A' } } },
        { type: 'selector-combinator' },
      ),
    ).toEqual({ status: 'valid', structuralStatus: 'documented' });
    expect(
      validateBlueprintEntityFragment(
        { control_behavior: { operation: 'random', random_update_interval: 0 } },
        { type: 'selector-combinator' },
      ),
    ).toEqual({ status: 'valid', structuralStatus: 'documented' });
    expect(
      validateBlueprintEntityFragment(
        { control_behavior: { operation: 'time', day_length_signal: { name: 'signal-A' } } },
        { type: 'selector-combinator' },
      ),
    ).toEqual({ status: 'valid', structuralStatus: 'documented' });
    expect(
      validateBlueprintEntityFragment(
        { control_behavior: { operation: 'quality-transfer' } },
        { type: 'selector-combinator' },
      ),
    ).toMatchObject({
      status: 'invalid',
      code: 'BSV1002',
      path: '$.control_behavior.quality_destination_signal',
    });
    expect(
      validateBlueprintEntityFragment(
        {
          control_behavior: {
            operation: 'select',
            count_signal: { name: 'signal-A' },
          },
        },
        { type: 'selector-combinator' },
      ),
    ).toMatchObject({
      status: 'invalid',
      code: 'BSV1001',
      path: '$.control_behavior.count_signal',
    });
    expect(
      validateBlueprintEntityFragment(
        { control_behavior: { operation: 'rocket-capacity', index_constant: 0 } },
        { type: 'selector-combinator' },
      ),
    ).toMatchObject({
      status: 'invalid',
      code: 'BSV1001',
      path: '$.control_behavior.index_constant',
    });
    expect(
      validateBlueprintEntityFragment(
        { control_behavior: { operation: 'rocket-capacity' } },
        { type: 'selector-combinator' },
      ),
    ).toEqual({ status: 'valid', structuralStatus: 'documented' });
    expect(
      validateBlueprintEntityFragment(
        { control_behavior: { operation: 'not-an-operation' } },
        { type: 'selector-combinator' },
      ),
    ).toMatchObject({
      status: 'invalid',
      code: 'BSV1002',
      path: '$.control_behavior.operation',
    });
  });

  test('does not execute accessors while selecting a SelectorCombinator variant', () => {
    const controlBehavior: Record<string, unknown> = {};
    Object.defineProperty(controlBehavior, 'operation', {
      enumerable: true,
      get() {
        throw new Error('getter executed');
      },
    });
    expect(
      validateBlueprintEntityFragment(
        { control_behavior: controlBehavior },
        { type: 'selector-combinator' },
      ),
    ).toMatchObject({ status: 'invalid', code: 'BSV1005', path: '$.control_behavior.operation' });
  });

  test('reports unknown fields, wrong scalar types, and compiler ownership with JSON paths', () => {
    expect(
      validateBlueprintEntityFragment({ recipe: 42 }, { type: 'assembling-machine' }),
    ).toMatchObject({ status: 'invalid', code: 'BSV1002', path: '$.recipe' });
    expect(
      validateBlueprintEntityFragment({ not_a_field: true }, { type: 'assembling-machine' }),
    ).toMatchObject({ status: 'invalid', code: 'BSV1001', path: '$.not_a_field' });
    expect(
      validateBlueprintEntityFragment({ name: 'owned' }, { type: 'assembling-machine' }),
    ).toMatchObject({
      status: 'invalid',
      code: 'BSV1003',
      path: '$.name',
    });
  });

  test('returns unassessed for unfamiliar scalar descriptors and suggests raw', () => {
    const schema = syntheticSchema([field('runtime_value', { kind: 'scalar', name: 'LuaCustom' })]);
    expect(validateBlueprintEntityFragmentAgainstSchema({ runtime_value: true }, schema)).toEqual({
      status: 'unassessed',
      structuralStatus: 'unassessed',
      code: 'BSV1004',
      path: '$.runtime_value',
      message: expect.stringContaining('LuaCustom'),
      rawSuggestion: 'Use Entity(prototype, { raw: ... }) for this value.',
    });
  });

  test('validates arrays, tuples, unions, dictionaries, literals, and recursive references', () => {
    const recursive: BlueprintSchemaDescriptor = {
      kind: 'object',
      fields: [
        field('value', { kind: 'scalar', name: 'int32' }),
        field('next', { kind: 'reference', name: 'Node' }),
      ],
    };
    const schema = syntheticSchema(
      [
        field('nodes', { kind: 'array', items: { kind: 'reference', name: 'Node' } }),
        field('position', {
          kind: 'union',
          options: [
            {
              kind: 'object',
              fields: [field('x', { kind: 'scalar', name: 'double' })],
            },
            {
              kind: 'tuple',
              items: [
                { kind: 'scalar', name: 'double' },
                { kind: 'scalar', name: 'double' },
              ],
            },
          ],
        }),
        field('filters', {
          kind: 'dictionary',
          keys: { kind: 'scalar', name: 'string' },
          values: { kind: 'literal', value: 'enabled' },
        }),
      ],
      [{ name: 'Node', type: recursive }],
    );

    expect(
      validateBlueprintEntityFragmentAgainstSchema(
        {
          nodes: [{ value: 0 }, { value: 2, next: { value: -2 } }],
          position: [0, 1.5],
          filters: { a: 'enabled', z: 'enabled' },
        },
        schema,
      ),
    ).toEqual({ status: 'valid', structuralStatus: 'documented' });
    expect(validateBlueprintEntityFragmentAgainstSchema({ position: [0] }, schema)).toMatchObject({
      status: 'invalid',
      code: 'BSV1002',
      path: '$.position',
    });
  });

  test('rejects cycles, accessors, symbols, holes, nonfinite values, and limit violations', () => {
    const schema = syntheticSchema([
      field('value', { kind: 'scalar', name: 'number' }),
      field('items', { kind: 'array', items: { kind: 'scalar', name: 'number' } }),
    ]);
    const cyclic: Record<string, unknown> = {};
    cyclic.value = cyclic;
    expect(validateBlueprintEntityFragmentAgainstSchema(cyclic, schema)).toMatchObject({
      status: 'invalid',
      code: 'BSV1005',
      path: '$.value',
    });

    const accessor = {};
    Object.defineProperty(accessor, 'value', { get: () => 1, enumerable: true });
    expect(validateBlueprintEntityFragmentAgainstSchema(accessor, schema)).toMatchObject({
      status: 'invalid',
      code: 'BSV1005',
      path: '$.value',
    });

    const symbol = { value: 1, [Symbol('unexpected')]: true };
    expect(validateBlueprintEntityFragmentAgainstSchema(symbol, schema)).toMatchObject({
      status: 'invalid',
      code: 'BSV1005',
    });
    const hole = [] as number[];
    hole.length = 1;
    expect(validateBlueprintEntityFragmentAgainstSchema({ items: hole }, schema)).toMatchObject({
      status: 'invalid',
      code: 'BSV1005',
      path: '$.items[0]',
    });
    expect(
      validateBlueprintEntityFragmentAgainstSchema({ value: Number.NaN }, schema),
    ).toMatchObject({
      status: 'invalid',
      code: 'BSV1005',
      path: '$.value',
    });

    const limits: BlueprintSchemaValidationLimits = {
      maxDepth: 0,
      maxNodes: 4096,
      maxBytes: 262_144,
    };
    expect(
      validateBlueprintEntityFragmentAgainstSchema({ value: 1 }, schema, limits),
    ).toMatchObject({
      status: 'invalid',
      code: 'BSV1005',
      path: '$.value',
    });
    expect(
      validateBlueprintEntityFragmentAgainstSchema({ value: 1 }, schema, {
        maxDepth: 32,
        maxNodes: 1,
        maxBytes: 262_144,
      }),
    ).toMatchObject({ status: 'invalid', code: 'BSV1005' });
  });

  test('checks signed and unsigned integer boundaries without mutating input', () => {
    const schema = syntheticSchema([
      field('signed', { kind: 'scalar', name: 'int32' }),
      field('unsigned', { kind: 'scalar', name: 'uint8' }),
    ]);
    const input = { signed: -2_147_483_648, unsigned: 255 };
    const before = JSON.stringify(input);
    expect(validateBlueprintEntityFragmentAgainstSchema(input, schema)).toEqual({
      status: 'valid',
      structuralStatus: 'documented',
    });
    expect(JSON.stringify(input)).toBe(before);
    expect(
      validateBlueprintEntityFragmentAgainstSchema({ signed: 2_147_483_648 }, schema),
    ).toMatchObject({
      status: 'invalid',
      code: 'BSV1003',
      path: '$.signed',
    });
    expect(validateBlueprintEntityFragmentAgainstSchema({ unsigned: -1 }, schema)).toMatchObject({
      status: 'invalid',
      code: 'BSV1003',
      path: '$.unsigned',
    });
  });
});
