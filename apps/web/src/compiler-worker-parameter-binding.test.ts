import { afterEach, describe, expect, test, vi } from 'vitest';
import * as prototypeApi from '@comblang/prototypes';
import { syntheticPrototypeDatabase } from '@comblang/prototypes';
import { parseLosslessJson } from '@comblang/blueprint/document';
import { BlueprintExchangeError } from '@comblang/blueprint/errors';
import * as blueprintExchangeCodec from '@comblang/blueprint/exchange-codec';
import {
  createTrustedEntityReplayContext,
  entityReplayContextTransport,
  generateBlueprintJson,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import type { EntityProfile } from '@comblang/compiler/entity';
import type { EntityPrototype } from '@comblang/prototypes';
import type { EntityPrototypeResolver } from '@comblang/runtime/entity-registry';
import type { BoundSourceCompilationCircuit } from '@comblang/runtime/source-compilation';
import type { SourceParameterOverride } from '@comblang/runtime/source-parameter-binding';
import { signal } from '@comblang/factorio';

import {
  CompilerWorkerParameterBindingError,
  CompilerWorkerRuntime,
} from './compiler-worker-request.js';
import { CompilerWorkerScheduler } from './compiler-worker-scheduler.js';
import { createParameterDrafts, parameterDraftOverrides } from './parameter-panel.js';
import { createSourceCircuitArtifact } from './source-circuit-artifact.js';
import { SourceSimulationController } from './source-demo.js';
import { runWebTests } from './web-test-runner.js';
import { selectBlueprintPanel } from './blueprint-panel.js';
import type {
  CompilerWorkerBindRequest,
  CompilerWorkerBoundResponse,
  CompilerWorkerRequest,
} from './worker-protocol.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const parameterFile = {
  path: 'worker-parameter-session.factorio.ts',
  text: `globalThis.__worker_parameter_runs = Number(globalThis.__worker_parameter_runs ?? 0) + 1;
const amount = Param.number('Amount', 5);
const channel = Param.signal('Channel', Signal('virtual', 'signal-A'));
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: channel, value: amount }] }] });`,
};

const localExpressionRunKey = '__worker_local_expression_runs';
const localExpressionFile = {
  path: 'worker-local-expression.factorio.ts',
  text: `globalThis.${localExpressionRunKey} = Number(globalThis.${localExpressionRunKey} ?? 0) + 1;
const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5);
const factor = Param.number('Factor', 2);
const input = new Network();
const output = new Network();
input += Constant({ sections: [{ filters: [{ signal: A, value: Math.abs((amount + 1) * factor) }] }] });
output += Arithmetic({ left: input[A], operation: 'multiply', right: amount - 1, output: A });`,
};

