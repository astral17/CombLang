import { signal } from '@comblang/factorio';
import type { NetworkId, SourceFileId, SourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { createBlueprintParameterSession } from './blueprint-parameters.js';
import { createArithmeticConfigurationTemplate } from './arithmetic-configuration-template.js';

const source: SourceSpan = {
  fileId: 'arithmetic-template.test.ts' as SourceFileId,
  start: 3,
  end: 14,
};

describe('symbolic Arithmetic configuration templates', () => {
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
