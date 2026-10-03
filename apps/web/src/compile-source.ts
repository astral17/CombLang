import {
  compileSourceProgram,
  sourceCompilationArtifact,
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
export type { SourceCompilationEnvironment };
export type { SourceCompilationObserver };

export function compileSource(
  file: SourceFileSnapshot,
  environment: SourceCompilationEnvironment = {},
  preflightDiagnostics: readonly Diagnostic[] = [],
  observe?: SourceCompilationObserver,
  blueprintExport?: BlueprintExportOptions,
): CompiledSourceResult {
  const compilation = compileSourceProgram(file, environment, preflightDiagnostics, observe);
  if (blueprintExport === undefined) return sourceCompilationArtifact(compilation);
  const exported = exportCompiledSourceBlueprint(compilation, blueprintExport);
  return { ...sourceCompilationArtifact(compilation), blueprintExport: exported };
}
