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
});
