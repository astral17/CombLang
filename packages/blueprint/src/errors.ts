/** Stable exchange codes: marker, Base64, budget, capability, deflate, UTF-8, cancellation. */
export type BlueprintExchangeErrorCode =
  'BEX1001' | 'BEX1002' | 'BEX1003' | 'BEX1004' | 'BEX1005' | 'BEX1006' | 'BEX1007';

/** Stable document codes: syntax, duplicate key, Unicode, budget, unsafe node, number lexeme, root, header. */
export type BlueprintDocumentErrorCode =
  'BPD1001' | 'BPD1002' | 'BPD1003' | 'BPD1004' | 'BPD1005' | 'BPD1006' | 'BPD1007' | 'BPD1008';

export interface BlueprintCodecErrorOptions {
  readonly path?: string;
  readonly cause?: unknown;
}

abstract class BlueprintCodecError<Code extends string> extends Error {
  readonly code: Code;
  readonly path: string | undefined;

  protected constructor(
    name: string,
    code: Code,
    message: string,
    options: BlueprintCodecErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = name;
    this.code = code;
    this.path = options.path;
  }
}

export class BlueprintExchangeError extends BlueprintCodecError<BlueprintExchangeErrorCode> {
  constructor(
    code: BlueprintExchangeErrorCode,
    message: string,
    options?: BlueprintCodecErrorOptions,
  ) {
    super('BlueprintExchangeError', code, message, options);
  }
}

export class BlueprintDocumentError extends BlueprintCodecError<BlueprintDocumentErrorCode> {
  constructor(
    code: BlueprintDocumentErrorCode,
    message: string,
    options?: BlueprintCodecErrorOptions,
  ) {
    super('BlueprintDocumentError', code, message, options);
  }
}
