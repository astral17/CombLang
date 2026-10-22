import { afterEach, describe, expect, test } from 'vitest';

import {
  createTrustedEntityReplayContext,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import { signal } from '@comblang/factorio';
import type { EntityProfile } from '@comblang/compiler/entity';
import type { EntityPrototype } from '@comblang/prototypes';
import { parseDiagnosticPolicy } from '@comblang/shared';

import type { EntityPrototypeResolver } from './entity-registry.js';
import { compileSourceProgram, type LocalSourceCompilation } from './source-compilation.js';
import { runSourceCompilationTests } from './source-compilation-test-runner.js';

const runSourceCounter = '__comblang_scenario_source_runs';
const registrationCounter = '__comblang_scenario_registration_runs';
const defaultsKey = '__comblang_scenario_run_defaults';
const invalidCallbackKey = '__comblang_scenario_invalid_callbacks';
const originalExecutionKey = '__comblang_scenario_original_execution';
const requiredSignalCallbackKey = '__comblang_required_signal_callbacks';

afterEach(() => {
  const globals = globalThis as Record<string, unknown>;
  for (const key of [
    runSourceCounter,
    registrationCounter,
    defaultsKey,
    invalidCallbackKey,
    originalExecutionKey,
    requiredSignalCallbackKey,
  ]) {
    delete globals[key];
  }
});

const parameterSource = `globalThis.${runSourceCounter} = Number(globalThis.${runSourceCounter} ?? 0) + 1;
const amount = Param.number('Shared', 5);
const channel = Param.signal('Shared', Signal('virtual', 'signal-A'));
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: channel, value: amount }] }] });`;

function compile(
  text = parameterSource,
  environment: Parameters<typeof compileSourceProgram>[1] = canonicalEntityHost(),
): LocalSourceCompilation {
  const compilation = compileSourceProgram(
    { path: 'source-compilation-test-runner.factorio.ts', text },
    environment,
  );
  expect(compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error')).toEqual(
    [],
  );
  expect(compilation.execution).toBeDefined();
  expect(compilation.plan).toBeDefined();
  expect(compilation.resolvedCircuit).toBeDefined();
  return compilation;
}

function expectOutput(signalName: string, value: number, quality?: string): string {
  const signalExpression =
    quality === undefined
      ? `Signal('virtual', '${signalName}')`
      : `Signal('virtual', '${signalName}', '${quality}')`;
  return `tick(); expectSignal(network('output'), ${signalExpression}).toBe(${value});`;
}

function canonicalEntityHost(): {
  trustedEntityReplayContext: ReturnType<typeof createTrustedEntityReplayContext>;
  entityPrototypeResolver: EntityPrototypeResolver;
} {
  const families = [
    ['constant-combinator', 'constant-combinator'],
    ['arithmetic-combinator', 'arithmetic-combinator'],
    ['decider-combinator', 'decider-combinator'],
    ['selector-combinator', 'selector-combinator'],
    ['structural', 'container'],
  ] as const;
  const profiles = families.map(([name, prototypeType], index) => ({
    ...syntheticZeroPortEntityProfile,
    prototypeType,
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${name}` as EntityProfile['ref']['prototypeKey'],
      profileId: `profile:parameter-scenario-${index}` as EntityProfile['ref']['profileId'],
    },
  }));
  const prototypes = families.map(([name, type]) => ({
    key: `entity:${name}`,
    name,
    type,
  })) as EntityPrototype[];
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profiles[0]!.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'parameter-scenario-entity-fixture',
    policyIdentity: 'parameter-scenario-entity-policy',
    profiles,
  });
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: profiles[0]!.ref.database,
    getEntity(nameOrKey) {
      return prototypes.find(({ key, name }) => nameOrKey === key || nameOrKey === name);
    },
  };
  return { trustedEntityReplayContext, entityPrototypeResolver };
}

describe('source compilation test runner parameter scenarios', () => {
  test('does not run callbacks from a compilation rejected by diagnostic policy without parameters', () => {
    const compilation = compileSourceProgram(
      {
        path: 'rejected-test-source.factorio.ts',
        text: `Constant({ sections: [{ filters: [{ signal: Signal('virtual', 'signal-A'), value: 1 }] }] });`,
      },
      {
        ...canonicalEntityHost(),
        diagnosticPolicy: parseDiagnosticPolicy({
          rules: { 'producer.unused-output': { severity: 'error' } },
        }),
      },
    );
    expect(compilation.pipelineDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL2001', severity: 'error' }),
    );
    expect(compilation.execution).toBeDefined();
    const result = runSourceCompilationTests(
      compilation,
      `test('must not execute', () => { throw new Error('REJECTED_SOURCE_CALLBACK_RAN'); });`,
    );
    expect(result.failed).toBe(1);
    expect(result.results[0]!.message).not.toContain('REJECTED_SOURCE_CALLBACK_RAN');
  });

  test('binds full case snapshots over run defaults and preserves originals without overrides', () => {
    const globals = globalThis as typeof globalThis & {
      [runSourceCounter]?: number;
      [registrationCounter]?: number;
      [defaultsKey]?: Array<{ id: number; value: unknown }>;
      [originalExecutionKey]?: unknown;
    };
    globals[runSourceCounter] = 0;
    globals[registrationCounter] = 0;
    const runDefaults = [
      { id: 0, value: 7 },
      { id: 1, value: signal('virtual', 'signal-C', 'rare') },
    ];
    globals[defaultsKey] = runDefaults;
    try {
      const compilation = compile();
      const originalPlan = structuredClone(compilation.plan);
      const originalResolved = structuredClone(compilation.resolvedCircuit);
      const result = runSourceCompilationTests(
        compilation,
        `globalThis.${registrationCounter} = Number(globalThis.${registrationCounter} ?? 0) + 1;
test('case B before defaults', ({ network, expectSignal, tick }) => {
  ${expectOutput('signal-B', 5, 'legendary')}
}, { parameters: [{ id: 1, value: Signal('virtual', 'signal-B', 'legendary') }] });
test('inherits run snapshot', ({ network, expectSignal, tick }) => {
  ${expectOutput('signal-C', 7, 'rare')}
});
test('empty snapshot resets originals', ({ network, expectSignal, tick }) => {
  ${expectOutput('signal-A', 5)}
}, { parameters: [] });
globalThis.${defaultsKey}[0].value = 99;
globalThis.${defaultsKey}[1].value = Signal('virtual', 'signal-D');`,
        { parameters: runDefaults },
      );

      expect(
        result.results.map(({ name, status, message, code }) => ({ name, status, message, code })),
      ).toEqual([
        { name: 'case B before defaults', status: 'passed', message: undefined, code: undefined },
        { name: 'inherits run snapshot', status: 'passed', message: undefined, code: undefined },
        {
          name: 'empty snapshot resets originals',
          status: 'passed',
          message: undefined,
          code: undefined,
        },
      ]);
      expect(result).toMatchObject({ passed: 3, failed: 0 });
      expect(result.results.map(({ name }) => name)).toEqual([
        'case B before defaults',
        'inherits run snapshot',
        'empty snapshot resets originals',
      ]);
      const original = runSourceCompilationTests(
        compilation,
        `test('no run defaults uses original execution', ({ execution }) => {
  globalThis.${originalExecutionKey} = execution;
});`,
      );
      expect(original).toMatchObject({ passed: 1, failed: 0 });
      expect(globals[originalExecutionKey]).toBe(compilation.execution);
      expect(globals[runSourceCounter]).toBe(1);
      expect(globals[registrationCounter]).toBe(1);
      expect(compilation.plan).toEqual(originalPlan);
      expect(compilation.resolvedCircuit).toEqual(originalResolved);
      expect(result.results.map(({ trace }) => trace?.endTick)).toEqual([1, 1, 1]);
      expect(result.results[0]!.trace).not.toBe(result.results[1]!.trace);
      expect(result.results[0]!.debug).not.toBe(result.results[1]!.debug);
    } finally {
      delete globals[runSourceCounter];
      delete globals[registrationCounter];
      delete globals[defaultsKey];
      delete globals[originalExecutionKey];
    }
  });

  test('isolates invalid bindings and retains source binding diagnostics without blocking later cases', () => {
    const globals = globalThis as typeof globalThis & {
      [invalidCallbackKey]?: string[];
    };
    globals[invalidCallbackKey] = [];
    const compilation = compile();
    const originalPlan = structuredClone(compilation.plan);
    const originalResolved = structuredClone(compilation.resolvedCircuit);
    try {
      const result = runSourceCompilationTests(
        compilation,
        `test('before errors', ({ network, expectSignal, tick }) => {
  ${expectOutput('signal-A', 5)}
});
test('duplicate IDs', () => globalThis.${invalidCallbackKey}.push('duplicate'), { parameters: [{ id: 0, value: 8 }, { id: 0, value: 9 }] });
test('unknown ID', () => globalThis.${invalidCallbackKey}.push('unknown'), { parameters: [{ id: 99, value: 9 }] });
test('invalid number', () => globalThis.${invalidCallbackKey}.push('number'), { parameters: [{ id: 0, value: NaN }] });
test('invalid signal', () => globalThis.${invalidCallbackKey}.push('signal'), { parameters: [{ id: 1, value: 'signal-A' }] });
test('malformed override list', () => globalThis.${invalidCallbackKey}.push('malformed'), { parameters: {} });
test('after errors', ({ network, expectSignal, tick }) => {
  ${expectOutput('signal-A', 5)}
});`,
      );

      expect(result).toMatchObject({ passed: 2, failed: 5 });
      expect(result.results.slice(1, 6).map(({ code, status }) => ({ code, status }))).toEqual(
        Array.from({ length: 5 }, () => ({ code: 'CP1000', status: 'failed' })),
      );
      expect(result.results.slice(1, 6).every(({ line }) => line === undefined)).toBe(true);
      expect(JSON.parse(JSON.stringify(result.results[1]!.details))).toHaveProperty('source');
      expect(globals[invalidCallbackKey]).toEqual([]);
      expect(compilation.plan).toEqual(originalPlan);
      expect(compilation.resolvedCircuit).toEqual(originalResolved);
    } finally {
      delete globals[invalidCallbackKey];
    }
  });

  test('accepts only empty snapshots when the compilation has no declarations', () => {
    const compilation = compile('const output = new Network();');
    let invalidBodyRan = false;
    const globals = globalThis as typeof globalThis & { __scenarioNoDeclarationBody?: () => void };
    globals.__scenarioNoDeclarationBody = () => {
      invalidBodyRan = true;
    };
    try {
      const result = runSourceCompilationTests(
        compilation,
        `test('empty is harmless', () => {}, { parameters: [] });
test('nonempty is rejected', () => globalThis.__scenarioNoDeclarationBody(), { parameters: [{ id: 0, value: 1 }] });`,
      );
      expect(result).toMatchObject({
        passed: 1,
        failed: 1,
        results: [{ status: 'passed' }, { status: 'failed', code: 'CP1000' }],
      });
      expect(invalidBodyRan).toBe(false);
    } finally {
      delete globals.__scenarioNoDeclarationBody;
    }
  });

  test('requires each used default-free Signal binding without blocking a later valid case', () => {
    const globals = globalThis as typeof globalThis & { [requiredSignalCallbackKey]?: string[] };
    globals[requiredSignalCallbackKey] = [];
    const source = `const channel = Param.signal('Required channel');
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: channel, value: 5 }] }] });`;
    const compilation = compileSourceProgram(
      { path: 'default-free-signal-runner.factorio.ts', text: source },
      canonicalEntityHost(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.requiredParameterIds).toEqual([0]);
    expect(compilation.plan).toBeUndefined();
    expect(compilation.resolvedCircuit).toBeUndefined();
    try {
      const result = runSourceCompilationTests(
        compilation,
        `test('explicit item binding', ({ network, expectSignal, tick }) => {
  tick();
  expectSignal(network('output'), Signal('item', 'iron-plate', 'uncommon')).toBe(5);
}, { parameters: [{ id: 0, value: Signal('item', 'iron-plate', 'uncommon') }] });
test('missing binding', () => globalThis.${requiredSignalCallbackKey}.push('missing'));
test('empty snapshot', () => globalThis.${requiredSignalCallbackKey}.push('empty'), { parameters: [] });
test('explicit fluid binding', ({ network, expectSignal, tick }) => {
  tick();
  expectSignal(network('output'), Signal('fluid', 'water', 'rare')).toBe(5);
}, { parameters: [{ id: 0, value: Signal('fluid', 'water', 'rare') }] });
test('explicit virtual binding', ({ network, expectSignal, tick }) => {
  tick();
  expectSignal(network('output'), Signal('virtual', 'signal-B', 'legendary')).toBe(5);
}, { parameters: [{ id: 0, value: Signal('virtual', 'signal-B', 'legendary') }] });`,
      );

      expect(result).toMatchObject({
        passed: 3,
        failed: 2,
        results: [
          { status: 'passed' },
          { status: 'failed', code: 'CP1002' },
          { status: 'failed', code: 'CP1002' },
          { status: 'passed' },
          { status: 'passed' },
        ],
      });
      expect(globals[requiredSignalCallbackKey]).toEqual([]);
    } finally {
      delete globals[requiredSignalCallbackKey];
    }
  });

  test('combines automatic numeric defaults with per-case default-free Signal bindings', () => {
    const source = `const amount = Param.number('Amount');
