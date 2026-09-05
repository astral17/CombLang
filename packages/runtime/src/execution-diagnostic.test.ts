import { describe, expect, test } from 'vitest';
import { sourceFileId, sourceSpan } from '@comblang/shared';

import { ElaborationExecutionError, ElaborationOperationLimitError } from './elaboration-errors.js';
import { executionFailureDiagnostic } from './execution-diagnostic.js';

describe('execution failure diagnostics', () => {
  test('preserves a structured execution code, span, and related information', () => {
    const file = sourceFileId('failure.factorio.ts');
    const span = sourceSpan(file, 20, 30);
    const related = [{ message: 'Declared here.', span: sourceSpan(file, 0, 10) }];

    expect(
      executionFailureDiagnostic(
        new ElaborationExecutionError('Cannot attach producer.', span, 'RT2006', related),
      ),
    ).toEqual({
      code: 'RT2006',
      severity: 'error',
      message: 'Cannot attach producer.',
      span,
      related,
    });
  });

  test('maps the DSL-call budget to its stable host diagnostic', () => {
    expect(executionFailureDiagnostic(new ElaborationOperationLimitError(5))).toMatchObject({
      code: 'EX1003',
      severity: 'error',
      message: expect.stringContaining('5'),
    });
  });

  test('keeps unexpected thrown values in the internal execution family', () => {
    expect(executionFailureDiagnostic('failed')).toEqual({
      code: 'EX1001',
      severity: 'error',
      message: 'Elaboration execution failed.',
    });
  });
});
