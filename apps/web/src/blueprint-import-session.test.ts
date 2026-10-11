import { describe, expect, test } from 'vitest';
import type { CompilerWorkerImportedResponse } from './worker-protocol.js';
import {
  BlueprintImportSession,
  type BlueprintImportSnapshot,
} from './blueprint-import-session.js';

const initial: BlueprintImportSnapshot = {
  requestRevision: 8,
  workerId: 3,
  sourceRevision: 5,
  profileSelectionRevision: 2,
  profileIdentity: 'profile-a',
  inputEditGeneration: 4,
};

function verifiedResponse(revision = initial.requestRevision): CompilerWorkerImportedResponse {
  return {
    kind: 'blueprint-imported',
    revision,
    result: {
      state: 'verified',
      source: { path: 'main.factorio.ts', text: 'const output = new Network();\n' },
      correspondence: { networks: [], entities: [] },
      diagnostics: [],
      verification: { state: 'verified', entityCount: 0, networkCount: 1 },
    },
  };
}

describe('blueprint import session apply permission', () => {
  test.each([
    ['source edit', { sourceRevision: initial.sourceRevision + 1 }],
    ['profile selection', { profileSelectionRevision: initial.profileSelectionRevision + 1 }],
    ['profile identity', { profileIdentity: 'profile-b' }],
    ['input edit', { inputEditGeneration: initial.inputEditGeneration + 1 }],
    ['Worker replacement', { workerId: initial.workerId + 1 }],
  ] as const)('revokes permission after %s', (_name, change) => {
    const session = new BlueprintImportSession();
    session.begin(initial);
    expect(session.complete(initial, verifiedResponse(), initial)).toBe(true);
    expect(session.canApply({ ...initial, ...change })).toBe(false);
  });

  test('replacing JSON input with exchange text revokes preview permission through the input generation', () => {
    const session = new BlueprintImportSession();
    const jsonInput = {
      ...initial,
      inputEditGeneration: initial.inputEditGeneration + 1,
    };
    session.begin(jsonInput);
    expect(
      session.complete(jsonInput, verifiedResponse(jsonInput.requestRevision), jsonInput),
    ).toBe(true);

    const exchangeInput = {
      ...jsonInput,
      inputEditGeneration: jsonInput.inputEditGeneration + 1,
    };
    expect(session.canApply(exchangeInput)).toBe(false);
    expect(session.consume(exchangeInput)).toBeUndefined();
  });

  test('an older reply cannot replace a newer conversion', () => {
    const session = new BlueprintImportSession();
    const newer = {
      ...initial,
      requestRevision: initial.requestRevision + 1,
      inputEditGeneration: 5,
    };
    session.begin(initial);
    session.begin(newer);
    expect(session.complete(initial, verifiedResponse(), initial)).toBe(false);
    expect(session.state).toMatchObject({ state: 'pending', snapshot: newer });
    expect(session.complete(newer, verifiedResponse(newer.requestRevision), newer)).toBe(true);
  });

  test('blocked responses never expose Apply permission', () => {
    const session = new BlueprintImportSession();
    session.begin(initial);
    const response: CompilerWorkerImportedResponse = {
      kind: 'blueprint-imported',
      revision: initial.requestRevision,
      result: {
        state: 'blocked',
        diagnostics: [
          { category: 'unsupported-root', path: '$.blueprint_book', message: 'Unsupported.' },
        ],
      },
    };
    expect(session.complete(initial, response, initial)).toBe(true);
    expect(session.state.state).toBe('blocked');
    expect(session.canApply(initial)).toBe(false);
    expect(session.consume(initial)).toBeUndefined();
  });

  test('cancel leaves the preview available for a retry, while successful Apply consumes once', () => {
    const session = new BlueprintImportSession();
    session.begin(initial);
    expect(session.complete(initial, verifiedResponse(), initial)).toBe(true);
    // A cancelled confirmation does not call consume; the preview remains usable.
    expect(session.canApply(initial)).toBe(true);
    const retry = { ...initial, requestRevision: 9, inputEditGeneration: 5 };
    session.begin(retry);
    expect(session.complete(retry, verifiedResponse(retry.requestRevision), retry)).toBe(true);
    expect(session.consume(retry)?.source.text).toContain('new Network');
    expect(session.consume(retry)).toBeUndefined();
  });

  test('confirmation-time invalidation prevents consumption', () => {
    const session = new BlueprintImportSession();
    session.begin(initial);
    expect(session.complete(initial, verifiedResponse(), initial)).toBe(true);
    session.invalidate('Input changed while confirmation was open.');
    expect(session.canApply(initial)).toBe(false);
    expect(session.consume(initial)).toBeUndefined();
  });

  test('ignores mismatched replies and does not retain the Worker environment report', () => {
    const session = new BlueprintImportSession();
    session.begin(initial);
    expect(session.complete(initial, verifiedResponse(initial.requestRevision + 1), initial)).toBe(
      false,
    );
    const response = {
      ...verifiedResponse(),
      prototypeEnvironment: { identity: 'not-session-state' },
    } as CompilerWorkerImportedResponse;
    expect(session.complete(initial, response, initial)).toBe(true);
    expect(JSON.stringify(session.state)).not.toContain('not-session-state');
  });
});
