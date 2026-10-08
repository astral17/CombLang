import { resolve } from 'node:path';

import { DEFAULT_BLUEPRINT_CODEC_LIMITS } from '@comblang/blueprint';
import {
  compileSourceProgram,
  listSourceCompilationParameters,
} from '@comblang/runtime/source-compilation';
import { createSourceParameterBindingSession } from '@comblang/runtime/source-parameter-binding';
import type { Diagnostic } from '@comblang/shared';

import {
  CliInputError,
  parseCompilationOptions,
  type CompilationOptions,
} from './prototype-options.js';
import { readBoundedUtf8File } from './blueprint-command.js';
import { reportSourceExportFailure } from './blueprint-source-export.js';
import type { CliCompilationEnvironment } from './main.js';

const maxOverrideFileBytes = 1_048_576;

/** Parse the deliberately small source-parameter listing command. */
export function parseSourceParameterListOptions(args: readonly string[]): CompilationOptions {
  if (args[0] !== 'list') {
    throw new CliInputError(
      'CLI1001',
      `Unknown parameters operation: ${args[0] ?? '(missing)'}. Expected list.`,
    );
  }
  const options = parseCompilationOptions(args.slice(1));
  if (options.projectPath !== undefined && options.prototypePath !== undefined) {
    throw new CliInputError('CLI1001', 'Choose either --project or --prototypes, not both.');
  }
  if (
    options.files.length > 1 ||
    (options.files.length === 1 && options.files[0]!.trim().length === 0) ||
    (options.files.length === 0 && options.projectPath === undefined)
  ) {
    throw new CliInputError(
      'CLI1001',
      options.projectPath === undefined
        ? 'parameters list requires exactly one source file.'
        : 'parameters list accepts at most one source file with --project.',
    );
  }
  return options;
}

/** Read JSON syntax only; the owning runtime adapter validates the override shape and values. */
export async function readSourceParameterOverrides(path: string): Promise<unknown> {
  const absolutePath = resolve(path);
  const text = await readBoundedUtf8File(absolutePath, maxOverrideFileBytes);
  try {
    return JSON.parse(text, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new CliInputError(
          'CLI1001',
          `Override JSON contains a non-finite number: ${absolutePath}`,
        );
      }
      return value;
    }) as unknown;
  } catch (error) {
    if (error instanceof CliInputError) throw error;
    throw new CliInputError('CLI1001', `Invalid overrides JSON in ${absolutePath}.`);
  }
}

/** List cloneable descriptors from one owning compilation. */
export async function runSourceParameterListing(
  options: CompilationOptions,
  environment: CliCompilationEnvironment,
  formatSourceDiagnostic: (
    diagnostic: Diagnostic,
    source: { readonly path: string; readonly text: string; readonly fileId: string },
  ) => string,
): Promise<number> {
  let diagnostics: readonly Diagnostic[] = [];
  let format: ((diagnostic: Diagnostic) => string) | undefined;
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
      const error = Object.assign(new Error(firstError.message), firstError);
      return reportSourceExportFailure(error, options.json, diagnostics, format);
    }
    const declarations = listSourceCompilationParameters(compilation);
    const parameters =
      declarations.length === 0 ? [] : createSourceParameterBindingSession(compilation).parameters;
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            parameters,
            ...(diagnostics.length === 0 ? {} : { diagnostics }),
          },
          null,
          2,
        ),
      );
    } else {
      for (const diagnostic of diagnostics) console.error(format(diagnostic));
      console.log(
        parameters.length === 0
          ? 'No parameters declared.'
          : parameters
              .map(
                ({ id, kind, label, defaultValue }) =>
                  `${id}\t${kind}\t${JSON.stringify(label)}\t${JSON.stringify(defaultValue)}`,
              )
              .join('\n'),
      );
    }
    return 0;
  } catch (error) {
    return reportSourceExportFailure(error, options.json, diagnostics, format);
  }
}
