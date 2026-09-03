const A = Signal('virtual', 'signal-A');
const rareA = Signal('virtual', 'signal-A', 'rare');

test('pulse is retained with quality and zero-tick initial state', ({ network, session }) => {
  const input = network('input');
  const output = network('output');
  session.trace(input, output, session.signal(output, rareA));
  session.expect(input).toBeEmpty();
  session.expect(output).toBeEmpty();
  session.pulse(input, [
    [A, 7],
    [rareA, 3],
  ]);
  session.tick();
  session.expect(input).toEqual([
    [A, 7],
    [rareA, 3],
  ]);
  session.expect(output).toBeEmpty();
  session.tick();
  session.expect(input).toBeEmpty();
  session.expect(output).toEqual([
    [A, 7],
    [rareA, 3],
  ]);
  session.run(6);
  session.expect(output).toEqual([
    [A, 7],
    [rareA, 3],
  ]);
});

test('scheduled replacement settles and later clear preserves memory', ({ network, session }) => {
  const input = network('input');
  const output = network('output');
  session.trace(input, output);
  session.drive(input, [[A, 7]]);
  session.settle({ maxTicks: 5 });
  session.expectSignal(output, A).toBe(7);
  session.at(5, () => session.drive(input, [[A, 11]]));
  session.at(7, () => session.clear(input));
  session.run(4);
  session.expect(input).toBeEmpty();
  session.expectSignal(output, A).toBe(11);
  session.settle({ maxTicks: 4 });
  session.expectSignal(output, A).toBe(11);
});

test('repeated calls have independent feedback and exact debug scopes', ({
  network,
  session,
  execution,
}) => {
  const first = execution.debug.root.child('function MemoCell');
  const second = execution.debug.root.child('function MemoCell #2');
  const input = network('input');
  const output = network('output');
  const secondOutput = network('secondOutput');
  session.trace(output, first.network('mem'), secondOutput, second.network('mem'));
  execution.structure().toHaveProducerCounts({ arithmetic: 2, decider: 2, constant: 0 });
  execution
    .structure(first)
    .toHaveProducerCounts({ arithmetic: 1, decider: 1 })
    .toHaveNetwork('mem');
  execution.structure(second).toHaveProducerCounts({ arithmetic: 1, decider: 1 });
  execution
    .structure(first)
    .toHaveTickLatency(execution.debug.root.network('input'), first.network('mem'), 1);
  session.pulse(input, [[A, 4]]);
  session.pulse(network('secondInput'), [[A, 9]]);
  session.tick(2);
  session.expectSignal(output, A).toBe(4);
  session.expectSignal(first.network('mem'), A).toBe(4);
  session.expectSignal(secondOutput, A).toBe(9);
  session.expectSignal(second.network('mem'), A).toBe(9);
  session.run(4);
  session.expectSignal(output, A).toBe(4);
  session.expectSignal(secondOutput, A).toBe(9);
});
