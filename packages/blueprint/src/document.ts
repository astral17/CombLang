import { BlueprintDocumentError } from './errors.js';
import { resolveBlueprintCodecLimits, type BlueprintCodecLimitOverrides } from './limits.js';

export type LosslessJsonValue =
  null | boolean | string | LosslessJsonNumber | LosslessJsonArray | LosslessJsonObject;

export type LosslessJsonEntry = readonly [key: string, value: LosslessJsonValue];

const numberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\s\S])/;
const identifierKeyPattern = /^[A-Za-z_$][\w$]*(?![\s\S])/;
const maxExactNumberLexemeLength = 2048;

function documentError(
  code: 'BPD1001' | 'BPD1002' | 'BPD1003' | 'BPD1004' | 'BPD1005' | 'BPD1006',
  message: string,
  path: string,
): BlueprintDocumentError {
  return new BlueprintDocumentError(code, message, { path });
}

function isLosslessJsonValue(value: unknown): value is LosslessJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value !== 'object') return false;
  if (value instanceof LosslessJsonNumber) {
    return Object.getPrototypeOf(value) === LosslessJsonNumber.prototype;
  }
  if (value instanceof LosslessJsonArray) {
    return Object.getPrototypeOf(value) === LosslessJsonArray.prototype;
  }
  return (
    value instanceof LosslessJsonObject &&
    Object.getPrototypeOf(value) === LosslessJsonObject.prototype
  );
}

function assertScalarString(value: string, path: string): number {
  let byteLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw documentError('BPD1003', 'Unpaired high surrogate is not valid Unicode.', path);
      }
      index += 1;
      byteLength += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw documentError('BPD1003', 'Unpaired low surrogate is not valid Unicode.', path);
    } else if (code <= 0x7f) {
      byteLength += 1;
    } else if (code <= 0x7ff) {
      byteLength += 2;
    } else {
      byteLength += 3;
    }
  }
  return byteLength;
}

function assertEntryArray(entries: readonly unknown[], path: string): void {
  if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype) {
    throw documentError('BPD1005', 'JSON container input must be a plain array.', path);
  }
  const keys = Reflect.ownKeys(entries);
  if (keys.length !== entries.length + 1 || !keys.includes('length')) {
    throw documentError('BPD1005', 'JSON container arrays must not have extra properties.', path);
  }
  for (let index = 0; index < entries.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(entries, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw documentError(
        'BPD1005',
        'JSON container arrays must be dense data arrays.',
        `${path}[${index}]`,
      );
    }
  }
}

/** A JSON number whose original valid JSON spelling remains authoritative. */
export class LosslessJsonNumber {
  readonly kind = 'number';
  readonly lexeme: string;

  constructor(lexeme: string) {
    if (typeof lexeme !== 'string' || !numberPattern.test(lexeme)) {
      throw documentError('BPD1006', 'Invalid JSON number lexeme.', '$');
    }
    assertScalarString(lexeme, '$');
    this.lexeme = lexeme;
    Object.freeze(this);
  }

  /** Returns a Number only when its IEEE-754 value exactly equals this decimal.
   * Returns undefined when exactness cannot be established within a bounded check.
   */
  toNumberIfExact(): number | undefined {
    if (this.lexeme.length > maxExactNumberLexemeLength) return undefined;
    const value = Number(this.lexeme);
    if (!Number.isFinite(value)) return undefined;

    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(this.lexeme);
    if (match === null) return undefined;
    const negative = match[1] === '-';
    const integerDigits = match[2] ?? '';
    const fractionDigits = match[3] ?? '';
    const significantDigits = `${integerDigits}${fractionDigits}`.replace(/^0+/, '');
    if (significantDigits.length === 0) return value;

    const exponentText = match[4] ?? '0';
    const exponent = Number(exponentText);
    if (!Number.isSafeInteger(exponent)) return undefined;
    const scale = exponent - fractionDigits.length;
    const decimalMagnitude = significantDigits.length + scale - 1;
    if (decimalMagnitude > 308 || decimalMagnitude < -324) return undefined;

    let coefficient = BigInt(`${negative ? '-' : ''}${significantDigits}`);
    let decimalDenominator = 1n;
    if (scale >= 0) coefficient *= 10n ** BigInt(scale);
    else decimalDenominator = 10n ** BigInt(-scale);

    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    const bits = (BigInt(view.getUint32(0)) << 32n) | BigInt(view.getUint32(4));
    const negativeFloat = bits >> 63n !== 0n;
    const exponentBits = Number((bits >> 52n) & 0x7ffn);
    const fractionBits = bits & ((1n << 52n) - 1n);
    const mantissa = exponentBits === 0 ? fractionBits : (1n << 52n) | fractionBits;
    const binaryExponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
    let binaryNumerator = negativeFloat ? -mantissa : mantissa;
    let binaryDenominator = 1n;
    if (binaryExponent >= 0) binaryNumerator <<= BigInt(binaryExponent);
    else binaryDenominator <<= BigInt(-binaryExponent);

    return coefficient * binaryDenominator === binaryNumerator * decimalDenominator
      ? value
      : undefined;
  }
}

