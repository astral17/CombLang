import { Signal, SparseBus } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';
import { describe, expect, it } from 'vitest';

import { knownBus, unknownBus } from './bus-value.js';
import type { CircuitObjectAdapter } from './object-adapter.js';
import { TestSession } from './test-session.js';
import { ValueSimulationKernel } from './value-kernel.js';

const A = Signal('virtual', 'signal-A');
const network = (id: string) => id as NetworkId;

interface SyntheticObject {
  readonly id: string;
  readonly inputs: readonly NetworkId[];
  readonly output: NetworkId;
  readonly defaultValue: SparseBus;
}

const syntheticAdapter: CircuitObjectAdapter<SyntheticObject, 'circuit'> = {
  id: 'synthetic-object',
  instanceId: (instance) => instance.id,
  connectors: (instance) => [
    {
      name: 'circuit',
      inputNetworks: instance.inputs,
      outputNetworks: [instance.output],
    },
  ],
  defaultOutput: (instance) => knownBus(instance.defaultValue),
};

describe('generic circuit object adapter', () => {
  it('aggregates connector input snapshots and injects a copied default output', () => {
    const inputRed = network('network:input-red');
    const inputGreen = network('network:input-green');
    const output = network('network:output');
    const defaultValue = new SparseBus([[A, 7]]);
    const session = new TestSession(new ValueSimulationKernel());
    const object = session.adaptObject(syntheticAdapter, {
      id: 'probe-1',
      inputs: [inputRed, inputGreen],
      output,
      defaultValue,
    });
    defaultValue.set(A, 100);

    expect(object).toMatchObject({
      kind: 'test-object',
      adapterId: 'synthetic-object',
      instanceId: 'probe-1',
      connectors: ['circuit'],
    });
    expect(session.readObjectInput(object, 'circuit')).toMatchObject({ kind: 'known' });

    session
      .drive(inputRed, [[A, 2]])
      .drive(inputGreen, [[A, 3]])
      .drive(output, [[A, 4]])
      .tick();

    const input = session.readObjectInput(object, 'circuit');
    expect(input.kind === 'known' ? input.bus.get(A) : undefined).toBe(5);
    expect(session.read(output).get(A)).toBe(11);
  });

  it('preserves Unknown output provenance through the object instance', () => {
    const output = network('network:unknown-output');
    const adapter: CircuitObjectAdapter<{ readonly id: string }, 'output'> = {
      id: 'unknown-object',
      instanceId: ({ id }) => id,
      connectors: () => [{ name: 'output', inputNetworks: [], outputNetworks: [output] }],
      defaultOutput: ({ id }) =>
        unknownBus([{ id: `unmodeled:${id}`, description: `Unmodeled ${id}` }]),
    };
    const session = new TestSession(new ValueSimulationKernel());
    const object = session.adaptObject(adapter, { id: 'probe-2' });

    session.tick();

    expect(session.readValue(output)).toEqual({
      kind: 'unknown',
      origins: [
        {
          id: 'unmodeled:probe-2',
          description: 'Unmodeled probe-2',
          path: [object.id],
        },
      ],
    });
  });

  it('replaces and clears persistent connector mocks with normal aggregation', () => {
    const output = network('network:mock-output');
    const session = new TestSession(new ValueSimulationKernel());
    const object = session.adaptObject(syntheticAdapter, {
      id: 'mocked',
      inputs: [],
      output,
      defaultValue: new SparseBus([[A, 7]]),
    });
    const mock = session.mock(object);
    const mutable = new SparseBus([[A, 10]]);
    mock.output(mutable);
    mutable.set(A, 100);
    session.drive(output, [[A, 4]]).tick();
    expect(session.read(output).get(A)).toBe(14);

    mock.output([[A, 20]]);
    session.tick();
    expect(session.read(output).get(A)).toBe(24);

    mock.clear();
    session.tick();
    expect(session.read(output).get(A)).toBe(11);
  });

  it('keeps an output Network visible on the same connector input snapshot', () => {
    const loop = network('network:self-contamination');
    const adapter: CircuitObjectAdapter<{ readonly id: string }, 'circuit'> = {
      id: 'loop-object',
      instanceId: ({ id }) => id,
      connectors: () => [{ name: 'circuit', inputNetworks: [loop], outputNetworks: [loop] }],
    };
    const session = new TestSession(new ValueSimulationKernel());
    const object = session.adaptObject(adapter, { id: 'loop-1' });
    const mock = session.mock(object, 'circuit').output([[A, 5]]);

    session.tick();
    const firstInput = session.readObjectInput(object, 'circuit');
    expect(firstInput.kind === 'known' ? firstInput.bus.get(A) : undefined).toBe(5);

    session.at(2, () => mock.output([[A, 8]]));
    session.tick();
    const secondInput = session.readObjectInput(object, 'circuit');
    expect(secondInput.kind === 'known' ? secondInput.bus.get(A) : undefined).toBe(8);
  });

  it('runs a reactive model once per tick and commits state and output at T+1', () => {
    const input = network('network:model-input');
    const left = network('network:model-left');
    const right = network('network:model-right');
    const adapter: CircuitObjectAdapter<{ readonly id: string }, 'circuit'> = {
      id: 'reactive-object',
      instanceId: ({ id }) => id,
      connectors: () => [
        {
          name: 'circuit',
          inputNetworks: [input],
          outputNetworks: [left, right],
        },
      ],
    };
    const session = new TestSession(new ValueSimulationKernel());
    const object = session.adaptObject(adapter, { id: 'counter' });
    const initialState = { total: 0, nested: { untouched: true } };
    const calls: { readonly tick: number; readonly input: number; readonly state: number }[] = [];
    const model = session.model(object, {
      initialState,
      step: ({ input: value, state, tick }) => {
        calls.push({
          tick,
          input: value.kind === 'known' ? value.bus.get(A) : 0,
          state: state.total,
        });
        const total = state.total + (value.kind === 'known' ? value.bus.get(A) : 0);
        return { state: { ...state, total }, output: [[A, total]] };
      },
    });
    initialState.total = 100;

    expect(Object.isFrozen(model.state)).toBe(true);
    expect(Object.isFrozen(model.state.nested)).toBe(true);
    session.drive(input, [[A, 3]]).tick();
    expect(model.state.total).toBe(0);
    expect(session.read(left).get(A)).toBe(0);
    expect(session.read(right).get(A)).toBe(0);

    session.tick(2);
    expect(calls).toEqual([
      { tick: 0, input: 0, state: 0 },
      { tick: 1, input: 3, state: 0 },
      { tick: 2, input: 3, state: 3 },
    ]);
    expect(model.state.total).toBe(6);
    expect(session.read(left).get(A)).toBe(6);
    expect(session.read(right).get(A)).toBe(6);
  });

  it('uses one replaceable provider per connector and restores adapter defaults on clear', () => {
    const output = network('network:provider-output');
    const session = new TestSession(new ValueSimulationKernel());
    const object = session.adaptObject(syntheticAdapter, {
      id: 'replaceable',
      inputs: [],
      output,
      defaultValue: new SparseBus([[A, 7]]),
    });
    let firstModelCalls = 0;
    const firstModel = session.model(object, {
      initialState: 0,
      step: ({ state }) => {
        firstModelCalls += 1;
        return { state: state + 1, output: [[A, 2]] };
      },
    });
    session.tick();
    expect(session.read(output).get(A)).toBe(2);

    const mock = session.mock(object).output([[A, 9]]);
    session.tick();
    expect(session.read(output).get(A)).toBe(9);
    expect(firstModelCalls).toBe(1);

    const secondModel = session.model(object, {
      initialState: 'active',
      step: ({ state }) => ({ state, output: [[A, 4]] }),
    });
    mock.clear();
    firstModel.clear();
    session.tick();
    expect(session.read(output).get(A)).toBe(4);

    secondModel.clear();
    session.tick();
    expect(session.read(output).get(A)).toBe(7);
  });

  it('treats an omitted model output as silence and validates initial state', () => {
    const output = network('network:silent-model');
    const session = new TestSession(new ValueSimulationKernel());
    const object = session.adaptObject(syntheticAdapter, {
      id: 'silent-model',
      inputs: [],
      output,
      defaultValue: new SparseBus([[A, 7]]),
    });
    const model = session.model(object, {
      initialState: { calls: 0 },
      step: ({ state }) => ({ state: { calls: state.calls + 1 } }),
    });

    session.tick();
    expect(session.read(output).size).toBe(0);
    expect(model.state.calls).toBe(1);
    expect(() =>
      session.model(object, {
        initialState: new Map<string, number>(),
        step: ({ state }) => ({ state }),
      }),
    ).toThrowError('only literals, arrays, and plain objects');
  });

  it('preserves committed model state and permanently seals a failed participant boundary', () => {
    const firstOutput = network('network:atomic-first');
    const failingOutput = network('network:atomic-failing');
    const session = new TestSession(new ValueSimulationKernel());
    const first = session.adaptObject(syntheticAdapter, {
      id: 'atomic-first',
      inputs: [],
      output: firstOutput,
      defaultValue: new SparseBus(),
    });
    const failing = session.adaptObject(syntheticAdapter, {
      id: 'atomic-failing',
      inputs: [],
      output: failingOutput,
      defaultValue: new SparseBus(),
    });
    const seenStates: number[] = [];
    const controller = session.model(first, {
      initialState: 0,
      step: ({ state }) => {
        seenStates.push(state);
        return { state: state + 1, output: [[A, state + 1]] };
      },
    });
    const mock = session.mock(failing);
    session.model(failing, {
      initialState: null,
      step: ({ tick }) => {
        if (tick === 0) return { state: null };
        throw new Error('external object failed');
      },
    });

    session.trace(firstOutput, session.objectOutput(first)).tick();
    const committed = session.snapshot;
    const trace = session.traces.toJSON();
    expect(() => session.tick()).toThrowError('external object failed');
    expect(session.currentTick).toBe(1);
    expect(session.snapshot).toBe(committed);
    expect(session.traces.toJSON()).toEqual(trace);
    for (const mutate of [
      () => controller.clear(),
      () => mock.output([]),
      () => mock.clear(),
      () => session.mock(first),
      () => session.model(first, { initialState: 0, step: ({ state }) => ({ state }) }),
      () =>
        session.adaptObject(syntheticAdapter, {
          id: 'late',
          inputs: [],
          output: firstOutput,
          defaultValue: new SparseBus(),
        }),
      () => session.tick(),
    ])
      expect(mutate).toThrow('TestSession failed at boundary 2;');
    expect(seenStates).toEqual([0, 1]);
    expect(controller.state).toBe(1);
    expect(session.read(firstOutput).get(A)).toBe(1);
  });

  it('cannot reuse mocks changed by a failed scheduled action', () => {
    const output = network('network:scheduled-mock');
    const session = new TestSession(new ValueSimulationKernel());
    const object = session.adaptObject(syntheticAdapter, {
      id: 'scheduled-mock',
      inputs: [output],
      output,
      defaultValue: new SparseBus(),
    });
    const mock = session.mock(object).output([[A, 3]]);
    session.trace(output, session.objectOutput(object)).tick();
    const trace = session.traces.toJSON();
    session.at(2, () => {
      mock.output([[A, 9]]);
      throw new Error('mock callback failed');
    });
    expect(() => session.tick()).toThrow('mock callback failed');
    expect(session.read(output).get(A)).toBe(3);
    const input = session.readObjectInput(object, 'circuit');
    expect(input.kind === 'known' && input.bus.get(A)).toBe(3);
    expect(session.traces.toJSON()).toEqual(trace);
    expect(() => mock.clear()).toThrow('TestSession failed at boundary 2;');
    expect(() => session.tick()).toThrow('TestSession failed at boundary 2;');
  });

  it('rejects model side-channel mutations independently of participant order', () => {
    const run = (order: readonly ['source' | 'target', 'source' | 'target']) => {
      const session = new TestSession(new ValueSimulationKernel());
      const handles = new Map(
        order.map((id) => [
          id,
          session.adaptObject(syntheticAdapter, {
            id,
            inputs: [],
            output: network(`network:${id}`),
            defaultValue: new SparseBus(),
          }),
        ]),
      );
      session.model(handles.get('source')!, {
        initialState: 0,
        step: ({ state }) => {
          session.mock(handles.get('target')!).output([[A, 123]]);
          return { state: state + 1, output: [] };
        },
      });

      let error: unknown;
      try {
        session.tick();
      } catch (caught) {
        error = caught;
      }
      expect(session.currentTick).toBe(0);
      return error;
    };

    const sourceFirst = run(['source', 'target']);
    const targetFirst = run(['target', 'source']);
    expect(sourceFirst).toBeInstanceOf(Error);
    expect((sourceFirst as Error).message).toBe(
      'TestSession mutation mock is not allowed during participant evaluation.',
    );
    expect((targetFirst as Error).message).toBe((sourceFirst as Error).message);
  });

  it('keeps the participant set fixed during a model transition', () => {
    const session = new TestSession(new ValueSimulationKernel());
    const source = session.adaptObject(syntheticAdapter, {
      id: 'source',
      inputs: [],
      output: network('network:source'),
      defaultValue: new SparseBus(),
    });
    session.model(source, {
      initialState: null,
      step: ({ state }) => {
        session.adaptObject(syntheticAdapter, {
          id: 'late',
          inputs: [],
          output: network('network:late'),
          defaultValue: new SparseBus(),
        });
        return { state, output: [] };
      },
    });

    expect(() => session.tick()).toThrow(
      'TestSession mutation adaptObject is not allowed during participant evaluation.',
    );
    expect(session.currentTick).toBe(0);
  });

  it('seals object registration and provider controllers after finish', () => {
    const session = new TestSession(new ValueSimulationKernel());
    const object = session.adaptObject(syntheticAdapter, {
      id: 'finished',
      inputs: [],
      output: network('network:finished'),
      defaultValue: new SparseBus(),
    });
    const mock = session.mock(object).output([]);
    const model = session.model(object, {
      initialState: null,
      step: ({ state }) => ({ state, output: [] }),
    });
    session.finish();

    expect(() => session.mock(object)).toThrow('TestSession is finished; mock cannot mutate it.');
    expect(() => mock.output([])).toThrow('TestSession is finished; mock.output cannot mutate it.');
    expect(() => mock.clear()).toThrow('TestSession is finished; mock.clear cannot mutate it.');
    expect(() => model.clear()).toThrow('TestSession is finished; model.clear cannot mutate it.');
    expect(() =>
      session.adaptObject(syntheticAdapter, {
        id: 'too-late',
        inputs: [],
        output: network('network:too-late'),
        defaultValue: new SparseBus(),
      }),
    ).toThrow('TestSession is finished; adaptObject cannot mutate it.');
  });

  it('can install a reactive model from a scheduled boundary action', () => {
    const output = network('network:scheduled-model');
    const session = new TestSession(new ValueSimulationKernel());
    const object = session.adaptObject(syntheticAdapter, {
      id: 'scheduled-model',
      inputs: [],
      output,
      defaultValue: new SparseBus([[A, 1]]),
    });
    session.at(2, () => {
      session.model(object, {
        initialState: 0,
        step: ({ state }) => ({ state: state + 1, output: [[A, state + 5]] }),
      });
    });

    session.tick();
    expect(session.read(output).get(A)).toBe(1);
    session.tick();
    expect(session.read(output).get(A)).toBe(5);
  });

  it('resolves instance, class, custom, and strict Unknown defaults in order', () => {
    type Connector = 'instance' | 'class' | 'global' | 'strict';
    const outputs = {
      instance: network('network:default-instance'),
      class: network('network:default-class'),
      global: network('network:default-global'),
      strict: network('network:default-strict'),
    } as const;
    const instanceBus = new SparseBus([[A, 1]]);
    const classBus = new SparseBus([[A, 2]]);
    const globalBus = new SparseBus([[A, 3]]);
    const policyCalls: string[] = [];
    const adapter: CircuitObjectAdapter<{ readonly id: string }, Connector> = {
      id: 'default-object',
      instanceId: ({ id }) => id,
      connectors: () =>
        (Object.keys(outputs) as Connector[]).map((name) => ({
          name,
          inputNetworks: [],
          outputNetworks: [outputs[name]],
        })),
      defaultOutput: (_instance, connector) =>
        connector === 'instance' ? knownBus(instanceBus) : undefined,
      classDefaultOutput: (connector) => (connector === 'class' ? knownBus(classBus) : undefined),
    };
    const session = new TestSession(new ValueSimulationKernel(), {
      objects: {
        default: (context) => {
          policyCalls.push(context.connector);
          return context.connector === 'global' ? globalBus : undefined;
        },
      },
    });
    const object = session.adaptObject(adapter, { id: 'defaults' });
    instanceBus.set(A, 10);
    classBus.set(A, 20);
    globalBus.set(A, 30);
    session.tick();

    expect(policyCalls).toEqual(['global', 'strict']);
    expect(session.read(outputs.instance).get(A)).toBe(1);
    expect(session.read(outputs.class).get(A)).toBe(2);
    expect(session.read(outputs.global).get(A)).toBe(3);
    expect(session.readValue(outputs.strict)).toEqual({
      kind: 'unknown',
      origins: [
        {
          id: 'unmodeled:default-object:defaults:strict',
          description: 'Unmodeled output default-object:defaults:strict',
          path: [object.id],
        },
      ],
    });
  });

  it('supports an explicit global zero policy', () => {
    const output = network('network:zero-default');
    const adapter: CircuitObjectAdapter<{ readonly id: string }, 'circuit'> = {
      id: 'zero-default-object',
      instanceId: ({ id }) => id,
      connectors: () => [{ name: 'circuit', inputNetworks: [], outputNetworks: [output] }],
    };
    const session = new TestSession(new ValueSimulationKernel(), {
      objects: { default: 'zero' },
    });
    session.adaptObject(adapter, { id: 'zero' });

    session.tick();
    expect(session.readValue(output)).toMatchObject({ kind: 'known' });
    expect(session.read(output).size).toBe(0);
  });

  it('enforces instance, connector, session, and registration identity', () => {
    const output = network('network:identity-output');
    const instance = {
      id: 'same',
      inputs: [] as const,
      output,
      defaultValue: new SparseBus(),
    };
    const session = new TestSession(new ValueSimulationKernel());
    const object = session.adaptObject(syntheticAdapter, instance);

    expect(() => session.adaptObject(syntheticAdapter, instance)).toThrowError(
      'Duplicate circuit object instance: synthetic-object:same.',
    );
    expect(() => session.readObjectInput(object, 'missing' as 'circuit')).toThrowError(
      'has no connector named "missing"',
    );
    const foreignSession = new TestSession(new ValueSimulationKernel());
    expect(() => foreignSession.readObjectInput(object, 'circuit')).toThrowError(
      'Foreign or invalid test object handle.',
    );
    expect(() => foreignSession.mock(object)).toThrowError(
      'Foreign or invalid test object handle.',
    );
    expect(() => foreignSession.objectInput(object)).toThrowError(
      'Foreign or invalid test object handle.',
    );

    const multiAdapter: CircuitObjectAdapter<{ readonly id: string }, 'left' | 'right'> = {
      id: 'multi-object',
      instanceId: ({ id }) => id,
      connectors: () => [
        { name: 'left', inputNetworks: [], outputNetworks: [output] },
        { name: 'right', inputNetworks: [], outputNetworks: [] },
      ],
    };
    const multi = session.adaptObject(multiAdapter, { id: 'multi' });
    expect(() => session.mock(multi)).toThrowError('select one explicitly');
    expect(() => session.mock(multi, 'right')).toThrowError('has no output Networks');
    expect(() => session.objectInput(multi)).toThrowError('select one explicitly');
    expect(() => session.objectOutput(multi, 'right')).toThrowError('has no output Networks');

    session.tick();
    expect(() => session.adaptObject(syntheticAdapter, { ...instance, id: 'late' })).toThrowError(
      'must be registered before the first tick',
    );
  });
});
