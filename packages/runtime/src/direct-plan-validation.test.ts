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
});
