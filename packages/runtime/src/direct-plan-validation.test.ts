import { describe, expect, test } from 'vitest';

import { validateDirectPlanEnvelope } from './direct-plan-validation.js';

const span = { fileId: 'schema.factorio.ts', start: 0, end: 1 };

describe('direct plan envelope validation', () => {
  test('accepts exact Constant configuration without inventing legacy outputs', () => {
    const plan = {
      format: 'comblang-direct-plan',
      networks: [{ name: 'output', source: span, instancePath: [] }],
      producers: [
        {
          kind: 'constant',
          configuration: {
            isOn: true,
            sections: [
              {
                active: true,
                multiplier: 1.5,
                filters: [{ signal: { type: 'virtual', name: 'signal-A' }, value: 2 }],
              },
            ],
          },
          destinations: [{ network: 'output', source: span, instancePath: [] }],
          source: span,
          instancePath: [],
        },
      ],
    };

    const result = validateDirectPlanEnvelope(plan);

    expect(result.diagnostics).toEqual([]);
    expect(result.value?.plan.producers[0]).toMatchObject({
      kind: 'constant',
      configuration: {
        sections: [{ multiplier: 1.5, filters: [{ value: 2 }] }],
      },
    });
    expect(result.value?.plan.producers[0]).not.toHaveProperty('outputs');
  });

  test('reads a legacy exact Constant record with an output cache but canonicalizes configuration as authoritative', () => {
    const plan = {
      format: 'comblang-direct-plan',
      networks: [{ name: 'output', source: span, instancePath: [] }],
      producers: [
        {
          kind: 'constant',
          outputs: [{ signal: { type: 'virtual', name: 'signal-A' }, value: 999 }],
          configuration: {
            isOn: true,
            sections: [
              {
                active: true,
                multiplier: 1.5,
                filters: [{ signal: { type: 'virtual', name: 'signal-A' }, value: 2 }],
              },
            ],
          },
          destinations: [{ network: 'output', source: span, instancePath: [] }],
          source: span,
          instancePath: [],
        },
      ],
    };

    const result = validateDirectPlanEnvelope(plan);

    expect(result.diagnostics).toEqual([]);
    expect(result.value?.plan.producers[0]).toMatchObject({
      kind: 'constant',
      configuration: { sections: [{ multiplier: 1.5, filters: [{ value: 2 }] }] },
    });
    expect(result.value?.plan.producers[0]).not.toHaveProperty('outputs');
  });

  test('accepts a minimal canonical transport without allocating a circuit', () => {
    const plan = {
      format: 'comblang-direct-plan',
      networks: [{ name: 'input', source: span, instancePath: [] }],
      producers: [],
    };

    const result = validateDirectPlanEnvelope(plan);

    expect(result.diagnostics).toEqual([]);
    expect(result.value?.plan).not.toBe(plan);
    expect(result.value?.declarations.get('input')).toBe(result.value?.plan.networks[0]);
    expect(Object.isFrozen(result.value?.plan)).toBe(true);
    expect(Object.isFrozen(result.value?.plan.networks)).toBe(true);
    expect(Object.isFrozen(result.value?.plan.networks[0])).toBe(true);
  });

  test.each(['generation', 'consumedAt'])('accepts canonical Network field %s', (field) => {
    const plan: Record<string, unknown> = {
      format: 'comblang-direct-plan',
      networks: [
        {
          name: 'input',
          source: span,
          instancePath: [],
          [field]: field === 'generation' ? 0 : span,
        },
      ],
      producers: [],
    };

    expect(validateDirectPlanEnvelope(plan).diagnostics).toEqual([]);
  });

  test.each([
    {
      name: 'missing Network collection',
      plan: { format: 'comblang-direct-plan', producers: [] },
      code: 'RT1001',
      message: 'Invalid direct elaboration plan envelope.',
    },
    {
      name: 'duplicate Network name',
      plan: {
        format: 'comblang-direct-plan',
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

  test('accepts and canonicalizes the discriminated Selector producer', () => {
    const plan = {
      format: 'comblang-direct-plan',
      networks: [
        { name: 'red', source: span, instancePath: [] },
        { name: 'green', source: span, instancePath: [] },
        { name: 'out', source: span, instancePath: [] },
      ],
      producers: [
        {
          kind: 'selector',
          input: { refKind: 'pair', networks: ['red', 'green'] },
          operation: 'select',
          selectMax: true,
          index: 4_294_967_298,
          destinations: [{ network: 'out', source: span, instancePath: [] }],
          source: span,
          instancePath: [],
        },
      ],
    };

    const result = validateDirectPlanEnvelope(plan);

    expect(result.diagnostics).toEqual([]);
    expect(result.value?.plan.producers[0]).toMatchObject({
      kind: 'selector',
      operation: 'select',
      input: { refKind: 'pair', networks: ['red', 'green'] },
      index: 2,
    });
    expect(Object.isFrozen(result.value?.plan.producers[0])).toBe(true);
  });

  test.each([
    ['unknown operation', { operation: 'random' }, '$.producers[0].operation'],
    [
      'invalid selectMax',
      { operation: 'select', selectMax: 'yes', index: 0 },
      '$.producers[0].selectMax',
    ],
    [
      'invalid count output',
      { operation: 'count', output: { type: 'virtual', name: '' } },
      '$.producers[0].output',
    ],
  ])('rejects Selector %s before replay', (_name, fields, path) => {
    const producer: Record<string, unknown> = {
      kind: 'selector',
      input: { refKind: 'single', network: 'input' },
      selectMax: true,
      index: 0,
      destinations: [{ network: 'out', source: span, instancePath: [] }],
      source: span,
      instancePath: [],
      ...fields,
    };
    if (fields.operation === 'count') {
      delete producer.selectMax;
      delete producer.index;
    }
    const plan = {
      format: 'comblang-direct-plan',
      networks: [
        { name: 'input', source: span, instancePath: [] },
        { name: 'out', source: span, instancePath: [] },
      ],
      producers: [producer],
    };

    expect(validateDirectPlanEnvelope(plan).diagnostics[0]).toMatchObject({
      message: expect.stringContaining(path),
    });
  });

  test.each([
    ['unknown configuration field', { extra: true }, '$.producers[0].extra'],
    [
      'duplicate destination',
      {
        destinations: [
          { network: 'out', source: span, instancePath: [] },
          { network: 'out', source: span, instancePath: [] },
        ],
      },
      '$.producers[0].destinations',
    ],
  ])('rejects Selector %s before replay', (_name, overrides, path) => {
    const plan = {
      format: 'comblang-direct-plan',
      networks: [
        { name: 'input', source: span, instancePath: [] },
        { name: 'out', source: span, instancePath: [] },
      ],
      producers: [
        {
          kind: 'selector',
          input: { refKind: 'single', network: 'input' },
          operation: 'select',
          selectMax: true,
          index: 0,
          destinations: [{ network: 'out', source: span, instancePath: [] }],
          source: span,
          instancePath: [],
          ...overrides,
        },
      ],
    };

    expect(validateDirectPlanEnvelope(plan).diagnostics[0]).toMatchObject({
      message: expect.stringContaining(path),
    });
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

  test('accepts nested Decider conditions, repeated output rows, and empty constants', () => {
    const plan = {
      format: 'comblang-direct-plan',
      networks: [
        { name: 'input', source: span, instancePath: [] },
        { name: 'other', source: span, instancePath: [] },
        { name: 'output', source: span, instancePath: [] },
      ],
      producers: [
        {
          kind: 'decider',
          condition: {
            kind: 'and',
            conditions: [
              {
                kind: 'compare-signal',
                signal: { type: 'virtual', name: 'signal-A' },
                comparator: '>',
                constant: 0,
                refKind: 'single',
                network: 'input',
              },
              {
                kind: 'or',
                conditions: [
                  {
                    kind: 'compare-wildcard',
                    wildcard: 'anything',
                    comparator: '!=',
                    constant: 0,
                    refKind: 'pair',
                    networks: ['input', 'other'],
                  },
                ],
              },
            ],
          },
          output: { kind: 'each', refKind: 'single', network: 'input' },
          outputs: [
            { kind: 'each', refKind: 'single', network: 'input' },
            {
              kind: 'signal-constant',
              signal: { type: 'virtual', name: 'signal-B' },
              value: 2,
            },
          ],
          elseOutputs: [
            {
              kind: 'wildcard',
              wildcard: 'everything',
              refKind: 'single',
              network: 'other',
            },
          ],
          destinations: [{ network: 'output', source: span, instancePath: [] }],
          source: span,
          instancePath: [],
          placement: { x: 1.5, y: -2, direction: 12 },
          debugCaptureIds: ['gate'],
        },
        {
          kind: 'constant',
          outputs: [],
          destinations: [{ network: 'other', source: span, instancePath: [] }],
          source: span,
          instancePath: [],
        },
      ],
    };

    expect(validateDirectPlanEnvelope(plan).diagnostics).toEqual([]);
  });

  test.each([
    {
      name: 'unknown nested comparator',
      mutate: (producer: Record<string, unknown>) => {
        const condition = producer.condition as {
          conditions: { comparator: string }[];
        };
        condition.conditions[0]!.comparator = '===';
      },
      path: '$.producers[0].condition.conditions[0].comparator',
      code: 'RT1001',
    },
    {
      name: 'unknown signal-to-signal input',
      mutate: (producer: Record<string, unknown>) => {
        producer.condition = {
          kind: 'compare-signals',
          comparator: '=',
          left: {
            signal: { type: 'virtual', name: 'signal-A' },
            refKind: 'single',
            network: 'input',
          },
          right: {
            signal: { type: 'virtual', name: 'signal-B' },
            refKind: 'single',
            network: 'missing',
          },
        };
      },
      path: '$.producers[0].condition.right',
      code: 'RT1003',
    },
    {
      name: 'invalid normal output row',
      mutate: (producer: Record<string, unknown>) => {
        producer.outputs = [{ kind: 'each-constant', value: 2 ** 31 }];
      },
      path: '$.producers[0].outputs[0].value',
      code: 'RT1001',
    },
    {
      name: 'invalid else output row',
      mutate: (producer: Record<string, unknown>) => {
        producer.elseOutputs = [
          {
            kind: 'wildcard',
            wildcard: 'each',
            refKind: 'single',
            network: 'input',
          },
        ];
      },
      path: '$.producers[0].elseOutputs[0].wildcard',
      code: 'RT1001',
    },
    {
      name: 'invalid placement direction',
      mutate: (producer: Record<string, unknown>) => {
        producer.placement = { x: 1, y: 2, direction: 16 };
      },
      path: '$.producers[0].placement',
      code: 'RT1001',
    },
    {
      name: 'empty capture ID',
      mutate: (producer: Record<string, unknown>) => {
        producer.debugCaptureIds = [''];
      },
      path: '$.producers[0].debugCaptureIds[0]',
      code: 'RT1001',
    },
  ])('rejects Decider $name before replay', ({ mutate, path, code }) => {
    const producer: Record<string, unknown> = {
      kind: 'decider',
      condition: {
        kind: 'and',
        conditions: [
          {
            kind: 'compare-each',
            comparator: '>',
            constant: 0,
            refKind: 'single',
            network: 'input',
          },
        ],
      },
      output: { kind: 'each', refKind: 'single', network: 'input' },
      destinations: [{ network: 'output', source: span, instancePath: [] }],
      source: span,
      instancePath: [],
    };
    mutate(producer);
    const plan = {
      format: 'comblang-direct-plan',
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

  test('rejects an excessively nested Decider condition before recursive lowering', () => {
    let condition: Record<string, unknown> = {
      kind: 'compare-each',
      comparator: '>',
      constant: 0,
      refKind: 'single',
      network: 'input',
    };
    for (let depth = 0; depth < 130; depth += 1)
      condition = { kind: 'and', conditions: [condition] };
    const plan = {
      format: 'comblang-direct-plan',
      networks: [
        { name: 'input', source: span, instancePath: [] },
        { name: 'output', source: span, instancePath: [] },
      ],
      producers: [
        {
          kind: 'decider',
          condition,
          output: { kind: 'each', refKind: 'single', network: 'input' },
          destinations: [{ network: 'output', source: span, instancePath: [] }],
          source: span,
          instancePath: [],
        },
      ],
    };

    expect(validateDirectPlanEnvelope(plan).diagnostics).toMatchObject([
      {
        code: 'RT1001',
        message: expect.stringContaining('condition nesting exceeds'),
      },
    ]);
  });

  test('accepts the nested-condition limit and rejects the next level with its source span', () => {
    let conditionAtLimit: Record<string, unknown> = {
      kind: 'compare-each',
      comparator: '>',
      constant: 0,
      refKind: 'single',
      network: 'input',
    };
    for (let depth = 0; depth < 128; depth += 1) {
      conditionAtLimit = {
        kind: 'and',
        conditions: [
          {
            kind: 'compare-each',
            comparator: '>',
            constant: 0,
            refKind: 'single',
            network: 'input',
          },
          conditionAtLimit,
        ],
      };
    }
    const makePlan = (condition: unknown) => ({
      format: 'comblang-direct-plan',
      networks: [
        { name: 'input', source: span, instancePath: [] },
        { name: 'output', source: span, instancePath: [] },
      ],
      producers: [
        {
          kind: 'decider',
          condition,
          output: { kind: 'each', refKind: 'single', network: 'input' },
          destinations: [{ network: 'output', source: span, instancePath: [] }],
          source: span,
          instancePath: [],
        },
      ],
    });

    expect(validateDirectPlanEnvelope(makePlan(conditionAtLimit)).diagnostics).toEqual([]);
    const beyondLimit = structuredClone(conditionAtLimit) as Record<string, unknown>;
    beyondLimit.conditions = [
      {
        kind: 'compare-each',
        comparator: '>',
        constant: 0,
        refKind: 'single',
        network: 'input',
      },
      beyondLimit,
    ];
    const result = validateDirectPlanEnvelope(makePlan(beyondLimit));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toMatchObject([
      {
        code: 'RT1001',
        span,
        message: expect.stringContaining('condition nesting exceeds the 128 level limit'),
      },
    ]);
  });

  test('rejects the first Decider output array beyond the bounded collection budget', () => {
    const row = { kind: 'each-constant', value: 1 };
    const outputs = Array.from({ length: 100_000 }, () => row);
    const makePlan = (rows: readonly unknown[]) => ({
      format: 'comblang-direct-plan',
      networks: [
        { name: 'input', source: span, instancePath: [] },
        { name: 'output', source: span, instancePath: [] },
      ],
      producers: [
        {
          kind: 'decider',
          condition: {
            kind: 'compare-each',
            comparator: '>',
            constant: 0,
            refKind: 'single',
            network: 'input',
          },
          output: row,
          outputs: rows,
          destinations: [{ network: 'output', source: span, instancePath: [] }],
          source: span,
          instancePath: [],
        },
      ],
    });

    expect(validateDirectPlanEnvelope(makePlan(outputs)).diagnostics).toEqual([]);
    const result = validateDirectPlanEnvelope(makePlan([...outputs, row]));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toMatchObject([
      {
        code: 'RT1001',
        span,
        message: expect.stringContaining('expected a bounded output array'),
      },
    ]);
  });

  test.each([
    {
      name: 'missing output array',
      outputs: undefined,
      path: '$.producers[0].outputs',
    },
    {
      name: 'invalid constant SignalID',
      outputs: [{ signal: { type: 'item', name: '' }, value: 1 }],
      path: '$.producers[0].outputs[0].signal',
    },
    {
      name: 'out-of-range constant value',
      outputs: [
        {
          signal: { type: 'virtual', name: 'signal-A' },
          value: -(2 ** 31) - 1,
        },
      ],
      path: '$.producers[0].outputs[0].value',
    },
  ])('rejects Constant $name before replay', ({ outputs, path }) => {
    const plan = {
      format: 'comblang-direct-plan',
      networks: [{ name: 'output', source: span, instancePath: [] }],
      producers: [
        {
          kind: 'constant',
          ...(outputs === undefined ? {} : { outputs }),
          destinations: [{ network: 'output', source: span, instancePath: [] }],
          source: span,
          instancePath: [],
        },
      ],
    };

    expect(validateDirectPlanEnvelope(plan).diagnostics).toMatchObject([
      { code: 'RT1001', message: expect.stringContaining(path) },
    ]);
  });

  test('rejects duplicate capture IDs before creating any Producer', () => {
    const constant = (captureId: string) => ({
      kind: 'constant',
      outputs: [],
      destinations: [{ network: 'output', source: span, instancePath: [] }],
      source: span,
      instancePath: [],
      debugCaptureIds: [captureId],
    });
    const plan = {
      format: 'comblang-direct-plan',
      networks: [{ name: 'output', source: span, instancePath: [] }],
      producers: [constant('same'), constant('same')],
    };

    expect(validateDirectPlanEnvelope(plan).diagnostics).toMatchObject([
      {
        code: 'RT1001',
        message: expect.stringContaining('$.producers[1].debugCaptureIds[0]'),
      },
    ]);
  });

  test('canonicalizes single Decider output and freezes only known payload fields', () => {
    const output = { kind: 'each', refKind: 'single', network: 'input', ignored: true };
    const plan = {
      format: 'comblang-direct-plan',
      networks: [
        { name: 'input', source: span, instancePath: [], ignored: true },
        { name: 'output', source: span, instancePath: [] },
      ],
      producers: [
        {
          kind: 'decider',
          condition: {
            kind: 'compare-each',
            comparator: '>',
            constant: 0,
            refKind: 'single',
            network: 'input',
          },
          output,
          destinations: [{ network: 'output', source: span, instancePath: [] }],
          source: span,
          instancePath: [],
          ignored: true,
        },
      ],
    };

    const canonical = validateDirectPlanEnvelope(plan).value?.plan;
    expect(canonical).toBeDefined();
    expect(canonical).not.toHaveProperty('ignored');
    expect(canonical?.networks[0]).not.toHaveProperty('ignored');
    expect(canonical?.producers[0]).not.toHaveProperty('ignored');
    expect(canonical?.producers[0]).toMatchObject({
      kind: 'decider',
      outputs: [{ kind: 'each', network: 'input' }],
    });
    expect(Object.isFrozen(canonical?.producers[0])).toBe(true);
    expect(
      Object.isFrozen(
        canonical?.producers[0]?.kind === 'decider' ? canonical.producers[0].condition : undefined,
      ),
    ).toBe(true);

    output.network = 'mutated';
    expect(canonical?.producers[0]).toMatchObject({
      kind: 'decider',
      output: { network: 'input' },
    });
  });

  test('accepts and freezes nested debug values and related diagnostics', () => {
    const plan = {
      format: 'comblang-direct-plan',
      networks: [{ name: 'output', source: span, instancePath: [] }],
      producers: [
        {
          kind: 'constant',
          outputs: [],
          destinations: [{ network: 'output', source: span, instancePath: [] }],
          source: span,
          instancePath: [],
          debugCaptureIds: ['constant'],
        },
      ],
      debugInstances: [
        {
          name: 'fixture',
          path: ['test fixture'],
          source: span,
          value: {
            kind: 'object',
            entries: [
              { key: 'network', value: { kind: 'network', network: 'output' } },
              {
                key: 'values',
                value: {
                  kind: 'array',
                  values: [
                    { kind: 'producer', captureId: 'constant' },
                    { kind: 'literal', value: 2 },
                    { kind: 'undefined' },
                  ],
                },
              },
            ],
          },
        },
      ],
      diagnostics: [
        {
          code: 'CL2001',
          severity: 'warning',
          message: 'Example warning.',
          span,
          related: [{ message: 'Created here.', span }],
        },
      ],
    };

    const canonical = validateDirectPlanEnvelope(plan).value?.plan;
    expect(canonical).toBeDefined();
    expect(Object.isFrozen(canonical?.debugInstances?.[0]?.value)).toBe(true);
    expect(Object.isFrozen(canonical?.diagnostics?.[0]?.related)).toBe(true);
  });

  test.each([
    {
      name: 'unknown debug Network',
      value: { kind: 'network', network: 'missing' },
      path: '$.debugInstances[0].value.network',
      code: 'RT1003',
    },
    {
      name: 'unknown Producer capture',
      value: { kind: 'producer', captureId: 'missing' },
      path: '$.debugInstances[0].value.captureId',
      code: 'RT1001',
    },
    {
      name: 'non-finite debug literal',
      value: { kind: 'literal', value: Number.NaN },
      path: '$.debugInstances[0].value.value',
      code: 'RT1001',
    },
    {
      name: 'duplicate debug object key',
      value: {
        kind: 'object',
        entries: [
          { key: 'same', value: { kind: 'undefined' } },
          { key: 'same', value: { kind: 'undefined' } },
        ],
      },
      path: '$.debugInstances[0].value.entries[1].key',
      code: 'RT1001',
    },
  ])('rejects $name before debug reconstruction', ({ value, path, code }) => {
    const plan = {
      format: 'comblang-direct-plan',
      networks: [{ name: 'output', source: span, instancePath: [] }],
      producers: [],
      debugInstances: [{ name: 'fixture', path: [], source: span, value }],
    };

    expect(validateDirectPlanEnvelope(plan).diagnostics).toMatchObject([
      { code, message: expect.stringContaining(path) },
    ]);
  });

  test('rejects excessively nested debug values before reconstruction', () => {
    let value: Record<string, unknown> = { kind: 'undefined' };
    for (let depth = 0; depth < 130; depth += 1) value = { kind: 'array', values: [value] };
    const plan = {
      format: 'comblang-direct-plan',
      networks: [],
      producers: [],
      debugInstances: [{ name: 'fixture', path: [], source: span, value }],
    };

    expect(validateDirectPlanEnvelope(plan).diagnostics).toMatchObject([
      {
        code: 'RT1001',
        message: expect.stringContaining('debug value nesting exceeds'),
      },
    ]);
  });

  test.each([
    {
      name: 'unknown severity',
      diagnostic: { code: 'X', severity: 'fatal', message: 'Failure.' },
      path: '$.diagnostics[0]',
    },
    {
      name: 'invalid primary span',
      diagnostic: {
        code: 'X',
        severity: 'error',
        message: 'Failure.',
        span: { fileId: '', start: 0, end: 1 },
      },
      path: '$.diagnostics[0].span',
    },
    {
      name: 'invalid related information',
      diagnostic: {
        code: 'X',
        severity: 'error',
        message: 'Failure.',
        related: [{ message: 1, span }],
      },
      path: '$.diagnostics[0].related[0]',
    },
  ])('rejects diagnostic $name', ({ diagnostic, path }) => {
    const plan = {
      format: 'comblang-direct-plan',
      networks: [],
      producers: [],
      diagnostics: [diagnostic],
    };

    expect(validateDirectPlanEnvelope(plan).diagnostics).toMatchObject([
      { code: 'RT1001', message: expect.stringContaining(path) },
    ]);
  });
});
