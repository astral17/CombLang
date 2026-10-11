import { classifyBlueprintDocument } from '@comblang/blueprint/classification';
import { parseLosslessJson } from '@comblang/blueprint/document';
import { analyzeBlueprintImport } from '@comblang/blueprint/import-analysis';
import type { Diagnostic } from '@comblang/shared';
import { createTrustedEntityReplayContext } from './entity-replay-context.js';
import type { DirectElaborationPlan } from './direct-plan-schema.js';
import type { ResolvedCircuit } from './resolved-circuit.js';
import { resolvedCircuitPlanFingerprint } from './resolved-circuit-public.js';
import { generateCanonicalBlueprintSource } from './blueprint-import-source-assembly.js';
import { verifyCanonicalBlueprintSourceRoundTrip } from './blueprint-import-source-verification.js';

import { describe, expect, test } from 'vitest';

const context = createTrustedEntityReplayContext({
  database: { schemaVersion: 1, identity: 'empty-source-verification' },
  source: 'synthetic',
  evidenceIdentity: 'empty-source-verification-evidence',
  policyIdentity: 'empty-source-verification-policy',
  profiles: [],
});

function emptyFixture() {
  const analysis = analyzeBlueprintImport(
    classifyBlueprintDocument(parseLosslessJson('{"blueprint":{"entities":[],"wires":[]}}')),
  );
  const selections = [] as const;
  const assembled = generateCanonicalBlueprintSource(analysis, selections, context, {
    path: 'empty-round-trip.factorio.ts',
  });
  if (assembled.state !== 'complete') throw new Error('Expected empty source assembly.');
  const plan: DirectElaborationPlan = {
    format: 'comblang-direct-plan',
    networks: [],
    producers: [],
    entities: [],
  };
  const resolvedCircuit: ResolvedCircuit = {
    format: 'comblang-resolved-circuit',
    planFingerprint: resolvedCircuitPlanFingerprint(plan),
    ir: { format: 'comblang-ncir', networks: [], producers: [], entities: [] },
  };
  const compiled = {
    source: assembled.source,
    plan,
    resolvedCircuit,
    diagnostics: [] as Diagnostic[],
  };
  return { analysis, assembled, compiled, selections, context };
}