const explicit = Param.number('Explicit amount', 4);
const channel = Param.signal('Required channel');
const secondChannel = Param.signal('Second required channel');
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: channel, value: amount },
  { signal: secondChannel, value: amount },
  { signal: Signal('virtual', 'signal-fixed'), value: explicit },
] }] });`;
    const compilation = compileSourceProgram(
      { path: 'automatic-number-with-required-signal.factorio.ts', text: source },
      canonicalEntityHost(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.requiredParameterIds).toEqual([2, 3]);
    expect(compilation.plan).toBeUndefined();
    expect(compilation.resolvedCircuit).toBeUndefined();
    expect(compilation.execution).toBeUndefined();

    const result = runSourceCompilationTests(
      compilation,
      `test('automatic and explicit numbers bind with two required Signals', ({ network, expectSignal, tick }) => {
  tick();
  expectSignal(network('output'), Signal('item', 'iron-plate', 'uncommon')).toBe(2);
  expectSignal(network('output'), Signal('fluid', 'water', 'rare')).toBe(2);
  expectSignal(network('output'), Signal('virtual', 'signal-fixed')).toBe(4);
}, { parameters: [
  { id: 2, value: Signal('item', 'iron-plate', 'uncommon') },
  { id: 3, value: Signal('fluid', 'water', 'rare') },
] });
test('numeric override composes with both Signal bindings', ({ network, expectSignal, tick }) => {
  tick();
  expectSignal(network('output'), Signal('item', 'iron-plate')).toBe(7);
  expectSignal(network('output'), Signal('fluid', 'water')).toBe(7);
  expectSignal(network('output'), Signal('virtual', 'signal-fixed')).toBe(4);
}, { parameters: [
  { id: 0, value: 7 },
  { id: 2, value: Signal('item', 'iron-plate') },
  { id: 3, value: Signal('fluid', 'water') },
] });
test('missing Signal binding', () => {
  throw new Error('missing-binding callback must not run');
});
test('empty snapshot still lacks required Signal', () => {
  throw new Error('missing-binding callback must not run');
}, { parameters: [] });
test('valid case after missing bindings resets automatic count', ({ network, expectSignal, tick }) => {
  tick();
  expectSignal(network('output'), Signal('virtual', 'signal-B', 'rare')).toBe(2);
  expectSignal(network('output'), Signal('fluid', 'water', 'uncommon')).toBe(2);
}, { parameters: [
  { id: 2, value: Signal('virtual', 'signal-B', 'rare') },
  { id: 3, value: Signal('fluid', 'water', 'uncommon') },
] });`,
    );
    expect(result).toMatchObject({
      passed: 3,
      failed: 2,
      results: [
        { status: 'passed' },
        { status: 'passed' },
        { status: 'failed', code: 'CP1002' },
        { status: 'failed', code: 'CP1002' },
        { status: 'passed' },
      ],
    });
    expect(result.results[2]!.message).not.toContain('missing-binding callback must not run');
    expect(result.results[3]!.message).not.toContain('missing-binding callback must not run');
  });

  test('an explicit case snapshot does not inherit an invalid run-wide snapshot', () => {
    const compilation = compile();
    const source = `test('inherits invalid defaults', () => { throw new Error('invalid body ran'); });