function parameterHost() {
  const families = [
    'constant-combinator',
    'arithmetic-combinator',
    'decider-combinator',
    'selector-combinator',
  ] as const;
  const profiles: EntityProfile[] = families.map((family, index) => ({
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${family}` as EntityProfile['ref']['prototypeKey'],
      profileId: `profile:worker-parameter-session-${index}` as EntityProfile['ref']['profileId'],
    },
    prototypeType: family,
  }));
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profiles[0]!.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'worker-parameter-session-evidence',
    policyIdentity: 'worker-parameter-session-policy',
    profiles,
  });
  const prototypes: readonly EntityPrototype[] = families.map((family) => ({
    key: `entity:${family}` as EntityPrototype['key'],
    name: family,
    type: family,
    tileWidth: 1,
    tileHeight: 1,
  }));
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: trustedEntityReplayContext.database,
    getEntity(nameOrKey) {
      return prototypes.find(
        (prototype) => nameOrKey === prototype.key || nameOrKey === prototype.name,
      );
    },
  };
  return {
    trustedEntityReplayContext,
    entityReplayContext: entityReplayContextTransport(trustedEntityReplayContext),
    entityPrototypeResolver,
  };
}

const host = parameterHost();

function parameterRuntime(): CompilerWorkerRuntime {
  return new CompilerWorkerRuntime({
    resolveEntityReplayContext: () => ({
      trustedEntityReplayContext: host.trustedEntityReplayContext,
      entityPrototypeResolver: host.entityPrototypeResolver,
    }),
  });
}

function parseRequest(
  revision: number,
  options: Record<string, unknown> = {},
): CompilerWorkerRequest {
  return {
    kind: 'parse',
    revision,
    file: parameterFile,
    entityReplayContext: host.entityReplayContext,
    ...options,
  } as CompilerWorkerRequest;
}

function runCount(): number {
  return Number((globalThis as Record<string, unknown>).__worker_parameter_runs ?? 0);
}

function resetRunCount(): void {
  (globalThis as Record<string, unknown>).__worker_parameter_runs = 0;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Worker-local source parameter sessions', () => {
  test('parameter drafts drive preview, independent tests and concrete JSON through retry and Reset without rerunning source', async () => {
    resetRunCount();
    const runtime = parameterRuntime();
    const parsed = structuredClone(
      await runtime.handle(parseRequest(90, { parameterBinding: true })),
    );
    if (
      parsed.parameterBinding?.ok !== true ||
      parsed.parameterBinding.token === undefined ||
      parsed.result.plan === undefined ||
      parsed.result.resolvedCircuit === undefined
    ) {
      throw new Error('Expected a concrete parse pair and parameter capture.');
    }
    const { parameters, token } = parsed.parameterBinding;
    const defaultsBefore = structuredClone(parameters);
    const original = { plan: parsed.result.plan, resolvedCircuit: parsed.result.resolvedCircuit };
    const originalBefore = structuredClone(original);
    let revision = 90;
    const bind = (overrides: readonly SourceParameterOverride[]) => {
      const request: CompilerWorkerBindRequest = {
        kind: 'bind-parameters',
        revision: ++revision,
        sourceRevision: 90,
        token,
        overrides,
      };
      const before = structuredClone(request);
      const response = structuredClone(runtime.handleBinding(structuredClone(request)));
      expect(request).toEqual(before);
      expect(runCount()).toBe(1);
      return response;
    };
    const consume = (
      pair: BoundSourceCompilationCircuit,
      amount: number,
      name: string,
      quality?: string,
    ) => {
      const before = structuredClone(pair);
      const artifact = createSourceCircuitArtifact(pair.plan, pair.resolvedCircuit);
      const controller = new SourceSimulationController(artifact);
      const channel = signal('virtual', name, quality);
      expect(controller.currentTick).toBe(0);
      expect(controller.timeline).toHaveLength(1);
      expect(controller.timeline[0]!.networks.every(({ signals }) => signals.length === 0)).toBe(
        true,
      );
      controller.stepFrom(0);
      expect(controller.signalValueAt(1, 'output', channel)).toBe(amount);
      const normalAmount = quality === undefined || quality === 'normal' ? amount : 0;
      expect(controller.signalValueAt(1, 'output', signal('virtual', name))).toBe(normalAmount);
      expect(controller.signalValueAt(1, 'output', signal('virtual', name, 'normal'))).toBe(
        normalAmount,
      );
      if (quality !== 'rare')
        expect(controller.signalValueAt(1, 'output', signal('virtual', name, 'rare'))).toBe(0);
      expect(artifact.blueprint.blueprint.entities[0]!.control_behavior).toMatchObject({
        sections: {
          sections: [
            {
              filters: [
                {
                  type: 'virtual',
                  name,
                  count: amount,
                  quality: quality ?? 'normal',
                },
              ],
            },
          ],
        },
      });
      const panel = selectBlueprintPanel({ parameters: false, concrete: artifact.blueprint });
      expect(panel.copyPayload).toBe(JSON.stringify(artifact.blueprint, null, 2));
      expect(JSON.parse(panel.copyPayload!)).not.toHaveProperty('blueprint.parameters');
      expect(
        selectBlueprintPanel({ parameters: true, concrete: artifact.blueprint }),
      ).toMatchObject({
        state: 'invalid',
        status: 'Parameter export unavailable',
      });
      expect(
        selectBlueprintPanel({ parameters: true, concrete: artifact.blueprint }).copyPayload,
      ).toBeUndefined();
      const output = artifact.execution.network('output');
      controller.setSignalAt(0, output.id, channel, 123);
      controller.stepFrom(0, 3);
      expect(controller.currentTick).toBe(3);
      const signalExpression = `Signal('virtual', ${JSON.stringify(name)}${quality === undefined ? '' : `, ${JSON.stringify(quality)}`})`;
      const run = runWebTests(
        pair.plan,
        `const channel = ${signalExpression};
test('chosen value in independent session', ({ network, tick, expectSignal }) => {
  expectSignal(network('output'), channel).toBe(0);
  tick(1); expectSignal(network('output'), channel).toBe(${amount});
  expectSignal(network('output'), Signal('virtual', ${JSON.stringify(name)})).toBe(${normalAmount});
  expectSignal(network('output'), Signal('virtual', ${JSON.stringify(name)}, 'normal')).toBe(${normalAmount});
});
test('another fresh session', ({ network, tick, expectSignal }) => {
  expectSignal(network('output'), channel).toBe(0);
  tick(1); expectSignal(network('output'), channel).toBe(${amount});
});`,
        pair.resolvedCircuit,
      );
      expect(run).toMatchObject({ passed: 2, failed: 0 });
      expect(pair).toEqual(before);
      return controller;
    };
    const originalPreview = consume(original, 5, 'signal-A');
    const drafts = createParameterDrafts(parameters);
    const amount = drafts[0]!;
    const channel = drafts[1]!;
    if (amount.kind !== 'number' || channel.kind !== 'signal')
      throw new Error('Expected number and Signal drafts.');
    amount.value = '9';
    channel.name = 'signal-B';
    channel.quality = 'rare';
    const changed = bind(parameterDraftOverrides(parameters, drafts));
    if (!changed.result.ok) throw new Error('Expected a changed concrete pair.');
    const changedPair = changed.result;
    consume(changedPair, 9, 'signal-B', 'rare');
    expect(originalPreview.currentTick).toBe(3);
    expect(() => createSourceCircuitArtifact(original.plan, changedPair.resolvedCircuit)).toThrow();
    expect(
      runWebTests(
        original.plan,
        "test('unreachable mismatch', () => {});",
        changedPair.resolvedCircuit,
      ),
    ).toMatchObject({ passed: 0, failed: 1 });

    amount.value = ' ';
    const invalidNumber = bind(parameterDraftOverrides(parameters, drafts));
    expect(invalidNumber.result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'CP1000', span: parameters[0]!.source }],
    });
    amount.value = '9';
    channel.name = 'signal-each';
    const invalidSignal = bind(parameterDraftOverrides(parameters, drafts));
    expect(invalidSignal.result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'CP1000', span: parameters[1]!.source }],
    });

    amount.value = '-7';
    channel.name = 'signal-C';
    channel.quality = 'legendary';
    const retry = bind(parameterDraftOverrides(parameters, drafts));
    if (!retry.result.ok) throw new Error('Expected a valid retry.');
    consume(retry.result, -7, 'signal-C', 'legendary');
    const resetDrafts = createParameterDrafts(parameters);
    expect(parameterDraftOverrides(parameters, resetDrafts)).toEqual([]);
    const reset = bind([]);
    if (!reset.result.ok) throw new Error('Expected original defaults after Reset.');
    consume(reset.result, 5, 'signal-A');
    // Exercise actual retained binding messages, not just parameter-draft equality.
    const topology = {
      devices: original.plan.entities.length,
      producers: original.plan.producers.length,
      networks: original.plan.networks.length,
      timelineNetworks: originalPreview.timeline[0]!.networks.length,
      blueprintWires: createSourceCircuitArtifact(original.plan, original.resolvedCircuit).blueprint
        .blueprint.wires,
    };
    for (const quality of [undefined, 'normal', 'rare']) {
      const selected = bind([
        { id: 0, value: 9 },
        { id: 1, value: signal('virtual', 'signal-A', quality) },
      ]);
      if (!selected.result.ok) throw new Error('Expected a quality-specific matching pair.');
      const preview = consume(selected.result, 9, 'signal-A', quality);
      expect(selected.result.plan.entities).toHaveLength(topology.devices);
      expect(selected.result.plan.producers).toHaveLength(topology.producers);
      expect(selected.result.plan.networks).toHaveLength(topology.networks);
      expect(preview.timeline[0]!.networks).toHaveLength(topology.timelineNetworks);
      expect(
        createSourceCircuitArtifact(selected.result.plan, selected.result.resolvedCircuit).blueprint
          .blueprint.wires,
      ).toEqual(topology.blueprintWires);
      preview.reset();
      expect(preview.currentTick).toBe(0);
      expect(preview.timeline).toHaveLength(1);
      expect(preview.signalValueAt(0, 'output', signal('virtual', 'signal-A'))).toBe(0);
      expect(preview.signalValueAt(0, 'output', signal('virtual', 'signal-A', 'normal'))).toBe(0);
    }
    expect(parameters).toEqual(defaultsBefore);
    expect(original).toEqual(originalBefore);
    expect(runCount()).toBe(1);
  });

  test('automatic numeric defaults survive Worker listing, native export, preview, tests and Reset', async () => {
    const key = '__worker_automatic_number_runs';
    const globals = globalThis as Record<string, unknown>;
    const previous = globals[key];
    globals[key] = 0;
    try {
      const file = {
        path: 'worker-automatic-number.factorio.ts',
        text: `globalThis.${key} = Number(globalThis.${key} ?? 0) + 1;
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const amount = Param.number('Count');
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: A, value: amount },
  { signal: B, value: 2 },
] }] });`,
      };
      const runtime = parameterRuntime();
      const parsed = structuredClone(
        await runtime.handle(
          parseRequest(225, {
            file,
            parameterBinding: true,
            blueprintExport: { parameters: true },
          }),
        ),
      );
      expect(globals[key]).toBe(1);
      expect(parsed.result.pipelineDiagnostics).toEqual([]);
      expect(parsed.parameterBinding).toMatchObject({
        ok: true,
        parameters: [{ id: 0, kind: 'number', label: 'Count', defaultValue: 3 }],
      });
      expect(parsed.result.blueprintExport).toMatchObject({ ok: true });
      if (
        parsed.parameterBinding?.ok !== true ||
        parsed.parameterBinding.token === undefined ||
        parsed.result.blueprintExport?.ok !== true ||
        parsed.result.plan === undefined ||
        parsed.result.resolvedCircuit === undefined
      ) {
        throw new Error('Expected automatic defaults in the Worker compilation and native export.');
      }
      const token = parsed.parameterBinding.token;
      const blueprint = parsed.result.blueprintExport.document.blueprint;
      expect(blueprint.parameters).toEqual([{ type: 'number', number: '3', name: 'Count' }]);
      expect(blueprint.entities[0]!.control_behavior).toMatchObject({
        sections: {
          sections: [
            {
              filters: [
                { name: 'signal-A', count: 3 },
                { name: 'signal-B', count: 2 },
              ],
            },
          ],
        },
      });

      let revision = parsed.revision;
      const bind = (value?: number): CompilerWorkerBoundResponse => {
        const request: CompilerWorkerBindRequest = {
          kind: 'bind-parameters',
          revision: ++revision,
          sourceRevision: parsed.revision,
          token,
          overrides: value === undefined ? [] : [{ id: 0, value }],
        };
        return structuredClone(runtime.handleBinding(structuredClone(request)));
      };
      const pairOf = (response: CompilerWorkerBoundResponse): BoundSourceCompilationCircuit => {
        if (!response.result.ok) throw new Error('Expected a concrete automatic-default binding.');
        return response.result;
      };
      const consume = (pair: BoundSourceCompilationCircuit, count: number) => {
        const artifact = createSourceCircuitArtifact(pair.plan, pair.resolvedCircuit);
        expect(artifact.blueprint.blueprint.entities[0]!.control_behavior).toMatchObject({
          sections: { sections: [{ filters: [{ name: 'signal-A', count }, { count: 2 }] }] },
        });
        const preview = new SourceSimulationController(artifact);
        preview.stepFrom(0);
        expect(preview.signalValueAt(1, 'output', signal('virtual', 'signal-A'))).toBe(count);
        expect(
          runWebTests(
            pair.plan,
            `const A = Signal('virtual', 'signal-A');\ntest('effective automatic value', ({ network, tick, expectSignal }) => { expectSignal(network('output'), A).toBe(0); tick(1); expectSignal(network('output'), A).toBe(${count}); });`,
            pair.resolvedCircuit,
          ),
        ).toMatchObject({ passed: 1, failed: 0 });
      };

      const defaults = pairOf(bind());
      const overridden = pairOf(bind(9));
      const reset = pairOf(bind());
      consume(defaults, 3);
      consume(overridden, 9);
      consume(reset, 3);
      expect(reset.plan).toEqual(defaults.plan);
      expect(blueprint.parameters).toEqual([{ type: 'number', number: '3', name: 'Count' }]);
      expect(globals[key]).toBe(1);
      expect(JSON.stringify(parsed)).not.toMatch(
        /parameterContext|configurationTemplate|sourceHandle/i,
      );
    } finally {
      if (previous === undefined) delete globals[key];
      else globals[key] = previous;
    }
  });

  test('keeps primary Constant Math-function and Arithmetic expressions local across Worker consumers and native rejection', async () => {
    const globals = globalThis as Record<string, unknown>;
    const previous = globals[localExpressionRunKey];
    globals[localExpressionRunKey] = 0;
    try {
      const runtime = parameterRuntime();
      const parsed = structuredClone(
        await runtime.handle(
          parseRequest(200, {
            file: localExpressionFile,
            parameterBinding: true,
            blueprintExport: { parameters: true },
          }),
        ),
      );
      expect(globals[localExpressionRunKey]).toBe(1);
      expect(
        parsed.result.pipelineDiagnostics.filter(({ severity }) => severity === 'error'),
      ).toEqual([]);
      expect(parsed.result.blueprintExport).toMatchObject({ ok: false });
      expect(JSON.stringify(parsed.result.blueprintExport)).toContain('CP1002');
      expect(parsed.result.plan?.entities).toHaveLength(2);
      expect(parsed.result.plan?.producers).toHaveLength(2);
      if (
        parsed.parameterBinding?.ok !== true ||
        parsed.parameterBinding.token === undefined ||
        parsed.result.plan === undefined ||
        parsed.result.resolvedCircuit === undefined
      ) {
        throw new Error('Expected a concrete pair and retained local-expression session.');
      }
      const { parameters, token } = parsed.parameterBinding;
      expect(
        parameters.map(({ id, kind, label, defaultValue }) => ({
          id,
          kind,
          label,
          defaultValue,
        })),
      ).toEqual([
        { id: 0, kind: 'number', label: 'Amount', defaultValue: 5 },
        { id: 1, kind: 'number', label: 'Factor', defaultValue: 2 },
      ]);
      expect(structuredClone(parameters)).toEqual(parameters);
      expect(
        parameters.every((parameter) => Object.getOwnPropertySymbols(parameter).length === 0),
      ).toBe(true);
      expect(JSON.stringify(parameters)).not.toMatch(/binary|numericExpression|expressionRoot/i);
      expect(parsed.result).not.toHaveProperty('execution');
      expect(parsed.result).not.toHaveProperty('session');
      expect(parsed.result).not.toHaveProperty('parameters');
      expect(structuredClone(parsed)).toEqual(parsed);

      let revision = parsed.revision;
      const bind = (overrides: readonly SourceParameterOverride[]) => {
        const request: CompilerWorkerBindRequest = {
          kind: 'bind-parameters',
          revision: ++revision,
          sourceRevision: parsed.revision,
          token,
          overrides,
        };
        const originalRequest = structuredClone(request);
        const response: CompilerWorkerBoundResponse = structuredClone(
          runtime.handleBinding(structuredClone(request)),
        );
        expect(request).toEqual(originalRequest);
        expect(structuredClone(response)).toEqual(response);
        expect(globals[localExpressionRunKey]).toBe(1);
        return response;
      };
      const pairOf = (response: CompilerWorkerBoundResponse) => {
        if (!response.result.ok) throw new Error('Expected a concrete bound pair.');
        return response.result;
      };
      const defaults = pairOf(bind([]));
      const overridden = pairOf(
        bind([
          { id: 0, value: 9 },
          { id: 1, value: 3 },
        ]),
      );
      const reset = pairOf(bind([]));
      expect(defaults.plan).toEqual(parsed.result.plan);
      expect(defaults.resolvedCircuit).toEqual(parsed.result.resolvedCircuit);
      expect(reset.plan).toEqual(defaults.plan);
      expect(reset.resolvedCircuit).toEqual(defaults.resolvedCircuit);

      const consume = (
        pair: BoundSourceCompilationCircuit,
        count: number,
        right: number,
        result: number,
      ) => {
        const before = structuredClone(pair);
        const artifact = createSourceCircuitArtifact(pair.plan, pair.resolvedCircuit);
        expect(artifact.blueprint.blueprint.entities).toHaveLength(2);
        const constant = artifact.blueprint.blueprint.entities.find(
          ({ name }) => name === 'constant-combinator',
        );
        const arithmetic = artifact.blueprint.blueprint.entities.find(
          ({ name }) => name === 'arithmetic-combinator',
        );
        expect(constant?.control_behavior).toMatchObject({
          sections: { sections: [{ filters: [{ name: 'signal-A', count }] }] },
        });
        expect(arithmetic?.control_behavior).toMatchObject({
          arithmetic_conditions: { first_signal: { name: 'signal-A' }, second_constant: right },
        });
        const controller = new SourceSimulationController(artifact);
        const channel = signal('virtual', 'signal-A');
        expect(controller.signalValueAt(0, 'input', channel)).toBe(0);
        expect(controller.signalValueAt(0, 'output', channel)).toBe(0);
        controller.stepFrom(0);
        expect(controller.signalValueAt(1, 'input', channel)).toBe(count);
        expect(controller.signalValueAt(1, 'output', channel)).toBe(0);
        controller.stepFrom(1);
        expect(controller.signalValueAt(2, 'output', channel)).toBe(result);

        const panel = selectBlueprintPanel({ parameters: false, concrete: artifact.blueprint });
        expect(panel.copyPayload).toBe(JSON.stringify(artifact.blueprint, null, 2));
        expect(JSON.parse(panel.copyPayload!)).not.toHaveProperty('blueprint.parameters');
        expect(
          selectBlueprintPanel({ parameters: true, concrete: artifact.blueprint }),
        ).toMatchObject({
          state: 'invalid',
          status: 'Parameter export unavailable',
        });
        const tests = runWebTests(
          pair.plan,
          `const A = Signal('virtual', 'signal-A');
test('primary T0/T1/T2', ({ network, tick, expectSignal }) => {
  expectSignal(network('input'), A).toBe(0);
  expectSignal(network('output'), A).toBe(0);
  tick();
  expectSignal(network('input'), A).toBe(${count});
  expectSignal(network('output'), A).toBe(0);
  tick();
  expectSignal(network('output'), A).toBe(${result});
});
test('primary independent session', ({ network, tick, expectSignal }) => {
  expectSignal(network('input'), A).toBe(0);
  expectSignal(network('output'), A).toBe(0);
  tick();
  expectSignal(network('input'), A).toBe(${count});
  tick();
  expectSignal(network('output'), A).toBe(${result});
});`,
          pair.resolvedCircuit,
        );
        expect(tests).toMatchObject({ passed: 2, failed: 0 });
        expect(pair).toEqual(before);
        return artifact.blueprint.blueprint.wires;
      };

      const wires = consume(defaults, 12, 4, 48);
      expect(consume(overridden, 30, 8, 240)).toEqual(wires);
      expect(consume(reset, 12, 4, 48)).toEqual(wires);
      expect(globals[localExpressionRunKey]).toBe(1);
    } finally {
      if (previous === undefined) delete globals[localExpressionRunKey];
      else globals[localExpressionRunKey] = previous;
    }
  });

  test('binds exact Decider thresholds through retained Worker consumers and native refusal', async () => {
    const globals = globalThis as Record<string, unknown>;
    const previous = globals[localExpressionRunKey];
    globals[localExpressionRunKey] = 0;
    try {
      const runtime = parameterRuntime();
      const file = {
        path: 'worker-decider-threshold.factorio.ts',
        text: `globalThis.${localExpressionRunKey} = Number(globalThis.${localExpressionRunKey} ?? 0) + 1;
