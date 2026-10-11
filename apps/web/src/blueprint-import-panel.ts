import type {
  CompilerWorkerBlueprintImportDiagnostic,
  CompilerWorkerBlueprintImportResult,
} from './worker-protocol.js';
import type { BlueprintImportSessionState } from './blueprint-import-session.js';

export interface BlueprintImportPanelView {
  readonly state: BlueprintImportSessionState['state'];
  readonly status: string;
  readonly generatedSource: string;
  readonly diagnostics: readonly string[];
  readonly convertDisabled: boolean;
  readonly applyDisabled: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function locationText(value: unknown): string | undefined {
  const location = record(value);
  const start = record(location?.start);
  const end = record(location?.end);
  if (
    typeof location?.path !== 'string' ||
    typeof start?.line !== 'number' ||
    typeof start.column !== 'number'
  ) {
    return undefined;
  }
  const startText = `${start.line}:${start.column}`;
  const endText =
    typeof end?.line === 'number' && typeof end.column === 'number'
      ? `-${end.line}:${end.column}`
      : '';
  return `Generated ${location.path}:${startText}${endText}`;
}

function formatDiagnostic(value: CompilerWorkerBlueprintImportDiagnostic): string {
  const diagnostic = record(value) ?? {};
  const category = typeof diagnostic.category === 'string' ? diagnostic.category : undefined;
  const path = typeof diagnostic.path === 'string' ? diagnostic.path : undefined;
  const severity = typeof diagnostic.severity === 'string' ? diagnostic.severity : undefined;
  const code = typeof diagnostic.code === 'string' ? diagnostic.code : undefined;
  const message =
    typeof diagnostic.message === 'string' ? diagnostic.message : 'Import diagnostic.';
  const coverage =
    category?.includes('coverage') === true || category?.startsWith('unsupported-') === true;
  const retainedOnly = category === undefined && severity === undefined && path !== undefined;
  const label =
    severity === 'warning'
      ? 'Warning'
      : coverage
        ? 'Coverage'
        : retainedOnly
          ? 'Retained-only metadata'
          : undefined;
  return [
    label,
    label === undefined ? category : undefined,
    code,
    path === undefined ? undefined : `Native ${path}`,
    locationText(diagnostic.generatedLocation),
    message,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
}

function resultDiagnostics(result: CompilerWorkerBlueprintImportResult): string[] {
  const diagnostics = result.diagnostics.map(formatDiagnostic);
  if (result.state === 'blocked' && result.error !== undefined) {
    const error = result.error;
    const alreadyShown = result.diagnostics.some((value) => {
      const diagnostic = record(value) ?? {};
      return (
        diagnostic.code === error.code &&
        diagnostic.message === error.message &&
        diagnostic.path === error.path
      );
    });
    if (!alreadyShown) {
      diagnostics.unshift(
        [error.code, error.path === undefined ? undefined : `Native ${error.path}`, error.message]
          .filter((part): part is string => part !== undefined)
          .join(' · '),
      );
    }
  }
  return diagnostics;
}

export function selectBlueprintImportPanel(
  state: BlueprintImportSessionState,
  convertAvailable: boolean,
  applyAvailable: boolean,
  convertUnavailableMessage = 'Select a validated prototype profile and wait for the compiler Worker.',
  profileWarnings: readonly string[] = [],
): BlueprintImportPanelView {
  let status: string;
  let generatedSource = '';
  let diagnostics: readonly string[] = [];
  if (state.state === 'pending') status = 'Converting blueprint JSON…';
  else if (state.state === 'verified' && applyAvailable) {
    status = `Verified source · ${state.result.verification.entityCount} entities · ${state.result.verification.networkCount} networks`;
    generatedSource = state.result.source.text;
    diagnostics = [...resultDiagnostics(state.result), ...profileWarnings];
  } else if (state.state === 'verified') {
    status =
      'Preview no longer matches the current source, profile, input, or Worker; convert again.';
  } else if (state.state === 'blocked') {
    status = 'Import blocked · no generated source is available';
    diagnostics = [...resultDiagnostics(state.result), ...profileWarnings];
  } else if (state.state === 'failed') {
    status = `Conversion failed · ${state.message}`;
  } else if (state.state === 'stale') status = state.message;
  else if (state.state === 'consumed')
    status = 'Source applied · compiling through the normal source path.';
  else
    status = convertAvailable
      ? 'Paste one uncompressed blueprint JSON document.'
      : convertUnavailableMessage;

  return {
    state: state.state === 'verified' && !applyAvailable ? 'stale' : state.state,
    status,
    generatedSource,
    diagnostics,
    convertDisabled: !convertAvailable,
    applyDisabled: !applyAvailable,
  };
}

export interface BlueprintImportPanelElements {
  readonly convert: HTMLButtonElement;
  readonly apply: HTMLButtonElement;
  readonly status: HTMLOutputElement;
  readonly preview: HTMLPreElement;
  readonly diagnostics: HTMLUListElement;
}

/** DOM output is text-only; generated source and diagnostics are always inert. */
export function renderBlueprintImportPanel(
  elements: BlueprintImportPanelElements,
  view: BlueprintImportPanelView,
): void {
  elements.convert.disabled = view.convertDisabled;
  elements.apply.disabled = view.applyDisabled;
  elements.status.textContent = view.status;
  elements.status.dataset.state =
    view.state === 'verified' || view.state === 'consumed'
      ? 'valid'
      : view.state === 'blocked' || view.state === 'failed'
        ? 'invalid'
        : view.state === 'stale'
          ? 'warning'
          : 'pending';
  elements.preview.textContent = view.generatedSource;
  elements.preview.hidden = view.generatedSource.length === 0;
  elements.diagnostics.replaceChildren(
    ...view.diagnostics.map((message) => {
      const item = elements.diagnostics.ownerDocument.createElement('li');
      item.textContent = message;
      return item;
    }),
  );
}
