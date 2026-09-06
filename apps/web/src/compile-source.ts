import {
  compileSourceProgram,
  sourceCompilationArtifact,
  type SourceCompilationArtifact,
  type SourceCompilationEnvironment,
} from '@comblang/runtime/source-compilation';
import type { SourceFileSnapshot } from '@comblang/language';
import type { Diagnostic } from '@comblang/shared';

export type CompiledSourceResult = SourceCompilationArtifact;
export type { SourceCompilationEnvironment };

export function compileSource(
  file: SourceFileSnapshot,
  environment: SourceCompilationEnvironment = {},
  preflightDiagnostics: readonly Diagnostic[] = [],
): CompiledSourceResult {
  return sourceCompilationArtifact(compileSourceProgram(file, environment, preflightDiagnostics));
}