const A = Signal('virtual', 'signal-A', 'rare');
const amount = Param.number('Amount', 5);
const threshold = amount * 2 - 1;
const input = new Network();
const output = new Network();
input += CC(7 * A);
output += Decider({ condition: input[A] > threshold, outputs: [input[A]] });`,
      };
      const parsed = structuredClone(
        await runtime.handle(
          parseRequest(230, {
            file,
            parameterBinding: true,
            blueprintExport: { parameters: true },
          }),
        ),
      );
      expect(structuredClone(parsed)).toEqual(parsed);
      expect(globals[localExpressionRunKey]).toBe(1);
      expect(parsed.result.pipelineDiagnostics).toEqual([]);
      expect(parsed.result.blueprintExport).toMatchObject({
        ok: false,
        diagnostics: [
          {
            code: 'CP1002',
            severity: 'error',
            span: {
              fileId: expect.any(String),
              start: expect.any(Number),
              end: expect.any(Number),
            },
          },
        ],
      });
      const binding = parsed.parameterBinding;
      if (
        binding?.ok !== true ||
        binding.token === undefined ||
        parsed.result.plan === undefined ||
        parsed.result.resolvedCircuit === undefined
      ) {
        throw new Error('Expected the retained Decider parameter session despite export refusal.');
      }
      expect(binding.parameters).toMatchObject([
        { id: 0, kind: 'number', label: 'Amount', defaultValue: 5 },
      ]);
      expect(structuredClone(binding.parameters)).toEqual(binding.parameters);

      let revision = parsed.revision;
      const bind = (value?: number) => {
        const request: CompilerWorkerBindRequest = {
          kind: 'bind-parameters',
          revision: ++revision,
          sourceRevision: parsed.revision,
          token: binding.token!,
          overrides: value === undefined ? [] : [{ id: 0, value }],
        };
        const response: CompilerWorkerBoundResponse = structuredClone(
          runtime.handleBinding(structuredClone(request)),
        );
        expect(structuredClone(response)).toEqual(response);
        expect(globals[localExpressionRunKey]).toBe(1);
        return response;
      };
      const pair = (response: CompilerWorkerBoundResponse) => {
        if (!response.result.ok) throw new Error('Expected a valid Decider parameter binding.');
        return response.result;
      };
      const defaults = pair(bind());
      const defaultsBefore = structuredClone(defaults);
      const overridden = pair(bind(3));
      const overriddenBefore = structuredClone(overridden);
      const invalid = bind(0.25);
      expect(invalid.result).toMatchObject({
        ok: false,
        diagnostics: [
          {
            code: 'CP1000',
            severity: 'error',
            span: binding.parameters[0]!.source,
          },
        ],
      });
      expect(invalid.result).not.toHaveProperty('plan');
      expect(invalid.result).not.toHaveProperty('resolvedCircuit');
      expect(defaults).toEqual(defaultsBefore);
      expect(overridden).toEqual(overriddenBefore);
      const retry = pair(bind(3));
      const reset = pair(bind());
      expect(reset.plan).toEqual(defaults.plan);
      expect(reset.resolvedCircuit).toEqual(defaults.resolvedCircuit);

      const topology = (selected: typeof defaults) => ({
        entities: selected.plan.entities.map(({ id, profile }) => ({
          id,
          profileId: profile.profileId,
        })),
        producers: selected.plan.producers.map(({ entityId, kind }) => ({ entityId, kind })),
        placements: selected.resolvedCircuit.ir.entities.map(({ id, placement }) => ({
          id,
          placement,
        })),
        networks: selected.resolvedCircuit.ir.networks,
        networkPairs: selected.plan.networkPairs,
      });
      expect(topology(overridden)).toEqual(topology(defaults));
      expect(topology(reset)).toEqual(topology(defaults));

      const consume = (selected: typeof defaults, thresholdValue: number, expected: number) => {
        const before = structuredClone(selected);
        const artifact = createSourceCircuitArtifact(selected.plan, selected.resolvedCircuit);
        const constant = artifact.blueprint.blueprint.entities.find(
          ({ name }) => name === 'constant-combinator',
        );
        const decider = artifact.blueprint.blueprint.entities.find(
          ({ name }) => name === 'decider-combinator',
        );
        expect(artifact.blueprint.blueprint.entities).toHaveLength(2);
        expect(constant?.control_behavior).toMatchObject({
          sections: {
            sections: [{ filters: [{ name: 'signal-A', quality: 'rare', count: 7 }] }],
          },
        });
        expect(decider?.control_behavior).toMatchObject({
          decider_conditions: {
            conditions: [
              {
                first_signal: { name: 'signal-A', quality: 'rare' },
                comparator: '>',
                constant: thresholdValue,
              },
            ],
            outputs: [
              { signal: { name: 'signal-A', quality: 'rare' }, copy_count_from_input: true },
            ],
          },
        });
        expect(artifact.blueprint.blueprint).not.toHaveProperty('parameters');
        const controller = new SourceSimulationController(artifact);
        const rare = signal('virtual', 'signal-A', 'rare');
        expect(controller.currentTick).toBe(0);
        expect(controller.timeline).toHaveLength(1);
        expect(controller.timeline[0]!.networks.every(({ signals }) => signals.length === 0)).toBe(
          true,
        );
        expect(controller.signalValueAt(0, 'input', rare)).toBe(0);
        expect(controller.signalValueAt(0, 'output', rare)).toBe(0);
        controller.stepFrom(0);
        expect(controller.signalValueAt(1, 'input', rare)).toBe(7);
        expect(controller.signalValueAt(1, 'output', rare)).toBe(0);
        controller.stepFrom(1);
        expect(controller.signalValueAt(2, 'output', rare)).toBe(expected);
        expect(controller.signalValueAt(2, 'output', signal('virtual', 'signal-A'))).toBe(0);

        const panel = selectBlueprintPanel({ parameters: false, concrete: artifact.blueprint });
        expect(panel.copyPayload).toBe(JSON.stringify(artifact.blueprint, null, 2));
        expect(
          selectBlueprintPanel({ parameters: true, concrete: artifact.blueprint }),
        ).toMatchObject({ state: 'invalid', status: 'Parameter export unavailable' });
        const webTests = runWebTests(
          selected.plan,
          `const A = Signal('virtual', 'signal-A', 'rare');
test('fresh exact Decider result', ({ network, tick, expectSignal }) => {
  expectSignal(network('input'), A).toBe(0);
  expectSignal(network('output'), A).toBe(0);
  tick(2);
  expectSignal(network('input'), A).toBe(7);
  expectSignal(network('output'), A).toBe(${expected});
  expectSignal(network('output'), Signal('virtual', 'signal-A')).toBe(0);
});
test('a later test starts from empty T0', ({ network, tick, expectSignal }) => {
  expectSignal(network('input'), A).toBe(0);
  expectSignal(network('output'), A).toBe(0);
  tick(2);
  expectSignal(network('input'), A).toBe(7);
  expectSignal(network('output'), A).toBe(${expected});
});`,
          selected.resolvedCircuit,
        );
        expect(webTests).toMatchObject({ passed: 2, failed: 0 });
        expect(selected).toEqual(before);
        controller.reset();
        expect(controller.currentTick).toBe(0);
        expect(controller.timeline).toHaveLength(1);
        expect(controller.signalValueAt(0, 'output', rare)).toBe(0);
        return artifact.blueprint.blueprint.wires;
      };

      const wires = consume(defaults, 9, 0);
      expect(consume(overridden, 5, 7)).toEqual(wires);
      expect(consume(retry, 5, 7)).toEqual(wires);
      expect(consume(reset, 9, 0)).toEqual(wires);
      expect(() =>
        createSourceCircuitArtifact(defaults.plan, overridden.resolvedCircuit),
      ).toThrow();
      expect(
        runWebTests(
          defaults.plan,
          "test('mismatched Decider pair', () => {});",
          overridden.resolvedCircuit,
        ),
      ).toMatchObject({ passed: 0, failed: 1 });
      expect(defaults).toEqual(defaultsBefore);
      expect(overridden).toEqual(overriddenBefore);
      expect(globals[localExpressionRunKey]).toBe(1);
    } finally {
      if (previous === undefined) delete globals[localExpressionRunKey];
      else globals[localExpressionRunKey] = previous;
    }
  });

  test('binds parameterized EACH Decider outputs through Worker override and reset', async () => {
    const globals = globalThis as Record<string, unknown>;
    const previous = globals[localExpressionRunKey];
    globals[localExpressionRunKey] = 0;
    try {
      const runtime = parameterRuntime();
      const parsed = structuredClone(
        await runtime.handle(
          parseRequest(231, {
            file: {
              path: 'worker-decider-each-output.factorio.ts',
              text: `globalThis.${localExpressionRunKey} = Number(globalThis.${localExpressionRunKey} ?? 0) + 1;
const amount = Param.number('Count', 2, { variable: 'x' });
const input = new Network();
const output = new Network();
const gate = when(input[EACH] > 0).then(amount * EACH);
output += gate;
gate.then(EACH * amount);
gate.else(amount * EACH);`,
            },
            parameterBinding: true,
            blueprintExport: { parameters: true },
          }),
        ),
      );
      expect(globals[localExpressionRunKey]).toBe(1);
      expect(parsed.result.pipelineDiagnostics).toEqual([]);
      expect(parsed.result.blueprintExport).toMatchObject({ ok: true });
      if (parsed.result.blueprintExport?.ok !== true) {
        throw new Error('Expected a native-template Worker export for Decider output counts.');
      }
      const template = parsed.result.blueprintExport.document.blueprint;
      expect(template.parameters).toEqual([
        { type: 'number', number: '2', name: 'Count', variable: 'x' },
      ]);
      expect(template.entities[0]?.control_behavior).toMatchObject({
        decider_conditions: {
          conditions: [{ constant: 0 }],
          outputs: [
            { signal: { type: 'virtual', name: 'signal-each' }, constant: 2 },
            { signal: { type: 'virtual', name: 'signal-each' }, constant: 2 },
          ],
          else_outputs: [{ signal: { type: 'virtual', name: 'signal-each' }, constant: 2 }],
        },
      });
      const binding = parsed.parameterBinding;
      if (binding?.ok !== true || binding.token === undefined) {
        throw new Error('Expected the retained Worker EACH-output binding session.');
      }
      expect(binding.parameters).toMatchObject([
        { id: 0, kind: 'number', label: 'Count', defaultValue: 2 },
      ]);

      let revision = parsed.revision;
      const bind = (value?: number) =>
        structuredClone(
          runtime.handleBinding({
            kind: 'bind-parameters',
            revision: ++revision,
            sourceRevision: parsed.revision,
            token: binding.token!,
            overrides: value === undefined ? [] : [{ id: 0, value }],
          }),
        );
      const pair = (response: CompilerWorkerBoundResponse) => {
        if (!response.result.ok) throw new Error('Expected a valid Worker EACH-output binding.');
        return response.result;
      };
      const defaults = pair(bind());
      const overridden = pair(bind(9));
      const reset = pair(bind());
      const decider = (selected: typeof defaults) => {
        const producer = selected.plan.producers.find(({ kind }) => kind === 'decider');
        if (producer?.kind !== 'decider') throw new Error('Expected the bound Decider.');
        return producer;
      };
      expect(decider(defaults)).toMatchObject({
        condition: { kind: 'compare-each', constant: 0 },
        outputs: [
          { kind: 'each-constant', value: 2 },
          { kind: 'each-constant', value: 2 },
        ],
        elseOutputs: [{ kind: 'each-constant', value: 2 }],
      });
      expect(decider(overridden)).toMatchObject({
        condition: { kind: 'compare-each', constant: 0 },
        outputs: [
          { kind: 'each-constant', value: 9 },
          { kind: 'each-constant', value: 9 },
        ],
        elseOutputs: [{ kind: 'each-constant', value: 9 }],
      });
      expect(reset.plan).toEqual(defaults.plan);
      const topology = (selected: typeof defaults) => ({
        entities: selected.plan.entities.map(({ id, profile }) => ({
          id,
          profile: profile.profileId,
        })),
        producers: selected.resolvedCircuit.ir.producers.map(({ id, entityId }) => ({
          id,
          entityId,
        })),
        circuitEntities: selected.resolvedCircuit.ir.entities.map(({ id, placement }) => ({
          id,
          placement,
        })),
        networks: selected.resolvedCircuit.ir.networks,
        networkPairs: selected.plan.networkPairs,
      });
      expect(topology(overridden)).toEqual(topology(defaults));
      expect(topology(reset)).toEqual(topology(defaults));
      expect(
        createSourceCircuitArtifact(overridden.plan, overridden.resolvedCircuit).blueprint.blueprint
          .entities[0]?.control_behavior,
      ).toMatchObject({
        decider_conditions: {
          outputs: [
            { signal: { type: 'virtual', name: 'signal-each' }, constant: 9 },
            { signal: { type: 'virtual', name: 'signal-each' }, constant: 9 },
          ],
          else_outputs: [{ signal: { type: 'virtual', name: 'signal-each' }, constant: 9 }],
        },
      });
      expect(
        createSourceCircuitArtifact(overridden.plan, overridden.resolvedCircuit).blueprint
          .blueprint,
      ).not.toHaveProperty('parameters');
      expect(JSON.stringify(parsed)).not.toMatch(
        /parameterContext|configurationTemplate|sourceHandle/i,
      );
      expect(globals[localExpressionRunKey]).toBe(1);
    } finally {
      if (previous === undefined) delete globals[localExpressionRunKey];
      else globals[localExpressionRunKey] = previous;
    }
  });

  test('preserves Signal quality and retries invalid derived counts on retained Worker sessions', async () => {
    const globals = globalThis as Record<string, unknown>;
    const previous = globals[localExpressionRunKey];
    globals[localExpressionRunKey] = 0;
    try {
      const runtime = parameterRuntime();
      const qualityFile = {
        path: 'worker-local-expression-quality.factorio.ts',
        text: `globalThis.${localExpressionRunKey} = Number(globalThis.${localExpressionRunKey} ?? 0) + 1;
