import { describe, expect, test } from 'vitest';

import {
  BlueprintDocumentError,
  LosslessJsonArray,
  LosslessJsonNumber,
  LosslessJsonObject,
  classifyBlueprintDocument,
  decodeBlueprintExchange,
  encodeBlueprintExchange,
  stringifyLosslessJson,
  type BlueprintDocumentClassification,
} from './index.js';

function wrapped(root: string, value: LosslessJsonObject): LosslessJsonObject {
  return new LosslessJsonObject([[root, value]]);
}

function expectClassificationError(
  document: Parameters<typeof classifyBlueprintDocument>[0],
  code: string,
  path: string,
): void {
  try {
    classifyBlueprintDocument(document);
  } catch (error) {
    expect(error).toBeInstanceOf(BlueprintDocumentError);
    expect(error).toMatchObject({ code, path });
    return;
  }
  throw new Error('Expected native document classification to fail.');
}

describe('native blueprint root classification', () => {
  test('projects a bounded blueprint header while retaining the complete lossless tree', () => {
    const document = wrapped(
      'blueprint',
      new LosslessJsonObject([
        ['item', 'blueprint'],
        ['label', 'main bus'],
        ['version', new LosslessJsonNumber('562949953421312')],
        ['entities', new LosslessJsonArray(['not inspected'])],
        ['wires', null],
        ['future_extension', new LosslessJsonNumber('9007199254740993')],
      ]),
    );

    const result = classifyBlueprintDocument(document);
    expect(result.kind).toBe('blueprint');
    if (result.kind !== 'blueprint') throw new Error('Expected a semantic blueprint projection.');
    expect(result.semantic).toEqual({
      item: 'blueprint',
      label: 'main bus',
      version: 562949953421312,
      hasEntities: true,
      hasWires: true,
    });
    expect(result.document).toBe(document);
    expect(stringifyLosslessJson(result.document)).toContain('"future_extension":9007199254740993');
  });

  test('leaves supported non-blueprint roots opaque and codec-round-trippable', async () => {
    const roots = ['blueprint_book', 'upgrade_planner', 'deconstruction_planner'] as const;
    const classifications: BlueprintDocumentClassification[] = roots.map((root) =>
      classifyBlueprintDocument(
        wrapped(
          root,
          new LosslessJsonObject([
            ['item', 'blueprint'],
            ['version', new LosslessJsonNumber('9007199254740993')],
            ['entities', new LosslessJsonArray([])],
          ]),
        ),
      ),
    );

    expect(classifications.map((result) => result.kind)).toEqual(['opaque', 'opaque', 'opaque']);
    for (const result of classifications) {
      expect(result).toMatchObject({ semanticProjectionAvailable: false });
      expect(result.document).toBeInstanceOf(LosslessJsonObject);
      const encoded = await encodeBlueprintExchange(result.document);
      const decoded = await decodeBlueprintExchange(encoded);
      expect(stringifyLosslessJson(decoded)).toBe(stringifyLosslessJson(result.document));
      expect(classifyBlueprintDocument(decoded)).toMatchObject({
        kind: 'opaque',
        root: result.root,
        semanticProjectionAvailable: false,
      });
    }
  });

  test('rejects non-object, empty, multiple and unknown top-level roots with paths', () => {
    expectClassificationError(null, 'BPD1007', '$');
    expectClassificationError(new LosslessJsonArray([]), 'BPD1007', '$');
    expectClassificationError(new LosslessJsonObject([]), 'BPD1007', '$');
    expectClassificationError(
      new LosslessJsonObject([
        ['blueprint', new LosslessJsonObject([])],
        ['blueprint_book', new LosslessJsonObject([])],
      ]),
      'BPD1007',
      '$',
    );
    expectClassificationError(
      new LosslessJsonObject([['future_root', new LosslessJsonObject([])]]),
      'BPD1007',
      '$.future_root',
    );
  });

  test('rejects wrong root and projected header field shapes at their paths', () => {
    for (const root of [
      'blueprint',
      'blueprint_book',
      'upgrade_planner',
      'deconstruction_planner',
    ]) {
      expectClassificationError(new LosslessJsonObject([[root, null]]), 'BPD1007', `$.${root}`);
    }
    expectClassificationError(
      wrapped('blueprint', new LosslessJsonObject([['item', new LosslessJsonNumber('1')]])),
      'BPD1008',
      '$.blueprint.item',
    );
    expectClassificationError(
      wrapped('blueprint', new LosslessJsonObject([['label', false]])),
      'BPD1008',
      '$.blueprint.label',
    );
  });

  test.each([
    ['"562949953421312"', 'wrong JSON type'],
    ['9007199254740993', 'rounded integer'],
    ['9007199254740992', 'exact but unsafe integer'],
    ['1.5', 'fractional version'],
  ])('rejects unsafe version access (%s: %s)', (lexeme) => {
    const document = wrapped(
      'blueprint',
      new LosslessJsonObject([
        ['version', lexeme.startsWith('"') ? lexeme.slice(1, -1) : new LosslessJsonNumber(lexeme)],
      ]),
    );
    expectClassificationError(document, 'BPD1008', '$.blueprint.version');
  });

  test('allows absent projected fields and records entity/wire presence without validating them', () => {
    const withoutFields = classifyBlueprintDocument(
      wrapped('blueprint', new LosslessJsonObject([])),
    );
    expect(withoutFields.kind === 'blueprint' && withoutFields.semantic).toEqual({
      item: undefined,
      label: undefined,
      version: undefined,
      hasEntities: false,
      hasWires: false,
    });

    const withUnvalidatedPresence = classifyBlueprintDocument(
      wrapped(
        'blueprint',
        new LosslessJsonObject([
          ['entities', 'not an entities array'],
          ['wires', new LosslessJsonObject([])],
        ]),
      ),
    );
    expect(
      withUnvalidatedPresence.kind === 'blueprint' && withUnvalidatedPresence.semantic,
    ).toMatchObject({
      hasEntities: true,
      hasWires: true,
    });
  });

  test('semantic metadata survives browser-standard structured cloning as detached data', async () => {
    const document = wrapped(
      'blueprint',
      new LosslessJsonObject([
        ['item', 'blueprint'],
        ['label', 'clone-safe'],
        ['version', new LosslessJsonNumber('7')],
        ['entities', new LosslessJsonArray([])],
      ]),
    );
    const exchange = await encodeBlueprintExchange(document);
    const decoded = await decodeBlueprintExchange(exchange);
    const classified = classifyBlueprintDocument(decoded);
    if (classified.kind !== 'blueprint') throw new Error('Expected a blueprint projection.');

    const detached = structuredClone(classified.semantic);
    expect(detached).toEqual(classified.semantic);
    expect(detached).not.toBe(classified.semantic);
    expect(Object.getPrototypeOf(detached)).toBe(Object.prototype);
    expect(Object.isFrozen(detached)).toBe(false);

    const delivered = await new Promise<unknown>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        channel.port1.close();
        channel.port2.close();
        resolve(event.data);
      };
      channel.port2.postMessage(classified.semantic);
    });
    expect(delivered).toEqual(classified.semantic);
    expect(delivered).not.toBe(classified.semantic);
    expect(Object.getPrototypeOf(delivered)).toBe(Object.prototype);
  });
});
