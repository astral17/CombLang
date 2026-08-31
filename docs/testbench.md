# Testbench

Phase 5 introduces a browser/Node-neutral `TestSession` around an already
elaborated circuit. Creating or using a test session does not execute the source
program again and does not change EG/NCIR topology.

The first testbench slice provides persistent external drives, one-boundary
pulses, clearing, clock advancement, and snapshot reads:

```ts
const test = circuit.createTestSession();

test.drive(input, [[SIGNAL_A, 10]]);
test.tick();

test.pulse(input, [[SIGNAL_A, 1]]);
test.tick();

const value = test.read(output).get(SIGNAL_A);
test.clear(input);
```

`drive` replaces the previous persistent drive for that Network. `clear`
removes both its persistent drive and a pending pulse. `pulse` broadcasts for
the next committed boundary only. Inputs are copied immediately and values are
normalized by `SparseBus` to Factorio `int32` circuit values.

All participants read snapshot `T`; their outputs are aggregated and committed
together to `T+1`. Consequently a drive becomes visible on its target Network
after one `tick()`, while a combinator reading it publishes its response on the
following tick.

Network handles are resolved by the elaboration session that created the
circuit. A handle from another runtime is rejected instead of being matched by
its textual ID. `read()` returns a copy, so test code cannot mutate a committed
snapshot.

## Time control

`tick(count)` and its explicit alias `run(count)` advance the synchronous clock.
`at(tick, callback)` schedules a callback immediately before the named boundary
is evaluated, so a drive scheduled for tick 5 is visible in snapshot 5.

```ts
test.at(5, () => test.drive(input, [[SIGNAL_A, 20]]));
test.run(10);
```

`settle({ maxTicks })` advances until two consecutive complete simulation
snapshots are equal. It throws when the bound is exhausted, including for an
oscillating circuit. Settling deliberately observes the whole circuit for now;
selected observation sets will be introduced with traces.

Object adapters, traces, and debug hierarchy are later Phase 5 slices.

## Known and Unknown values

Test sessions use a separate opt-in whole-bus value kernel. Its values are
either `Known(SparseBus)` or `Unknown(origins)`. An Unknown broadcaster makes
the aggregated Network unknown, and arithmetic and decider combinators extend
the retained dependency path when they read it. Origins are deduplicated and
canonically ordered, so device traversal order cannot change diagnostics.

The ordinary production `SimulationKernel` remains on its existing concrete
`SparseBus` path. `readValue(network)` exposes the lattice value. The convenient
`read(network)` returns the known bus, but throws with the current tick and
origin descriptions instead of silently treating Unknown as an empty bus.

## Assertions

Assertions read the current committed snapshot. The direct runtime API supports
both a dedicated signal helper and a composable signal target:

```ts
test.expectSignal(output, SIGNAL_A).toBe(42);
test.expect(test.signal(output, SIGNAL_A)).toBe(42);

test.expect(output).toEqual([
  [SIGNAL_A, 42],
  [SIGNAL_B, -2],
]);
test.expect(output).toContain([[SIGNAL_A, 42]]);
test.expect(output).toHaveSignal(SIGNAL_A);
test.expect(output).toHaveSupport(SIGNAL_A, SIGNAL_B);
test.expect(output).toBeKnown();
```

Whole-Network matchers are `toEqual`, `toContain`, `toBeEmpty`,
`toHaveSignal`, and exact-set `toHaveSupport`. Both Network and signal targets
support `toBeKnown` and `toBeUnknown`. A signal target supports exact `toBe`;
this is also how absence is tested with `toBe(0)`, because zero is not stored in
a `SparseBus`.

Failures are `TestAssertionError` values containing structured details and a
human-readable message. They include the current tick, Network/signal target,
matcher, expected and actual values, and every deterministic dependency path
when the actual value is Unknown.

The future source-level test syntax may lower `test.expect(output[SIGNAL_A])`
to the same signal-target primitive. It is not emulated with ordinary
JavaScript property access in the direct API.

## Traces

Register trace targets at tick zero, then inspect a renderer-independent
timeline or serialize the complete document:

```ts
test.trace(input, output, test.signal(output, SIGNAL_A));
test.run(10);

const events = test.traces.timeline();
const document = test.traces.toJSON();
```

`comblang-trace` version 1 stores target metadata separately from events. Every
target records its tick-zero state. Later Known events contain only changed
signals; a removed signal is represented by a change to zero. An event has
`reset: true` at registration and after a transition from Unknown to Known.
Unknown events retain their complete origin paths.

Targets and events have stable structural IDs and canonical ordering. Repeated
registration of the same target is harmless. `timeline(targetId)` filters one
target without changing event objects or ordering. Trace registration after
tick zero is rejected for now, because the store must not pretend it captured
history that has already elapsed.

Whole Networks and selected signals are implemented. Object input/output trace
targets remain pending until the Phase 5 generic object-adapter boundary is
available. Chart rendering is intentionally outside the trace store; the web
waveform will consume this shared JSON model later.
