import { describe, expect, test } from 'vitest';
import type { SourceSpan } from '@comblang/shared';
import type { DirectElaborationPlan, PlanDeciderCondition } from './direct-plan-schema.js';
import { resolvedCircuitPlanFingerprint } from './resolved-circuit.js';

function constantPlan(value = 2, fileId = 'fingerprint.factorio.ts'): DirectElaborationPlan {
  const source: SourceSpan = { fileId: fileId as SourceSpan['fileId'], start: 0, end: 1 };
  return {
    format: 'comblang-direct-plan',
    networks: [{ name: 'output', source, instancePath: [] }],
    producers: [
      {
        kind: 'constant',
        outputs: [{ signal: { type: 'virtual', name: 'signal-A' }, value }],
        destinations: [{ network: 'output', source, instancePath: [] }],
        source,
        instancePath: [],
      },
    ],
    entities: [],
  };
}

describe('resolved circuit Plan fingerprint', () => {
  test('preserves representative canonical hashes including nested options and Unicode', () => {
    const base = constantPlan();
    const nested: DirectElaborationPlan = {
      ...base,
      producers: [
        {
          ...base.producers[0]!,
          bindingName: 'constant',
          debugCaptureIds: ['capture:1'],
          placement: { x: 1, y: -2, direction: 4 },
        },
      ],
      networkAliases: [
        {
          name: 'alias',
          network: 'output',
          source: base.networks[0]!.source,
          instancePath: [],
          moved: false,
        },
      ],
    };
    expect(
      [base, nested, constantPlan(2, 'схемы/信号😀.factorio.ts'), constantPlan(3)].map(
        resolvedCircuitPlanFingerprint,
      ),
    ).toEqual([
      'plan-fnv1a64:7ebdcaaf7827e8a3',
      'plan-fnv1a64:89c015b2fa2ff2ca',
      'plan-fnv1a64:7ad038b25ee1eb2f',
      'plan-fnv1a64:ca7d54ab272e2942',
    ]);
  });

  test('rejects cyclic data instead of overflowing the stack', () => {
    const plan = constantPlan();
    const cyclic = { ...plan, networks: [] as unknown[] };
    cyclic.networks.push(cyclic);
    expect(() =>
      resolvedCircuitPlanFingerprint(cyclic as unknown as DirectElaborationPlan),
    ).toThrow(TypeError);
  });

  test('allows condition nesting at the existing semantic depth limit', () => {
    const base = constantPlan();
    let condition: PlanDeciderCondition = {
      kind: 'compare-each',
      refKind: 'single',
      network: 'output',
      comparator: '>',
      constant: 0,
    };
    for (let depth = 0; depth < 128; depth += 1)
      condition = { kind: 'and', conditions: [condition] };
    const plan: DirectElaborationPlan = {
      ...base,
      producers: [
        {
          kind: 'decider',
          condition,
          output: { kind: 'each-constant', value: 1 },
          destinations: base.producers[0]!.destinations,
          source: base.producers[0]!.source,
          instancePath: [],
        },
      ],
    };
    expect(() => resolvedCircuitPlanFingerprint(plan)).not.toThrow();
  });

  test.each([
    ['sparse arrays', () => new Array(1)],
    ['oversized arrays', () => new Array(100_001)],
    ['non-finite numbers', () => [Number.NaN]],
    ['custom object prototypes', () => [new Date(0)]],
    ['symbol keys', () => [{ [Symbol('hidden')]: true }]],
    [
      'deep containers',
      () => {
        let value: unknown = 0;
        for (let depth = 0; depth < 520; depth += 1) value = [value];
        return value;
      },
    ],
  ] as const)('rejects %s without producing a hash', (_name, invalidValue) => {
    const plan = { ...constantPlan(), producers: invalidValue() };
    expect(() => resolvedCircuitPlanFingerprint(plan as unknown as DirectElaborationPlan)).toThrow(
      TypeError,
    );
  });

  test('rejects accessors without invoking them', () => {
    let reads = 0;
    const plan = constantPlan();
    Object.defineProperty(plan, 'networks', {
      enumerable: true,
      get() {
        reads += 1;
        return [];
      },
    });
    expect(() => resolvedCircuitPlanFingerprint(plan)).toThrow(TypeError);
    expect(reads).toBe(0);
  });
});
