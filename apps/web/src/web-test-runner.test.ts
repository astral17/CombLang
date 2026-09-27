import { describe, expect, it } from 'vitest';
import type { EntityProfile } from '@comblang/compiler/entity';
import type { ResolvedCircuit } from '@comblang/compiler/resolved-circuit';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import { createTrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import type { EntityPrototype } from '@comblang/prototypes';
import type { EntityPrototypeResolver } from '@comblang/runtime/entity-registry';
import {
  canonicalResolvedCircuit,
  executeResolvedDirectPlan,
  runDirectPlanTests,
} from '@comblang/runtime';

import { compileSource } from './compile-source.js';
import { runWebTests } from './web-test-runner.js';

const source = `const A = Signal("virtual", "signal-A");
const input = new Network();
const output = new Network();
output += input + 1;`;

function plan() {
  const compiled = compileSource({ path: 'test.factorio.ts', text: source });
  if (compiled.plan === undefined) throw new Error('Fixture did not compile.');
  return compiled.plan;
}

function entityHost() {
  const profile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:web-test-container',
      profileId: 'profile:web-test-container' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'container',
  };
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'web-test-container-evidence',
    policyIdentity: 'web-test-container-policy',
    profiles: [profile],
  });
  const prototype: EntityPrototype = {
    key: 'entity:web-test-container' as EntityPrototype['key'],
    name: 'web-test-container',
    type: 'container',
    tileWidth: 1,
    tileHeight: 1,
  };
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: profile.ref.database,
    getEntity(nameOrKey) {
      return nameOrKey === prototype.key || nameOrKey === prototype.name ? prototype : undefined;
    },
  };
  return { trustedEntityReplayContext, entityPrototypeResolver };
}