test('explicit reset', ({ network, expectSignal, tick }) => {
  ${expectOutput('signal-A', 5)}
}, { parameters: [] });
test('explicit signal', ({ network, expectSignal, tick }) => {
  ${expectOutput('signal-B', 5)}
}, { parameters: [{ id: 1, value: Signal('virtual', 'signal-B') }] });`;
    for (const parameters of [() => {}, [{ id: 0, value: NaN }]]) {
      const result = runSourceCompilationTests(compilation, source, { parameters });
      expect(result).toMatchObject({
        passed: 2,
        failed: 1,
        results: [{ status: 'failed', code: 'CP1000' }, { status: 'passed' }, { status: 'passed' }],
      });
      expect(result.results[0]!.message).not.toContain('invalid body ran');
    }
  });

  test('keeps same-label numeric declarations independently addressable in either case order', () => {
    const compilation = compile(`const first = Param.number('Amount', 5);
const second = Param.number('Amount', 5);
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: Signal('virtual', 'signal-A'), value: first },
  { signal: Signal('virtual', 'signal-B'), value: second }
] }] });`);
    const cases = [
      `test('first', ({ network, expectSignal, tick }) => {
        tick();
        expectSignal(network('output'), Signal('virtual', 'signal-A')).toBe(11);
        expectSignal(network('output'), Signal('virtual', 'signal-B')).toBe(5);
      }, { parameters: [{ id: 0, value: 11 }] });`,
      `test('second', ({ network, expectSignal, tick }) => {
        tick();
        expectSignal(network('output'), Signal('virtual', 'signal-A')).toBe(5);
        expectSignal(network('output'), Signal('virtual', 'signal-B')).toBe(13);
      }, { parameters: [{ id: 1, value: 13 }] });`,
    ];
    expect(runSourceCompilationTests(compilation, cases.join('\n'))).toMatchObject({
      passed: 2,
      failed: 0,
    });
    expect(runSourceCompilationTests(compilation, cases.toReversed().join('\n'))).toMatchObject({
      passed: 2,
      failed: 0,
    });
  });

  test('replays a bound Entity-bearing compilation through its trusted host pair', () => {
    const compilation = compile(
      `const amount = Param.number('Amount', 5);
const A = Signal('virtual', 'signal-A');
const output = new Network();
const structural = Entity('entity:structural');
const constant: ConstantCombinator = Constant({ sections: [{ filters: [{ signal: A, value: amount }] }] });
output += constant;
void structural;`,
      canonicalEntityHost(),
    );
    const result = runSourceCompilationTests(
      compilation,
      `test('entity binding is consumed', ({ execution }) => {
  const entity = execution.circuit.ir.entities.find(({ configuration }) => configuration?.mode === 'constant');
  if (entity?.configuration?.value?.sections?.[0]?.filters?.[0]?.value !== 13) {
    throw new Error('Bound Entity circuit did not contain the selected value.');
  }
}, { parameters: [{ id: 0, value: 13 }] });`,
    );

    expect(result).toMatchObject({ passed: 1, failed: 0 });
  });
});
