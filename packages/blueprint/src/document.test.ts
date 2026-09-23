import { describe, expect, test } from 'vitest';

import {
  BlueprintDocumentError,
  LosslessJsonArray,
  LosslessJsonNumber,
  LosslessJsonObject,
  parseLosslessJson,
  stringifyLosslessJson,
} from './index.js';

function parseError(
  input: string,
  limits?: NonNullable<Parameters<typeof parseLosslessJson>[1]>['limits'],
) {
  try {
    parseLosslessJson(input, limits === undefined ? undefined : { limits });
  } catch (error) {
    expect(error).toBeInstanceOf(BlueprintDocumentError);
    return error as BlueprintDocumentError;
  }
  throw new Error(`Expected parsing to fail: ${input}`);
}

describe('lossless JSON document', () => {
  test('preserves member order, escaped strings and every number lexeme', () => {
    const source =
      '{"later":9007199254740993,"__proto__":-0,"first":1.2300e+04,"nested":[true,null,"a\\n"]}';
    const document = parseLosslessJson(source);
    expect(document).toBeInstanceOf(LosslessJsonObject);
    if (!(document instanceof LosslessJsonObject)) throw new Error('Expected object document.');
    expect(document.entries.map(([key]) => key)).toEqual(['later', '__proto__', 'first', 'nested']);
    expect(stringifyLosslessJson(document)).toBe(source);
    expect((document.get('later') as LosslessJsonNumber).lexeme).toBe('9007199254740993');
    expect((document.get('first') as LosslessJsonNumber).lexeme).toBe('1.2300e+04');
  });

  test('only offers exact finite IEEE-754 number views', () => {
    expect(new LosslessJsonNumber('0.5').toNumberIfExact()).toBe(0.5);
    expect(new LosslessJsonNumber('9007199254740992').toNumberIfExact()).toBe(9007199254740992);
    expect(new LosslessJsonNumber('9007199254740993').toNumberIfExact()).toBeUndefined();
    expect(new LosslessJsonNumber('0.1').toNumberIfExact()).toBeUndefined();
    expect(new LosslessJsonNumber('1e9999').toNumberIfExact()).toBeUndefined();
    expect(Object.is(new LosslessJsonNumber('-0').toNumberIfExact(), -0)).toBe(true);
    expect(() => new LosslessJsonNumber('1\n')).toThrowError(BlueprintDocumentError);
  });

  test.each([
    '{"a":1,"a":2}',
    '{"a":01}',
    '[1,]',
    '"\\x"',
    '"\\u12x4"',
    '+1',
    '1.',
    '1e',
    'true false',
  ])('rejects malformed JSON %s with a stable code and path', (source) => {
    const error = parseError(source);
    expect(error.code).toMatch(/^BPD10(?:01|02)$/);
    expect(error.path).toBeDefined();
  });

  test('reports duplicate, Unicode, depth and node failures at useful paths', () => {
    expect(parseError('{"a":{"x":1,"x":2}}').path).toBe('$.a.x');
    expect(parseError('{"name":"\\uD800"}').code).toBe('BPD1003');
    expect(parseError('{"name":"\ud800"}').path).toBe('$.name');
    expect(parseError('{"a":[]}', { maxJsonDepth: 1 }).path).toBe('$.a');
    expect(parseError('[0,1]', { maxJsonNodes: 2 }).path).toBe('$[1]');
  });

  test('handles configured nesting iteratively without relying on the JS call stack', () => {
    const depth = 300;
    const source = `${'['.repeat(depth)}0${']'.repeat(depth)}`;
    const value = parseLosslessJson(source, { limits: { maxJsonDepth: depth } });
    expect(stringifyLosslessJson(value, { limits: { maxJsonDepth: depth } })).toBe(source);
  });

  test('enforces UTF-8 input and aggregate decoded string byte limits', () => {
    expect(parseError('"€"', { maxDecompressedBytes: 4 }).code).toBe('BPD1004');
    expect(parseError('["ab","cd"]', { maxStringBytes: 3 }).path).toBe('$[1]');
  });

  test('rejects invalid Unicode and unsafe container construction', () => {
    expect(() => parseLosslessJson('"\ud800"')).toThrowError(BlueprintDocumentError);
    const accessor = Object.defineProperty([], '0', { get: () => 'unsafe', enumerable: true });
    accessor.length = 1;
    expect(() => new LosslessJsonArray(accessor as unknown as string[])).toThrowError(
      BlueprintDocumentError,
    );
    expect(
      () =>
        new LosslessJsonObject([
          ['toString', new LosslessJsonNumber('1')],
          ['toString', null],
        ]),
    ).toThrowError(BlueprintDocumentError);
    expect(() => new LosslessJsonArray(['\ud800'])).toThrowError(BlueprintDocumentError);
    expect(() => stringifyLosslessJson({ polluted: true } as never)).toThrowError(
      BlueprintDocumentError,
    );
  });

  test('writer is deterministic and enforces output and string budgets', () => {
    const value = new LosslessJsonObject([
      ['z', new LosslessJsonNumber('2.00')],
      ['a', new LosslessJsonArray(['line\n', null])],
    ]);
    expect(stringifyLosslessJson(value)).toBe('{"z":2.00,"a":["line\\n",null]}');
    expect(() => stringifyLosslessJson(value, { limits: { maxEmittedBytes: 5 } })).toThrowError(
      /emitted byte limit/,
    );
    expect(() => stringifyLosslessJson(value, { limits: { maxStringBytes: 4 } })).toThrowError(
      /string byte limit/,
    );
  });

  test('writer checks depth and node limits without recursive traversal', () => {
    const deep = new LosslessJsonArray([new LosslessJsonArray([null])]);
    expect(() => stringifyLosslessJson(deep, { limits: { maxJsonDepth: 1 } })).toThrowError(
      /depth limit/,
    );
    expect(() => stringifyLosslessJson(deep, { limits: { maxJsonNodes: 2 } })).toThrowError(
      /node limit/,
    );
  });
});
