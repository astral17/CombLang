import { describe, expect, test } from 'vitest';

import { validateDirectPlanEnvelope } from './direct-plan-validation.js';

const span = { fileId: 'schema.factorio.ts', start: 0, end: 1 };

describe('direct plan envelope validation', () => {
  test('accepts a minimal versioned transport without allocating a circuit', () => {
    const plan = {
      format: 'comblang-direct-plan',
      version: 2,
      networks: [{ name: 'input', source: span, instancePath: [] }],
      producers: [],
    };

    const result = validateDirectPlanEnvelope(plan);

    expect(result.diagnostics).toEqual([]);
    expect(result.value?.plan).toBe(plan);
    expect(result.value?.declarations.get('input')).toBe(plan.networks[0]);
  });

  test.each([
    {
      name: 'missing Network collection',
      plan: { format: 'comblang-direct-plan', version: 2, producers: [] },
      code: 'RT1001',
      message: 'Invalid direct elaboration plan envelope.',
    },
    {
      name: 'duplicate Network name',
      plan: {
        format: 'comblang-direct-plan',
        version: 2,
        networks: [
          { name: 'input', source: span, instancePath: [] },
          { name: 'input', source: span, instancePath: [] },
        ],
        producers: [],
      },
      code: 'RT1002',
      message: 'Duplicate Network in direct plan: input.',
    },
    {
      name: 'non-array transfer collection',
      plan: {
        format: 'comblang-direct-plan',
        version: 2,
        networks: [],
        producers: [],
        networkTransfers: {},
      },
      code: 'RT1001',
      message: 'Invalid networkTransfers collection in direct plan.',
    },
  ])('rejects $name as RT100x before execution', ({ plan, code, message }) => {
    expect(validateDirectPlanEnvelope(plan).diagnostics).toMatchObject([
      { code, severity: 'error', message },
    ]);
  });

  test.each([
    {
      name: 'null Producer',
      mutate: (plan: Record<string, unknown>) => (plan.producers = [null]),
      path: '$.producers[0]',
    },
    {
      name: 'unknown Producer tag',
      mutate: (plan: Record<string, unknown>) =>
        (plan.producers = [{ kind: 'lamp', source: span, instancePath: [], destinations: [] }]),
      path: '$.producers[0].kind',
    },
    {
      name: 'malformed pair',
      mutate: (plan: Record<string, unknown>) =>
        (plan.networkPairs = [{ networks: ['input'], provenance: span, instancePath: [] }]),
      path: '$.networkPairs[0]',
    },
    {
      name: 'unknown attachment Network',
      mutate: (plan: Record<string, unknown>) =>
        (plan.producers = [
          {
            kind: 'constant',
            outputs: [],
            source: span,
            instancePath: [],
            destinations: [{ network: 'missing', source: span, instancePath: [] }],
          },
        ]),
      path: '$.producers[0].destinations[0]',
    },
  ])('rejects $name with its payload path', ({ mutate, path }) => {
    const plan: Record<string, unknown> = {
      format: 'comblang-direct-plan',
      version: 2,
      networks: [{ name: 'input', source: span, instancePath: [] }],
      producers: [],
    };
    mutate(plan);
    expect(validateDirectPlanEnvelope(plan).diagnostics[0]).toMatchObject({
      code: expect.stringMatching(/^RT100[14]$/),
      message: expect.stringContaining(path),
    });
  });

  test('accepts a complete arithmetic producer with single and pair inputs', () => {
    const plan = {
      format: 'comblang-direct-plan',
      version: 2,
      networks: [
        { name: 'a', source: span, instancePath: [] },
        { name: 'b', source: span, instancePath: [] },
        { name: 'out', source: span, instancePath: [] },
      ],
      producers: [
        {
          kind: 'arithmetic',
          left: {
            kind: 'signal',
            signal: { type: 'virtual', name: 'signal-A' },
            refKind: 'single',
            network: 'a',
          },
          operation: 'add',
          right: { kind: 'each', refKind: 'pair', networks: ['a', 'b'] },
          output: { kind: 'each' },
          destinations: [{ network: 'out', source: span, instancePath: [] }],
          source: span,
          instancePath: [],
        },
      ],
    };

    expect(validateDirectPlanEnvelope(plan).diagnostics).toEqual([]);
  });

  test.each([
    {
      name: 'unknown arithmetic operation',
      mutate: (producer: Record<string, unknown>) => (producer.operation = 'rotate'),
      path: '$.producers[0].operation',
      code: 'RT1001',
    },
    {
      name: 'fractional circuit constant',
      mutate: (producer: Record<string, unknown>) =>
        (producer.left = { kind: 'constant', value: 1.5 }),
      path: '$.producers[0].left.value',
      code: 'RT1001',
    },
    {
      name: 'malformed SignalID',
      mutate: (producer: Record<string, unknown>) =>
        (producer.left = {
          kind: 'signal',
          signal: { type: 'unknown', name: 'signal-A' },
          refKind: 'single',
          network: 'input',
        }),
      path: '$.producers[0].left.signal',
      code: 'RT1001',
    },
    {
      name: 'unknown input Network',
      mutate: (producer: Record<string, unknown>) =>
        (producer.left = { kind: 'each', refKind: 'single', network: 'missing' }),
      path: '$.producers[0].left',
      code: 'RT1003',
    },
    {
      name: 'collapsed input pair',
      mutate: (producer: Record<string, unknown>) =>
        (producer.right = {
          kind: 'each',
          refKind: 'pair',
          networks: ['input', 'input'],
        }),
      path: '$.producers[0].right',
      code: 'RT1003',
    },
    {
      name: 'malformed arithmetic output',
      mutate: (producer: Record<string, unknown>) =>
        (producer.output = { kind: 'signal', signal: { type: 'virtual', name: '' } }),
      path: '$.producers[0].output',
      code: 'RT1001',
    },
  ])('rejects $name before replay', ({ mutate, path, code }) => {
    const producer: Record<string, unknown> = {
      kind: 'arithmetic',
      left: { kind: 'each', refKind: 'single', network: 'input' },
      operation: 'add',
      right: { kind: 'constant', value: 1 },
      output: { kind: 'each' },
      destinations: [{ network: 'output', source: span, instancePath: [] }],
      source: span,
      instancePath: [],
    };
    mutate(producer);
    const plan = {
      format: 'comblang-direct-plan',
      version: 2,
      networks: [
        { name: 'input', source: span, instancePath: [] },
        { name: 'output', source: span, instancePath: [] },
      ],
      producers: [producer],
    };

    expect(validateDirectPlanEnvelope(plan).diagnostics).toMatchObject([
      { code, message: expect.stringContaining(path) },
    ]);
  });
});
