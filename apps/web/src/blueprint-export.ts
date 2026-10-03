import { DEFAULT_BLUEPRINT_CODEC_LIMITS } from '@comblang/blueprint';
import {
  generateBlueprintJson,
  type FactorioBlueprintJson,
} from '@comblang/compiler/blueprint-json';
import {
  exportSourceCompilationNativeBlueprint,
  listSourceCompilationParameters,
  type LocalSourceCompilation,
} from '@comblang/runtime/source-compilation';
import type { Diagnostic } from '@comblang/shared';
import { emitNativeBlueprintJson } from '../../../packages/compiler/src/native-blueprint-emitter.js';

export interface BlueprintExportOptions {
  readonly parameters?: boolean;
  readonly label?: string;
}

export type BlueprintExportResult =
  | { readonly ok: true; readonly document: FactorioBlueprintJson }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export class BrowserBlueprintExportRequestError extends Error {
  readonly code = 'WP1005';
}

/** Descriptor-only ingress inspection and immutable snapshot before any profile awaits. */
export function readBlueprintExportOptions(request: {
  readonly blueprintExport?: BlueprintExportOptions;
}): BlueprintExportOptions | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(request, 'blueprintExport');
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor) || !descriptor.enumerable) {
    throw new BrowserBlueprintExportRequestError(
      '$.blueprintExport: expected an enumerable data property.',
    );
  }
  const value: unknown = descriptor.value;
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new BrowserBlueprintExportRequestError(
      '$.blueprintExport: expected a plain data record.',
    );
  }
  const options: { parameters?: boolean; label?: string } = {};
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'parameters' && key !== 'label') {
      throw new BrowserBlueprintExportRequestError(
        `$.blueprintExport: unknown key ${String(key)}.`,
      );
    }
    const field = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in field) || !field.enumerable) {
      throw new BrowserBlueprintExportRequestError(
        `$.blueprintExport.${key}: expected an enumerable data property.`,
      );
    }
    const data: unknown = field.value;
    if (key === 'parameters') {
      if (typeof data !== 'boolean')
        throw new BrowserBlueprintExportRequestError(
          '$.blueprintExport.parameters: expected a boolean.',
        );
      options.parameters = data;
    } else {
      if (typeof data !== 'string')
        throw new BrowserBlueprintExportRequestError('$.blueprintExport.label: expected a string.');
      const maxBytes = DEFAULT_BLUEPRINT_CODEC_LIMITS.maxStringBytes;
      if (data.length > maxBytes || new TextEncoder().encode(data).byteLength > maxBytes) {
        throw new BrowserBlueprintExportRequestError(
          `$.blueprintExport.label: exceeds the ${maxBytes}-byte limit.`,
        );
      }
      options.label = data;
    }
  }
  return Object.freeze(options);
}

/** Projects the owning local result; failures never invalidate its concrete compilation. */
export function exportCompiledSourceBlueprint(
  compilation: LocalSourceCompilation,
  options: BlueprintExportOptions,
): BlueprintExportResult {
  const errors = compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error');
  if (errors.length > 0) return { ok: false, diagnostics: errors };
  try {
    if (compilation.resolvedCircuit === undefined) {
      throw new Error('Compilation did not produce a resolved circuit for blueprint export.');
    }
    const projection = {
      label: options.label ?? 'CombLang generated circuit',
      maxDeciderConditionRows: 1024,
    };
    const document =
      options.parameters === true && listSourceCompilationParameters(compilation).length > 0
        ? emitNativeBlueprintJson(exportSourceCompilationNativeBlueprint(compilation, projection))
        : generateBlueprintJson(compilation.resolvedCircuit.ir, projection);
    return { ok: true, document };
  } catch (error) {
    const typed =
      error instanceof Error
        ? (error as Error & Partial<Diagnostic> & { readonly path?: string })
        : undefined;
    const message = typed?.message ?? String(error);
    return {
      ok: false,
      diagnostics: [
        {
          code: typeof typed?.code === 'string' ? typed.code : 'BP1001',
          severity: 'error',
          message:
            typed?.path === undefined || message.startsWith(`${typed.path}:`)
              ? message
              : `${typed.path}: ${message}`,
          ...(typed?.span === undefined ? {} : { span: typed.span }),
          ...(typed?.related === undefined ? {} : { related: typed.related }),
        },
      ],
    };
  }
}
