import { signal } from '@comblang/factorio';
import type { SourceFileId, SourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { createBlueprintParameterSession } from './blueprint-parameters.js';
import { createDeciderConfigurationTemplate } from './decider-configuration-template.js';

const source: SourceSpan = {
  fileId: 'decider-template.test.ts' as SourceFileId,
  start: 5,
  end: 19,
};

describe('symbolic Decider configuration templates', () => {
  test('preserves nested conditions, typed operand slots, wildcard and ordered network pairs', () => {
    const session = createBlueprintParameterSession();
    const count = session.number('threshold', { source });
    const target = session.signal('target', { source });
    const input = {
      condition: {
        kind: 'and',
        conditions: [
          {
            kind: 'compare',
            left: {
              kind: 'signal',
              signal: target,
              refKind: 'pair',
              networks: ['network:red', 'network:green'],
            },
            comparator: '>=',
            right: { kind: 'constant', value: count },
          },
          {
            kind: 'or',
            conditions: [
              {
                kind: 'compare',
                left: {
                  kind: 'wildcard',
                  value: 'anything',
                  refKind: 'single',
                  network: 'network:green',
                },
                comparator: '!=',
                right: {
                  kind: 'signal',
                  signal: target,
                  refKind: 'pair',
                  networks: ['network:green', 'network:red'],
                },
              },
            ],
          },
        ],
      },
      outputs: [],
    };

    const template = createDeciderConfigurationTemplate(session, input);

    expect(template.condition).toEqual(input.condition);
    expect(template.condition).toMatchObject({
      conditions: [
        {
          left: {
            kind: 'signal',
            signal: target,
            refKind: 'pair',
            networks: ['network:red', 'network:green'],
          },
          right: { kind: 'constant', value: count },
        },
        {
          kind: 'or',
          conditions: [
            {
              left: { kind: 'wildcard', value: 'anything', network: 'network:green' },
              right: {
                kind: 'signal',
                signal: target,
                networks: ['network:green', 'network:red'],
              },
            },
          ],
        },
      ],
    });
    expect(Object.isFrozen(template)).toBe(true);
    expect(Object.isFrozen(template.condition)).toBe(true);
    if (template.condition.kind === 'and') {
      expect(Object.isFrozen(template.condition.conditions)).toBe(true);
      const left =
        template.condition.conditions[0]?.kind === 'compare'
          ? template.condition.conditions[0].left
          : undefined;
      expect(
        left?.kind === 'signal' && left.refKind === 'pair' ? Object.isFrozen(left.networks) : false,
      ).toBe(true);
    }
    expect(input.condition).toEqual(template.condition);
    expect(input.condition).not.toBe(template.condition);
  });

  test('rejects wrong-kind, foreign and forged handles in typed condition slots', () => {
    const session = createBlueprintParameterSession();
    const foreign = createBlueprintParameterSession();
    const count = session.number('count');
    const target = session.signal('target');
    const foreignSignal = foreign.signal('foreign', { source });
    const base = {
      condition: {
        kind: 'compare',
        left: { kind: 'signal', signal: target, refKind: 'single', network: 'network:input' },
        comparator: '>',
        right: { kind: 'constant', value: 1 },
      },
      outputs: [],
    };

    expect(() =>
      createDeciderConfigurationTemplate(session, {
        ...base,
        condition: { ...base.condition, left: { ...base.condition.left, signal: count } },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.condition.left.signal' }));
    expect(() =>
      createDeciderConfigurationTemplate(session, {
        ...base,
        condition: {
          ...base.condition,
          right: { kind: 'constant', value: target },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.condition.right.value' }));
    expect(() =>
      createDeciderConfigurationTemplate(session, {
        ...base,
        condition: { ...base.condition, left: { ...base.condition.left, signal: foreignSignal } },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.condition.left.signal', span: source }),
    );
    expect(() =>
      createDeciderConfigurationTemplate(session, {
        ...base,
        condition: {
          ...base.condition,
          comparator: { kind: 'number', label: 'forged' },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.condition.comparator' }));
    expect(() =>
      createDeciderConfigurationTemplate(session, { ...base, condition: count }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.condition' }));
    expect(() =>
      createDeciderConfigurationTemplate(session, {
        ...base,
        condition: {
          kind: 'compare',
          left: {
            kind: 'signal',
            signal: target,
            refKind: 'pair',
            networks: [count, 'network:green'],
          },
          comparator: '>',
          right: { kind: 'constant', value: 1 },
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.condition.left.networks[0]' }),
    );
  });

  test('rejects malformed, cyclic, sparse and accessor-backed recursive data safely', () => {
    const session = createBlueprintParameterSession();
    const cyclic: Record<string, unknown> = { kind: 'and', conditions: [] };
    (cyclic.conditions as unknown[]).push(cyclic);
    expect(() =>
      createDeciderConfigurationTemplate(session, { condition: cyclic, outputs: [] }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000' }));

    expect(() =>
      createDeciderConfigurationTemplate(session, {
        condition: { kind: 'and', conditions: new Array(1) },
        outputs: [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.condition.conditions[0]' }));

    let calls = 0;
    const compare = {
      kind: 'compare',
      left: { kind: 'wildcard', value: 'each', refKind: 'single', network: 'network:input' },
      comparator: '>',
      right: { kind: 'constant', value: 1 },
    };
    Object.defineProperty(compare, 'comparator', {
      enumerable: true,
      get() {
        calls += 1;
        return '>';
      },
    });
    expect(() =>
      createDeciderConfigurationTemplate(session, { condition: compare, outputs: [] }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.condition.comparator' }));
    expect(calls).toBe(0);

    expect(() =>
      createDeciderConfigurationTemplate(session, {
        condition: { kind: 'unknown', conditions: [] },
        outputs: [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.condition.kind' }));
  });

  test('enforces shared depth and byte budgets for nested conditions and parameter metadata', () => {
    const session = createBlueprintParameterSession();
    let tooDeep: unknown = {
      kind: 'compare',
      left: {
        kind: 'wildcard',
        value: 'each',
        refKind: 'single',
        network: 'network:input',
      },
      comparator: '>',
      right: { kind: 'constant', value: 0 },
    };
    for (let index = 0; index < 36; index += 1) {
      tooDeep = { kind: 'and', conditions: [tooDeep] };
    }
    expect(() =>
      createDeciderConfigurationTemplate(session, { condition: tooDeep, outputs: [] }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', message: expect.stringContaining('depth limit') }),
    );

    const huge = session.number('x'.repeat(270_000));
    expect(() =>
      createDeciderConfigurationTemplate(session, {
        condition: {
          kind: 'compare',
          left: {
            kind: 'wildcard',
            value: 'each',
            refKind: 'single',
            network: 'network:input',
          },
          comparator: '>',
          right: { kind: 'constant', value: huge },
        },
        outputs: [],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', message: expect.stringContaining('byte limit') }),
    );
  });

  test('preserves ordered then/else output modes, wildcard distinctions, and optional input refs', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 0 });
    const target = session.signal('target', { defaultValue: signal('item', 'iron-plate') });
    const repeatedCopy = {
      mode: 'copy',
      signal: { kind: 'signal', signal: target },
      input: { refKind: 'single', network: 'network:red' },
    };
    const template = createDeciderConfigurationTemplate(session, {
      condition: {
        kind: 'compare',
        left: {
          kind: 'wildcard',
          value: 'each',
          refKind: 'single',
          network: 'network:input',
        },
        comparator: '>',
        right: { kind: 'constant', value: 0 },
      },
      outputs: [
        {
          mode: 'constant',
          signal: { kind: 'signal', signal: target },
          value: amount,
          input: { refKind: 'pair', networks: ['network:green', 'network:red'] },
        },
        { mode: 'copy', signal: { kind: 'wildcard', value: 'everything' } },
        {
          mode: 'copy',
          signal: { kind: 'signal', signal: target },
          input: { refKind: 'single', network: 'network:red' },
        },
        repeatedCopy,
      ],
      elseOutputs: [
        { mode: 'constant', signal: { kind: 'wildcard', value: 'anything' }, value: amount },
        { mode: 'copy', signal: { kind: 'signal', signal: target } },
      ],
    });

    expect(template.outputs).toEqual([
      {
        mode: 'constant',
        signal: { kind: 'signal', signal: target },
        value: amount,
        input: { refKind: 'pair', networks: ['network:green', 'network:red'] },
      },
      { mode: 'copy', signal: { kind: 'wildcard', value: 'everything' } },
      {
        mode: 'copy',
        signal: { kind: 'signal', signal: target },
        input: { refKind: 'single', network: 'network:red' },
      },
      {
        mode: 'copy',
        signal: { kind: 'signal', signal: target },
        input: { refKind: 'single', network: 'network:red' },
      },
    ]);
    expect(template.elseOutputs).toEqual([
      { mode: 'constant', signal: { kind: 'wildcard', value: 'anything' }, value: amount },
      { mode: 'copy', signal: { kind: 'signal', signal: target } },
    ]);
    expect(Object.isFrozen(template.outputs)).toBe(true);
    expect(Object.isFrozen(template.outputs[0]?.input)).toBe(true);
    if (template.outputs[0]?.input?.refKind === 'pair') {
      expect(Object.isFrozen(template.outputs[0].input.networks)).toBe(true);
    }
  });

  test('rejects parameter handles in output mode, wildcard, and network-reference slots', () => {
    const session = createBlueprintParameterSession();
    const count = session.number('count');
    const target = session.signal('target');
    const base = {
      condition: {
        kind: 'compare',
        left: { kind: 'wildcard', value: 'each', refKind: 'single', network: 'network:input' },
        comparator: '>',
        right: { kind: 'constant', value: 0 },
      },
      outputs: [{ mode: 'copy', signal: { kind: 'signal', signal: target } }],
    };
    const withOutput = (outputValue: unknown) => ({ ...base, outputs: [outputValue] });

    expect(() =>
      createDeciderConfigurationTemplate(session, withOutput({ ...base.outputs[0], mode: count })),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.outputs[0].mode' }));
    expect(() =>
      createDeciderConfigurationTemplate(
        session,
        withOutput({ mode: 'constant', signal: { kind: 'wildcard', value: count }, value: 1 }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.outputs[0].signal.value' }));
    expect(() =>
      createDeciderConfigurationTemplate(
        session,
        withOutput({
          mode: 'copy',
          signal: { kind: 'signal', signal: target },
          input: { refKind: 'single', network: count },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.outputs[0].input.network' }));
    expect(() =>
      createDeciderConfigurationTemplate(
        session,
        withOutput({ mode: 'copy', signal: { kind: 'signal', signal: count } }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.outputs[0].signal.signal' }));
    expect(() =>
      createDeciderConfigurationTemplate(
        session,
        withOutput({ mode: 'constant', signal: { kind: 'signal', signal: target }, value: target }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.outputs[0].value' }));
    expect(() =>
      createDeciderConfigurationTemplate(session, { ...base, outputs: new Array(1) }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.outputs[0]' }));
  });
});
