import { sourceFileId, type Diagnostic } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { chooseSourceEditorKind, toEditorDiagnostics } from './code-editor.js';

describe('CodeMirror diagnostic adapter', () => {
  test('uses the native editor automatically only for narrow coarse-pointer devices', () => {
    expect(chooseSourceEditorKind('auto', true)).toBe('native');
    expect(chooseSourceEditorKind('auto', false)).toBe('codemirror');
    expect(chooseSourceEditorKind('codemirror', true)).toBe('codemirror');
    expect(chooseSourceEditorKind('native', false)).toBe('native');
  });

  test('preserves source ranges and diagnostic identity', () => {
    const diagnostics: readonly Diagnostic[] = [
      {
        code: 'CL1001',
        severity: 'error',
        message: 'Unsupported source construct.',
        span: { fileId: sourceFileId('main.factorio.ts'), start: 4, end: 12 },
      },
    ];

    expect(toEditorDiagnostics(20, diagnostics)).toEqual([
      {
        from: 4,
        to: 12,
        severity: 'error',
        message: 'CL1001: Unsupported source construct.',
      },
    ]);
  });

  test('anchors spanless diagnostics and clamps stale ranges', () => {
    const diagnostics: readonly Diagnostic[] = [
      { code: 'CL2001', severity: 'warning', message: 'Unused producer.' },
      {
        code: 'CL1002',
        severity: 'error',
        message: 'Stale range.',
        span: { fileId: sourceFileId('main.factorio.ts'), start: 40, end: 60 },
      },
    ];

    expect(toEditorDiagnostics(10, diagnostics)).toMatchObject([
      { from: 0, to: 0 },
      { from: 10, to: 10 },
    ]);
  });

  test('maps note and hint to editor info while retaining their semantic level in text', () => {
    expect(
      toEditorDiagnostics(30, [
        {
          code: 'CL2003',
          severity: 'note',
          message: 'Generated copy.',
          ruleId: 'future.generated-copy',
          category: 'native-semantics',
          occurrences: 2,
        },
        { code: 'CL2004', severity: 'hint', message: 'Prefer explicit intent.' },
      ]),
    ).toEqual([
      {
        from: 0,
        to: 0,
        severity: 'info',
        message:
          'CL2003 [note] future.generated-copy/native-semantics (2 occurrences): Generated copy.',
      },
      {
        from: 0,
        to: 0,
        severity: 'info',
        message: 'CL2004 [hint]: Prefer explicit intent.',
      },
    ]);
  });
});
