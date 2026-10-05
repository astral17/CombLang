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

import {
  CompilerWorkerParameterBindingError,
  CompilerWorkerRuntime,
} from './compiler-worker-request.js';
import type { CompilerWorkerRequest } from './worker-protocol.js';

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
      const response = await runtime.handle(request);
      expect(response).not.toHaveProperty('parameterBinding');
      expect(() => runtime.bindParameters(token, 45)).toThrow(CompilerWorkerParameterBindingError);
    }
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
    expect(() => runtime.bindParameters(previousToken, 54)).toThrow(
      CompilerWorkerParameterBindingError,
    );
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
