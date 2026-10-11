import { resolve } from 'node:path';

import { DEFAULT_BLUEPRINT_CODEC_LIMITS } from '@comblang/blueprint';
import type { Diagnostic } from '@comblang/shared';
import { offsetToPosition } from '@comblang/shared';
import {
  importCanonicalBlueprintSource,
  type BlueprintSourceImportDiagnostic,
  type BlueprintSourceImportDiagnosticContext,
} from '@comblang/runtime/blueprint-source-import';

import { BlueprintCliError, readBoundedUtf8File, writeExclusiveText } from './blueprint-command.js';
import type { CliCompilationEnvironment } from './main.js';

export const sourceBlueprintImportUsage = `Usage:
  factorio-dsl blueprint import [--json] [--output <source.factorio.ts>] [--prototypes <database.json>] [--prototype-identity <id>] <document.json>`;

export interface SourceBlueprintImportOptions {
  readonly inputPath: string;
  readonly json: boolean;
  readonly output?: string;
  readonly prototypePath?: string;
  readonly prototypeIdentity?: string;
}

interface ImportErrorReport {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

type ImportDiagnostic = BlueprintSourceImportDiagnostic;
type SourceImportDiagnosticFormatter = (diagnostic: Diagnostic) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDiagnostic(value: unknown): value is Diagnostic {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.severity === 'string' &&
    typeof value.message === 'string'
  );
}

export function sourceBlueprintImportJsonHint(args: readonly string[]): boolean {
  return args.slice(0, args.includes('--') ? args.indexOf('--') : args.length).includes('--json');
}

function optionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--') || value.trim().length === 0) {
    throw new BlueprintCliError('CLIBP1001', `${option} requires a nonblank value.`);
  }
  if (value.includes('\0')) {
    throw new BlueprintCliError('CLIBP1001', `${option} must not contain NUL.`);
  }
  return value;
}

/** Parses and validates every import argument before provider loading or file access. */
export function parseSourceBlueprintImportOptions(
  args: readonly string[],
): SourceBlueprintImportOptions {
  let json = false;
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--') {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (argument === '--json') {
      if (json) throw new BlueprintCliError('CLIBP1001', 'Duplicate option: --json.');
      json = true;
      continue;
    }
    if (
      argument === '--output' ||
      argument === '--prototypes' ||
      argument === '--prototype-identity'
    ) {
      if (values.has(argument)) {
        throw new BlueprintCliError('CLIBP1001', `Duplicate option: ${argument}.`);
      }
      values.set(argument, optionValue(args, index, argument));
      index += 1;
      continue;
    }
    if (
      argument === '--project' ||
      argument === '--parameters' ||
      argument === '--overrides' ||
      argument === '--input-file'
    ) {
      throw new BlueprintCliError('CLIBP1001', `${argument} is not supported by blueprint import.`);
    }
    if (argument.startsWith('-')) {
      throw new BlueprintCliError('CLIBP1001', `Unknown blueprint import option: ${argument}.`);
    }
    positional.push(argument);
  }

  if (positional.length !== 1 || positional[0]!.trim().length === 0) {
    throw new BlueprintCliError('CLIBP1001', 'import requires exactly one JSON document path.');
  }
  const inputPath = positional[0]!;
  const output = values.get('--output');
  const prototypePath = values.get('--prototypes');
  if (inputPath.includes('\0')) {
    throw new BlueprintCliError('CLIBP1001', 'Input path must not contain NUL.');
  }
  if (output?.includes('\0')) {
    throw new BlueprintCliError('CLIBP1001', '--output must not contain NUL.');
  }
  if (prototypePath?.includes('\0')) {
    throw new BlueprintCliError('CLIBP1001', '--prototypes must not contain NUL.');
  }
  return {
    inputPath,
    json,
    ...(output === undefined ? {} : { output }),
    ...(prototypePath === undefined ? {} : { prototypePath }),
    ...(values.get('--prototype-identity') === undefined
      ? {}
      : { prototypeIdentity: values.get('--prototype-identity')! }),
  };
}

function diagnosticPath(value: unknown): string | undefined {
  return isRecord(value) && typeof value.path === 'string' ? value.path : undefined;
}

function diagnosticMessage(value: unknown): string {
  return isRecord(value) && typeof value.message === 'string'
    ? value.message
    : 'Blueprint import was refused.';
}

function diagnosticCategory(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const category = value['category'];
  return typeof category === 'string' ? category : undefined;
}

function diagnosticSource(value: unknown): unknown {
  return isRecord(value) ? value['source'] : undefined;
}

function errorReport(error: unknown): ImportErrorReport {
  const typed =
    error instanceof Error ? (error as Error & { code?: unknown; path?: unknown }) : null;
  return {
    code: typeof typed?.code === 'string' ? typed.code : 'CLIBP1000',
    message: typed?.message ?? String(error),
    ...(typeof typed?.path === 'string' ? { path: typed.path } : {}),
  };
}

function sourceLocation(
  value: unknown,
  source: { readonly path: string; readonly text: string; readonly fileId: string } | undefined,
): string | undefined {
  if (!isRecord(value) || source === undefined) return undefined;
  const { fileId, start } = value;
  if (
    fileId !== source.fileId ||
    typeof start !== 'number' ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    start > source.text.length
  ) {
    return undefined;
  }
  const position = offsetToPosition(source.text, start);
  return `${source.path}:${position.line + 1}:${position.column + 1}`;
}