/** Immutable JSON array node; values are copied and validated at construction. */
export class LosslessJsonArray {
  readonly kind = 'array';
  readonly items: readonly LosslessJsonValue[];

  constructor(items: readonly LosslessJsonValue[]) {
    assertEntryArray(items, '$');
    const copy: LosslessJsonValue[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(items, String(index));
      const value: unknown = descriptor?.value;
      if (!isLosslessJsonValue(value)) {
        throw documentError(
          'BPD1005',
          'Array contains a non-JSON or mutable value.',
          `$[${index}]`,
        );
      }
      if (typeof value === 'string') assertScalarString(value, `$[${index}]`);
      copy.push(value);
    }
    this.items = Object.freeze(copy);
    Object.freeze(this);
  }
}

/** Immutable ordered JSON object node; members are represented as pairs, never properties. */
export class LosslessJsonObject {
  readonly kind = 'object';
  readonly entries: readonly LosslessJsonEntry[];

  constructor(entries: readonly LosslessJsonEntry[]) {
    assertEntryArray(entries, '$');
    const seen = new Set<string>();
    const copy: LosslessJsonEntry[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const tupleDescriptor = Object.getOwnPropertyDescriptor(entries, String(index));
      const tuple: unknown = tupleDescriptor?.value;
      if (!Array.isArray(tuple) || Object.getPrototypeOf(tuple) !== Array.prototype) {
        throw documentError(
          'BPD1005',
          'Object entries must be plain key/value pairs.',
          `$[${index}]`,
        );
      }
      assertEntryArray(tuple, `$[${index}]`);
      if (tuple.length !== 2) {
        throw documentError(
          'BPD1005',
          'Object entries must contain exactly a key and value.',
          `$[${index}]`,
        );
      }
      const keyDescriptor = Object.getOwnPropertyDescriptor(tuple, '0');
      const valueDescriptor = Object.getOwnPropertyDescriptor(tuple, '1');
      const key: unknown = keyDescriptor?.value;
      const value: unknown = valueDescriptor?.value;
      if (typeof key !== 'string' || !isLosslessJsonValue(value)) {
        throw documentError('BPD1005', 'Object entry is not a JSON key/value pair.', `$[${index}]`);
      }
      assertScalarString(key, '$');
      if (typeof value === 'string') assertScalarString(value, pathForKey('$', key));
      if (seen.has(key)) {
        throw documentError('BPD1002', 'Duplicate object member name.', '$');
      }
      seen.add(key);
      copy.push(Object.freeze([key, value] as const));
    }
    this.entries = Object.freeze(copy);
    Object.freeze(this);
  }

  get(key: string): LosslessJsonValue | undefined {
    return this.entries.find(([entryKey]) => entryKey === key)?.[1];
  }
}

export interface LosslessJsonOptions {
  /** Parser input uses maxDecompressedBytes; writer output uses maxEmittedBytes. */
  readonly limits?: BlueprintCodecLimitOverrides;
}

