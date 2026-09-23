import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  BlueprintDocumentError,
  BlueprintExchangeError,
  DEFAULT_BLUEPRINT_CODEC_LIMITS,
  decodeBlueprintExchange,
  encodeBlueprintExchange,
  parseLosslessJson,
  stringifyLosslessJson,
} from '@comblang/blueprint';

const blueprintUsage = `Usage:
  factorio-dsl blueprint decode [--json] [--input-file <exchange.txt> | <exchange-string>] [--output <document.json>]
  factorio-dsl blueprint encode [--json] [--output <exchange.txt>] <document.json>`;

type BlueprintCliErrorCode =
  'CLIBP1000' | 'CLIBP1001' | 'CLIBP1002' | 'CLIBP1003' | 'CLIBP1004' | 'CLIBP1005';

export class BlueprintCliError extends Error {
  readonly code: BlueprintCliErrorCode;
  readonly path: string | undefined;

  constructor(code: BlueprintCliErrorCode, message: string, path?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BlueprintCliError';
    this.code = code;
    this.path = path;
  }
}

export async function readBoundedUtf8File(path: string, maxBytes: number): Promise<string> {
  const absolutePath = resolve(path);
  let handle;
  try {
    handle = await open(absolutePath, 'r');
  } catch (error) {
    throw new BlueprintCliError(
      'CLIBP1002',
      `Unable to open input file: ${absolutePath}`,
      absolutePath,
      error,
    );
  }

  try {
    const { size } = await handle.stat();
    if (!Number.isSafeInteger(size) || size > maxBytes) {
      throw new BlueprintCliError(
        'CLIBP1002',
        `Input file exceeds the ${maxBytes}-byte limit.`,
        absolutePath,
      );
    }

    const chunks: Uint8Array[] = [];
    const buffer = new Uint8Array(64 * 1024);
    let total = 0;
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      if (bytesRead > maxBytes - total) {
        throw new BlueprintCliError(
          'CLIBP1002',
          `Input file grew beyond the ${maxBytes}-byte limit while reading.`,
          absolutePath,
        );
      }
      chunks.push(buffer.slice(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
      throw new BlueprintCliError(
        'CLIBP1005',
        'Input file is not valid UTF-8.',
        absolutePath,
        error,
      );
    }
  } catch (error) {
    if (error instanceof BlueprintCliError) throw error;
    throw new BlueprintCliError(
      'CLIBP1002',
      `Unable to read input file: ${absolutePath}`,
      absolutePath,
      error,
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeExclusiveText(path: string, text: string): Promise<string> {
  const absolutePath = resolve(path);
  let handle;
  try {
    handle = await open(absolutePath, 'wx');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new BlueprintCliError(
        'CLIBP1003',
        'Output file already exists; refusing to overwrite.',
        absolutePath,
        error,
      );
    }
    throw new BlueprintCliError(
      'CLIBP1004',
      `Unable to create output file: ${absolutePath}`,
      absolutePath,
      error,
    );
  }
  try {
    await handle.writeFile(text, 'utf8');
    return absolutePath;
  } catch (error) {
    throw new BlueprintCliError(
      'CLIBP1004',
      `Unable to write output file: ${absolutePath}`,
      absolutePath,
      error,
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

interface ParsedBlueprintCommand {
  readonly action: 'decode' | 'encode';
  readonly json: boolean;
  readonly inputFile: string | undefined;
  readonly outputFile: string | undefined;
  readonly positional: readonly string[];
}

function parseBlueprintCommand(args: readonly string[]): ParsedBlueprintCommand {
  const [action, ...rest] = args;
  if (action !== 'decode' && action !== 'encode') {
    throw new BlueprintCliError(
      'CLIBP1001',
      `Unknown blueprint operation: ${action ?? '(missing)'}.`,
    );
  }
  let json = false;
  let inputFile: string | undefined;
  let outputFile: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === undefined) continue;
    if (argument === '--json') {
      if (json) throw new BlueprintCliError('CLIBP1001', 'Duplicate option: --json.');
      json = true;
    } else if (argument === '--input-file') {
      const value = rest[index + 1];
      if (action !== 'decode' || inputFile !== undefined || value === undefined) {
        throw new BlueprintCliError('CLIBP1001', '--input-file requires one decode input path.');
      }
      inputFile = value;
      index += 1;
    } else if (argument === '--output') {
      const value = rest[index + 1];
      if (outputFile !== undefined || value === undefined) {
        throw new BlueprintCliError('CLIBP1001', '--output requires one output path.');
      }
      outputFile = value;
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new BlueprintCliError('CLIBP1001', `Unknown blueprint option: ${argument}.`);
    } else positional.push(argument);
  }

  if (action === 'decode') {
    if (
      (inputFile === undefined && positional.length !== 1) ||
      (inputFile !== undefined && positional.length > 0)
    ) {
      throw new BlueprintCliError(
        'CLIBP1001',
        'decode requires one exchange string or one --input-file path.',
      );
    }
  } else if (inputFile !== undefined || positional.length !== 1) {
    throw new BlueprintCliError('CLIBP1001', 'encode requires one lossless JSON input file.');
  }
  return { action, json, inputFile, outputFile, positional };
}

function reportError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
} {
  if (
    error instanceof BlueprintCliError ||
    error instanceof BlueprintExchangeError ||
    error instanceof BlueprintDocumentError
  ) {
    return {
      code: error.code,
      message: error.message,
      ...(error.path === undefined ? {} : { path: error.path }),
    };
  }
  return {
    code: 'CLIBP1000',
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Runs the narrowly scoped lossless blueprint codec commands. */
export async function runBlueprintCommand(args: readonly string[]): Promise<number> {
  const jsonHint = args.includes('--json');
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      console.log(blueprintUsage);
      return 0;
    }
    const command = parseBlueprintCommand(args);
    let output: string;
    if (command.action === 'decode') {
      let exchange =
        command.inputFile === undefined
          ? command.positional[0]!
          : await readBoundedUtf8File(
              command.inputFile,
              DEFAULT_BLUEPRINT_CODEC_LIMITS.maxEncodedCharacters + 2,
            ).then((text) => text.replace(/\r?\n$/, ''));
      const document = await decodeBlueprintExchange(exchange);
      output = stringifyLosslessJson(document);
      if (command.outputFile === undefined) {
        console.log(command.json ? `{"ok":true,"document":${output}}` : output);
      } else {
        const destination = await writeExclusiveText(command.outputFile, output);
        console.log(
          command.json ? JSON.stringify({ ok: true, output: destination }) : `Wrote ${destination}`,
        );
      }
      return 0;
    }

    const inputPath = command.positional[0]!;
    const input = await readBoundedUtf8File(
      inputPath,
      DEFAULT_BLUEPRINT_CODEC_LIMITS.maxDecompressedBytes,
    );
    const document = parseLosslessJson(input);
    output = await encodeBlueprintExchange(document);
    if (command.outputFile === undefined) {
      console.log(command.json ? JSON.stringify({ ok: true, exchange: output }) : output);
    } else {
      const destination = await writeExclusiveText(command.outputFile, output);
      console.log(
        command.json ? JSON.stringify({ ok: true, output: destination }) : `Wrote ${destination}`,
      );
    }
    return 0;
  } catch (error) {
    const reported = reportError(error);
    if (jsonHint) console.log(JSON.stringify({ ok: false, error: reported }));
    else {
      const location = reported.path === undefined ? '' : ` ${reported.path}`;
      console.error(`${reported.code}${location}: ${reported.message}`);
    }
    return 2;
  }
}
