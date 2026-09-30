import { readFile } from 'node:fs/promises';
import { decodeBlueprintExchange, stringifyLosslessJson } from '@comblang/blueprint';
import { describe, expect, test } from 'vitest';

import { BlueprintJsonError } from './blueprint-json.js';
import { emitNativeBlueprintJson } from './native-blueprint-emitter.js';
import type { NativeBlueprintFcir, NativeBlueprintParameter } from './native-blueprint-ir.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function emptyFcir(): NativeBlueprintFcir {
  return deepFreeze({
    header: {
      item: 'blueprint',
      label: 'parameter metadata',
      version: 562954249502720,
      icons: [{ signal: { type: 'item', name: 'blueprint' }, index: 1 }],
    },
    entities: [],
    wires: [],
  });
}

function withParameters(parameters: unknown): NativeBlueprintFcir {
  return Object.freeze({ ...emptyFcir(), parameters }) as unknown as NativeBlueprintFcir;
}

describe('native blueprint parameter metadata emission', () => {
  test('keeps absent parameters absent', () => {
    expect(emitNativeBlueprintJson(emptyFcir()).blueprint).not.toHaveProperty('parameters');
  });

  test('retains an explicit immutable empty parameters array', () => {
    const fcir = withParameters(Object.freeze([]));
    expect(emitNativeBlueprintJson(fcir).blueprint).toHaveProperty('parameters', []);
  });

  test('preserves ordered number/id rows and their opaque fields without mutating FCIR', () => {
    const parameters: readonly NativeBlueprintParameter[] = deepFreeze([
      {
        type: 'number',
        number: '+0005.00e-2',
        name: 'Число 信号',
        variable: 'x',
        formula: ' x*p0_i1\n',
        dependent: true,
      },
      {
        type: 'id',
        id: 'parameter-0',
        name: '',
        'ingredient-of': 'parameter-1',
        'item-ingredient-of': 'parameter-2',
        'fluid-ingredient-of': 'parameter-3',
        'product-of': 'parameter-4',
        'item-product-of': 'parameter-5',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
    ]);
    const fcir = withParameters(parameters);
    const before = JSON.stringify(fcir);
    const output = emitNativeBlueprintJson(fcir);
    expect(output.blueprint.parameters).toEqual(parameters);
    expect(JSON.parse(JSON.stringify(output)).blueprint.parameters).toEqual(parameters);
    expect(JSON.stringify(fcir)).toBe(before);
    expect(parameters.every(Object.isFrozen)).toBe(true);
  });

  test('does not interpret numeric spellings, formulas, duplicates or semantic references', () => {
    const parameters: readonly NativeBlueprintParameter[] = deepFreeze([
      { type: 'number', number: '  ', name: '', variable: '', formula: '', dependent: false },
      { type: 'number', number: '  ' },
      {
        type: 'id',
        id: 'opaque id',
        'ingredient-of': 'opaque id',
        'product-of': 'missing id',
        'quality-condition': { quality: '', comparator: 'unassessed comparator' },
      },
      { type: 'id', id: 'opaque id' },
    ]);
    expect(emitNativeBlueprintJson(withParameters(parameters)).blueprint.parameters).toEqual(
      parameters,
    );
  });

  test.each(['recipe-formulas', 'display-quality', 'dependency-chain'])(
    'emits the complete %s fixture parameter metadata only',
    async (name) => {
      const path = new URL(
        `../../../fixtures/blueprint-exchange/factorio-2.1.17/${name}.txt`,
        import.meta.url,
      );
      const exchange = (await readFile(path, 'utf8')).trim();
      const decoded = await decodeBlueprintExchange(exchange);
      const document = JSON.parse(stringifyLosslessJson(decoded)) as {
        blueprint: { parameters: unknown };
      };
      // Only top-level metadata is compared: no Entity reconstruction, header/default
      // matching, native import, formula evaluation or placement behavior is tested.
      const parameters = deepFreeze(document.blueprint.parameters);
      expect(Array.isArray(parameters)).toBe(true);
      const fcir = withParameters(parameters);
      const before = JSON.stringify(fcir);
      const output = emitNativeBlueprintJson(fcir);
      expect(output.blueprint.parameters).toStrictEqual(parameters);
      expect(JSON.stringify(output.blueprint.parameters)).toBe(JSON.stringify(parameters));
      expect(JSON.stringify(fcir)).toBe(before);
    },
  );
});

describe('native parameter metadata boundary', () => {
  function expectInvalid(parameters: unknown, detail: string): void {
    expect(() => emitNativeBlueprintJson(withParameters(parameters))).toThrow(BlueprintJsonError);
    expect(() => emitNativeBlueprintJson(withParameters(parameters))).toThrowError(
      expect.objectContaining({ code: 'BP1001', message: expect.stringContaining(detail) }),
    );
  }

  test.each([
    ['unknown discriminator', { type: 'signal', id: 'parameter-0' }, '.type'],
    ['non-string discriminator', { type: 1, number: '1' }, '.type'],
    ['numeric original instead of text', { type: 'number', number: 1 }, '.number'],
    ['missing numeric original', { type: 'number' }, '.number'],
    ['empty numeric original', { type: 'number', number: '' }, '.number'],
    ['wrong identifier type', { type: 'id', id: 1 }, '.id'],
    ['missing identifier', { type: 'id' }, '.id'],
    ['empty identifier', { type: 'id', id: '' }, '.id'],
    ['wrong name type', { type: 'number', number: '1', name: 1 }, '.name'],
    ['wrong variable type', { type: 'number', number: '1', variable: true }, '.variable'],
    ['wrong formula type', { type: 'number', number: '1', formula: null }, '.formula'],
    ['wrong dependent type', { type: 'number', number: '1', dependent: 'true' }, '.dependent'],
    [
      'wrong dependency type',
      { type: 'id', id: 'parameter-0', 'ingredient-of': 1 },
      '.ingredient-of',
    ],
    ['unknown row field', { type: 'number', number: '1', source: 'internal' }, '.source'],
    ['field from the other variant', { type: 'id', id: 'parameter-0', formula: '' }, '.formula'],
    ['undefined optional field', { type: 'number', number: '1', variable: undefined }, '.variable'],
    [
      'missing quality comparator',
      { type: 'id', id: 'parameter-0', 'quality-condition': { quality: 'normal' } },
      '.comparator',
    ],
    [
      'wrong quality type',
      { type: 'id', id: 'parameter-0', 'quality-condition': { quality: 1, comparator: '=' } },
      '.quality',
    ],
    [
      'unknown quality field',
      {
        type: 'id',
        id: 'parameter-0',
        'quality-condition': { quality: 'normal', comparator: '=', extra: true },
      },
      '.extra',
    ],
  ] as const)('rejects %s with a typed error before emission', (_name, row, detail) => {
    expectInvalid(deepFreeze([row]), detail);
  });

  test('rejects non-array metadata and explicitly undefined metadata', () => {
    expectInvalid(Object.freeze({}), 'expected an immutable plain array');
    expectInvalid(undefined, 'omit absent metadata');
  });

  test('rejects mutable arrays, rows and nested quality records', () => {
    expectInvalid([Object.freeze({ type: 'number', number: '1' })], 'array must be immutable');
    expectInvalid(Object.freeze([{ type: 'number', number: '1' }]), 'record must be immutable');
    const row = Object.freeze({
      type: 'id',
      id: 'parameter-0',
      'quality-condition': { quality: 'normal', comparator: '=' },
    });
    expectInvalid(Object.freeze([row]), 'quality-condition: record must be immutable');
  });

  test('rejects sparse and extra-field metadata arrays', () => {
    expectInvalid(Object.freeze(new Array(1)), 'array holes');
    const extra = Object.assign([Object.freeze({ type: 'number', number: '1' })], { extra: true });
    expectInvalid(Object.freeze(extra), 'unknown array field');
  });

  test('rejects symbol keys and cyclic metadata', () => {
    expectInvalid(
      deepFreeze([{ type: 'number', number: '1', [Symbol('hidden')]: true }]),
      'symbol keys',
    );
    const row: Record<string, unknown> = { type: 'number', number: '1' };
    row.formula = row;
    Object.freeze(row);
    expectInvalid(Object.freeze([row]), 'cyclic native payloads');
  });

  test('rejects accessor-backed rows, array items and root metadata without evaluating getters', () => {
    let calls = 0;
    const getter = () => {
      calls += 1;
      return '1';
    };
    const row = { type: 'number' };
    Object.defineProperty(row, 'number', { enumerable: true, get: getter });
    expectInvalid(Object.freeze([Object.freeze(row)]), 'accessors are not supported');
    const parameters: unknown[] = [];
    Object.defineProperty(parameters, '0', { enumerable: true, get: getter });
    expectInvalid(Object.freeze(parameters), 'accessors are not supported');
    const root = { ...emptyFcir() };
    Object.defineProperty(root, 'parameters', { enumerable: true, get: getter });
    expect(() => emitNativeBlueprintJson(Object.freeze(root))).toThrowError(
      expect.objectContaining({ code: 'BP1001', message: expect.stringContaining('accessors') }),
    );
    expect(calls).toBe(0);
  });

  test('charges metadata against the same string-byte budget as the header', () => {
    const base = emptyFcir();
    const fcir = Object.freeze({
      ...base,
      header: Object.freeze({ ...base.header, label: 'x'.repeat(4_194_304 - 1) }),
    });
    expect(() => emitNativeBlueprintJson(fcir)).not.toThrow();
    const parameters: readonly NativeBlueprintParameter[] = deepFreeze([
      { type: 'number', number: '1' },
    ]);
    expect(() => emitNativeBlueprintJson(Object.freeze({ ...fcir, parameters }))).toThrowError(
      expect.objectContaining({
        code: 'BP1001',
        message: expect.stringContaining('native JSON string byte limit exceeded'),
      }),
    );
  });
});
