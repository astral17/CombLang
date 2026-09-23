export type BlueprintCompressionFormat = 'deflate';

export interface BlueprintCodecCancellation {
  readonly signal?: AbortSignal;
}

export interface BlueprintCodecOperationOptions extends BlueprintCodecCancellation {}

export interface BlueprintCompressionCapabilities {
  readonly deflate: boolean;
}

/** Streaming boundary implemented by the host's Web CompressionStream adapter. */
export interface BlueprintCompressionAdapter {
  readonly capabilities: Readonly<BlueprintCompressionCapabilities>;
  compress(
    chunks: AsyncIterable<Uint8Array>,
    options?: BlueprintCodecOperationOptions,
  ): AsyncIterable<Uint8Array>;
  decompress(
    chunks: AsyncIterable<Uint8Array>,
    options?: BlueprintCodecOperationOptions,
  ): AsyncIterable<Uint8Array>;
}