function formatImportDiagnostic(
  value: ImportDiagnostic,
  source: { readonly path: string; readonly text: string; readonly fileId: string } | undefined,
  format: SourceImportDiagnosticFormatter | undefined,
): string {
  if (isDiagnostic(value)) return format?.(value) ?? `${value.code}: ${value.message}`;
  const path = diagnosticPath(value);
  const category = diagnosticCategory(value);
  const message = diagnosticMessage(value);
  const head = `${path === undefined ? '' : `${path}: `}${category === undefined ? '' : `${category}: `}${message}`;
  const generated = sourceLocation(diagnosticSource(value), source);
  return generated === undefined ? head : `${head}\nGenerated source ${generated}`;
}

function publishFailure(
  error: ImportErrorReport,
  json: boolean,
  diagnostics: readonly ImportDiagnostic[] = [],
  source?: { readonly path: string; readonly text: string; readonly fileId: string },
  format?: SourceImportDiagnosticFormatter,
): number {
  if (json) {
    console.log(
      JSON.stringify({
        ok: false,
        error,
        ...(diagnostics.length === 0 ? {} : { diagnostics }),
      }),
    );
  } else {
    console.error(
      `${error.code}${error.path === undefined ? '' : ` ${error.path}`}: ${error.message}`,
    );
    for (const diagnostic of diagnostics) {
      console.error(formatImportDiagnostic(diagnostic, source, format));
    }
  }
  return 2;
}

/** Retains native JSON paths and, separately, any related generated-source location. */
function refuseDiagnostics(
  diagnostics: readonly ImportDiagnostic[],
  fallbackMessage: string,
): ImportErrorReport {
  const first =
    diagnostics.find((diagnostic) => isDiagnostic(diagnostic) && diagnostic.severity === 'error') ??
    diagnostics.find(
      (diagnostic) => diagnosticCategory(diagnostic) === 'source-verification-mismatch',
    ) ??
    diagnostics.find((diagnostic) => diagnosticCategory(diagnostic) !== undefined) ??
    diagnostics[0];
  if (first === undefined) return { code: 'CLIBP1006', message: fallbackMessage };
  const path = diagnosticPath(first);
  if (isDiagnostic(first) && first.severity === 'error') {
    return {
      code: first.code,
      message: first.message,
      ...(path === undefined ? {} : { path }),
    };
  }
  return {
    code: 'CLIBP1006',
    message: diagnosticMessage(first),
    ...(path === undefined ? {} : { path }),
  };
}

/** Reads and presents one file; the host-neutral runtime owns semantic import. */
export async function runSourceBlueprintImport(
  options: SourceBlueprintImportOptions,
  environment: CliCompilationEnvironment,
  formatSourceDiagnostic: (
    diagnostic: Diagnostic,
    source: { readonly path: string; readonly text: string; readonly fileId: string },
  ) => string,
): Promise<number> {
  let diagnostics: readonly ImportDiagnostic[] = [];
  let sourceForFormatting: BlueprintSourceImportDiagnosticContext | undefined;
  let format: SourceImportDiagnosticFormatter | undefined;
  try {
    const inputPath = resolve(options.inputPath);
    const input = await readBoundedUtf8File(
      inputPath,
      DEFAULT_BLUEPRINT_CODEC_LIMITS.maxDecompressedBytes,
    );
    const sourcePath = resolve(options.output ?? `${inputPath}.factorio.ts`);
    const result = importCanonicalBlueprintSource(input, { path: sourcePath }, environment);
    diagnostics = result.diagnostics;
    sourceForFormatting = result.diagnosticContext;
    if (sourceForFormatting !== undefined) {
      format = (diagnostic) => formatSourceDiagnostic(diagnostic, sourceForFormatting!);
    }
    if (result.state === 'blocked') {
      return publishFailure(
        refuseDiagnostics(diagnostics, 'Blueprint source import was blocked.'),
        options.json,
        diagnostics,
        sourceForFormatting,
        format,
      );
    }

    const destination =
      options.output === undefined
        ? undefined
        : await writeExclusiveText(sourcePath, result.source.text);
    const response = {
      ok: true,
      source: result.source,
      correspondence: result.correspondence,
      verification: result.verification,
      ...(diagnostics.length === 0 ? {} : { diagnostics }),
      ...(destination === undefined ? {} : { output: destination }),
    };
    if (options.json) console.log(JSON.stringify(response, null, 2));
    else {
      for (const diagnostic of diagnostics) {
        console.error(formatImportDiagnostic(diagnostic, sourceForFormatting, format));
      }
      console.log(destination === undefined ? result.source.text : `Wrote ${destination}`);
    }
    return 0;
  } catch (error) {
    return publishFailure(
      errorReport(error),
      options.json,
      diagnostics,
      sourceForFormatting,
      format,
    );
  }
}

/** Used by main before provider selection so --json parsing failures remain machine-safe. */
export function reportSourceBlueprintImportFailure(error: unknown, json: boolean): number {
  return publishFailure(errorReport(error), json);
}
