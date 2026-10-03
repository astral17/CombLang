import { resolve } from 'node:path';
import { DEFAULT_BLUEPRINT_CODEC_LIMITS } from '@comblang/blueprint';
import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import {
  compileSourceProgram,
  exportSourceCompilationNativeBlueprint,
  listSourceCompilationParameters,
} from '@comblang/runtime/source-compilation';
import type { Diagnostic, SourceSpan } from '@comblang/shared';
import { emitNativeBlueprintJson } from '../../../packages/compiler/src/native-blueprint-emitter.js';
import { BlueprintCliError, readBoundedUtf8File, writeExclusiveText } from './blueprint-command.js';
import type { CliCompilationEnvironment } from './main.js';
import { parseCompilationOptions, type CompilationOptions } from './prototype-options.js';

export const sourceExportUsage = `Usage:
  factorio-dsl blueprint export [--json] [--parameters] [--label <text>] [--output <document.json>] [--prototypes <database.json>] [--prototype-identity <id>] <source.factorio.ts>`;

export interface SourceExportOptions extends CompilationOptions {
  readonly parameters: boolean;
  readonly label?: string;
  readonly output?: string;
}

export function sourceExportJsonHint(args: readonly string[]): boolean {
  return args.slice(0, args.includes('--') ? args.indexOf('--') : args.length).includes('--json');
}

/** Validate all export arguments before provider loading or source execution. */
export function parseSourceExportOptions(args: readonly string[]): SourceExportOptions {
  const common: string[] = [];
  const seen = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--') {
      common.push(...args.slice(index));
      break;
    }
    if (
      argument === '--json' ||
      argument === '--parameters' ||
      argument === '--label' ||
      argument === '--output' ||
      argument === '--prototypes' ||
      argument === '--prototype-identity'
    ) {
      if (seen.has(argument))
        throw new BlueprintCliError('CLIBP1001', `Duplicate option: ${argument}.`);
      seen.add(argument);
      if (argument === '--json') common.push(argument);
      else if (argument !== '--parameters') {
        const value = args[++index];
        if (
          value === undefined ||
          value.startsWith('-') ||
          (argument !== '--label' && value.trim().length === 0)
        ) {
          throw new BlueprintCliError('CLIBP1001', `${argument} requires a value.`);
        }
        if (argument === '--prototypes' || argument === '--prototype-identity')
          common.push(argument, value);
        else values.set(argument, value);
      }
    } else {
      if (argument.startsWith('-'))
        throw new BlueprintCliError('CLIBP1001', `Unknown blueprint export option: ${argument}.`);
      common.push(argument);
    }
  }
  const options = parseCompilationOptions(common);
  if (options.files.length !== 1 || options.files[0]!.trim().length === 0) {
    throw new BlueprintCliError('CLIBP1001', 'export requires exactly one source file.');
  }
  const label = values.get('--label');
  const output = values.get('--output');
  return {
    ...options,
    parameters: seen.has('--parameters'),
    ...(label === undefined ? {} : { label }),
    ...(output === undefined ? {} : { output }),
  };
}

interface ExportErrorReport {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly span?: SourceSpan;
  readonly related?: Diagnostic['related'];
}

type FormatDiagnostic = (diagnostic: Diagnostic) => string;

function publishFailure(
  error: ExportErrorReport,
  json: boolean,
  diagnostics: readonly Diagnostic[],
  format?: FormatDiagnostic,
): number {
  if (json)
    console.log(
      JSON.stringify({ ok: false, error, ...(diagnostics.length === 0 ? {} : { diagnostics }) }),
    );
  else if (diagnostics.some(({ severity }) => severity === 'error')) {
    for (const diagnostic of diagnostics) console.error(format!(diagnostic));
  } else {
    for (const diagnostic of diagnostics) console.error(format!(diagnostic));
    const message =
      error.path === undefined || error.message.startsWith(`${error.path}:`)
        ? error.message
        : `${error.path}: ${error.message}`;
    const diagnostic: Diagnostic = {
      code: error.code,
      message,
      severity: 'error',
      ...(error.span === undefined ? {} : { span: error.span }),
    };
    console.error(
      format === undefined
        ? `${error.code}${error.path === undefined ? '' : ` ${error.path}`}: ${error.message}`
        : format(diagnostic),
    );
  }
  return 2;
}

