import { describe, expect, test } from 'vitest';

import {
  BlueprintDocumentError,
  BlueprintExchangeError,
  LosslessJsonNumber,
  LosslessJsonObject,
  createWebBlueprintCompressionAdapter,
  decodeBlueprintExchange,
  encodeBlueprintExchange,
  type BlueprintCompressionAdapter,
} from './index.js';

function passthroughAdapter(): BlueprintCompressionAdapter {
  return {
    capabilities: { deflate: true },
    async *compress(chunks) {
      yield* chunks;
    },
    async *decompress(chunks) {
      yield* chunks;
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function compressDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const writing = (async () => {
    await writer.write(new Uint8Array(bytes));
    await writer.close();
  })();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    parts.push(result.value);
    total += result.value.byteLength;
  }
  await writing;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

describe('bounded blueprint exchange codec', () => {
  test('round-trips lossless documents through standard Web zlib/deflate streams', async () => {
    // Generated locally for codec behavior only; this is not Factorio-export evidence.
    const document = new LosslessJsonObject([
      [
        'blueprint',
        new LosslessJsonObject([
          ['item', 'blueprint'],
          ['label', 'π circuit'],
          ['entities', new LosslessJsonObject([['1', new LosslessJsonNumber('9007199254740993')]])],
        ]),
      ],
    ]);
    const first = await encodeBlueprintExchange(document);
    const second = await encodeBlueprintExchange(document);
    const decoded = await decodeBlueprintExchange(first);

    expect(first[0]).toBe('0');
    expect(first).toBe(second);
    expect(decoded).toBeInstanceOf(LosslessJsonObject);
    expect(decoded && (await encodeBlueprintExchange(decoded))).toBe(first);
  });

  test('validates marker, encoded budget and strict canonical Base64 before adapter use', async () => {
    let called = false;
    const adapter: BlueprintCompressionAdapter = {
      capabilities: { deflate: true },
      async *compress(chunks) {
        yield* chunks;
      },
      async *decompress(chunks) {
        called = true;
        yield* chunks;
      },
    };
    for (const [input, code] of [
      ['xAAAA', 'BEX1001'],
      ['0A===', 'BEX1002'],
      ['0AB=', 'BEX1002'],
      ['0AA=A', 'BEX1002'],
      ['0AAé', 'BEX1002'],
    ] as const) {
      await expect(decodeBlueprintExchange(input, { compression: adapter })).rejects.toMatchObject({
        code,
      });
    }
    await expect(
      decodeBlueprintExchange('0AAAA', {
        compression: adapter,
        limits: { maxEncodedCharacters: 4 },
      }),
    ).rejects.toMatchObject({ code: 'BEX1003' });
    await expect(
      decodeBlueprintExchange('0AAAA', {
        compression: adapter,
        limits: { maxCompressedBytes: 2 },
      }),
    ).rejects.toMatchObject({ code: 'BEX1003' });
    expect(called).toBe(false);
  });

  test('bounds decompressed chunks and maps invalid UTF-8 separately from invalid JSON', async () => {
    let cancelledForLimit = false;
    const oversized: BlueprintCompressionAdapter = {
      capabilities: { deflate: true },
      async *compress(chunks) {
        yield* chunks;
      },
      async *decompress() {
        try {
          yield new Uint8Array([49, 50, 51]);
        } finally {
          cancelledForLimit = true;
        }
      },
    };
    await expect(
      decodeBlueprintExchange('0MTIz', {
        compression: oversized,
        limits: { maxDecompressedBytes: 2 },
      }),
    ).rejects.toMatchObject({ code: 'BEX1003', path: '$' });
    expect(cancelledForLimit).toBe(true);

    const identity = passthroughAdapter();
    await expect(decodeBlueprintExchange('0/w==', { compression: identity })).rejects.toMatchObject(
      {
        code: 'BEX1006',
      },
    );
    await expect(
      decodeBlueprintExchange('0eA==', { compression: identity }),
    ).rejects.toBeInstanceOf(BlueprintDocumentError);
    await expect(
      decodeBlueprintExchange('077u/', { compression: identity }),
    ).rejects.toBeInstanceOf(BlueprintDocumentError);
  });

  test('joins bounded output chunks before strict UTF-8 decoding', async () => {
    const split: BlueprintCompressionAdapter = {
      capabilities: { deflate: true },
      async *compress(chunks) {
        yield* chunks;
      },
      async *decompress() {
        yield new Uint8Array([0x22, 0xe2]);
        yield new Uint8Array([0x82]);
        yield new Uint8Array([0xac, 0x22]);
      },
    };
    await expect(decodeBlueprintExchange('0AAAA', { compression: split })).resolves.toBe('€');
  });

  test('rejects unsupported adapters and propagates caller cancellation', async () => {
    const unavailable: BlueprintCompressionAdapter = {
      capabilities: { deflate: false },
      async *compress() {},
      async *decompress() {},
    };
    await expect(encodeBlueprintExchange(null, { compression: unavailable })).rejects.toMatchObject(
      {
        code: 'BEX1004',
      },
    );

    const controller = new AbortController();
    controller.abort(new Error('test cancel'));
    await expect(
      decodeBlueprintExchange('0AAAA', {
        compression: passthroughAdapter(),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(BlueprintExchangeError);
    await expect(
      decodeBlueprintExchange('0AAAA', {
        compression: passthroughAdapter(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'BEX1007' });
  });

  test('applies compressed and encoded output bounds before final string creation', async () => {
    const oversized: BlueprintCompressionAdapter = {
      capabilities: { deflate: true },
      async *compress() {
        yield new Uint8Array([1, 2, 3]);
      },
      async *decompress(chunks) {
        yield* chunks;
      },
    };
    await expect(
      encodeBlueprintExchange(null, {
        compression: oversized,
        limits: { maxCompressedBytes: 2 },
      }),
    ).rejects.toMatchObject({ code: 'BEX1003' });

    const oneByte: BlueprintCompressionAdapter = {
      ...passthroughAdapter(),
      async *compress() {
        yield new Uint8Array([0]);
      },
    };
    await expect(
      encodeBlueprintExchange(null, {
        compression: oneByte,
        limits: { maxEncodedCharacters: 4 },
      }),
    ).rejects.toMatchObject({ code: 'BEX1003' });
  });

  test('standard deflate rejects trailing bytes after the zlib stream', async () => {
    const compressed = await compressDeflate(new TextEncoder().encode('{"x":1}'));
    const tailed = new Uint8Array(compressed.length + 1);
    tailed.set(compressed);
    tailed[tailed.length - 1] = 0;
    const exchange = `0${bytesToBase64(tailed)}`;
    await expect(decodeBlueprintExchange(exchange)).rejects.toMatchObject({ code: 'BEX1005' });
  });

  test('exposes Web compression support through a lazy capability adapter', () => {
    const adapter = createWebBlueprintCompressionAdapter();
    expect(adapter.capabilities.deflate).toBe(true);
  });

  test('cancels an active Web compression stream when its signal aborts', async () => {
    const adapter = createWebBlueprintCompressionAdapter();
    const controller = new AbortController();
    async function* endlessBytes(): AsyncGenerator<Uint8Array> {
      for (;;) yield new Uint8Array(1024);
    }
    const running = (async () => {
      for await (const _chunk of adapter.compress(endlessBytes(), { signal: controller.signal })) {
        // Drain output until the signal closes the stream.
      }
    })();
    controller.abort(new Error('stop test stream'));
    await expect(running).rejects.toBeDefined();
  });
});