describe('browser test runner', () => {
  it('reproduces plan-only replay rejection and runs Entity tests from resolved IR', () => {
    const compiled = compileSource(
      {
        path: 'entity-test.factorio.ts',
        text: `const object = Entity('entity:web-test-container');
const A = Signal("virtual", "signal-A");
const input = new Network();
const output = new Network();
output += input + 1;`,
      },
      entityHost(),
    );
    if (compiled.plan === undefined || compiled.resolvedCircuit === undefined) {
      throw new Error('Expected a plan and resolved circuit for the synthetic Entity fixture.');
    }
    const planWithEntityDebugInstance = {
      ...compiled.plan,
      debugInstances: [
        {
          name: 'dut',
          path: [],
          source: compiled.plan.entities[0]!.provenance.source,
          value: { kind: 'entity' as const, entityId: compiled.plan.entities[0]!.id },
        },
      ],
    };
    const resolvedCircuit = canonicalResolvedCircuit(
      undefined,
      planWithEntityDebugInstance,
      compiled.resolvedCircuit.ir,
    ) as ResolvedCircuit;
    expect(planWithEntityDebugInstance.entities).toHaveLength(1);
    const resolvedExecution = executeResolvedDirectPlan(
      planWithEntityDebugInstance,
      resolvedCircuit,
    );
    expect(resolvedExecution.debug.root.entities).toHaveLength(1);
    expect(resolvedExecution.instances).toHaveLength(1);

    const planOnly = runDirectPlanTests(
      planWithEntityDebugInstance,
      `test('old path', ({ tick }) => { tick(); });`,
    );
    expect(planOnly).toMatchObject({
      passed: 0,
      failed: 1,
      results: [
        {
          failureKind: 'runtime',
          message: 'Entity-bearing canonical plans require a trusted replay context.',
        },
      ],
    });

    expect(
      runWebTests(planWithEntityDebugInstance, `test('missing pair', () => {});`),
    ).toMatchObject({
      passed: 0,
      failed: 1,
      results: [
        {
          message: 'Entity-bearing canonical plans require a matching resolved circuit.',
        },
      ],
    });

    const run = runWebTests(
      planWithEntityDebugInstance,
      `const A = Signal("virtual", "signal-A");
test('first test advances its own session', ({ tick }) => {
  tick();
});
test('deliberate assertion failure', ({ network, expectSignal }) => {
  expectSignal(network("output"), A).toBe(99);
});
test('resolved Entity circuit and fresh session', ({ execution, network, expectSignal, tick }) => {
  const entity = execution.debug.root.entities[0];
  if (entity?.entityId !== "${planWithEntityDebugInstance.entities[0]!.id}") throw new Error("missing Entity debug mapping");
  if (execution.instance(1).value?.entityId !== "${planWithEntityDebugInstance.entities[0]!.id}") throw new Error("missing debug instance");
  expectSignal(network("output"), A).toBe(0);
  tick(2);
});`,
      resolvedCircuit,
    );

    expect(run).toMatchObject({ passed: 2, failed: 1 });
    expect(run.results[0]).toMatchObject({ status: 'passed', trace: { endTick: 1 } });
    expect(run.results[1]).toMatchObject({
      status: 'failed',
      failureKind: 'assertion',
      details: { tick: 0, matcher: 'toBe()' },
    });
    expect(run.results[2]).toMatchObject({ status: 'passed', trace: { endTick: 2 } });
    expect(structuredClone(run)).toEqual(run);
  });

  it('rejects stale plans and resolved circuits with missing Entity identity', () => {
    const compiled = compileSource(
      {
        path: 'entity-pair-test.factorio.ts',
        text: "const object = Entity('entity:web-test-container');",
      },
      entityHost(),
    );
    if (compiled.plan === undefined || compiled.resolvedCircuit === undefined) {
      throw new Error('Expected a plan and resolved circuit for the synthetic Entity fixture.');
    }

    const stalePlan = {
      ...compiled.plan,
      entities: compiled.plan.entities.map((entity) => ({
        ...entity,
        ordinal: entity.ordinal + 1,
      })),
    };
    const stale = runWebTests(
      stalePlan,
      `test('must not run', () => {});`,
      compiled.resolvedCircuit,
    );
    expect(stale).toMatchObject({
      passed: 0,
      failed: 1,
      results: [{ name: 'Circuit setup', message: expect.stringContaining('fingerprint') }],
    });

    const missingEntity = {
      ...compiled.resolvedCircuit,
      ir: {
        ...compiled.resolvedCircuit.ir,
        entities: compiled.resolvedCircuit.ir.entities.map((entity) => ({
          ...entity,
          id: 'entity:missing' as typeof entity.id,
        })),
      },
    } satisfies ResolvedCircuit;
    const missing = runWebTests(compiled.plan, `test('must not run', () => {});`, missingEntity);
    expect(missing).toMatchObject({
      passed: 0,
      failed: 1,
      results: [{ name: 'Circuit setup', message: expect.stringContaining('is missing') }],
    });
  });

  it('rejects Network handles owned by another resolved execution', () => {
    const compiled = compileSource({ path: 'foreign-network.factorio.ts', text: source });
    if (compiled.plan === undefined || compiled.resolvedCircuit === undefined) {
      throw new Error('Expected a Direct Plan and resolved circuit.');
    }
    const first = executeResolvedDirectPlan(compiled.plan, compiled.resolvedCircuit);
    const second = executeResolvedDirectPlan(compiled.plan, compiled.resolvedCircuit);
    const session = first.createTestSession();
    expect(() => session.drive(second.network('input'), [])).toThrow(
      'Foreign or invalid Network handle.',
    );
  });

  it('runs an Entity-free browser example through the legacy plan-only route', () => {
    const run = runWebTests(
      plan(),
      `const A = Signal("virtual", "signal-A");
test('ticks a direct plan', ({ tick }) => {
  tick();
});`,
    );
    expect(run).toMatchObject({ passed: 1, failed: 0 });
  });

  it('runs every test against a fresh elaborated circuit', () => {
    const run = runWebTests(
      plan(),
      `const A = Signal("virtual", "signal-A");
test("passes", ({ network, drive, tick, expectSignal }) => {
  drive(network("input"), [[A, 4]]);
  tick(2);
  expectSignal(network("output"), A).toBe(5);
});
test("fresh session", ({ network, expectSignal }) => {
  expectSignal(network("output"), A).toBe(0);
});`,
    );
    expect(run).toMatchObject({ passed: 2, failed: 0 });
  });

  it('reports assertion failures without preventing later tests', () => {
    const run = runWebTests(
      plan(),
      `const A = Signal("virtual", "signal-A");
test("fails", ({ network, expectSignal }) => {
  expectSignal(network("output"), A).toBe(99);
});
test("still runs", ({ network, expectSignal }) => {
  expectSignal(network("output"), A).toBe(0);
});`,
    );
    expect(run).toMatchObject({ passed: 1, failed: 1 });
    expect(run.results[0]).toMatchObject({
      name: 'fails',
      status: 'failed',
      failureKind: 'assertion',
      line: 3,
      message: expect.stringContaining('Expected: 99'),
      details: { tick: 0, matcher: 'toBe()' },
      trace: { format: 'comblang-trace', version: 1 },
    });
    expect(run.results[1]).toMatchObject({ name: 'still runs', status: 'passed' });
  });

  it('turns test-file execution errors into a visible result', () => {
    const run = runWebTests(plan(), 'throw new Error("broken test file");');
    expect(run).toMatchObject({
      passed: 0,
      failed: 1,
      results: [{ name: 'Test file', status: 'failed', message: 'broken test file' }],
    });
  });

  it('returns trace documents and structured debug-query failures', () => {
    const run = runWebTests(
      plan(),
      `test("traces", ({ network, session, tick }) => {
  session.trace(network("output"));
  tick();
});
test("bad query", ({ execution }) => {
  execution.debug.root.network("missing");
});`,
    );

    expect(run.results[0]).toMatchObject({
      status: 'passed',
      trace: {
        format: 'comblang-trace',
        version: 1,
        endTick: 1,
        targets: [{ kind: 'network' }],
      },
    });
    expect(run.results[1]).toMatchObject({
      status: 'failed',
      failureKind: 'debug-query',
      code: 'DBG1001',
      candidates: expect.any(Array),
      debugScopePath: [],
      debug: { format: 'comblang-debug', version: 1 },
    });
    const transported = structuredClone(run.results[0]!);
    expect(transported.debug).toEqual(run.results[0]!.debug);
    const target = transported.trace!.targets[0]!;
    if (target.kind !== 'network') throw new Error('Expected a Network trace.');
    expect(transported.debug!.scopes[0]!.producers[0]!.outputs).toContain(target.networkId);
  });
});
