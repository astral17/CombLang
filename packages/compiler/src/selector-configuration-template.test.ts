import { constantConfigurationLimits, signal } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { createBlueprintParameterSession } from './blueprint-parameters.js';
import { createBlueprintNumericExpression } from './blueprint-numeric-expression.js';
import {
  createSelectorConfigurationTemplate,
  inspectSelectorConfigurationTemplate,
} from './selector-configuration-template.js';

const red = 'network:red' as NetworkId;
const green = 'network:green' as NetworkId;

describe('symbolic Selector configuration templates', () => {
  test('accepts only registered same-session numeric expressions in select indices', () => {
    const session = createBlueprintParameterSession();
    const foreign = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 5 });
    const foreignExpression = createBlueprintNumericExpression(foreign, {
      kind: 'literal',
      value: 2,
    });
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: amount },
      right: { kind: 'literal', value: 1 },
    });
    const base = {
      operation: 'select',
      input: { refKind: 'single', network: red },
      selectMax: false,
    } as const;

    const template = createSelectorConfigurationTemplate(session, { ...base, index: expression });
    expect(template).toMatchObject({ operation: 'select', index: expression });
    expect(inspectSelectorConfigurationTemplate(template, '$.template').usedParameters).toEqual([
      amount,
    ]);
    expect(() =>
      createSelectorConfigurationTemplate(session, { ...base, index: foreignExpression }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.index' }));
    expect(() =>
      createSelectorConfigurationTemplate(session, {
        ...base,
        index: { kind: 'binary', operator: 'add', left: 1, right: 2 },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.index.kind' }));
    expect(() =>
      createSelectorConfigurationTemplate(session, {
        operation: 'count',
        input: { refKind: 'single', network: red },
        output: expression,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', path: expect.stringMatching(/^\$\.output/) }),
    );
    expect(() =>
      createSelectorConfigurationTemplate(session, {
        ...base,
        selectMax: expression,
        index: 0,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', path: expect.stringMatching(/^\$\.selectMax/) }),
    );
  });

  test('budgets shared expression DAGs without expanding repeated subgraphs', () => {
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
    const base = {
      operation: 'select',
      input: { refKind: 'single', network: red },
      selectMax: false,
    } as const;
    const template = createSelectorConfigurationTemplate(session, { ...base, index: shared });
    expect(template).toMatchObject({ operation: 'select', index: shared });

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
      createSelectorConfigurationTemplate(session, { ...base, index: wide }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.index',
        message: expect.stringContaining('node limit'),
      }),
    );

    const largeLabel = session.number('x'.repeat(constantConfigurationLimits.maxBytes - 100));
    const largeExpression = createBlueprintNumericExpression(session, {
      kind: 'parameter',
      parameter: largeLabel,
    });
    expect(() =>
      createSelectorConfigurationTemplate(session, { ...base, index: largeExpression }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$',
        message: expect.stringContaining('byte limit'),
      }),
    );
  }, 20_000);

  test('preserves numeric and Signal select variants, count output, and ordered pair refs', () => {
    const session = createBlueprintParameterSession();
    const index = session.number('index', { defaultValue: 0 });
    const target = session.signal('target', {
      defaultValue: signal('item', 'iron-plate', 'rare'),
    });
    const input = { refKind: 'pair', networks: [green, red] };

    const numeric = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input,
      selectMax: true,
      index,
    });
    const signalIndex = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input,
      selectMax: false,
      index: target,
    });
    const count = createSelectorConfigurationTemplate(session, {
      operation: 'count',
      input: { refKind: 'single', network: red },
      output: target,
    });

    expect(numeric).toMatchObject({
      operation: 'select',
      input: { refKind: 'pair', networks: [green, red] },
      selectMax: true,
      index,
    });
    expect(signalIndex).toMatchObject({
      operation: 'select',
      selectMax: false,
      index: target,
    });
    expect(count).toMatchObject({
      operation: 'count',
      input: { refKind: 'single', network: red },
      output: target,
    });
    expect(Object.isFrozen(numeric)).toBe(true);
    expect(Object.isFrozen(numeric.input)).toBe(true);
    if (numeric.input.refKind === 'pair')
      expect(Object.isFrozen(numeric.input.networks)).toBe(true);
    expect(input.networks).toEqual([green, red]);
  });

  test('rejects handles in operation, selectMax and network fields with exact paths', () => {
    const session = createBlueprintParameterSession();
    const number = session.number('number');
    const target = session.signal('target');
    const select = {
      operation: 'select',
      input: { refKind: 'single', network: red },
      selectMax: false,
      index: 1,
    };

    expect(() =>
      createSelectorConfigurationTemplate(session, { ...select, operation: number }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.operation' }));
    expect(() =>
      createSelectorConfigurationTemplate(session, { ...select, selectMax: number }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.selectMax' }));
    expect(() =>
      createSelectorConfigurationTemplate(session, {
        ...select,
        input: { refKind: 'single', network: target },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.input.network' }));
    expect(() =>
      createSelectorConfigurationTemplate(session, {
        ...select,
        input: { refKind: 'pair', networks: [red, number] },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.input.networks[1]' }));
    expect(() =>
      createSelectorConfigurationTemplate(session, {
        operation: 'count',
        input: { refKind: 'single', network: red },
        output: number,
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.output' }));
  });

  test('rejects wrong-kind, foreign and forged handles in index and count slots', () => {
    const session = createBlueprintParameterSession();
    const foreign = createBlueprintParameterSession();
    const number = session.number('number');
    const target = session.signal('target');
    const foreignNumber = foreign.number('foreign');
    const foreignSignal = foreign.signal('foreign-signal');
    const base = {
      operation: 'select',
      input: { refKind: 'single', network: red },
      selectMax: false,
    };

    expect(() =>
      createSelectorConfigurationTemplate(session, {
        ...base,
        index: { kind: 'number', label: 'forged' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.index' }));
    expect(() =>
      createSelectorConfigurationTemplate(session, { ...base, index: foreignNumber }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.index' }));
    expect(() =>
      createSelectorConfigurationTemplate(session, { ...base, index: foreignSignal }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.index' }));
    expect(() =>
      createSelectorConfigurationTemplate(session, {
        operation: 'count',
        input: { refKind: 'single', network: red },
        output: number,
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.output' }));
    expect(() =>
      createSelectorConfigurationTemplate(session, {
        operation: 'count',
        input: { refKind: 'single', network: red },
        output: target,
        extra: number,
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.extra' }));
  });

  test('rejects malformed, cyclic, sparse, accessor-backed, and oversized data', () => {
    const session = createBlueprintParameterSession();
    const cyclic: Record<string, unknown> = {
      operation: 'count',
      output: signal('virtual', 'signal-count'),
    };
    cyclic.input = cyclic;
    expect(() => createSelectorConfigurationTemplate(session, cyclic)).toThrowError(
      expect.objectContaining({ code: 'CP1000' }),
    );

    expect(() =>
      createSelectorConfigurationTemplate(session, {
        operation: 'select',
        input: { refKind: 'pair', networks: new Array(2) },
        selectMax: false,
        index: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.input.networks[0]' }));

    expect(() =>
      createSelectorConfigurationTemplate(session, {
        operation: 'select',
        input: { refKind: 'pair', networks: new Array(5000) },
        selectMax: false,
        index: 0,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', message: expect.stringContaining('node limit') }),
    );

    let calls = 0;
    const input = { refKind: 'single', network: red };
    Object.defineProperty(input, 'network', {
      enumerable: true,
      get() {
        calls += 1;
        return red;
      },
    });
    expect(() =>
      createSelectorConfigurationTemplate(session, {
        operation: 'count',
        input,
        output: signal('virtual', 'signal-count'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.input.network' }));
    expect(calls).toBe(0);

    expect(() =>
      createSelectorConfigurationTemplate(session, {
        operation: 'count',
        input: { refKind: 'single', network: 'n'.repeat(270_000) },
        output: signal('virtual', 'signal-count'),
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', message: expect.stringContaining('byte limit') }),
    );
  });
});