const channel = Param.signal('Channel', Signal('virtual', 'signal-A'));
const amount = Param.number('Amount', 5);
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: channel, value: amount + 1 }] }] });`,
      };
      const qualityParse = structuredClone(
        await runtime.handle(parseRequest(210, { file: qualityFile, parameterBinding: true })),
      );
      expect(globals[localExpressionRunKey]).toBe(1);
      const qualityBinding = qualityParse.parameterBinding;
      if (qualityBinding?.ok !== true || qualityBinding.token === undefined) {
        throw new Error('Expected a retained Signal/count expression session.');
      }
      expect(
        qualityBinding.parameters.map(({ id, kind, label, defaultValue }) => ({
          id,
          kind,
          label,
          defaultValue,
        })),
      ).toEqual([
        {
          id: 0,
          kind: 'signal',
          label: 'Channel',
          defaultValue: { type: 'virtual', name: 'signal-A' },
        },
        { id: 1, kind: 'number', label: 'Amount', defaultValue: 5 },
      ]);
      const qualityRequest: CompilerWorkerBindRequest = {
        kind: 'bind-parameters',
        revision: 211,
        sourceRevision: qualityParse.revision,
        token: qualityBinding.token,
        overrides: [
          { id: 0, value: { type: 'virtual', name: 'signal-B', quality: 'rare' } },
          { id: 1, value: 9 },
        ],
      };
      const qualityBound: CompilerWorkerBoundResponse = structuredClone(
        runtime.handleBinding(structuredClone(qualityRequest)),
      );
      expect(structuredClone(qualityRequest)).toEqual(qualityRequest);
      expect(structuredClone(qualityBound)).toEqual(qualityBound);
      if (!qualityBound.result.ok) throw new Error('Expected a bound rare Signal pair.');
      const qualityPair = qualityBound.result;
      const qualityArtifact = createSourceCircuitArtifact(
        qualityPair.plan,
        qualityPair.resolvedCircuit,
      );
      expect(qualityArtifact.blueprint.blueprint.entities[0]?.control_behavior).toMatchObject({
        sections: {
          sections: [{ filters: [{ name: 'signal-B', quality: 'rare', count: 10 }] }],
        },
      });
      const qualityController = new SourceSimulationController(qualityArtifact);
      qualityController.stepFrom(0);
      expect(
        qualityController.signalValueAt(1, 'output', signal('virtual', 'signal-B', 'rare')),
      ).toBe(10);
      expect(qualityController.signalValueAt(1, 'output', signal('virtual', 'signal-B'))).toBe(0);
      const qualityTests = runWebTests(
        qualityPair.plan,
        `const rare = Signal('virtual', 'signal-B', 'rare');
test('rare identity in first test', ({ network, tick, expectSignal }) => {
  tick();
  expectSignal(network('output'), rare).toBe(10);
  expectSignal(network('output'), Signal('virtual', 'signal-B')).toBe(0);
});
test('rare identity in fresh test', ({ network, tick, expectSignal }) => {
  expectSignal(network('output'), rare).toBe(0);
  tick();
  expectSignal(network('output'), rare).toBe(10);
});`,
        qualityPair.resolvedCircuit,
      );
      expect(qualityTests).toMatchObject({ passed: 2, failed: 0 });
      expect(globals[localExpressionRunKey]).toBe(1);

      const unsafeFile = {
        path: 'worker-local-expression-unsafe-count.factorio.ts',
        text: `globalThis.${localExpressionRunKey} = Number(globalThis.${localExpressionRunKey} ?? 0) + 1;
const amount = Param.number('Amount', 0);
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: Signal('virtual', 'signal-A'), value: amount * 1e16 }] }] });`,
      };
      const unsafeParse = structuredClone(
        await runtime.handle(parseRequest(220, { file: unsafeFile, parameterBinding: true })),
      );
      expect(globals[localExpressionRunKey]).toBe(2);
      const unsafeBinding = unsafeParse.parameterBinding;
      if (unsafeBinding?.ok !== true || unsafeBinding.token === undefined) {
        throw new Error('Expected a retained unsafe-result test session.');
      }
      let revision = unsafeParse.revision;
      const bindUnsafe = (value: number) => {
        const request: CompilerWorkerBindRequest = {
          kind: 'bind-parameters',
          revision: ++revision,
          sourceRevision: unsafeParse.revision,
          token: unsafeBinding.token!,
          overrides: [{ id: 0, value }],
        };
        return structuredClone(runtime.handleBinding(structuredClone(request)));
      };
      const baselineResponse = bindUnsafe(0);
      if (!baselineResponse.result.ok) throw new Error('Expected the valid zero default.');
      const baseline = baselineResponse.result;
      const baselineBefore = structuredClone(baseline);
      const baselineArtifact = createSourceCircuitArtifact(baseline.plan, baseline.resolvedCircuit);
      const baselineArtifactBefore = structuredClone(baselineArtifact.blueprint);
      const failed = bindUnsafe(1);
      expect(failed.result).toMatchObject({
        ok: false,
        diagnostics: [{ code: 'CP1000', severity: 'error' }],
      });
      expect(failed.result).not.toHaveProperty('plan');
      expect(failed.result).not.toHaveProperty('resolvedCircuit');
      expect(baseline).toEqual(baselineBefore);
      expect(baselineArtifact.blueprint).toEqual(baselineArtifactBefore);
      expect(globals[localExpressionRunKey]).toBe(2);

      const retry = bindUnsafe(1e-15);
      if (!retry.result.ok) throw new Error('Expected a valid derived-count retry.');
      expect(retry.result.plan.producers[0]).toMatchObject({
        configuration: { sections: [{ filters: [{ value: 10 }] }] },
      });
      const reset = bindUnsafe(0);
      if (!reset.result.ok) throw new Error('Expected Reset to restore the valid default.');
      expect(reset.result.plan).toEqual(baseline.plan);
      expect(reset.result.resolvedCircuit).toEqual(baseline.resolvedCircuit);
      expect(globals[localExpressionRunKey]).toBe(2);
    } finally {
      if (previous === undefined) delete globals[localExpressionRunKey];
      else globals[localExpressionRunKey] = previous;
    }
  });

  test('bind operation returns its exact concrete pair with independent revisions and no source rerun', async () => {
    resetRunCount();
    const runtime = parameterRuntime();
    const parsed = await runtime.handle(parseRequest(100, { parameterBinding: true }));
    const token = parsed.parameterBinding?.ok === true ? parsed.parameterBinding.token : undefined;
    if (token === undefined) throw new Error('Expected a retained parameter token.');

    const request: CompilerWorkerBindRequest = {
      kind: 'bind-parameters',
      revision: 101,
      sourceRevision: 100,
      token,
      overrides: [
        { id: 0, value: 9 },
        { id: 1, value: { type: 'virtual', name: 'signal-B' } },
      ],
    };
    const bindParameters = vi.spyOn(runtime, 'bindParameters');
    const response: CompilerWorkerBoundResponse = runtime.handleBinding(request);

    expect(response).toMatchObject({
      kind: 'bound',
      revision: 101,
      sourceRevision: 100,
      result: { ok: true },
    });
    if (!response.result.ok) throw new Error('Expected a successful concrete binding.');
    expect(bindParameters).toHaveBeenCalledOnce();
    expect(bindParameters).toHaveBeenCalledWith(
      request.token,
      request.sourceRevision,
      request.overrides,
    );
    const delegatedPair = bindParameters.mock.results[0]!.value;
    expect(response.result.plan).toBe(delegatedPair.plan);
    expect(response.result.resolvedCircuit).toBe(delegatedPair.resolvedCircuit);
    expect(response.result.resolvedCircuit.ir.entities[0]!.configuration).toMatchObject({
      mode: 'constant',
      value: {
        sections: [{ filters: [{ signal: { type: 'virtual', name: 'signal-B' }, value: 9 }] }],
      },
    });
    expect(structuredClone(response)).toEqual(response);
    expect(runCount()).toBe(1);
  });

  test('scheduler coalesces binding snapshots and lets a newer parse replace queued binds', async () => {
    resetRunCount();
    const runtime = parameterRuntime();
    const scheduler = new CompilerWorkerScheduler();
    const workerId = scheduler.createWorker();
    scheduler.enqueue(parseRequest(150, { parameterBinding: true }));
    expect(scheduler.markReady(workerId)).toBe(true);

    const parseDispatch = scheduler.takeForDispatch();
    if (parseDispatch?.request.kind !== 'parse') throw new Error('Expected a parse dispatch.');
    const parsed = await runtime.handle(parseDispatch.request);
    expect(scheduler.complete(workerId, parsed)).toBe('accepted');
    const capture = scheduler.bindingCapture;
    if (capture === undefined) throw new Error('Expected the scheduler to capture the token.');

    const firstBinding: CompilerWorkerBindRequest = {
      kind: 'bind-parameters',
      revision: 151,
      sourceRevision: capture.sourceRevision,
      token: capture.token,
      overrides: [
        { id: 0, value: 9 },
        { id: 1, value: { type: 'virtual', name: 'signal-B' } },
      ],
    };
    const latestBinding: CompilerWorkerBindRequest = {
      ...firstBinding,
      revision: 152,
      overrides: [
        { id: 0, value: 17 },
        { id: 1, value: { type: 'virtual', name: 'signal-C' } },
      ],
    };
    expect(scheduler.enqueueBinding(firstBinding)).toBe(true);
    const firstDispatch = scheduler.takeForDispatch();
    if (firstDispatch?.request.kind !== 'bind-parameters') {
      throw new Error('Expected the first binding dispatch.');
    }
    expect(scheduler.enqueueBinding(latestBinding)).toBe(true);
    const supersededResponse = runtime.handleBinding(firstDispatch.request);
    expect(scheduler.complete(workerId, supersededResponse)).toBe('stale');

    const latestDispatch = scheduler.takeForDispatch();
    if (latestDispatch?.request.kind !== 'bind-parameters') {
      throw new Error('Expected the latest binding dispatch.');
    }
    expect(latestDispatch.request).toEqual(latestBinding);
    const latestResponse = runtime.handleBinding(latestDispatch.request);
    expect(scheduler.complete(workerId, latestResponse)).toBe('accepted');
    if (!latestResponse.result.ok) throw new Error('Expected a successful concrete binding.');
    expect(latestResponse.result.resolvedCircuit.ir.entities[0]!.configuration).toMatchObject({
      mode: 'constant',
      value: {
        sections: [{ filters: [{ signal: { type: 'virtual', name: 'signal-C' }, value: 17 }] }],
      },
    });
    expect(latestResponse.revision).toBe(152);
    expect(latestResponse.sourceRevision).toBe(150);
    expect(runCount()).toBe(1);

    const obsoleteBinding = { ...latestBinding, revision: 153 };
    const obsoleteRetry = { ...latestBinding, revision: 154 };
    expect(scheduler.enqueueBinding(obsoleteBinding)).toBe(true);
    const obsoleteDispatch = scheduler.takeForDispatch();
    if (obsoleteDispatch?.request.kind !== 'bind-parameters') {
      throw new Error('Expected an obsolete binding dispatch.');
    }
    expect(scheduler.enqueueBinding(obsoleteRetry)).toBe(true);
    scheduler.enqueue(parseRequest(155, { parameterBinding: true }));
    expect(scheduler.bindingCapture).toBeUndefined();
    expect(scheduler.complete(workerId, runtime.handleBinding(obsoleteDispatch.request))).toBe(
      'stale',
    );
    const replacementParse = scheduler.takeForDispatch();
    if (replacementParse?.request.kind !== 'parse') {
      throw new Error('Expected the newer parse to replace queued bindings.');
    }
    const replacementResponse = await runtime.handle(replacementParse.request);
    expect(scheduler.complete(workerId, replacementResponse)).toBe('accepted');
    expect(scheduler.bindingCapture).toMatchObject({
      workerId,
      sourceRevision: 155,
    });
    expect(scheduler.bindingCapture?.token).not.toBe(capture.token);
    expect(runCount()).toBe(2);
  });

  test('returns WP1007 for missing, mismatched, and other-runtime binding tokens', async () => {
    const runtime = parameterRuntime();
    const parsed = await runtime.handle(parseRequest(110, { parameterBinding: true }));
    const token = parsed.parameterBinding?.ok === true ? parsed.parameterBinding.token : undefined;
    if (token === undefined) throw new Error('Expected a retained parameter token.');

    const requests: CompilerWorkerBindRequest[] = [
      { kind: 'bind-parameters', revision: 111, sourceRevision: 110, token: 'wrong-token' },
      { kind: 'bind-parameters', revision: 112, sourceRevision: 111, token },
    ];
    for (const request of requests) {
      const response = runtime.handleBinding(request);
      expect(response).toMatchObject({
        kind: 'bound',
        revision: request.revision,
        sourceRevision: request.sourceRevision,
        result: { ok: false, diagnostics: [{ code: 'WP1007', severity: 'error' }] },
      });
      expect(structuredClone(response)).toEqual(response);
    }

    const otherRuntimeResponse = parameterRuntime().handleBinding({
      kind: 'bind-parameters',
      revision: 113,
      sourceRevision: 110,
      token,
    });
    expect(otherRuntimeResponse.result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'WP1007', severity: 'error' }],
    });
  });

  test('retains located parameter failures, permits retry, and treats each bind as a full snapshot', async () => {
    resetRunCount();
    const runtime = parameterRuntime();
    const parsed = await runtime.handle(parseRequest(120, { parameterBinding: true }));
    const binding = parsed.parameterBinding;
    if (binding?.ok !== true || binding.token === undefined) {
      throw new Error('Expected a retained parameter token.');
    }
    const source = binding.parameters[0]!.source;
    const failed = runtime.handleBinding({
      kind: 'bind-parameters',
      revision: 121,
      sourceRevision: 120,
      token: binding.token,
      overrides: [{ id: 0, value: 'nine' }],
    });
    expect(failed.result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: 'CP1000',
          severity: 'error',
          message: expect.stringContaining('$.overrides[0].value'),
          span: source,
        },
      ],
    });
    expect(structuredClone(failed)).toEqual(failed);

    const retried = runtime.handleBinding({
      kind: 'bind-parameters',
      revision: 122,
      sourceRevision: 120,
      token: binding.token,
      overrides: [{ id: 0, value: 9 }],
    });
    expect(retried.result).toMatchObject({ ok: true });
    const defaults = runtime.handleBinding({
      kind: 'bind-parameters',
      revision: 123,
      sourceRevision: 120,
      token: binding.token,
    });
    const emptySnapshot = runtime.handleBinding({
      kind: 'bind-parameters',
      revision: 124,
      sourceRevision: 120,
      token: binding.token,
      overrides: [],
    });
    expect(defaults.result).toMatchObject({ ok: true });
    expect(emptySnapshot.result).toEqual(defaults.result);
    if (defaults.result.ok) expect(defaults.result.plan).toEqual(parsed.result.plan);
    expect(runCount()).toBe(1);
  });

  test('preserves CP1001 for an unused declaration and maps unexpected failures to WP1008', async () => {
    const runtime = parameterRuntime();
    const unusedCompilation = await runtime.handle(
      parseRequest(130, {
        parameterBinding: true,
        file: {
          path: 'unused-worker-parameter.ts',
          text: `const unused = Param.number('Unused', 3);
