import type { BlueprintCodecOptions } from './exchange.js';
import { BLUEPRINT_EXCHANGE_MARKER } from './exchange.js';
import { BlueprintDocumentError, BlueprintExchangeError } from './errors.js';
import { parseLosslessJson, stringifyLosslessJson, type LosslessJsonValue } from './document.js';
import { resolveBlueprintCodecLimits } from './limits.js';
import { createWebBlueprintCompressionAdapter } from './web-compression.js';

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function exchangeError(
  code: 'BEX1001' | 'BEX1002' | 'BEX1003' | 'BEX1004' | 'BEX1005' | 'BEX1006' | 'BEX1007',
  message: string,
  cause?: unknown,
): BlueprintExchangeError {
  return new BlueprintExchangeError(
    code,
    message,
    cause === undefined ? { path: '$' } : { cause, path: '$' },
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw exchangeError('BEX1007', 'Blueprint exchange operation was cancelled.', signal.reason);
  }
}

function getAdapter(options: BlueprintCodecOptions) {
  const adapter = options.compression ?? createWebBlueprintCompressionAdapter();
  if (!adapter.capabilities.deflate) {
    throw exchangeError('BEX1004', 'Deflate compression is unavailable in this environment.');
  }
  return adapter;
}

function operationOptions(signal: AbortSignal | undefined) {
  return signal === undefined ? undefined : { signal };
}

async function* oneChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

async function collectTransformedBytes(
  input: Uint8Array,
  mode: 'compress' | 'decompress',
  options: BlueprintCodecOptions,
  limit: number,
): Promise<Uint8Array> {
  const signal = options.signal;
  throwIfAborted(signal);
  const adapter = getAdapter(options);
  const operation = operationOptions(signal);
  let chunks: AsyncIterable<Uint8Array>;
  try {
    chunks =
      mode === 'compress'
        ? adapter.compress(oneChunk(input), operation)
        : adapter.decompress(oneChunk(input), operation);
    const ownedChunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of chunks) {
      throwIfAborted(signal);
      if (!(chunk instanceof Uint8Array)) {
        throw exchangeError('BEX1005', `Deflate ${mode} adapter yielded a non-byte chunk.`);
      }
      if (chunk.byteLength > limit - total) {
        throw exchangeError('BEX1003', `Blueprint ${mode} byte limit exceeded.`);
      }
      if (chunk.byteLength > 0) {
        ownedChunks.push(new Uint8Array(chunk));
        total += chunk.byteLength;
      }
    }
    throwIfAborted(signal);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of ownedChunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } catch (error) {
    if (error instanceof BlueprintExchangeError) throw error;
    if (signal?.aborted) throwIfAborted(signal);
    throw exchangeError('BEX1005', `Deflate ${mode} stream failed.`, error);
  }
}

function base64Value(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (code === 0x2b) return 62;
  if (code === 0x2f) return 63;
  return -1;
}

