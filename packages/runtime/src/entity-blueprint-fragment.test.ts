import { Signal } from '@comblang/factorio';
import type { BlueprintSchemaDescriptor, BlueprintSchemaField } from '@comblang/prototypes';
import { describe, expect, test } from 'vitest';
import {
  BlueprintEntitySignalConversionError,
  detachBlueprintEntitySignalHandles,
} from './entity-blueprint-fragment.js';

function field(name: string, type: BlueprintSchemaDescriptor): BlueprintSchemaField {
  return { name, type, optional: true };
}

const signalReference: BlueprintSchemaDescriptor = { kind: 'reference', name: 'SignalID' };
const signalObject: BlueprintSchemaDescriptor = {
  kind: 'object',
  fields: [
    field('name', { kind: 'scalar', name: 'string' }),
    field('type', { kind: 'scalar', name: 'string' }),
    field('quality', { kind: 'scalar', name: 'string' }),
  ],
};
const schema = {
  kind: 'resolved' as const,
  lookup: 'blueprint-entity-schema' as const,
  prototypeType: 'synthetic',
  structuralStatus: 'documented-variant' as const,
  common: { kind: 'object' as const, fields: [] },
  commonFields: [],
  variantFields: [],
  fields: [],
  references: [{ name: 'SignalID', type: signalObject }],
  object: { kind: 'object' as const, fields: [] },
};

const sourceSignal = Signal('virtual', 'signal-A');
const isSignal = (value: unknown): boolean => value === sourceSignal;

describe('Blueprint Entity Signal detachment', () => {
  test('detaches signals through arrays, tuples, dictionaries, references, and unions', () => {
    const value = {
      array: [sourceSignal],
      tuple: [sourceSignal, sourceSignal],
      dictionary: { first: sourceSignal },
      nested: { entries: [sourceSignal] },
      union: { first: sourceSignal, second: sourceSignal },
    };
    const node: BlueprintSchemaDescriptor = {
      kind: 'object',
      fields: [field('entries', { kind: 'array', items: signalReference })],
    };
    const descriptor: BlueprintSchemaDescriptor = {
      kind: 'object',
      fields: [
        field('array', { kind: 'array', items: signalReference }),
        field('tuple', { kind: 'tuple', items: [signalReference, signalReference] }),
        field('dictionary', {
          kind: 'dictionary',
          keys: { kind: 'scalar', name: 'string' },
          values: signalReference,
        }),
        field('nested', { kind: 'reference', name: 'Node' }),
        field('union', {
          kind: 'union',
          options: [
            { kind: 'object', fields: [field('first', signalReference)] },
            { kind: 'object', fields: [field('second', signalReference)] },
          ],
        }),
      ],
    };
    const resolved = {
      ...schema,
      references: [...schema.references, { name: 'Node', type: node }],
    };

    const detached = detachBlueprintEntitySignalHandles(value, descriptor, resolved, isSignal) as {
      array: readonly unknown[];
      tuple: readonly unknown[];
      dictionary: Record<string, unknown>;
      nested: { entries: readonly unknown[] };
      union: Record<string, unknown>;
    };

    const candidates = [
      detached.array[0],
      detached.tuple[0],
      detached.tuple[1],
      detached.dictionary.first,
      detached.nested.entries[0],
      detached.union.first,
      detached.union.second,
    ];
    expect(candidates.map((candidate) => candidate === sourceSignal)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    for (const candidate of candidates) {
      expect(candidate).toEqual({ type: 'virtual', name: 'signal-A' });
    }
    expect(detached.array).not.toBe(value.array);
    expect(detached.tuple).not.toBe(value.tuple);
    expect(detached.dictionary).not.toBe(value.dictionary);
    expect(detached.nested).not.toBe(value.nested);
    expect(detached.union).not.toBe(value.union);
  });

  test('keeps structural SignalID data for the schema validator', () => {
    const plain = { name: 'signal-A' };
    const detached = detachBlueprintEntitySignalHandles(
      { icon: plain },
      { kind: 'object', fields: [field('icon', signalReference)] },
      schema,
      () => false,
    ) as { icon: unknown };

    expect(detached.icon).toBe(plain);
  });

  test('rejects a foreign nominal Signal handle without invoking its coercion hook', () => {
    let invoked = false;
    const foreign = Object.freeze(
      Object.create(Object.prototype, {
        type: { configurable: false, enumerable: true, value: 'virtual', writable: false },
        name: { configurable: false, enumerable: true, value: 'signal-A', writable: false },
        [Symbol.toPrimitive]: {
          configurable: false,
          enumerable: false,
          value: () => {
            invoked = true;
            return 'signal:v1/virtual/signal-A/';
          },
          writable: false,
        },
      }),
    );

    expect(() =>
      detachBlueprintEntitySignalHandles(
        { icon: foreign },
        { kind: 'object', fields: [field('icon', signalReference)] },
        schema,
        () => false,
      ),
    ).toThrowError(BlueprintEntitySignalConversionError);
    expect(invoked).toBe(false);
  });
});