const A = Signal('virtual', 'signal-A');
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: A, value: 2 }] }] });`,
        },
      }),
    );
    const token =
      unusedCompilation.parameterBinding?.ok === true
        ? unusedCompilation.parameterBinding.token
        : undefined;
    if (token === undefined) throw new Error('Expected a retained unused declaration.');
    const unused = runtime.handleBinding({
      kind: 'bind-parameters',
      revision: 131,
      sourceRevision: 130,
      token,
      overrides: [{ id: 0, value: 9 }],
    });
    expect(unused.result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'CP1001', severity: 'error' }],
    });
    expect(structuredClone(unused)).toEqual(unused);

    const normalCompilation = await runtime.handle(parseRequest(132, { parameterBinding: true }));
    const normalToken =
      normalCompilation.parameterBinding?.ok === true
        ? normalCompilation.parameterBinding.token
        : undefined;
    if (normalToken === undefined) throw new Error('Expected a retained parameter token.');
    vi.spyOn(runtime, 'bindParameters')
      .mockImplementationOnce(() => {
        throw new Error('unexpected bind failure');
      })
      .mockImplementationOnce(() => {
        throw new Error('');
      });
    const unexpected = runtime.handleBinding({
      kind: 'bind-parameters',
      revision: 133,
      sourceRevision: 132,
      token: normalToken,
    });
    expect(unexpected.result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'WP1008', severity: 'error', message: 'unexpected bind failure' }],
    });
    if (unexpected.result.ok) throw new Error('Expected the unexpected failure diagnostic.');
    expect(unexpected.result.diagnostics[0]).not.toHaveProperty('span');
    expect(unexpected.result.diagnostics[0]).not.toHaveProperty('stack');
    expect(structuredClone(unexpected)).toEqual(unexpected);
    const emptyMessage = runtime.handleBinding({
      kind: 'bind-parameters',
      revision: 134,
      sourceRevision: 132,
      token: normalToken,
    });
    expect(emptyMessage.result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: 'WP1008',
          severity: 'error',
          message: 'Unexpected parameter binding failure.',
        },
      ],
    });
  });

  test('lists detached descriptors and binds defaults, overrides, and reset without recompiling', async () => {
    resetRunCount();
    const runtime = parameterRuntime();
    const response = await runtime.handle(parseRequest(41, { parameterBinding: true }));
    expect(runCount()).toBe(1);
    expect(response.parameterBinding).toMatchObject({
      ok: true,
      parameters: [
        { id: 0, kind: 'number', label: 'Amount', defaultValue: 5 },
        {
          id: 1,
          kind: 'signal',
          label: 'Channel',
          defaultValue: { type: 'virtual', name: 'signal-A' },
        },
      ],
      token: expect.any(String),
    });
    const binding = response.parameterBinding;
    if (binding?.ok !== true || binding.token === undefined) throw new Error('Expected a token.');
    const token = binding.token;
    expect(structuredClone(binding.parameters)).toEqual(binding.parameters);
    expect(response.result).not.toHaveProperty('execution');
    expect(response.result).not.toHaveProperty('session');
    expect(response.result).not.toHaveProperty('parameters');
    expect(response.result).not.toHaveProperty('blueprintExport');
    expect(structuredClone(response)).toEqual(response);

    const defaults = runtime.bindParameters(binding.token, response.revision);
    const overridden = runtime.bindParameters(binding.token, response.revision, [
      { id: 0, value: 9 },
      { id: 1, value: { type: 'virtual', name: 'signal-B' } },
    ]);
    const reset = runtime.bindParameters(binding.token, response.revision, []);
    expect(defaults.plan).toBeDefined();
    expect(defaults.resolvedCircuit).toBeDefined();
    expect(overridden.plan).not.toEqual(defaults.plan);
    expect(reset.plan).toEqual(defaults.plan);
    expect(runCount()).toBe(1);
    expect(response.result.plan).toEqual(defaults.plan);
    expect(() => runtime.bindParameters(token, response.revision, {})).toThrow(
      expect.objectContaining({ code: 'CP1000', path: '$.overrides' }),
    );
    try {
      runtime.bindParameters(token, response.revision, [{ id: 0, value: '9' }]);
      throw new Error('Expected a typed parameter validation failure.');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'CP1000',
        path: '$.overrides[0].value',
        span: binding.parameters[0]!.source,
      });
    }
  });

  test.each([
    ['string', 'true'],
    ['object', {}],
    ['null', null],
  ])('rejects a %s flag before profile loading or source execution', async (_name, value) => {
    resetRunCount();
    const load = vi.spyOn(prototypeApi, 'loadPrototypeInputJson');
    const response = await new CompilerWorkerRuntime().handle(
      parseRequest(42, {
        parameterBinding: value,
        prototypeProfile: { source: '{' },
      } as never),
    );
    expect(response.result.pipelineDiagnostics[0]).toMatchObject({
      code: 'WP1006',
      severity: 'error',
    });
    expect(response).not.toHaveProperty('parameterBinding');
    expect(runCount()).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });

  test('rejects accessors and non-enumerable flags without invoking getters', async () => {
    const getter = vi.fn(() => {
      throw new Error('getter invoked');
    });
    const accessor = Object.defineProperty(
      { kind: 'parse', revision: 43, file: parameterFile },
      'parameterBinding',
      { enumerable: true, get: getter },
    );
    const hidden = Object.defineProperty(
      { kind: 'parse', revision: 44, file: parameterFile },
      'parameterBinding',
      { enumerable: false, value: true },
    );
    const runtime = new CompilerWorkerRuntime();
    for (const request of [accessor, hidden]) {
      const response = await runtime.handle(request as never);
      expect(response.result.pipelineDiagnostics[0]?.code).toBe('WP1006');
      expect(response).not.toHaveProperty('parameterBinding');
    }
    expect(getter).not.toHaveBeenCalled();
  });

  test('omitted, undefined, and false flags expose no listing and expire the prior token', async () => {
    const runtime = parameterRuntime();
    const captured = await runtime.handle(parseRequest(45, { parameterBinding: true }));
    if (captured.parameterBinding?.ok !== true || captured.parameterBinding.token === undefined) {
      throw new Error('Expected a token.');
    }
    const token = captured.parameterBinding.token;
    for (const request of [
      parseRequest(46),
      parseRequest(47, { parameterBinding: undefined }),
      parseRequest(48, { parameterBinding: false }),
    ]) {
      const pending = runtime.handle(request);
      expect(
        runtime.handleBinding({
          kind: 'bind-parameters',
          revision: request.revision + 100,
          sourceRevision: 45,
          token,
        }).result,
      ).toMatchObject({ ok: false, diagnostics: [{ code: 'WP1007', severity: 'error' }] });
      const response = await pending;
      expect(response).not.toHaveProperty('parameterBinding');
    }
  });

  test('a newer failed parse immediately expires the previous binding token', async () => {
    const runtime = parameterRuntime();
    const captured = await runtime.handle(parseRequest(481, { parameterBinding: true }));
    const token =
      captured.parameterBinding?.ok === true ? captured.parameterBinding.token : undefined;
    if (token === undefined) throw new Error('Expected an initial token.');

    const pending = runtime.handle(
      parseRequest(482, {
        file: { path: 'failed-newer-parse.ts', text: 'const = ;' },
        parameterBinding: true,
      }),
    );
    expect(
      runtime.handleBinding({
        kind: 'bind-parameters',
        revision: 483,
        sourceRevision: 481,
        token,
      }).result,
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'WP1007', severity: 'error' }] });
    const failed = await pending;
    expect(failed.parameterBinding).toMatchObject({ ok: false });
  });

  test('returns an empty listing for parameter-free source and rejects binding errors', async () => {
    const runtime = new CompilerWorkerRuntime();
    const response = await runtime.handle({
      kind: 'parse',
      revision: 49,
      file: { path: 'no-parameters.ts', text: 'const output = new Network();' },
      parameterBinding: true,
    });
    expect(response.parameterBinding).toEqual({ ok: true, parameters: [] });
    expect(() => runtime.bindParameters('missing', 49)).toThrow(
      expect.objectContaining({ code: 'WP1007' }),
    );
  });

  test('keeps default binding for unused declarations and preserves CP1001 on explicit override', async () => {
    const runtime = parameterRuntime();
    const response = await runtime.handle(
      parseRequest(491, {
        parameterBinding: true,
        file: {
          path: 'unused-worker-parameter.ts',
          text: `const unused = Param.number('Unused', 3);
