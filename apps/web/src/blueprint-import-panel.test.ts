import { describe, expect, test } from 'vitest';
import {
  BlueprintImportSession,
  type BlueprintImportSnapshot,
} from './blueprint-import-session.js';
import { selectBlueprintImportPanel } from './blueprint-import-panel.js';
import { blockedBlueprintImportResponse } from './blueprint-import.js';
import type { CompilerWorkerImportedResponse } from './worker-protocol.js';

const snapshot: BlueprintImportSnapshot = {
  requestRevision: 1,
  workerId: 2,
  sourceRevision: 3,
  profileSelectionRevision: 4,
  profileIdentity: 'builtin-profile',
  inputEditGeneration: 5,
};

function sessionFor(response: CompilerWorkerImportedResponse) {
  const session = new BlueprintImportSession();
  session.begin(snapshot);
  session.complete(snapshot, response, snapshot);
  return session;
}

function blockedResponse(
  error: { readonly code: string; readonly message: string; readonly path?: string },
  diagnostics: readonly unknown[],
): CompilerWorkerImportedResponse {
  return {
    kind: 'blueprint-imported',
    revision: snapshot.requestRevision,
    result: { state: 'blocked', error, diagnostics },
  } as unknown as CompilerWorkerImportedResponse;
}

function displayedDiagnostics(response: CompilerWorkerImportedResponse): readonly string[] {
  const session = sessionFor(response);
  return selectBlueprintImportPanel(session.state, true, session.canApply(snapshot)).diagnostics;
}

