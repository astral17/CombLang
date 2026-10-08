import { afterEach, describe, expect, test, vi } from 'vitest';
import * as prototypeApi from '@comblang/prototypes';
import { syntheticPrototypeDatabase } from '@comblang/prototypes';
import {
  createTrustedEntityReplayContext,
  entityReplayContextTransport,
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

function parameterHost() {
  const profile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:constant-combinator' as EntityProfile['ref']['prototypeKey'],
      profileId: 'profile:worker-parameter-session' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'constant-combinator',
  };
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'worker-parameter-session-evidence',
    policyIdentity: 'worker-parameter-session-policy',
    profiles: [profile],
  });
  const prototype: EntityPrototype = {
    key: 'entity:constant-combinator' as EntityPrototype['key'],
    name: 'constant-combinator',
    type: 'constant-combinator',
    tileWidth: 1,
    tileHeight: 1,
  };
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: trustedEntityReplayContext.database,
    getEntity(nameOrKey) {
      return nameOrKey === prototype.key || nameOrKey === prototype.name ? prototype : undefined;
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
      expect(artifact.blueprint.blueprint.entities[0]!.control_behavior).toMatchObject({
        sections: {
          sections: [
            {
              filters: [
                {
                  type: 'virtual',
                  name,
                  count: amount,
                  ...(quality === undefined ? {} : { quality }),
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
    expect(parameters).toEqual(defaultsBefore);
    expect(original).toEqual(originalBefore);
    expect(runCount()).toBe(1);
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
        parameterBinding: true,
        blueprintExport: {
          parameters: true,
        },
      }),
    );
    expect(response.result.blueprintExport).toMatchObject({ ok: false });
    expect(response.result.pipelineDiagnostics).toEqual([]);
    expect(response.parameterBinding).toMatchObject({ ok: true, token: expect.any(String) });
    if (response.parameterBinding?.ok !== true || response.parameterBinding.token === undefined) {
      throw new Error('Expected a retained session despite native export failure.');
    }
    expect(
      runtime.bindParameters(response.parameterBinding.token, response.revision).plan,
    ).toBeDefined();
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
});
