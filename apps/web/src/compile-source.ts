import {
  compileSourceProgram,
  sourceCompilationArtifact,
  type LocalSourceCompilation,
  type SourceCompilationArtifact,
  type SourceCompilationEnvironment,
  type SourceCompilationObserver,
} from '@comblang/runtime/source-compilation';
import type { SourceFileSnapshot } from '@comblang/language';
import type { Diagnostic } from '@comblang/shared';
import {
  exportCompiledSourceBlueprint,
  type BlueprintExportOptions,
  type BlueprintExportResult,
} from './blueprint-export.js';

export type CompiledSourceResult = SourceCompilationArtifact & {
  readonly blueprintExport?: BlueprintExportResult;
};
export interface OwnedCompiledSource {
  readonly compilation: LocalSourceCompilation;
  readonly result: CompiledSourceResult;
}
export type { SourceCompilationEnvironment };
export type { SourceCompilationObserver };

export function compileSource(
  file: SourceFileSnapshot,
  environment: SourceCompilationEnvironment = {},
  preflightDiagnostics: readonly Diagnostic[] = [],
  observe?: SourceCompilationObserver,
  blueprintExport?: BlueprintExportOptions,
): CompiledSourceResult {
  return compileOwnedSource(file, environment, preflightDiagnostics, observe, blueprintExport)
    .result;
}

export function compileOwnedSource(
  file: SourceFileSnapshot,
  environment: SourceCompilationEnvironment = {},
  preflightDiagnostics: readonly Diagnostic[] = [],
  observe?: SourceCompilationObserver,
  blueprintExport?: BlueprintExportOptions,
): OwnedCompiledSource {
  const compilation = compileSourceProgram(file, environment, preflightDiagnostics, observe);
  const exported =
    blueprintExport === undefined
      ? undefined
      : exportCompiledSourceBlueprint(compilation, blueprintExport);
  const artifact = sourceCompilationArtifact(compilation);
  const result = exported === undefined ? artifact : { ...artifact, blueprintExport: exported };
  return { compilation, result };
}