describe('blueprint import panel view', () => {
  test('preserves the native error path when the Worker diagnostic repeats its message', () => {
    const response = blockedBlueprintImportResponse(
      snapshot.requestRevision,
      'BPI1001',
      'Blueprint entities analysis limit exceeded (10000).',
      '$.blueprint.entities',
    );
    const session = sessionFor(response);
    const view = selectBlueprintImportPanel(session.state, true, session.canApply(snapshot));
    expect(view.diagnostics.join('\n')).toContain('BPI1001');
    expect(view.diagnostics.join('\n')).toContain('Native $.blueprint.entities');
    expect(view.generatedSource).toBe('');
    expect(view.applyDisabled).toBe(true);
  });

  test('deduplicates blocked errors only when their original code, message and path match', () => {
    const message = 'Blueprint import failed.';

    const differentCode = displayedDiagnostics(
      blockedResponse({ code: 'BPI1001', message }, [
        { code: 'BPI1002', severity: 'error', message },
      ]),
    );
    expect(differentCode).toHaveLength(2);
    expect(differentCode.join('\n')).toContain('BPI1001');
    expect(differentCode.join('\n')).toContain('BPI1002');

    const differentPath = displayedDiagnostics(
      blockedResponse({ code: 'BPI1001', message, path: '$.blueprint.entities' }, [
        { code: 'BPI1001', message, path: '$.blueprint.label' },
      ]),
    );
    expect(differentPath).toHaveLength(2);
    expect(differentPath.join('\n')).toContain('Native $.blueprint.entities');
    expect(differentPath.join('\n')).toContain('Native $.blueprint.label');

    const containingMessage = displayedDiagnostics(
      blockedResponse({ code: 'BPI1001', message }, [
        { code: 'BPI1001', message: `Additional context: ${message}` },
      ]),
    );
    expect(containingMessage).toHaveLength(2);
    expect(containingMessage.join('\n')).toContain(`Additional context: ${message}`);

    const noPathError = displayedDiagnostics(
      blockedBlueprintImportResponse(snapshot.requestRevision, 'BPI1001', message),
    );
    expect(noPathError).toHaveLength(1);
    expect(noPathError[0]).toContain('BPI1001');

    const exactWithLocation = displayedDiagnostics(
      blockedResponse({ code: 'BPI1001', message, path: '$.blueprint.entities' }, [
        {
          code: 'BPI1001',
          severity: 'error',
          message,
          path: '$.blueprint.entities',
          generatedLocation: {
            path: 'main.factorio.ts',
            start: { line: 3, column: 5 },
            end: { line: 3, column: 9 },
          },
        },
      ]),
    );
    expect(exactWithLocation).toHaveLength(1);
    expect(exactWithLocation[0]).toContain('Native $.blueprint.entities');
    expect(exactWithLocation[0]).toContain('Generated main.factorio.ts:3:5-3:9');
  });

  test('shows native paths, generated UTF-16 locations and retained-only metadata on verified source', () => {
    const response = {
      kind: 'blueprint-imported',
      revision: snapshot.requestRevision,
      result: {
        state: 'verified',
        source: { path: 'main.factorio.ts', text: 'const output = new Network();\n' },
        correspondence: { networks: [], entities: [] },
        diagnostics: [
          {
            category: 'source-verification-mismatch',
            path: '$.blueprint.entities[0].control_behavior',
            message: 'Field metadata was retained only in the original document.',
            generatedLocation: {
              path: 'main.factorio.ts',
              start: { line: 2, column: 2 },
              end: { line: 2, column: 4 },
            },
          },
          {
            path: '$.blueprint.label',
            message: 'Label was retained only in the original document.',
          },
        ],
        verification: { state: 'verified', entityCount: 1, networkCount: 1 },
      },
    } as unknown as CompilerWorkerImportedResponse;
    const session = sessionFor(response);
    const view = selectBlueprintImportPanel(session.state, true, session.canApply(snapshot));
    expect(view.generatedSource).toContain('new Network');
    expect(view.applyDisabled).toBe(false);
    expect(view.diagnostics.join('\n')).toContain(
      'Native $.blueprint.entities[0].control_behavior',
    );
    expect(view.diagnostics.join('\n')).toContain('Generated main.factorio.ts:2:2-2:4');
    expect(view.diagnostics.join('\n')).toContain(
      'Retained-only metadata · Native $.blueprint.label',
    );
  });

  test('labels coverage-only diagnostics and refuses to show partial source or Apply when blocked', () => {
    const response: CompilerWorkerImportedResponse = {
      kind: 'blueprint-imported',
      revision: snapshot.requestRevision,
      result: {
        state: 'blocked',
        diagnostics: [
          {
            category: 'unsupported-wire-representation',
            path: '$.blueprint.wires[0]',
            message: 'Coverage is incomplete for this wire representation.',
          },
        ],
        error: { code: 'BPD1008', path: '$.blueprint.wires[0]', message: 'Unsupported wire data.' },
      },
    };
    const session = sessionFor(response);
    const view = selectBlueprintImportPanel(session.state, true, session.canApply(snapshot));
    expect(view.state).toBe('blocked');
    expect(view.generatedSource).toBe('');
    expect(view.applyDisabled).toBe(true);
    expect(view.diagnostics.join('\n')).toContain('Coverage · Native $.blueprint.wires[0]');
    expect(view.diagnostics.join('\n')).toContain('BPD1008 · Native $.blueprint.wires[0]');
  });

  test('shows verified warning diagnostics and hides Apply when current revisions differ', () => {
    const response = {
      kind: 'blueprint-imported',
      revision: snapshot.requestRevision,
      result: {
        state: 'verified',
        source: { path: 'main.factorio.ts', text: 'const output = new Network();\n' },
        correspondence: { networks: [], entities: [] },
        diagnostics: [{ code: 'CL2001', severity: 'warning', message: 'A compiler warning.' }],
        verification: { state: 'verified', entityCount: 0, networkCount: 1 },
      },
    } as unknown as CompilerWorkerImportedResponse;
    const session = sessionFor(response);
    const view = selectBlueprintImportPanel(session.state, false, session.canApply(snapshot));
    expect(view.diagnostics).toEqual(['Warning · CL2001 · A compiler warning.']);
    expect(view.convertDisabled).toBe(true);
    expect(view.applyDisabled).toBe(false);
  });

  test('mismatched verified preview is displayed as stale without exposing source', () => {
    const response = {
      kind: 'blueprint-imported',
      revision: snapshot.requestRevision,
      result: {
        state: 'verified',
        source: { path: 'main.factorio.ts', text: 'must not remain visible' },
        correspondence: { networks: [], entities: [] },
        diagnostics: [],
        verification: { state: 'verified', entityCount: 0, networkCount: 1 },
      },
    } as unknown as CompilerWorkerImportedResponse;
    const session = sessionFor(response);
    const view = selectBlueprintImportPanel(
      session.state,
      true,
      session.canApply({ ...snapshot, inputEditGeneration: snapshot.inputEditGeneration + 1 }),
    );
    expect(view.state).toBe('stale');
    expect(view.generatedSource).toBe('');
    expect(view.applyDisabled).toBe(true);
  });

  test('blocked/no-source state never renders generated text', () => {
    const response: CompilerWorkerImportedResponse = {
      kind: 'blueprint-imported',
      revision: snapshot.requestRevision,
      result: { state: 'blocked', diagnostics: [] },
    };
    const session = sessionFor(response);
    const view = selectBlueprintImportPanel(session.state, false, session.canApply(snapshot));
    expect(view.status).toContain('no generated source');
    expect(view.generatedSource).toBe('');
    expect(view.applyDisabled).toBe(true);
  });
});
