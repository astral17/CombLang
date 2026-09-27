import { constantConfigurationLimits, signal } from '@comblang/factorio';
import type { NetworkId, SourceFileId, SourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { createBlueprintParameterSession } from './blueprint-parameters.js';
import { createBlueprintNumericExpression } from './blueprint-numeric-expression.js';
import { createArithmeticConfigurationTemplate } from './arithmetic-configuration-template.js';

const source: SourceSpan = {
  fileId: 'arithmetic-template.test.ts' as SourceFileId,
  start: 3,
  end: 14,
};

describe('symbolic Arithmetic configuration templates', () => {
  test('preserves a registered numeric expression in either constant operand slot', () => {
    const session = createBlueprintParameterSession();
    const value = session.number('value', { defaultValue: 3, source });
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'subtract',
      left: { kind: 'literal', value: 20 },
      right: { kind: 'parameter', parameter: value },
    });

    const template = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: expression },
      operation: 'add',
      right: { kind: 'constant', value: expression },
      output: { kind: 'each' },
    });

    expect(template.left).toEqual({ kind: 'constant', value: expression });
    expect(template.right).toEqual({ kind: 'constant', value: expression });
    if (template.left.kind !== 'constant' || template.right.kind !== 'constant') {
      throw new Error('expected two constant operands');
    }
    expect(template.left.value).toBe(expression);
    expect(template.right.value).toBe(expression);
  });

  test('accepts only registered same-session expressions and keeps ordinary objects concrete', () => {
    const session = createBlueprintParameterSession();
    const foreign = createBlueprintParameterSession();
    const foreignExpression = createBlueprintNumericExpression(foreign, {
      kind: 'literal',
      value: 4,
    });
    const base = {
      left: { kind: 'constant', value: 1 },
      operation: 'add',
      right: { kind: 'constant', value: 2 },
      output: { kind: 'each' },
    };

    expect(() =>
      createArithmeticConfigurationTemplate(session, {
        ...base,
        left: { kind: 'constant', value: foreignExpression },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.left.value' }));
    expect(() =>
      createArithmeticConfigurationTemplate(session, {
        ...base,
        left: { kind: 'constant', value: { kind: 'literal', value: 4 } },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.left.value' }));
    expect(() =>
      createArithmeticConfigurationTemplate(session, {
        ...base,
        left: { kind: 'constant', value: { nested: { kind: 'literal', value: 4 } } },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.left.value' }));
  });

  test('budgets expression DAG nodes and bytes without expanding shared subgraphs', () => {
    const session = createBlueprintParameterSession();
    let shared: unknown = createBlueprintNumericExpression(session, {
      kind: 'literal',
      value: 1,
    });
    for (let depth = 0; depth < 20; depth += 1) {
      shared = createBlueprintNumericExpression(session, {
        kind: 'binary',
        operator: 'add',
        left: shared,
        right: shared,
      });
    }
    const sharedTemplate = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: shared },
      operation: 'add',
      right: { kind: 'constant', value: shared },
      output: { kind: 'each' },
    });
    expect(sharedTemplate.left).toMatchObject({ kind: 'constant', value: shared });
    expect(sharedTemplate.right).toMatchObject({ kind: 'constant', value: shared });

    const makeBalanced = (depth: number): unknown =>
      depth === 0
        ? { kind: 'literal', value: 1 }
        : {
            kind: 'binary',
            operator: 'add',
            left: makeBalanced(depth - 1),
            right: makeBalanced(depth - 1),
          };
    const wide = createBlueprintNumericExpression(session, makeBalanced(11));
    expect(() =>
      createArithmeticConfigurationTemplate(session, {
        left: { kind: 'constant', value: wide },
        operation: 'add',
        right: { kind: 'constant', value: 1 },
        output: { kind: 'each' },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.left.value',
        message: expect.stringContaining('node limit'),
      }),
    );

    const largeLabel = session.number('x'.repeat(constantConfigurationLimits.maxBytes - 100));
    const largeExpression = createBlueprintNumericExpression(session, {
      kind: 'parameter',
      parameter: largeLabel,
    });
    expect(() =>
      createArithmeticConfigurationTemplate(session, {
        left: { kind: 'constant', value: largeExpression },
        operation: 'add',
        right: { kind: 'constant', value: 1 },
        output: { kind: 'each' },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$',
        message: expect.stringContaining('byte limit'),
      }),
    );
  }, 20_000);

  test('preserves operand/output distinctions, concrete refs, and nominal slot handles', () => {
    const session = createBlueprintParameterSession();
    const count = session.number('operand', { source });
    const target = session.signal('signal', { source });
    const input = {
      left: { kind: 'constant', value: count },
      operation: 'add',
      right: {
        kind: 'signal',
        signal: target,
        refKind: 'pair',
        networks: ['network:red', 'network:green'],
      },
      output: { kind: 'signal', signal: target },
    };

    const template = createArithmeticConfigurationTemplate(session, input);

    expect(template).toMatchObject({
      left: { kind: 'constant', value: count },
      operation: 'add',
      right: {
        kind: 'signal',
        signal: target,
        refKind: 'pair',
        networks: ['network:red', 'network:green'],
      },
      output: { kind: 'signal', signal: target },
    });
    expect(Object.isFrozen(template)).toBe(true);
    expect(Object.isFrozen(template.right)).toBe(true);
    if (template.right.kind === 'signal' && template.right.refKind === 'pair') {
      expect(Object.isFrozen(template.right.networks)).toBe(true);
    } else {
      throw new Error('expected a pair Signal operand');
    }
    expect(input.right.networks).toEqual(['network:red', 'network:green']);
  });

  test('normalizes concrete numeric operands while keeping each and network references concrete', () => {
    const session = createBlueprintParameterSession();
    const template = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: 2_147_483_649 },
      operation: 'multiply',
      right: { kind: 'each', refKind: 'single', network: 'network:input' as NetworkId },
      output: { kind: 'each' },
    });

    expect(template.left).toEqual({ kind: 'constant', value: -2_147_483_647 });
    expect(template.right).toEqual({
      kind: 'each',
      refKind: 'single',
      network: 'network:input',
    });
    expect(template.output).toEqual({ kind: 'each' });
  });

  test('rejects wrong-kind, foreign and forged handles outside their typed slots', () => {
    const session = createBlueprintParameterSession();
    const foreign = createBlueprintParameterSession();
    const count = session.number('count');
    const target = session.signal('target');
    const foreignSignal = foreign.signal('foreign', { source });

    expect(() =>
      createArithmeticConfigurationTemplate(session, {
        left: { kind: 'constant', value: target },
        operation: 'add',
        right: { kind: 'constant', value: 1 },
        output: { kind: 'each' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.left.value' }));
    expect(() =>
      createArithmeticConfigurationTemplate(session, {
        left: { kind: 'constant', value: count },
        operation: 'add',
        right: {
          kind: 'signal',
          signal: count,
          refKind: 'single',
          network: 'network:input',
        },
        output: { kind: 'each' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.right.signal' }));
    expect(() =>
      createArithmeticConfigurationTemplate(session, {
        left: { kind: 'constant', value: 1 },
        operation: 'add',
        right: {
          kind: 'signal',
          signal: foreignSignal,
          refKind: 'single',
          network: 'network:input',
        },
        output: { kind: 'each' },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.right.signal', span: source }),
    );
    expect(() =>
      createArithmeticConfigurationTemplate(session, {
        left: { kind: 'constant', value: { kind: 'number', label: 'fake' } },
        operation: 'add',
        right: { kind: 'constant', value: 1 },
        output: { kind: 'each' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.left.value' }));
  });

  test('rejects invalid operations, invalid numeric domains, and unknown data fields', () => {
    const session = createBlueprintParameterSession();
    const base = {
      left: { kind: 'constant', value: 1 },
      operation: 'add',
      right: { kind: 'constant', value: 2 },
      output: { kind: 'each' },
    };
    expect(() =>
      createArithmeticConfigurationTemplate(session, { ...base, operation: 'invalid' }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.operation' }));
    expect(() =>
      createArithmeticConfigurationTemplate(session, {
        ...base,
        left: { kind: 'constant', value: 1.5 },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.left.value' }));
    expect(() =>
      createArithmeticConfigurationTemplate(session, { ...base, extra: true }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.extra' }));
    expect(() =>
      createArithmeticConfigurationTemplate(session, {
        ...base,
        right: {
          kind: 'each',
          refKind: 'single',
          network: 'n'.repeat(270_000),
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        message: expect.stringContaining('byte limit'),
      }),
    );
  });

  test('rejects cycles, sparse network pairs, and accessors without evaluation', () => {
    const session = createBlueprintParameterSession();
    const cyclic: Record<string, unknown> = {};
    cyclic.left = cyclic;
    expect(() => createArithmeticConfigurationTemplate(session, cyclic)).toThrowError(
      expect.objectContaining({ code: 'CP1000' }),
    );

    const sparse = new Array(2);
    expect(() =>
      createArithmeticConfigurationTemplate(session, {
        left: { kind: 'constant', value: 1 },
        operation: 'add',
        right: { kind: 'each', refKind: 'pair', networks: sparse },
        output: { kind: 'each' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.right.networks[0]' }));

    let calls = 0;
    const left = { kind: 'constant', value: 1 };
    Object.defineProperty(left, 'value', {
      enumerable: true,
      get() {
        calls += 1;
        return 1;
      },
    });
    expect(() =>
      createArithmeticConfigurationTemplate(session, {
        left,
        operation: 'add',
        right: { kind: 'constant', value: 2 },
        output: { kind: 'each' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.left.value' }));
    expect(calls).toBe(0);
  });
});
