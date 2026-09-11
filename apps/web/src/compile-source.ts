import {
  compileSourceProgram,
  sourceCompilationArtifact,
  type SourceCompilationArtifact,
  type SourceCompilationEnvironment,
  type SourceCompilationObserver,
} from '@comblang/runtime/source-compilation';
import type { SourceFileSnapshot } from '@comblang/language';
import type { Diagnostic } from '@comblang/shared';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';

export type CompiledSourceResult = SourceCompilationArtifact;
type LegacySourceCompilationEnvironment = Omit<
  SourceCompilationEnvironment,
  'trustedEntityReplayContext'
> & {
  readonly trustedEntityReplayContext?: never;
};
type LegacyCompiledSourceResult = Omit<SourceCompilationArtifact, 'plan'> & {
  readonly plan?: DirectElaborationPlan;
};
export type { SourceCompilationEnvironment };
export type { SourceCompilationObserver };

export function compileSource(
  file: SourceFileSnapshot,
  environment?: LegacySourceCompilationEnvironment,
  preflightDiagnostics?: readonly Diagnostic[],
  observe?: SourceCompilationObserver,
): LegacyCompiledSourceResult;
export function compileSource(
  file: SourceFileSnapshot,
  environment: SourceCompilationEnvironment,
  preflightDiagnostics?: readonly Diagnostic[],
  observe?: SourceCompilationObserver,
): CompiledSourceResult;
export function compileSource(
  file: SourceFileSnapshot,
  environment: SourceCompilationEnvironment = {},
  preflightDiagnostics: readonly Diagnostic[] = [],
  observe?: SourceCompilationObserver,
): CompiledSourceResult {
  return sourceCompilationArtifact(
    compileSourceProgram(file, environment, preflightDiagnostics, observe),
  );
}