const A = Signal('virtual', 'signal-A');
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: A, value: 2 }] }] });`,
        },
      }),
    );
    const binding = response.parameterBinding;
    if (binding?.ok !== true || binding.token === undefined) throw new Error('Expected a token.');
    expect(runtime.bindParameters(binding.token, response.revision).plan).toBeDefined();
    expect(() =>
      runtime.bindParameters(binding.token!, response.revision, [{ id: 0, value: 9 }]),
    ).toThrow(expect.objectContaining({ code: 'CP1001', path: '$.bindings' }));
  });

  test('compile errors and policy-promoted errors never retain a session', async () => {
    const runtime = new CompilerWorkerRuntime();
    const failed = await runtime.handle(
      parseRequest(50, {
        parameterBinding: true,
        file: { path: 'failed.ts', text: 'const = ;' },
      }),
    );
    expect(failed.parameterBinding).toMatchObject({
      ok: false,
      diagnostics: [{ severity: 'error' }],
    });

    const promoted = await runtime.handle({
      kind: 'parse',
      revision: 51,
      file: { path: 'policy-promoted.ts', text: 'const input = new Network(); input + 1;' },
      parameterBinding: true,
      diagnosticPolicy: {
        levels: { error: true, warning: true, note: true, hint: false },
        rules: { 'producer.unused-output': { severity: 'error' } },
        maxInstanceDetails: 3,
      },
    });
    expect(promoted.result.pipelineDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'producer.unused-output', severity: 'error' }),
      ]),
    );
    expect(promoted.parameterBinding).toMatchObject({ ok: false });
  });

  test('parameter opt-in preserves profile reporting, cache references, and preflight failures', async () => {
    const runtime = new CompilerWorkerRuntime();
    const file = {
      path: 'profile-parameter.ts',
      text: `const unused = Param.number('Unused', 4); const output = new Network();`,
    };
    const source = JSON.stringify(syntheticPrototypeDatabase());
    const loaded = await runtime.handle({
      kind: 'parse',
      revision: 511,
      file,
      parameterBinding: true,
      prototypeProfile: { source },
    });
    expect(loaded.prototypeEnvironment?.identity).toBeDefined();
    expect(loaded.parameterBinding).toMatchObject({ ok: true, token: expect.any(String) });

    const cached = await runtime.handle({
      kind: 'parse',
      revision: 512,
      file,
      parameterBinding: true,
      prototypeProfile: { identity: loaded.prototypeEnvironment!.identity },
    });
    expect(cached.prototypeEnvironment?.identity).toBe(loaded.prototypeEnvironment?.identity);
    expect(cached.parameterBinding).toMatchObject({ ok: true, token: expect.any(String) });
    const cachedToken =
      cached.parameterBinding?.ok === true ? cached.parameterBinding.token : undefined;
    if (cachedToken === undefined) throw new Error('Expected cached-session token.');

    const preflight = await runtime.handle({
      kind: 'parse',
      revision: 513,
      file,
      parameterBinding: true,
      prototypeProfile: { source: '{' },
    });
    expect(preflight.parameterBinding).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ severity: 'error' })],
    });
    expect(() => runtime.bindParameters(cachedToken, 512)).toThrow(
      CompilerWorkerParameterBindingError,
    );
  });

  test('native blueprint export failure does not block the host-local session', async () => {
    const runtime = parameterRuntime();
    const response = await runtime.handle(
      parseRequest(52, {
        file: {
          ...parameterFile,
          text: parameterFile.text.replace(
            "Signal('virtual', 'signal-A')",
            "Signal('virtual', 'signal-A', 'legendary')",
          ),
        },
        parameterBinding: true,
        blueprintExport: {
          parameters: true,
        },
      }),
    );
    expect(response.result.blueprintExport).toMatchObject({ ok: false });
    if (response.result.blueprintExport?.ok === false) {
      expect(response.result.blueprintExport.diagnostics).toEqual([
        expect.objectContaining({ code: 'CP1002', span: expect.any(Object) }),
      ]);
    }
    expect(response.result.pipelineDiagnostics).toEqual([]);
    expect(response.parameterBinding).toMatchObject({ ok: true, token: expect.any(String) });
    if (response.parameterBinding?.ok !== true || response.parameterBinding.token === undefined) {
      throw new Error('Expected a retained session despite native export failure.');
    }
    expect(
      runtime.bindParameters(response.parameterBinding.token, response.revision).plan,
    ).toBeDefined();
  });

  test('serializes located CP1002 when Constant parameter substitution collides', async () => {
    const runtime = parameterRuntime();
    const response = await runtime.handle(
      parseRequest(54, {
        file: {
          path: 'worker-constant-placeholder-collision.factorio.ts',
          text: `const original = Signal('virtual', 'signal-A');
const channel = Param.signal('Channel', original);
const amount = Param.number('Amount', 5);
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: channel, value: amount },
  { signal: original, value: 13 }
] }] });`,
        },
        parameterBinding: true,
        blueprintExport: { parameters: true },
      }),
    );

    expect(response.result.pipelineDiagnostics).toEqual([]);
    expect(response.result.blueprintExport).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: 'CP1002',
          span: expect.objectContaining({ fileId: expect.any(String) }),
          message: expect.stringMatching(/duplicate native Constant filter/i),
        },
      ],
    });
    expect(response.parameterBinding).toMatchObject({ ok: true, token: expect.any(String) });
    if (response.parameterBinding?.ok !== true || response.parameterBinding.token === undefined) {
      throw new Error('Expected a retained Worker parameter session after export refusal.');
    }
    expect(
      runtime.bindParameters(response.parameterBinding.token, response.revision).plan,
    ).toBeDefined();
  });

  test('exports an Arithmetic formula-only parameter through the Worker', async () => {
    const runtime = parameterRuntime();
    const response = await runtime.handle(
      parseRequest(55, {
        file: {
          path: 'worker-formula-only-parameter.factorio.ts',
          text: `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const output = new Network();
output += Arithmetic({ left: amount * 2, operation: 'add', right: 1, output: A });`,
        },
        parameterBinding: true,
        blueprintExport: { parameters: true },
      }),
    );

    expect(response.result.pipelineDiagnostics).toEqual([]);
    expect(response.result.blueprintExport).toMatchObject({ ok: true });
    if (response.result.blueprintExport?.ok !== true) {
      throw new Error('Expected a successful Worker formula-only template export.');
    }
    expect(response.result.blueprintExport.document.blueprint.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
    ]);
    expect(response.result.blueprintExport.document.blueprint.entities).toHaveLength(1);
    expect(
      response.result.blueprintExport.document.blueprint.entities[0]!.control_behavior,
    ).toMatchObject({
      arithmetic_conditions: { first_constant: 10, second_constant: 1 },
    });
    expect(response.parameterBinding).toMatchObject({ ok: true, token: expect.any(String) });
  });

  test('exports an output-only Arithmetic Signal parameter with a numeric formula operand', async () => {
    const runtime = parameterRuntime();
    const parsed = structuredClone(
      await runtime.handle(
        parseRequest(57, {
          file: {
            path: 'worker-arithmetic-output-signal-template.factorio.ts',
            text: `const result = Param.signal('Result', Signal('virtual', 'signal-B'));
const amount = Param.number('Amount', 5, { variable: 'x' });
const output = new Network();
output += Arithmetic({ left: 2, operation: 'add', right: amount * 2, output: result });`,
          },
          parameterBinding: true,
          blueprintExport: { parameters: true },
        }),
      ),
    );
    expect(parsed.result.pipelineDiagnostics).toEqual([]);
    expect(parsed.result.blueprintExport).toMatchObject({ ok: true });
    if (parsed.result.blueprintExport?.ok !== true) {
      throw new Error('Expected an output-only Arithmetic Signal template export.');
    }
    const document = parsed.result.blueprintExport.document.blueprint;
    expect(document.parameters).toEqual([
      {
        type: 'id',
        id: 'parameter-0',
        name: 'Result',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
    ]);
    const projectedBehavior = document.entities[0]!.control_behavior as {
      arithmetic_conditions: { output_signal: unknown };
    };
    const conditions = projectedBehavior.arithmetic_conditions;
    expect(conditions).toMatchObject({
      first_constant: 2,
      second_constant: 10,
      output_signal: { name: 'parameter-0' },
    });
    expect(conditions.output_signal).not.toHaveProperty('type');
    if (parsed.parameterBinding?.ok !== true) {
      throw new Error('Expected a retained Worker parameter binding session.');
    }
    expect(parsed.parameterBinding.parameters).toMatchObject([
      { id: 0, kind: 'signal', label: 'Result', defaultValue: signal('virtual', 'signal-B') },
      { id: 1, kind: 'number', label: 'Amount', defaultValue: 5 },
    ]);
  });

  test('exports and binds a default-free Arithmetic output through the Worker session', async () => {
    const runtime = parameterRuntime();
    const parsed = structuredClone(
      await runtime.handle(
        parseRequest(59, {
          file: {
            path: 'worker-default-free-arithmetic-output.factorio.ts',
            text: `const result = Param.signal('Result');
const amount = Param.number('Amount', 5);
const output = new Network();
output += Arithmetic({ left: 2, operation: 'add', right: amount, output: result });`,
          },
          parameterBinding: true,
          blueprintExport: { parameters: true },
        }),
      ),
    );
    expect(parsed.result.pipelineDiagnostics).toEqual([]);
    expect(parsed.result.blueprintExport).toMatchObject({ ok: true });
    const metadata = parsed.result.blueprintExport;
    if (metadata?.ok !== true) throw new Error('Expected native Arithmetic template export.');
    expect(metadata.document.blueprint.parameters).toEqual([
      {
        type: 'id',
        id: 'parameter-0',
        name: 'Result',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
      { type: 'number', number: '5', name: 'Amount' },
    ]);
    expect(metadata.document.blueprint.entities[0]!.control_behavior).toMatchObject({
      arithmetic_conditions: {
        second_constant: 5,
        output_signal: { name: 'parameter-0' },
      },
    });

    const binding = parsed.parameterBinding;
    if (binding?.ok !== true || binding.token === undefined) {
      throw new Error('Expected a retained Worker parameter binding session.');
    }
    expect(binding.parameters).toMatchObject([
      { id: 0, kind: 'signal', label: 'Result' },
      { id: 1, kind: 'number', label: 'Amount', defaultValue: 5 },
    ]);
    expect(binding.parameters[0]).not.toHaveProperty('defaultValue');

    const bound = runtime.bindParameters(binding.token, parsed.revision, [
      { id: 0, value: { type: 'item', name: 'iron-plate', quality: 'uncommon' } },
    ]);
    expect(bound.plan.producers).toMatchObject([
      {
        kind: 'arithmetic',
        right: { kind: 'constant', value: 5 },
        output: {
          kind: 'signal',
          signal: { type: 'item', name: 'iron-plate', quality: 'uncommon' },
        },
      },
    ]);
    const reset = runtime.bindParameters(binding.token, parsed.revision, [
      { id: 0, value: { type: 'virtual', name: 'signal-B', quality: 'rare' } },
      { id: 1, value: 11 },
    ]);
    expect(reset.plan.producers).toMatchObject([
      {
        kind: 'arithmetic',
        right: { kind: 'constant', value: 11 },
        output: {
          kind: 'signal',
          signal: { type: 'virtual', name: 'signal-B', quality: 'rare' },
        },
      },
    ]);
  });

  test('exports Selector Signal index and count-output parameters through the Worker', async () => {
    const runtime = parameterRuntime();
    const parsed = structuredClone(
      await runtime.handle(
        parseRequest(58, {
          file: {
            path: 'worker-selector-signal-templates.factorio.ts',
            text: `const index = Param.signal('Index', Signal('virtual', 'signal-index'));
