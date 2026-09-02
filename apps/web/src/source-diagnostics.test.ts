import { ElaborationExecutionError, RuntimeDiagnosticError } from '@comblang/runtime';
import { sourceFileId, sourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { formatSourceDiagnostic, sourcePreviewDiagnostic } from './source-diagnostics.js';

describe('source preview diagnostics', () => {
  const source = 'const input = new Network();\r\noutput.take(input);';
  const span = sourceSpan(
    sourceFileId('main.factorio.ts'),
    source.indexOf('output'),
    source.length,
  );
  const related = [{ message: 'Declared here.', span: sourceSpan(span.fileId, 0, 27) }];

  test('retains runtime codes, source positions and related spans', () => {
    const diagnostic = {
      code: 'RT2012',
      severity: 'error' as const,
      message: 'Cannot use moved Network: input.',
      span,
      related,
    };
    const result = sourcePreviewDiagnostic(new RuntimeDiagnosticError(diagnostic));
    expect(result).toBe(diagnostic);
    expect(formatSourceDiagnostic(result, source)).toBe(
      'RT2012 error at 2:1: Cannot use moved Network: input.',
    );
  });

  test('retains executed-source diagnostics', () => {
    const result = sourcePreviewDiagnostic(
      new ElaborationExecutionError('Invalid argument.', span, 'RT2015', related),
    );
    expect(result).toEqual({
      code: 'RT2015',
      severity: 'error',
      message: 'Invalid argument.',
      span,
      related,
    });
    expect(formatSourceDiagnostic(result, source)).toContain('RT2015 error at 2:1');
  });

  test('labels unstructured preview errors without inventing a source line', () => {
    const result = sourcePreviewDiagnostic(new Error('Rendering failed.'));
    expect(result.span).toBeUndefined();
    expect(formatSourceDiagnostic(result, source)).toBe('WEB1001 error: Rendering failed.');
  });
});