/** Retain codes and source context from compiler/export/provider errors. */
export function reportSourceExportFailure(
  error: unknown,
  json: boolean,
  diagnostics: readonly Diagnostic[] = [],
  format?: FormatDiagnostic,
): number {
  const typed = error instanceof Error ? (error as Error & Partial<ExportErrorReport>) : undefined;
  return publishFailure(
    {
      code: typeof typed?.code === 'string' ? typed.code : 'CLIBP1000',
      message: typed?.message ?? String(error),
      ...(typed?.path === undefined ? {} : { path: typed.path }),
      ...(typed?.span === undefined ? {} : { span: typed.span }),
      ...(typed?.related === undefined ? {} : { related: typed.related }),
    },
    json,
    diagnostics,
    format,
  );
}

/** Called only after main has selected and provisioned the existing CLI environment. */
export async function runSourceBlueprintExport(
  options: SourceExportOptions,
  environment: CliCompilationEnvironment,
  formatSourceDiagnostic: (
    diagnostic: Diagnostic,
    source: {
      readonly path: string;
      readonly text: string;
      readonly fileId: string;
    },
  ) => string,
): Promise<number> {
  let diagnostics: readonly Diagnostic[] = [];
  let format: FormatDiagnostic | undefined;
  try {
    const path = resolve(options.files[0]!);
    const text = await readBoundedUtf8File(
      path,
      DEFAULT_BLUEPRINT_CODEC_LIMITS.maxDecompressedBytes,
    );
    const compilation = compileSourceProgram({ path, text }, environment);
    diagnostics = compilation.pipelineDiagnostics;
    format = (diagnostic) =>
      formatSourceDiagnostic(diagnostic, { path, text, fileId: compilation.fileId });
    const firstError = diagnostics.find(({ severity }) => severity === 'error');
    if (firstError !== undefined) {
      return publishFailure(
        {
          code: firstError.code,
          message: firstError.message,
          ...(firstError.span === undefined ? {} : { span: firstError.span }),
          ...(firstError.related === undefined ? {} : { related: firstError.related }),
        },
        options.json,
        diagnostics,
        format,
      );
    }
    if (compilation.resolvedCircuit === undefined) {
      throw new BlueprintCliError('CLIBP1000', 'Compilation did not produce a resolved circuit.');
    }
    const projection = {
      label: options.label ?? 'CombLang generated circuit',
      maxDeciderConditionRows: 1024,
    };
    const document =
      options.parameters && listSourceCompilationParameters(compilation).length > 0
        ? emitNativeBlueprintJson(exportSourceCompilationNativeBlueprint(compilation, projection))
        : generateBlueprintJson(compilation.resolvedCircuit.ir, projection);
    const output = JSON.stringify(document, null, 2);
    if (Buffer.byteLength(output, 'utf8') > DEFAULT_BLUEPRINT_CODEC_LIMITS.maxEmittedBytes) {
      throw new BlueprintCliError(
        'CLIBP1002',
        `Output exceeds the ${DEFAULT_BLUEPRINT_CODEC_LIMITS.maxEmittedBytes}-byte limit.`,
        options.output,
      );
    }
    const destination =
      options.output === undefined ? undefined : await writeExclusiveText(options.output, output);
    if (!options.json) for (const diagnostic of diagnostics) console.error(format(diagnostic));
    if (options.json)
      console.log(
        JSON.stringify(
          {
            ok: true,
            ...(destination === undefined ? { document } : { output: destination }),
            ...(diagnostics.length === 0 ? {} : { diagnostics }),
          },
          null,
          2,
        ),
      );
    else console.log(destination === undefined ? output : `Wrote ${destination}`);
    return 0;
  } catch (error) {
    return reportSourceExportFailure(error, options.json, diagnostics, format);
  }
}