function pathForKey(path: string, key: string): string {
  return identifierKeyPattern.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function inputByteLength(input: string): number {
  let bytes = 0;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      input.charCodeAt(index + 1) >= 0xdc00 &&
      input.charCodeAt(index + 1) <= 0xdfff
    ) {
      index += 1;
      bytes += 4;
    } else if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

interface ParseFrame {
  readonly kind: 'array' | 'object';
  readonly path: string;
  readonly items: LosslessJsonValue[];
  readonly entries: LosslessJsonEntry[];
  readonly keys: Set<string>;
  state: 'first' | 'value' | 'key' | 'colon' | 'commaOrEnd';
  key: string | undefined;
}

/** Parses JSON into immutable data-only nodes without delegating number storage to JSON.parse. */
export function parseLosslessJson(
  input: string,
  options: LosslessJsonOptions = {},
): LosslessJsonValue {
  const limits = resolveBlueprintCodecLimits(options.limits);
  if (typeof input !== 'string') {
    throw documentError('BPD1001', 'JSON input must be a string.', '$');
  }
  if (inputByteLength(input) > limits.maxDecompressedBytes) {
    throw documentError('BPD1004', 'JSON input byte limit exceeded.', '$');
  }

  let cursor = 0;
  let nodes = 0;
  let stringBytes = 0;
  let root: LosslessJsonValue | undefined;
  const frames: ParseFrame[] = [];

  const syntax = (message: string, path: string): never => {
    throw documentError('BPD1001', message, path);
  };
  const skipWhitespace = (): void => {
    while (cursor < input.length) {
      const code = input.charCodeAt(cursor);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) cursor += 1;
      else break;
    }
  };
  const readString = (path: string): string => {
    if (input[cursor] !== '"') syntax('Expected a JSON string.', path);
    cursor += 1;
    let localBytes = 0;
    let chunkLength = 0;
    const chunks: string[] = [];
    const pending: string[] = [];
    const append = (part: string): void => {
      if (part.length === 0) return;
      pending.push(part);
      chunkLength += part.length;
      if (chunkLength >= 4096) {
        chunks.push(pending.join(''));
        pending.length = 0;
        chunkLength = 0;
      }
    };
    const charge = (bytes: number): void => {
      localBytes += bytes;
      if (localBytes > limits.maxStringBytes || stringBytes + localBytes > limits.maxStringBytes) {
        throw documentError('BPD1004', 'JSON string byte limit exceeded.', path);
      }
    };
    let rawStart = cursor;
    while (cursor < input.length) {
      const code = input.charCodeAt(cursor);
      if (code === 0x22) {
        append(input.slice(rawStart, cursor));
        cursor += 1;
        stringBytes += localBytes;
        chunks.push(pending.join(''));
        return chunks.join('');
      }
      if (code < 0x20) syntax('Unescaped control character in JSON string.', path);
      if (code === 0x5c) {
        append(input.slice(rawStart, cursor));
        cursor += 1;
        const escape = input[cursor];
        cursor += 1;
        switch (escape) {
          case '"':
            append('"');
            charge(1);
            break;
          case '\\':
            append('\\');
            charge(1);
            break;
          case '/':
            append('/');
            charge(1);
            break;
          case 'b':
            append('\b');
            charge(1);
            break;
          case 'f':
            append('\f');
            charge(1);
            break;
          case 'n':
            append('\n');
            charge(1);
            break;
          case 'r':
            append('\r');
            charge(1);
            break;
          case 't':
            append('\t');
            charge(1);
            break;
          case 'u': {
            const hex = input.slice(cursor, cursor + 4);
            if (!/^[\da-fA-F]{4}(?![\s\S])/.test(hex))
              syntax('Invalid Unicode escape in JSON string.', path);
            cursor += 4;
            const first = Number.parseInt(hex, 16);
            if (first >= 0xd800 && first <= 0xdbff) {
              if (input.slice(cursor, cursor + 2) !== '\\u') {
                throw documentError('BPD1003', 'Unpaired high surrogate escape.', path);
              }
              const lowHex = input.slice(cursor + 2, cursor + 6);
              if (!/^[\da-fA-F]{4}(?![\s\S])/.test(lowHex))
                syntax('Invalid Unicode escape in JSON string.', path);
              const second = Number.parseInt(lowHex, 16);
              if (second < 0xdc00 || second > 0xdfff) {
                throw documentError(
                  'BPD1003',
                  'High surrogate is not followed by a low surrogate.',
                  path,
                );
              }
              cursor += 6;
              append(String.fromCharCode(first, second));
              charge(4);
            } else if (first >= 0xdc00 && first <= 0xdfff) {
              throw documentError('BPD1003', 'Unpaired low surrogate escape.', path);
            } else {
              append(String.fromCharCode(first));
              charge(first <= 0x7f ? 1 : first <= 0x7ff ? 2 : 3);
            }
            break;
          }
          default:
            syntax('Invalid escape in JSON string.', path);
        }
        rawStart = cursor;
        continue;
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = input.charCodeAt(cursor + 1);
        if (next < 0xdc00 || next > 0xdfff) {
          throw documentError('BPD1003', 'Unpaired high surrogate in JSON string.', path);
        }
        charge(4);
        cursor += 2;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        throw documentError('BPD1003', 'Unpaired low surrogate in JSON string.', path);
      }
      charge(code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3);
      cursor += 1;
    }
    return syntax('Unterminated JSON string.', path);
  };

  const attach = (value: LosslessJsonValue): void => {
    const parent = frames.at(-1);
    if (parent === undefined) {
      root = value;
      return;
    }
    if (parent.kind === 'array') parent.items.push(value);
    else {
      const key = parent.key;
      if (key === undefined) return syntax('Object value has no member name.', parent.path);
      parent.entries.push([key, value]);
      parent.key = undefined;
    }
  };

  const readValue = (path: string): void => {
    skipWhitespace();
    nodes += 1;
    if (nodes > limits.maxJsonNodes) {
      throw documentError('BPD1004', 'JSON node limit exceeded.', path);
    }
    const character = input[cursor];
    if (character === '"') {
      attach(readString(path));
      return;
    }
    if (character === '{' || character === '[') {
      const depth = frames.length + 1;
      if (depth > limits.maxJsonDepth) {
        throw documentError('BPD1004', 'JSON depth limit exceeded.', path);
      }
      cursor += 1;
      frames.push({
        kind: character === '{' ? 'object' : 'array',
        path,
        items: [],
        entries: [],
        keys: new Set(),
        state: 'first',
        key: undefined,
      });
      return;
    }
    if (character === 't' && input.slice(cursor, cursor + 4) === 'true') {
      cursor += 4;
      attach(true);
      return;
    }
    if (character === 'f' && input.slice(cursor, cursor + 5) === 'false') {
      cursor += 5;
      attach(false);
      return;
    }
    if (character === 'n' && input.slice(cursor, cursor + 4) === 'null') {
      cursor += 4;
      attach(null);
      return;
    }
    const numberStart = cursor;
    if (character === '-') cursor += 1;
    if (input[cursor] === '0') cursor += 1;
    else if (
      input[cursor] !== undefined &&
      input.charCodeAt(cursor) >= 0x31 &&
      input.charCodeAt(cursor) <= 0x39
    ) {
      while (
        input[cursor] !== undefined &&
        input.charCodeAt(cursor) >= 0x30 &&
        input.charCodeAt(cursor) <= 0x39
      )
        cursor += 1;
    } else syntax('Expected a JSON value.', path);
    if (input[cursor] === '.') {
      cursor += 1;
      const fractionStart = cursor;
      while (
        input[cursor] !== undefined &&
        input.charCodeAt(cursor) >= 0x30 &&
        input.charCodeAt(cursor) <= 0x39
      )
        cursor += 1;
      if (cursor === fractionStart) syntax('JSON fraction requires at least one digit.', path);
    }
    if (input[cursor] === 'e' || input[cursor] === 'E') {
      cursor += 1;
      if (input[cursor] === '+' || input[cursor] === '-') cursor += 1;
      const exponentStart = cursor;
      while (
        input[cursor] !== undefined &&
        input.charCodeAt(cursor) >= 0x30 &&
        input.charCodeAt(cursor) <= 0x39
      )
        cursor += 1;
      if (cursor === exponentStart) syntax('JSON exponent requires at least one digit.', path);
    }
    const lexeme = input.slice(numberStart, cursor);
    if (!numberPattern.test(lexeme)) syntax('Invalid JSON number.', path);
    attach(new LosslessJsonNumber(lexeme));
  };

  while (root === undefined || frames.length > 0) {
    const frame = frames.at(-1);
    if (frame === undefined) {
      readValue('$');
      continue;
    }
    skipWhitespace();
    if (frame.kind === 'array') {
      if (frame.state === 'first' || frame.state === 'value') {
        if (frame.state === 'first' && input[cursor] === ']') {
          cursor += 1;
          frames.pop();
          attach(new LosslessJsonArray(frame.items));
          continue;
        }
        frame.state = 'commaOrEnd';
        readValue(`${frame.path}[${frame.items.length}]`);
        continue;
      }
      if (input[cursor] === ',') {
        cursor += 1;
        frame.state = 'value';
      } else if (input[cursor] === ']') {
        cursor += 1;
        frames.pop();
        attach(new LosslessJsonArray(frame.items));
      } else syntax('Expected a comma or closing bracket.', frame.path);
      continue;
    }

    if (frame.state === 'first' || frame.state === 'key') {
      if (frame.state === 'first' && input[cursor] === '}') {
        cursor += 1;
        frames.pop();
        attach(new LosslessJsonObject(frame.entries));
        continue;
      }
      if (input[cursor] !== '"') syntax('Expected an object member name.', frame.path);
      const key = readString(frame.path);
      const memberPath = pathForKey(frame.path, key);
      if (frame.keys.has(key)) {
        throw documentError('BPD1002', 'Duplicate object member name.', memberPath);
      }
      frame.keys.add(key);
      frame.key = key;
      frame.state = 'colon';
    } else if (frame.state === 'colon') {
      if (input[cursor] !== ':') syntax('Expected a colon after object member name.', frame.path);
      cursor += 1;
      frame.state = 'commaOrEnd';
      readValue(pathForKey(frame.path, frame.key ?? ''));
    } else if (input[cursor] === ',') {
      cursor += 1;
      frame.state = 'key';
    } else if (input[cursor] === '}') {
      cursor += 1;
      frames.pop();
      attach(new LosslessJsonObject(frame.entries));
    } else syntax('Expected a comma or closing brace.', frame.path);
  }
  skipWhitespace();
  if (cursor !== input.length) syntax('Unexpected content after the JSON value.', '$');
  return root;
}

