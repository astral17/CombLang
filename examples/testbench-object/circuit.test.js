const A = Signal('virtual', 'signal-A');

// A synthetic test participant, not a Factorio entity implementation.
function probe(session, network) {
  return session.adaptObject(
    {
      id: 'acceptance-probe',
      instanceId: (instance) => instance.id,
      connectors: () => [
        {
          name: 'circuit',
          inputNetworks: [network('command').id],
          outputNetworks: [network('sensor').id],
        },
      ],
    },
    { id: 'sensor' },
  );
}

test('unmodeled output propagates Unknown only through active dependencies', ({
  network,
  session,
}) => {
  const object = probe(session, network);
  session.trace(
    network('sensor'),
    network('stage'),
    network('output'),
    network('gated'),
    session.objectInput(object),
    session.objectOutput(object),
  );
  session.expect(network('sensor')).toBeEmpty();
  session.tick();
  session.expect(network('sensor')).toBeUnknown();
  session.expectSignal(network('stage'), A).toBe(1);
  session.tick();
  session.expect(network('stage')).toBeUnknown();
  session.expectSignal(network('output'), A).toBe(2);
  session.tick();
  session.expect(network('output')).toBeUnknown();
  session.expect(network('gated')).toBeEmpty();
});

test('mock replacement aggregates with drives and clear restores strict Unknown', ({
  network,
  session,
}) => {
  const object = probe(session, network);
  session.trace(network('sensor'), network('output'), session.objectOutput(object));
  const mock = session.mock(object).output([[A, 5]]);
  session.run(3);
  session.expectSignal(network('output'), A).toBe(12);
  session.drive(network('sensor'), [[A, 1]]);
  session.run(3);
  session.expectSignal(network('sensor'), A).toBe(6);
  session.expectSignal(network('output'), A).toBe(14);
  mock.output([[A, 8]]);
  session.run(3);
  session.expectSignal(network('sensor'), A).toBe(9);
  session.expectSignal(network('output'), A).toBe(20);
  mock.clear();
  session.clear(network('sensor'));
  session.run(3);
  session.expect(network('output')).toBeUnknown();
});

test('reactive model reads T and publishes state/output at T+1', ({ network, session }) => {
  const object = probe(session, network);
  session.trace(
    network('command'),
    network('sensor'),
    network('stage'),
    network('output'),
    session.objectInput(object),
    session.objectOutput(object),
  );
  const model = session.model(object, {
    initialState: { total: 0 },
    step: ({ input, state }) => {
      if (input.kind === 'unknown') throw new Error('This model requires known command input.');
      const total = state.total + input.bus.get(A);
      return { state: { total }, output: [[A, total]] };
    },
  });
  session.drive(network('command'), [[A, 3]]);
  session.tick();
  session.expect(network('sensor')).toBeEmpty();
  session.tick();
  session.expectSignal(network('sensor'), A).toBe(3);
  session.run(2);
  session.expectSignal(network('sensor'), A).toBe(9);
  session.expectSignal(network('output'), A).toBe(8);
  if (model.state.total !== 9) throw new Error('Model state did not commit with its output.');
  model.clear();
  session.run(3);
  session.expect(network('output')).toBeUnknown();
});
