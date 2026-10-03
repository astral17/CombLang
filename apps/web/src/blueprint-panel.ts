import type { FactorioBlueprintJson } from '@comblang/compiler/blueprint-json';
import type { Diagnostic } from '@comblang/shared';
import type { BlueprintExportOptions, BlueprintExportResult } from './blueprint-export.js';

export function blueprintExportRequest(parameters: boolean): {
  readonly blueprintExport?: BlueprintExportOptions;
} {
  return parameters ? { blueprintExport: { parameters: true } } : {};
}

interface BlueprintPanelInput {
  readonly parameters: boolean;
  readonly pending?: boolean;
  readonly error?: string;
  readonly concrete?: FactorioBlueprintJson;
  readonly exported?: BlueprintExportResult | undefined;
}

export interface BlueprintPanelView {
  readonly state: 'pending' | 'invalid' | 'valid';
  readonly status: string;
  readonly text: string;
  readonly copyPayload?: string;
}

/** Select display data only; export diagnostics never change compilation or simulation. */
export function selectBlueprintPanel(
  input: BlueprintPanelInput,
  formatDiagnostic: (diagnostic: Diagnostic) => string = (diagnostic) =>
    `${diagnostic.code} ${diagnostic.severity}: ${diagnostic.message}`,
): BlueprintPanelView {
  if (input.pending) return { state: 'pending', status: 'Waiting for compiler…', text: '{}' };
  if (input.error !== undefined) {
    return {
      state: 'invalid',
      status: 'No blueprint JSON',
      text: JSON.stringify({ error: input.error }, null, 2),
    };
  }
  if (input.parameters && input.exported === undefined) {
    return {
      state: 'invalid',
      status: 'Parameter export unavailable',
      text: 'Parameter export unavailable: the compiler returned no blueprint export result.',
    };
  }
  if (input.parameters && input.exported?.ok === false) {
    const text = input.exported.diagnostics
      .flatMap((diagnostic) => [
        formatDiagnostic(diagnostic),
        ...(diagnostic.related ?? []).map((related) =>
          formatDiagnostic({
            code: diagnostic.code,
            severity: 'note',
            message: related.message,
            span: related.span,
          }),
        ),
      ])
      .join('\n');
    return {
      state: 'invalid',
      status: 'Parameter export failed',
      text: text || 'Parameter export failed without diagnostics.',
    };
  }
  const document =
    input.parameters && input.exported?.ok ? input.exported.document : input.concrete;
  if (document === undefined) return { state: 'invalid', status: 'No blueprint JSON', text: '{}' };
  const text = JSON.stringify(document, null, 2);
  return {
    state: 'valid',
    status: `${document.blueprint.entities.length} entities · ${document.blueprint.wires.length} wires`,
    text,
    copyPayload: text,
  };
}

interface BlueprintCopySnapshot {
  readonly revision: number;
  readonly parameters: boolean;
  readonly json: string | undefined;
}

/** An asynchronous clipboard result belongs only to the document that initiated it. */
export function blueprintCopyIsCurrent(
  captured: BlueprintCopySnapshot,
  current: BlueprintCopySnapshot,
): boolean {
  return (
    current.json !== undefined &&
    captured.revision === current.revision &&
    captured.parameters === current.parameters &&
    captured.json === current.json
  );
}
