import type { BlueprintCodecOperationOptions, BlueprintCompressionAdapter } from './compression.js';
import type { BlueprintCodecLimitOverrides } from './limits.js';

/** Factorio exchange strings begin with this framing marker before Base64 data. */
export const BLUEPRINT_EXCHANGE_MARKER = '0' as const;

export interface BlueprintCodecOptions extends BlueprintCodecOperationOptions {
  readonly limits?: BlueprintCodecLimitOverrides;
  readonly compression?: BlueprintCompressionAdapter;
}