const countOutput = Param.signal('Count output', Signal('fluid', 'water', 'normal'));
const A = Signal('virtual', 'signal-index');
const input = new Network();
const selectOutput = new Network();
const countNetwork = new Network();
const deciderOutput = new Network();
selectOutput += Selector({ input, operation: 'select', index });
countNetwork += Selector({ input, operation: 'count', output: countOutput });
deciderOutput += Decider({ condition: input[A] > 0, outputs: [input[A]], elseOutputs: [2 * A] });`,
          },
          parameterBinding: true,
          blueprintExport: { parameters: true },
        }),
      ),
    );
    expect(parsed.result.pipelineDiagnostics).toEqual([]);
    expect(parsed.result.blueprintExport).toMatchObject({ ok: true });
    if (parsed.result.blueprintExport?.ok !== true) {
      throw new Error('Expected Selector Signal template export through the Worker.');
    }
    const blueprint = parsed.result.blueprintExport.document.blueprint;
    expect(blueprint.parameters).toEqual([
      {
        type: 'id',
        id: 'parameter-0',
        name: 'Index',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
      {
        type: 'id',
        id: 'parameter-1',
        name: 'Count output',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
    ]);
    expect(blueprint.entities[0]!.control_behavior).toMatchObject({
      operation: 'select',
      index_signal: { name: 'parameter-0' },
    });
    expect(blueprint.entities[1]!.control_behavior).toMatchObject({
      operation: 'count',
      count_signal: { name: 'parameter-1', quality: 'normal' },
    });
    expect(blueprint.entities[2]!.control_behavior).toMatchObject({
      decider_conditions: {
        conditions: [{ first_signal: { name: 'parameter-0' }, constant: 0 }],
        outputs: [{ signal: { name: 'parameter-0' }, copy_count_from_input: true }],
        else_outputs: [{ signal: { name: 'parameter-0' }, constant: 2 }],
      },
    });
    expect(parsed.parameterBinding).toMatchObject({
      ok: true,
      parameters: [
        { id: 0, kind: 'signal', label: 'Index', defaultValue: signal('virtual', 'signal-index') },
        {
          id: 1,
          kind: 'signal',
          label: 'Count output',
          defaultValue: signal('fluid', 'water', 'normal'),
        },
      ],
    });
  });

  test('exports default-free Selector Signal index and count-output parameters through the Worker', async () => {
    const runtime = parameterRuntime();
    const parsed = structuredClone(
      await runtime.handle(
        parseRequest(58, {
          file: {
            path: 'worker-selector-signal-templates.factorio.ts',
            text: `const index = Param.signal('Index');
const countOutput = Param.signal('Count output');
const A = Signal('virtual', 'signal-index');
const input = new Network();
const selectOutput = new Network();
const countNetwork = new Network();
const deciderOutput = new Network();
selectOutput += Selector({ input, operation: 'select', index });
countNetwork += Selector({ input, operation: 'count', output: countOutput });
deciderOutput += Decider({ condition: input[A] > 0, outputs: [input[A]], elseOutputs: [2 * A] });`,
          },
          parameterBinding: true,
          blueprintExport: { parameters: true },
        }),
      ),
    );
    expect(parsed.result.pipelineDiagnostics).toEqual([]);
    expect(parsed.result.blueprintExport).toMatchObject({ ok: true });
    if (parsed.result.blueprintExport?.ok !== true) {
      throw new Error('Expected Selector Signal template export through the Worker.');
    }
    const blueprint = parsed.result.blueprintExport.document.blueprint;
    expect(blueprint.parameters).toEqual([
      {
        type: 'id',
        id: 'parameter-0',
        name: 'Index',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
      {
        type: 'id',
        id: 'parameter-1',
        name: 'Count output',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
    ]);
    expect(blueprint.entities[0]!.control_behavior).toMatchObject({
      operation: 'select',
      index_signal: { name: 'parameter-0' },
    });
    expect(blueprint.entities[1]!.control_behavior).toMatchObject({
      operation: 'count',
      count_signal: { type: 'virtual', name: 'parameter-1' },
    });
    expect(blueprint.entities[2]!.control_behavior).toMatchObject({
      decider_conditions: {
        conditions: [{ first_signal: { name: 'signal-index' }, constant: 0 }],
        outputs: [{ signal: { name: 'signal-index' }, copy_count_from_input: true }],
        else_outputs: [{ signal: { name: 'signal-index' }, constant: 2 }],
      },
    });
    const parameterBinding = parsed.parameterBinding;
    if (parameterBinding?.ok !== true) {
      throw new Error('Expected a retained Worker parameter binding session.');
    }
    expect(parameterBinding).toMatchObject({
      ok: true,
      parameters: [
        { id: 0, kind: 'signal', label: 'Index' },
        { id: 1, kind: 'signal', label: 'Count output' },
      ],
    });
    expect(parameterBinding.parameters[0]).not.toHaveProperty('defaultValue');
    expect(parameterBinding.parameters[1]).not.toHaveProperty('defaultValue');
  });

  test('exports item/fluid Constant Signal templates and keeps Worker bindings local', async () => {
    const key = '__worker_mixed_signal_namespace_runs';
    const globals = globalThis as Record<string, unknown>;
    const previous = globals[key];
    globals[key] = 0;
    try {
      const runtime = parameterRuntime();
      const parsed = structuredClone(
        await runtime.handle(
          parseRequest(56, {
            file: {
              path: 'worker-item-fluid-signal-template.factorio.ts',
              text: `globalThis.${key} = Number(globalThis.${key} ?? 0) + 1;
const plate = Param.signal('Plate', Signal('iron-plate'));
const amount = Param.number('Amount', 5, { variable: 'x' });
const water = Param.signal('Water', Signal('fluid', 'water', 'normal'));
const output = new Network();
output += Constant({ sections: [
  { filters: [
    { signal: plate, value: amount * 2 },
    { signal: water, value: 4 },
  ] },
  { filters: [
    { signal: Signal('iron-plate'), value: 3 },
    { signal: Signal('fluid', 'water'), value: 5 },
  ] },
] });`,
            },
            parameterBinding: true,
            blueprintExport: { parameters: true },
          }),
        ),
      );

      expect(globals[key]).toBe(1);
      expect(parsed.result.pipelineDiagnostics).toEqual([]);
      expect(parsed.result.blueprintExport).toMatchObject({ ok: true });
      if (parsed.result.blueprintExport?.ok !== true) {
        throw new Error('Expected a successful Worker item/fluid template export.');
      }
      expect(parsed.result.blueprintExport.document.blueprint.parameters).toEqual([
        {
          type: 'id',
          id: 'parameter-0',
          name: 'Plate',
          'quality-condition': { quality: 'normal', comparator: '=' },
        },
        { type: 'number', number: '5', name: 'Amount', variable: 'x' },
        {
          type: 'id',
          id: 'parameter-1',
          name: 'Water',
          'quality-condition': { quality: 'normal', comparator: '=' },
        },
        { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
      ]);
      expect(
        parsed.result.blueprintExport.document.blueprint.entities[0]!.control_behavior,
      ).toMatchObject({
        sections: {
          sections: [
            {
              filters: [
                { name: 'parameter-0', count: 10 },
                { name: 'parameter-1', count: 4 },
              ],
            },
            {
              filters: [
                { name: 'parameter-0', count: 3 },
                { name: 'parameter-1', count: 5 },
              ],
            },
          ],
        },
      });

      const binding = parsed.parameterBinding;
      if (binding?.ok !== true || binding.token === undefined) {
        throw new Error('Expected a retained Worker Signal binding session.');
      }
      let revision = parsed.revision;
      const bind = (overrides: readonly SourceParameterOverride[] = []) =>
        structuredClone(
          runtime.handleBinding({
            kind: 'bind-parameters',
            revision: ++revision,
            sourceRevision: parsed.revision,
            token: binding.token!,
            overrides,
          }),
        );
      const concrete = (response: CompilerWorkerBoundResponse) => {
        if (!response.result.ok) throw new Error('Expected a concrete Worker binding.');
        return response.result;
      };
      const defaults = concrete(bind());
      const overridden = concrete(
        bind([
          { id: 0, value: { type: 'item', name: 'copper-plate' } },
          { id: 1, value: 9 },
          { id: 2, value: { type: 'fluid', name: 'crude-oil' } },
        ]),
      );
      const reset = concrete(bind());
      const rows = (result: typeof defaults) => {
        const document = generateBlueprintJson(result.resolvedCircuit.ir);
        return document.blueprint.entities.map((entity) => {
          const behavior = entity.control_behavior as {
            sections: { sections: { filters: { type?: string; name: string; count: number }[] }[] };
          };
          return behavior.sections.sections.flatMap(({ filters: filtersInSection }) =>
            filtersInSection.map(({ type, name, count }) => ({ type, name, count })),
          );
        });
      };
      expect(rows(defaults)).toEqual([
        [
          { type: undefined, name: 'iron-plate', count: 10 },
          { type: 'fluid', name: 'water', count: 4 },
          { type: undefined, name: 'iron-plate', count: 3 },
          { type: 'fluid', name: 'water', count: 5 },
        ],
      ]);
      expect(rows(overridden)).toEqual([
        [
          { type: undefined, name: 'copper-plate', count: 18 },
          { type: 'fluid', name: 'crude-oil', count: 4 },
          { type: undefined, name: 'iron-plate', count: 3 },
          { type: 'fluid', name: 'water', count: 5 },
        ],
      ]);
      expect(rows(reset)).toEqual(rows(defaults));
      expect(defaults.resolvedCircuit.ir.producers.map(({ id }) => id)).toEqual(
        overridden.resolvedCircuit.ir.producers.map(({ id }) => id),
      );
      expect(generateBlueprintJson(defaults.resolvedCircuit.ir).blueprint.wires).toEqual(
        generateBlueprintJson(overridden.resolvedCircuit.ir).blueprint.wires,
      );
      expect(generateBlueprintJson(overridden.resolvedCircuit.ir).blueprint).not.toHaveProperty(
        'parameters',
      );
      expect(globals[key]).toBe(1);
    } finally {
      if (previous === undefined) delete globals[key];
      else globals[key] = previous;
    }
  });

  test('exports Selector index formulas and rebinds their concrete defaults through the Worker', async () => {
    const globals = globalThis as Record<string, unknown>;
    const previous = globals[localExpressionRunKey];
    globals[localExpressionRunKey] = 0;
    try {
      const runtime = parameterRuntime();
      const parsed = structuredClone(
        await runtime.handle(
          parseRequest(54, {
            file: {
              path: 'worker-selector-index-formula.factorio.ts',
              text: `globalThis.${localExpressionRunKey} = Number(globalThis.${localExpressionRunKey} ?? 0) + 1;
