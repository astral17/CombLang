import { describe, expect, test } from 'vitest';
import { resolveBlueprintEntitySchema } from './blueprint-schema-resolution.js';
import {
  validateBlueprintEntityFragment,
  validateBlueprintEntityFragmentAgainstSchema,
  type BlueprintSchemaValidationLimits,
} from './blueprint-schema-validation.js';
import type { BlueprintSchemaDescriptor, BlueprintSchemaField } from './blueprint-schema.js';

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

describe('Blueprint Entity schema validation', () => {
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