describe('canonical blueprint source round-trip verifier', () => {
  test('snapshots nested related diagnostic spans without freezing caller-owned data', () => {
    const fixture = emptyFixture();
    const warningSpan = {
      fileId: fixture.assembled.source.path as NonNullable<Diagnostic['span']>['fileId'],
      start: 0,
      end: 1,
    };
    const warning: Diagnostic = {
      code: 'TEST_WARNING',
      severity: 'warning',
      message: 'kept',
      related: [{ message: 'related source', span: warningSpan }],
    };
    const result = verifyCanonicalBlueprintSourceRoundTrip(
      fixture.assembled,
      { ...fixture.compiled, diagnostics: [warning] },
      fixture.selections,
      fixture.context,
    );
    const copied = result.diagnostics.find(
      (diagnostic) => 'code' in diagnostic && diagnostic.code === warning.code,
    ) as Diagnostic;
    warningSpan.start = 1;
    expect(copied.related?.[0]?.span.start).toBe(0);
    expect(copied.related?.[0]?.span).not.toBe(warningSpan);
    expect(Object.isFrozen(copied.related?.[0]?.span)).toBe(true);
    expect(Object.isFrozen(warningSpan)).toBe(false);
    expect(Object.isFrozen(warning.related?.[0])).toBe(false);
    expect(Object.isFrozen(warning.related)).toBe(false);

    const errorSpan = {
      fileId: fixture.assembled.source.path as NonNullable<Diagnostic['span']>['fileId'],
      start: 2,
      end: 3,
    };
    const error: Diagnostic = {
      code: 'TEST_ERROR',
      severity: 'error',
      message: 'blocks',
      related: [{ message: 'related error source', span: errorSpan }],
    };
    const blocked = verifyCanonicalBlueprintSourceRoundTrip(
      fixture.assembled,
      { ...fixture.compiled, diagnostics: [error] },
      fixture.selections,
      fixture.context,
    );
    const copiedError = blocked.diagnostics.find(
      (diagnostic) => 'code' in diagnostic && diagnostic.code === error.code,
    ) as Diagnostic;
    errorSpan.start = 3;
    expect(blocked.state).toBe('blocked');
    expect(copiedError.related?.[0]?.span.start).toBe(2);
    expect(copiedError.related?.[0]?.span).not.toBe(errorSpan);
    expect(Object.isFrozen(copiedError.related?.[0]?.span)).toBe(true);
    expect(Object.isFrozen(errorSpan)).toBe(false);
    expect(Object.isFrozen(error.related?.[0])).toBe(false);
    expect(Object.isFrozen(error.related)).toBe(false);
  });

  test('accepts an empty exact source snapshot and returns frozen empty associations', () => {
    const fixture = emptyFixture();
    const result = verifyCanonicalBlueprintSourceRoundTrip(
      fixture.assembled,
      fixture.compiled,
      fixture.selections,
      fixture.context,
    );

    expect(result).toMatchObject({
      state: 'verified',
      entities: [],
      networks: [],
      diagnostics: [],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entities)).toBe(true);
    expect(Object.isFrozen(result.networks)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
  });

  test('blocks changed source snapshots, missing artifacts, and stale Plan fingerprints atomically', () => {
    const fixture = emptyFixture();
    const changedPath = verifyCanonicalBlueprintSourceRoundTrip(
      fixture.assembled,
      { ...fixture.compiled, source: { ...fixture.compiled.source, path: 'other.ts' } },
      fixture.selections,
      fixture.context,
    );
    expect(changedPath.state).toBe('blocked');
    expect(changedPath.entities).toEqual([]);
    expect(changedPath.networks).toEqual([]);
    expect(changedPath.diagnostics).toContainEqual(
      expect.objectContaining({ category: 'source-verification-mismatch', path: '$.source.path' }),
    );

    const changedText = verifyCanonicalBlueprintSourceRoundTrip(
      fixture.assembled,
      {
        ...fixture.compiled,
        source: {
          ...fixture.compiled.source,
          text: `${fixture.compiled.source.text}\\n// changed`,
        },
      },
      fixture.selections,
      fixture.context,
    );
    expect(changedText.state).toBe('blocked');
    expect(changedText.entities).toEqual([]);
    expect(changedText.networks).toEqual([]);
    expect(changedText.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'source-verification-mismatch',
        path: '$.source.text',
      }),
    );

    const missingArtifacts = verifyCanonicalBlueprintSourceRoundTrip(
      fixture.assembled,
      { source: fixture.compiled.source, diagnostics: [] },
      fixture.selections,
      fixture.context,
    );
    expect(missingArtifacts.state).toBe('blocked');
    expect(missingArtifacts.entities).toEqual([]);
    expect(missingArtifacts.networks).toEqual([]);
    expect(missingArtifacts.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'source-verification-mismatch', path: '$.plan' }),
        expect.objectContaining({
          category: 'source-verification-mismatch',
          path: '$.resolvedCircuit',
        }),
      ]),
    );

    const stalePair = verifyCanonicalBlueprintSourceRoundTrip(
      fixture.assembled,
      {
        ...fixture.compiled,
        resolvedCircuit: {
          ...fixture.compiled.resolvedCircuit,
          planFingerprint: 'plan-fnv1a64:0000000000000000',
        },
      },
      fixture.selections,
      fixture.context,
    );
    expect(stalePair.state).toBe('blocked');
    expect(stalePair.entities).toEqual([]);
    expect(stalePair.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'source-verification-mismatch',
        path: '$.resolvedCircuit.planFingerprint',
      }),
    );
  });

  test('retains compiler warnings, blocks compiler errors, and preserves blocked assembly diagnostics', () => {
    const fixture = emptyFixture();
    const warning: Diagnostic = { code: 'TEST_WARNING', severity: 'warning', message: 'kept' };
    const withWarning = verifyCanonicalBlueprintSourceRoundTrip(
      fixture.assembled,
      { ...fixture.compiled, diagnostics: [warning] },
      fixture.selections,
      fixture.context,
    );
    expect(withWarning.state).toBe('verified');
    expect(withWarning.diagnostics).toContainEqual(warning);

    const error: Diagnostic = { code: 'TEST_ERROR', severity: 'error', message: 'blocks' };
    const withError = verifyCanonicalBlueprintSourceRoundTrip(
      fixture.assembled,
      { ...fixture.compiled, diagnostics: [warning, error] },
      fixture.selections,
      fixture.context,
    );
    expect(withError.state).toBe('blocked');
    expect(withError.entities).toEqual([]);
    expect(withError.networks).toEqual([]);
    expect(withError.diagnostics).toEqual([warning, error]);

    const blockedAssembly = generateCanonicalBlueprintSource(
      analyzeBlueprintImport(
        classifyBlueprintDocument(
          parseLosslessJson('{"blueprint":{"entities":[],"wires":[],"unexpected":true}}'),
        ),
      ),
      [],
      context,
      { path: fixture.assembled.source.path },
    );
    const blocked = verifyCanonicalBlueprintSourceRoundTrip(
      blockedAssembly,
      fixture.compiled,
      fixture.selections,
      fixture.context,
    );
    expect(blocked.state).toBe('blocked');
    expect(blocked.entities).toEqual([]);
    expect(blocked.diagnostics).toContainEqual(
      expect.objectContaining({ category: 'unsupported-source-field' }),
    );
  });
});