const amount = Param.number('Amount', 10, { variable: 'x' });
const input = new Network();
const directOutput = new Network();
const fractionalOutput = new Network();
const formulaOutput = new Network();
const powerOutput = new Network();
const largeOutput = new Network();
directOutput += Selector({ input, operation: 'select', index: amount });
fractionalOutput += Selector({ input, operation: 'select', index: amount * 0.5 + 1 });
formulaOutput += Selector({ input, operation: 'select', index: amount / 2 + 3 });
powerOutput += Selector({ input, operation: 'select', index: amount ** 2 });
largeOutput += Selector({ input, operation: 'select', index: (amount + 2147483648) - 2147483647 });`,
            },
            parameterBinding: true,
            blueprintExport: { parameters: true },
          }),
        ),
      );
      expect(globals[localExpressionRunKey]).toBe(1);
      expect(parsed.result.pipelineDiagnostics).toEqual([]);
      expect(parsed.result.blueprintExport).toMatchObject({ ok: true });
      if (parsed.result.blueprintExport?.ok !== true) {
        throw new Error('Expected a successful Worker native-template export.');
      }
      expect(parsed.result.blueprintExport.document.blueprint.parameters).toEqual([
        { type: 'number', number: '10', name: 'Amount', variable: 'x' },
        { type: 'number', number: '6', formula: '((x * 0.5) + 1)', dependent: true },
        { type: 'number', number: '8', formula: '((x / 2) + 3)', dependent: true },
        { type: 'number', number: '100', formula: '((x) ^ (2))', dependent: true },
        {
          type: 'number',
          number: '11',
          formula: '((x + 2147483648) - 2147483647)',
          dependent: true,
        },
      ]);
      expect(
        parsed.result.blueprintExport.document.blueprint.entities.map(({ control_behavior }) =>
          typeof control_behavior === 'object' &&
          control_behavior !== null &&
          'index_constant' in control_behavior
            ? control_behavior.index_constant
            : undefined,
        ),
      ).toEqual([10, 6, 8, 100, 11]);

      const binding = parsed.parameterBinding;
      if (binding?.ok !== true || binding.token === undefined) {
        throw new Error('Expected a retained Selector parameter session.');
      }
      let revision = parsed.revision;
      const bind = (value?: number) =>
        structuredClone(
          runtime.handleBinding({
            kind: 'bind-parameters',
            revision: ++revision,
            sourceRevision: parsed.revision,
            token: binding.token!,
            overrides: value === undefined ? [] : [{ id: 0, value }],
          }),
        );
      const concrete = (response: CompilerWorkerBoundResponse) => {
        if (!response.result.ok) throw new Error('Expected a concrete Selector binding.');
        return response.result;
      };
      const defaults = concrete(bind());
      const overridden = concrete(bind(14));
      const invalid = bind(1.5);
      expect(invalid.result).toMatchObject({
        ok: false,
        diagnostics: [{ code: 'CP1000', span: binding.parameters[0]!.source }],
      });
      const fractional = bind(11);
      expect(fractional.result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ code: 'CP1000', span: expect.any(Object) })],
      });
      expect(fractional.result).not.toHaveProperty('plan');
      const retry = concrete(bind(14));
      const reset = concrete(bind());
      const indices = (pair: typeof defaults) =>
        pair.plan.producers
          .filter((producer) => producer.kind === 'selector')
          .map((producer) =>
            producer.kind === 'selector' && producer.operation === 'select'
              ? producer.index
              : undefined,
          );
      expect(indices(defaults)).toEqual([10, 6, 8, 100, 11]);
      expect(indices(overridden)).toEqual([14, 8, 10, 196, 15]);
      expect(retry.plan).toEqual(overridden.plan);
      expect(reset.plan).toEqual(defaults.plan);
      expect(defaults.resolvedCircuit.ir.producers.map(({ id }) => id)).toEqual(
        overridden.resolvedCircuit.ir.producers.map(({ id }) => id),
      );
      const artifact = createSourceCircuitArtifact(overridden.plan, overridden.resolvedCircuit);
      expect(
        artifact.blueprint.blueprint.entities.map(({ control_behavior }) =>
          typeof control_behavior === 'object' &&
          control_behavior !== null &&
          'index_constant' in control_behavior
            ? control_behavior.index_constant
            : undefined,
        ),
      ).toEqual([14, 8, 10, 196, 15]);
      expect(artifact.blueprint.blueprint).not.toHaveProperty('parameters');
      expect(globals[localExpressionRunKey]).toBe(1);
    } finally {
      if (previous === undefined) delete globals[localExpressionRunKey];
      else globals[localExpressionRunKey] = previous;
    }
  });

  test('rejects tokens from another runtime or revision and allocates distinct runtime tokens', async () => {
    const firstRuntime = parameterRuntime();
    const secondRuntime = parameterRuntime();
    const first = await firstRuntime.handle(parseRequest(53, { parameterBinding: true }));
    const second = await secondRuntime.handle(parseRequest(53, { parameterBinding: true }));
    if (first.parameterBinding?.ok !== true || first.parameterBinding.token === undefined) {
      throw new Error('Expected first token.');
    }
    if (second.parameterBinding?.ok !== true || second.parameterBinding.token === undefined) {
      throw new Error('Expected second token.');
    }
    const firstToken = first.parameterBinding.token;
    const secondToken = second.parameterBinding.token;
    expect(firstToken).not.toBe(secondToken);
    expect(() => firstRuntime.bindParameters(firstToken, 54)).toThrow(
      CompilerWorkerParameterBindingError,
    );
    expect(() => secondRuntime.bindParameters(firstToken, 53)).toThrow(
      CompilerWorkerParameterBindingError,
    );
    const recaptured = await firstRuntime.handle(parseRequest(55, { parameterBinding: true }));
    if (
      recaptured.parameterBinding?.ok !== true ||
      recaptured.parameterBinding.token === undefined
    ) {
      throw new Error('Expected a recaptured token.');
    }
    expect(recaptured.parameterBinding.token).not.toBe(firstToken);
    expect(() => firstRuntime.bindParameters(firstToken, 53)).toThrow(
      CompilerWorkerParameterBindingError,
    );
  });

  test('reports unavailable token crypto without invalidating the compilation', async () => {
    vi.stubGlobal('crypto', undefined);
    const response = await parameterRuntime().handle(parseRequest(54, { parameterBinding: true }));
    expect(response.result.plan).toBeDefined();
    expect(response.result.pipelineDiagnostics).toEqual([]);
    expect(response.parameterBinding).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'WP1007', severity: 'error' }],
    });
  });

  test('a stale profile completion cannot replace the newer session or expose its token', async () => {
    const actualLoad = prototypeApi.loadPrototypeInputJson;
    const oldEntered = deferred<void>();
    const newEntered = deferred<void>();
    const releaseOld = deferred<void>();
    const releaseNew = deferred<void>();
    const oldSource = JSON.stringify(syntheticPrototypeDatabase()) + '\n';
    const newSource = JSON.stringify(syntheticPrototypeDatabase()) + '\n\n';
    vi.spyOn(prototypeApi, 'loadPrototypeInputJson').mockImplementation(async (source, options) => {
      if (source === oldSource) {
        oldEntered.resolve();
        await releaseOld.promise;
      } else if (source === newSource) {
        newEntered.resolve();
        await releaseNew.promise;
      }
      return actualLoad(source, options);
    });

    const runtime = new CompilerWorkerRuntime();
    const raceFile = {
      path: 'worker-parameter-race.ts',
      text: `const amount = Param.number('Amount', 5); const output = new Network();`,
    };
    const previous = await runtime.handle({
      kind: 'parse',
      revision: 54,
      file: raceFile,
      parameterBinding: true,
    });
    if (previous.parameterBinding?.ok !== true || previous.parameterBinding.token === undefined) {
      throw new Error('Expected an initial token.');
    }
    const previousToken = previous.parameterBinding.token;
    const oldPending = runtime.handle(
      parseRequest(55, {
        file: raceFile,
        entityReplayContext: undefined,
        parameterBinding: true,
        prototypeProfile: { source: oldSource },
      }),
    );
    await oldEntered.promise;
    expect(
      runtime.handleBinding({
        kind: 'bind-parameters',
        revision: 551,
        sourceRevision: 54,
        token: previousToken,
      }).result,
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'WP1007', severity: 'error' }] });
    const newPending = runtime.handle(
      parseRequest(56, {
        file: raceFile,
        entityReplayContext: undefined,
        parameterBinding: true,
        prototypeProfile: { source: newSource },
      }),
    );
    await newEntered.promise;
    releaseNew.resolve();
    const newer = await newPending;
    if (newer.parameterBinding?.ok !== true || newer.parameterBinding.token === undefined) {
      throw new Error('Expected the newer session token.');
    }
    const newerToken = newer.parameterBinding.token;
    releaseOld.resolve();
    const older = await oldPending;
    expect(older).not.toHaveProperty('parameterBinding');
    expect(() => runtime.bindParameters(newerToken, 56)).not.toThrow();
  });

  test('a stale profile failure cannot clear a newer session', async () => {
    const actualLoad = prototypeApi.loadPrototypeInputJson;
    const oldEntered = deferred<void>();
    const releaseOld = deferred<void>();
    const invalidSource = '{';
    const validSource = JSON.stringify(syntheticPrototypeDatabase());
    vi.spyOn(prototypeApi, 'loadPrototypeInputJson').mockImplementation(async (source, options) => {
      if (source === invalidSource) {
        oldEntered.resolve();
        await releaseOld.promise;
      }
      return actualLoad(source, options);
    });

    const runtime = new CompilerWorkerRuntime();
    const file = {
      path: 'worker-parameter-stale-failure.ts',
      text: `const amount = Param.number('Amount', 5); const output = new Network();`,
    };
    const oldPending = runtime.handle({
      kind: 'parse',
      revision: 57,
      file,
      parameterBinding: true,
      prototypeProfile: { source: invalidSource },
    });
    await oldEntered.promise;
    const newer = await runtime.handle({
      kind: 'parse',
      revision: 58,
      file,
      parameterBinding: true,
      prototypeProfile: { source: validSource },
    });
    if (newer.parameterBinding?.ok !== true || newer.parameterBinding.token === undefined) {
      throw new Error('Expected the newer session token.');
    }
    const newerToken = newer.parameterBinding.token;
    releaseOld.resolve();
    const older = await oldPending;
    expect(older).not.toHaveProperty('parameterBinding');
    expect(() => runtime.bindParameters(newerToken, 58)).not.toThrow();
  });

  test('delayed blueprint import preserves the newer retained parameter capture', async () => {
    const actualLoad = prototypeApi.loadPrototypeInputJson;
    const entered = deferred<void>();
    const release = deferred<void>();
    const source = JSON.stringify(syntheticPrototypeDatabase());
    vi.spyOn(prototypeApi, 'loadPrototypeInputJson').mockImplementation(async (text, options) => {
      if (text === source) {
        entered.resolve();
        await release.promise;
      }
      return actualLoad(text, options);
    });

    const runtime = parameterRuntime();
    const importPending = runtime.handleImport({
      kind: 'import-blueprint',
      revision: 590,
      document: { text: '{"blueprint":{"entities":[],"wires":[]}}' },
      sourcePath: 'virtual/empty-import.ts',
      prototypeProfile: { source },
    });
    await entered.promise;

    const newer = await runtime.handle(parseRequest(591, { parameterBinding: true }));
    if (newer.parameterBinding?.ok !== true || newer.parameterBinding.token === undefined) {
      throw new Error('Expected the newer parameter capture.');
    }
    const token = newer.parameterBinding.token;
    release.resolve();
    const imported = await importPending;

    expect(imported.result.state).toBe('verified');
    const refused = await runtime.handleImport({
      kind: 'import-blueprint',
      revision: 593,
      document: { text: '{"blueprint_book":{}}' },
      sourcePath: 'virtual/refused-import.ts',
    });
    expect(refused.result.state).toBe('blocked');
    expect(() => runtime.bindParameters(token, 591)).not.toThrow();

    await runtime.handle(parseRequest(592, { parameterBinding: false }));
    expect(() => runtime.bindParameters(token, 591)).toThrow(CompilerWorkerParameterBindingError);
  });

  test('deferred exchange decode preserves the newer retained parameter capture', async () => {
    const text = '{"blueprint":{"entities":[],"wires":[]}}';
    const exchange = await blueprintExchangeCodec.encodeBlueprintExchange(parseLosslessJson(text));
    const source = JSON.stringify(syntheticPrototypeDatabase());
    const actualDecode = blueprintExchangeCodec.decodeBlueprintExchange;
    const entered = deferred<void>();
    const release = deferred<void>();
    vi.spyOn(blueprintExchangeCodec, 'decodeBlueprintExchange').mockImplementation(
      async (input) => {
        if (input === exchange) {
          entered.resolve();
          await release.promise;
        }
        return actualDecode(input);
      },
    );

    const runtime = parameterRuntime();
    const importPending = runtime.handleImport({
      kind: 'import-blueprint',
      revision: 594,
      document: { text: exchange, format: 'exchange' },
      sourcePath: 'virtual/deferred-exchange.ts',
      prototypeProfile: { source },
    });
    await entered.promise;

    const newer = await runtime.handle(parseRequest(595, { parameterBinding: true }));
    if (newer.parameterBinding?.ok !== true || newer.parameterBinding.token === undefined) {
      throw new Error('Expected the newer parameter capture.');
    }
    const token = newer.parameterBinding.token;
    release.resolve();
    const imported = await importPending;

    expect(imported.result.state).toBe('verified');
    expect(() => runtime.bindParameters(token, 595)).not.toThrow();
  });

  test('failed deferred exchange decode also preserves the newer parameter capture', async () => {
    const source = JSON.stringify(syntheticPrototypeDatabase());
    const entered = deferred<void>();
    const release = deferred<void>();
    vi.spyOn(blueprintExchangeCodec, 'decodeBlueprintExchange').mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new BlueprintExchangeError('BEX1001', 'Blueprint exchange marker is missing.', {
        path: '$',
      });
    });

    const runtime = parameterRuntime();
    const importPending = runtime.handleImport({
      kind: 'import-blueprint',
      revision: 596,
      document: { text: 'malformed', format: 'exchange' },
      sourcePath: 'virtual/failed-exchange.ts',
      prototypeProfile: { source },
    });
    await entered.promise;

    const newer = await runtime.handle(parseRequest(597, { parameterBinding: true }));
    if (newer.parameterBinding?.ok !== true || newer.parameterBinding.token === undefined) {
      throw new Error('Expected the newer parameter capture.');
    }
    const token = newer.parameterBinding.token;
    release.resolve();
    const refused = await importPending;

    expect(refused.result).toMatchObject({
      state: 'blocked',
      error: { code: 'BEX1001', path: '$' },
    });
    expect(refused.result).not.toHaveProperty('source');
    expect(refused.result).not.toHaveProperty('correspondence');
    expect(() => runtime.bindParameters(token, 597)).not.toThrow();
  });
});