/** Deterministically serializes a lossless JSON value within configured output budgets. */
export function stringifyLosslessJson(
  value: LosslessJsonValue,
  options: LosslessJsonOptions = {},
): string {
  const limits = resolveBlueprintCodecLimits(options.limits);
  if (!isLosslessJsonValue(value)) {
    throw documentError('BPD1005', 'Value is not a lossless JSON node.', '$');
  }

  const chunks: string[] = [];
  const pending: string[] = [];
  let pendingLength = 0;
  let emittedBytes = 0;
  let stringBytes = 0;
  let nodes = 0;
  const append = (part: string, path: string): void => {
    if (part.length === 0) return;
    if (emittedBytes + part.length > limits.maxEmittedBytes) {
      throw documentError('BPD1004', 'JSON emitted byte limit exceeded.', path);
    }
    const bytes = assertScalarString(part, path);
    if (emittedBytes + bytes > limits.maxEmittedBytes) {
      throw documentError('BPD1004', 'JSON emitted byte limit exceeded.', path);
    }
    emittedBytes += bytes;
    pending.push(part);
    pendingLength += part.length;
    if (pendingLength >= 8192) {
      chunks.push(pending.join(''));
      pending.length = 0;
      pendingLength = 0;
    }
  };
  const writeString = (text: string, path: string): void => {
    if (stringBytes + text.length > limits.maxStringBytes) {
      throw documentError('BPD1004', 'JSON string byte limit exceeded.', path);
    }
    if (emittedBytes + text.length + 2 > limits.maxEmittedBytes) {
      throw documentError('BPD1004', 'JSON emitted byte limit exceeded.', path);
    }
    const bytes = assertScalarString(text, path);
    stringBytes += bytes;
    if (stringBytes > limits.maxStringBytes) {
      throw documentError('BPD1004', 'JSON string byte limit exceeded.', path);
    }
    append('"', path);
    let segmentStart = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      let escaped: string | undefined;
      if (code === 0x22) escaped = '\\"';
      else if (code === 0x5c) escaped = '\\\\';
      else if (code === 0x08) escaped = '\\b';
      else if (code === 0x0c) escaped = '\\f';
      else if (code === 0x0a) escaped = '\\n';
      else if (code === 0x0d) escaped = '\\r';
      else if (code === 0x09) escaped = '\\t';
      else if (code < 0x20) escaped = `\\u00${code.toString(16).padStart(2, '0')}`;
      if (escaped !== undefined) {
        append(text.slice(segmentStart, index), path);
        append(escaped, path);
        segmentStart = index + 1;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        index += 1;
      }
    }
    append(text.slice(segmentStart), path);
    append('"', path);
  };

  type Task =
    | {
        readonly kind: 'value';
        readonly value: LosslessJsonValue;
        readonly path: string;
        readonly depth: number;
      }
    | { readonly kind: 'text'; readonly value: string; readonly path: string }
    | { readonly kind: 'string'; readonly value: string; readonly path: string }
    | {
        readonly kind: 'arrayItem';
        readonly array: LosslessJsonArray;
        readonly index: number;
        readonly path: string;
        readonly depth: number;
      }
    | {
        readonly kind: 'objectItem';
        readonly object: LosslessJsonObject;
        readonly index: number;
        readonly path: string;
        readonly depth: number;
      };
  const tasks: Task[] = [{ kind: 'value', value, path: '$', depth: 0 }];
  while (tasks.length > 0) {
    const task = tasks.pop();
    if (task === undefined) break;
    if (task.kind === 'text') {
      append(task.value, task.path);
      continue;
    }
    if (task.kind === 'string') {
      writeString(task.value, task.path);
      continue;
    }
    if (task.kind === 'arrayItem') {
      if (task.index > 0) append(',', task.path);
      const item = task.array.items[task.index];
      if (item === undefined) {
        throw documentError('BPD1005', 'Array node contains a missing item.', task.path);
      }
      if (task.index + 1 < task.array.items.length) {
        tasks.push({ ...task, index: task.index + 1 });
      }
      tasks.push({
        kind: 'value',
        value: item,
        path: `${task.path}[${task.index}]`,
        depth: task.depth,
      });
      continue;
    }
    if (task.kind === 'objectItem') {
      if (task.index > 0) append(',', task.path);
      const entry = task.object.entries[task.index];
      if (entry === undefined) {
        throw documentError('BPD1005', 'Object node contains a missing member.', task.path);
      }
      const memberPath = pathForKey(task.path, entry[0]);
      writeString(entry[0], memberPath);
      append(':', memberPath);
      if (task.index + 1 < task.object.entries.length) {
        tasks.push({ ...task, index: task.index + 1 });
      }
      tasks.push({ kind: 'value', value: entry[1], path: memberPath, depth: task.depth });
      continue;
    }
    nodes += 1;
    if (nodes > limits.maxJsonNodes) {
      throw documentError('BPD1004', 'JSON node limit exceeded.', task.path);
    }
    const current = task.value;
    if (current === null) append('null', task.path);
    else if (typeof current === 'boolean') append(current ? 'true' : 'false', task.path);
    else if (typeof current === 'string') writeString(current, task.path);
    else if (
      current instanceof LosslessJsonNumber &&
      Object.getPrototypeOf(current) === LosslessJsonNumber.prototype
    ) {
      append(current.lexeme, task.path);
    } else if (
      current instanceof LosslessJsonArray &&
      Object.getPrototypeOf(current) === LosslessJsonArray.prototype
    ) {
      const depth = task.depth + 1;
      if (depth > limits.maxJsonDepth) {
        throw documentError('BPD1004', 'JSON depth limit exceeded.', task.path);
      }
      append('[', task.path);
      tasks.push({ kind: 'text', value: ']', path: task.path });
      if (current.items.length > 0) {
        tasks.push({ kind: 'arrayItem', array: current, index: 0, path: task.path, depth });
      }
    } else if (
      current instanceof LosslessJsonObject &&
      Object.getPrototypeOf(current) === LosslessJsonObject.prototype
    ) {
      const depth = task.depth + 1;
      if (depth > limits.maxJsonDepth) {
        throw documentError('BPD1004', 'JSON depth limit exceeded.', task.path);
      }
      append('{', task.path);
      tasks.push({ kind: 'text', value: '}', path: task.path });
      if (current.entries.length > 0) {
        tasks.push({ kind: 'objectItem', object: current, index: 0, path: task.path, depth });
      }
    } else {
      throw documentError('BPD1005', 'Value is not a lossless JSON node.', task.path);
    }
  }
  chunks.push(pending.join(''));
  return chunks.join('');
}
