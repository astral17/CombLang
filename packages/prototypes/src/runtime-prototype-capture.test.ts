import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import snapshot from '../../../fixtures/runtime-prototypes/synthetic.json';
import {
  parseRuntimePrototypeCaptureJson,
  RuntimePrototypeCaptureError,
} from './runtime-prototype-capture.js';

function parse(overrides: Record<string, unknown> = {}) {
  return parseRuntimePrototypeCaptureJson(JSON.stringify({ ...snapshot, ...overrides }));
}

describe('runtime prototype capture', () => {
  test('preserves runtime roles, explicit false, absent, unknown and errors', () => {
    const result = parse();
    expect(result.environment.startupSettings[0]!.outcome).toEqual({
      status: 'value',
      value: false,
    });
    expect(result.environment.startupSettings[1]!.outcome.status).toBe('error');
    expect(result.collections.recipes[0]!.facts.products).toEqual({
      status: 'value',
      value: [],
    });
    expect(result.collections.entities[0]!.facts).toMatchObject({
      tileWidth: { status: 'value', value: 2 },
      tileHeight: { status: 'value', value: 3 },
      collisionBox: { status: 'error', message: 'unreadable' },
      fluidCapacity: {
        status: 'unknown',
        reason: 'not applicable to this prototype',
      },
    });
  });

  test('retains a runtime footprint independently of the selection box', () => {
    const facts = resultEntity().facts;
    expect(facts.tileWidth).toEqual({ status: 'value', value: 2 });
    expect(facts.tileHeight).toEqual({ status: 'value', value: 3 });
    expect(facts.selectionBox).toMatchObject({
      status: 'value',
      value: { leftTop: { x: -5 }, rightBottom: { x: 5 } },
    });
  });

  test('returns deeply immutable capture values', () => {
    const result = parse();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.collections.entities)).toBe(true);
    expect(Object.isFrozen(result.collections.entities[0]!.facts)).toBe(true);
    const selection = result.collections.entities[0]!.facts.selectionBox;
    if (selection?.status !== 'value') throw new Error('Expected selection box');
    expect(Object.isFrozen(selection.value)).toBe(true);
  });

  test('reads the checked-in synthetic exporter artifact', async () => {
    const source = await readFile(
      new URL('../../../fixtures/runtime-prototypes/synthetic.json', import.meta.url),
      'utf8',
    );
    expect(parseRuntimePrototypeCaptureJson(source)).toEqual(parse());
  });

  test.each([
    [{ schemaVersion: 2 }, '<capture>'],
    [{ collectorVersion: '' }, 'collectorVersion'],
    [
      {
        environment: {
          ...snapshot.environment,
          mods: [{ name: 'base', version: '2.1.17' }],
        },
      },
      'environment.mods',
    ],
    [
      {
        collections: {
          ...snapshot.collections,
          items: [{ ...snapshot.collections.items[0], key: 'item:copper-plate' }],
        },
      },
      'collections.items[0].key',
    ],
    [
      {
        limits: {
          broken: { status: 'value', value: undefined },
        },
      },
      'limits.broken.value',
    ],
    [
      {
        limits: {
          broken: { status: 'absent', value: false },
        },
      },
      'limits.broken.value',
    ],
  ])('rejects malformed capture at %s', (override, expectedPath) => {
    expect(() => parse(override)).toThrow(expectedPath);
  });

  test('uses a dedicated stable diagnostic code', () => {
    try {
      parseRuntimePrototypeCaptureJson('{');
      throw new Error('Expected parser failure');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimePrototypeCaptureError);
      expect((error as RuntimePrototypeCaptureError).code).toBe('PR1001');
      expect((error as RuntimePrototypeCaptureError).path).toBe('<json>');
    }
  });
});

function resultEntity() {
  return parse().collections.entities[0]!;
}
