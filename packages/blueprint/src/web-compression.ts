import type { BlueprintCodecOperationOptions, BlueprintCompressionAdapter } from './compression.js';

interface ByteTransformStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw (
      signal.reason ??
      Object.assign(new Error('Blueprint compression was aborted.'), { name: 'AbortError' })
    );
  }
}

async function* transformBytes(
  chunks: AsyncIterable<Uint8Array>,
  stream: ByteTransformStream,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  throwIfAborted(signal);
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  const pump = (async (): Promise<void> => {
    for await (const chunk of chunks) {
      throwIfAborted(signal);
      await writer.write(chunk);
    }
    throwIfAborted(signal);
    await writer.close();
  })();
  void pump.catch(() => undefined);

  let completed = false;
  const abortStream = (): void => {
    const reason = signal?.reason;
    void Promise.allSettled([writer.abort(reason), reader.cancel(reason)]);
  };
  signal?.addEventListener('abort', abortStream, { once: true });
  try {
    for (;;) {
      throwIfAborted(signal);
      const result = await reader.read();
      if (result.done) break;
      yield result.value;
    }
    await pump;
    completed = true;
  } catch (error) {
    await Promise.allSettled([writer.abort(error), reader.cancel(error), pump]);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortStream);
    if (!completed) {
      await Promise.allSettled([writer.abort(), reader.cancel(), pump]);
    }
    reader.releaseLock();
    writer.releaseLock();
  }
}

function constructTransform(compress: boolean): ByteTransformStream | undefined {
  if (compress) {
    if (typeof globalThis.CompressionStream !== 'function') return undefined;
    return new globalThis.CompressionStream('deflate') as unknown as ByteTransformStream;
  }
  if (typeof globalThis.DecompressionStream !== 'function') return undefined;
  return new globalThis.DecompressionStream('deflate') as unknown as ByteTransformStream;
}

/** Creates a lazy, browser-neutral adapter over the standard Web deflate streams. */
export function createWebBlueprintCompressionAdapter(): BlueprintCompressionAdapter {
  const capabilities = Object.freeze({
    deflate:
      typeof globalThis.CompressionStream === 'function' &&
      typeof globalThis.DecompressionStream === 'function',
  });
  return Object.freeze({
    capabilities,
    compress(
      chunks: AsyncIterable<Uint8Array>,
      options?: BlueprintCodecOperationOptions,
    ): AsyncIterable<Uint8Array> {
      const stream = constructTransform(true);
      if (stream === undefined) throw new Error('Web CompressionStream deflate is unavailable.');
      return transformBytes(chunks, stream, options?.signal);
    },
    decompress(
      chunks: AsyncIterable<Uint8Array>,
      options?: BlueprintCodecOperationOptions,
    ): AsyncIterable<Uint8Array> {
      const stream = constructTransform(false);
      if (stream === undefined) throw new Error('Web DecompressionStream deflate is unavailable.');
      return transformBytes(chunks, stream, options?.signal);
    },
  });
}