function decodeBase64(payload: string, maxBytes: number): Uint8Array {
  if (payload.length === 0 || payload.length % 4 !== 0) {
    throw exchangeError('BEX1002', 'Exchange payload is not valid padded Base64.');
  }
  let padding = 0;
  for (
    let index = payload.length - 1;
    index >= 0 && payload.charCodeAt(index) === 0x3d;
    index -= 1
  ) {
    padding += 1;
  }
  if (padding > 2) throw exchangeError('BEX1002', 'Exchange payload has invalid Base64 padding.');

  const dataLength = payload.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    if (base64Value(payload.charCodeAt(index)) < 0) {
      throw exchangeError('BEX1002', 'Exchange payload contains a non-Base64 character.');
    }
  }
  for (let index = dataLength; index < payload.length; index += 1) {
    if (payload.charCodeAt(index) !== 0x3d) {
      throw exchangeError('BEX1002', 'Exchange payload has invalid Base64 padding.');
    }
  }
  if (padding === 1 && (base64Value(payload.charCodeAt(payload.length - 2)) & 0x03) !== 0) {
    throw exchangeError('BEX1002', 'Exchange payload has non-canonical Base64 trailing bits.');
  }
  if (padding === 2 && (base64Value(payload.charCodeAt(payload.length - 3)) & 0x0f) !== 0) {
    throw exchangeError('BEX1002', 'Exchange payload has non-canonical Base64 trailing bits.');
  }

  const byteLength = (payload.length / 4) * 3 - padding;
  if (byteLength > maxBytes) {
    throw exchangeError('BEX1003', 'Compressed blueprint byte limit exceeded.');
  }
  const bytes = new Uint8Array(byteLength);
  let output = 0;
  for (let index = 0; index < payload.length; index += 4) {
    const first = base64Value(payload.charCodeAt(index));
    const second = base64Value(payload.charCodeAt(index + 1));
    const third =
      payload.charCodeAt(index + 2) === 0x3d ? 0 : base64Value(payload.charCodeAt(index + 2));
    const fourth =
      payload.charCodeAt(index + 3) === 0x3d ? 0 : base64Value(payload.charCodeAt(index + 3));
    bytes[output] = (first << 2) | (second >> 4);
    output += 1;
    if (output < byteLength) {
      bytes[output] = ((second & 0x0f) << 4) | (third >> 2);
      output += 1;
    }
    if (output < byteLength) {
      bytes[output] = ((third & 0x03) << 6) | fourth;
      output += 1;
    }
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  const pieces: string[] = [];
  let pending = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? (bytes[index + 1] ?? 0) : 0;
    const third = hasThird ? (bytes[index + 2] ?? 0) : 0;
    pending += base64Alphabet[first >> 2];
    pending += base64Alphabet[((first & 0x03) << 4) | (second >> 4)];
    pending += hasSecond ? base64Alphabet[((second & 0x0f) << 2) | (third >> 6)] : '=';
    pending += hasThird ? base64Alphabet[third & 0x3f] : '=';
    if (pending.length >= 8192) {
      pieces.push(pending);
      pending = '';
    }
  }
  if (pending.length > 0) pieces.push(pending);
  return pieces.join('');
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new BlueprintDocumentError('BPD1003', 'Unpaired high surrogate in JSON text.', {
          path: '$',
        });
      }
      index += 1;
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new BlueprintDocumentError('BPD1003', 'Unpaired low surrogate in JSON text.', {
        path: '$',
      });
    } else if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

/** Decodes marker + strict Base64 + zlib/deflate + UTF-8 into a lossless JSON tree. */
export async function decodeBlueprintExchange(
  exchange: string,
  options: BlueprintCodecOptions = {},
): Promise<LosslessJsonValue> {
  const limits = resolveBlueprintCodecLimits(options.limits);
  throwIfAborted(options.signal);
  if (typeof exchange !== 'string' || !exchange.startsWith(BLUEPRINT_EXCHANGE_MARKER)) {
    throw exchangeError('BEX1001', 'Blueprint exchange marker is missing or invalid.');
  }
  if (exchange.length > limits.maxEncodedCharacters) {
    throw exchangeError('BEX1003', 'Encoded blueprint character limit exceeded.');
  }
  const compressed = decodeBase64(
    exchange.slice(BLUEPRINT_EXCHANGE_MARKER.length),
    limits.maxCompressedBytes,
  );
  const decompressed = await collectTransformedBytes(
    compressed,
    'decompress',
    options,
    limits.maxDecompressedBytes,
  );

  let jsonText: string;
  try {
    jsonText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decompressed);
  } catch (error) {
    throw exchangeError('BEX1006', 'Decompressed blueprint is not valid UTF-8.', error);
  }
  return parseLosslessJson(jsonText, { limits });
}

/** Encodes a lossless JSON tree using marker + canonical Base64 + zlib/deflate. */
export async function encodeBlueprintExchange(
  document: LosslessJsonValue,
  options: BlueprintCodecOptions = {},
): Promise<string> {
  const limits = resolveBlueprintCodecLimits(options.limits);
  throwIfAborted(options.signal);
  const jsonText = stringifyLosslessJson(document, { limits });
  const jsonBytesLength = utf8ByteLength(jsonText);
  if (jsonBytesLength > limits.maxDecompressedBytes) {
    throw exchangeError('BEX1003', 'JSON input byte limit exceeded before compression.');
  }
  const jsonBytes = new TextEncoder().encode(jsonText);
  const compressed = await collectTransformedBytes(
    jsonBytes,
    'compress',
    options,
    limits.maxCompressedBytes,
  );
  if (compressed.byteLength === 0) {
    throw exchangeError('BEX1005', 'Deflate compressor produced an empty stream.');
  }
  const base64Length = Math.ceil(compressed.byteLength / 3) * 4;
  if (base64Length + BLUEPRINT_EXCHANGE_MARKER.length > limits.maxEncodedCharacters) {
    throw exchangeError('BEX1003', 'Encoded blueprint character limit exceeded.');
  }
  return BLUEPRINT_EXCHANGE_MARKER + encodeBase64(compressed);
}
