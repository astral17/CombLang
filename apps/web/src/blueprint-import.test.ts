import { describe, expect, test } from 'vitest';
import type { CanonicalBlueprintSourceImportResult } from '@comblang/runtime/blueprint-source-import';
import type { SourceSpan } from '@comblang/shared';

import { projectBlueprintImportResult } from './blueprint-import.js';

describe('Worker blueprint import projection', () => {
  test('projects successful results as cloneable data without host diagnostic context', () => {
    const result = {
      state: 'verified',
      source: { path: 'virtual/ok.factorio.ts', text: 'const output = new Network();\n' },
      correspondence: { networks: [], entities: [] },
      diagnostics: [],
      diagnosticContext: {
        path: 'virtual/ok.factorio.ts',
        text: 'host-only source context',
        fileId: 'worker-file-id',
      },
      verification: { state: 'verified', entityCount: 0, networkCount: 0 },
    } as unknown as CanonicalBlueprintSourceImportResult;

    const projected = projectBlueprintImportResult(result);

    expect(structuredClone(projected)).toEqual(projected);
    expect(projected).not.toHaveProperty('diagnosticContext');
    expect(JSON.stringify(projected)).not.toContain('host-only source context');
    expect(projected).toMatchObject({
      state: 'verified',
      source: { path: 'virtual/ok.factorio.ts' },
      verification: { entityCount: 0, networkCount: 0 },
    });
  });

  test('retains native paths and maps generated UTF-16 spans to one-based locations', () => {
    const fileId = 'worker-generated-file' as SourceSpan['fileId'];
    const nativePath = '$.blueprint.entities[3].control_behavior.arithmetic_conditions';
    const result = {
      state: 'blocked',
      diagnostics: [
        {
          category: 'source-verification-mismatch',
          message: 'The imported value did not round-trip.',
          path: nativePath,
          source: { fileId, start: 5, end: 7 },
        },
      ],
      diagnosticContext: {
        path: 'generated/🚀-blueprint.ts',
        text: '😀x\nz😀q',
        fileId,
      },
    } as unknown as CanonicalBlueprintSourceImportResult;

    const projected = projectBlueprintImportResult(result);

    expect(structuredClone(projected)).toEqual(projected);
    expect(projected).toMatchObject({
      state: 'blocked',
      diagnostics: [
        {
          path: nativePath,
          generatedLocation: {
            path: 'generated/🚀-blueprint.ts',
            start: { line: 2, column: 2 },
            end: { line: 2, column: 4 },
          },
        },
      ],
    });
    expect(projected).not.toHaveProperty('diagnosticContext');
    expect(JSON.stringify(projected)).not.toContain('😀x\nz😀q');
  });
});
