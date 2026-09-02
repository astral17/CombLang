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

The participant set and testbench configuration are frozen while that
transition is evaluated. Device and model callbacks cannot call mutating
`TestSession` APIs (`drive`, `pulse`, `clear`, `at`, `trace`, `mock`, `model`,
`adaptObject`, or clock methods), and the simulation kernels independently
reject device registration or reentrant stepping during evaluation. This makes
the result independent of participant traversal order.

Network handles are resolved by the elaboration session that created the
circuit. A handle from another runtime is rejected instead of being matched by
its textual ID. `read()` returns a copy, so test code cannot mutate a committed
snapshot.

For an executed source plan, prefer `execution.createTestSession()`. Its targets
may be either public handles returned by `execution.network(name)` or internal
Network entries returned by `execution.debug`. A test drive models an external
circuit participant, so source-level `Readonly<Network>` and `Ref<Network>`
capabilities do not restrict it. This does not revive ownership aliases: a moved
debug entry is rejected, as are handles and debug entries belonging to another
execution.

## Time control

`tick(count)` and its explicit alias `run(count)` advance the synchronous clock.
`at(tick, callback)` schedules a callback immediately before the named boundary
is evaluated, so a drive scheduled for tick 5 is visible in snapshot 5.

```ts
test.at(5, () => test.drive(input, [[SIGNAL_A, 20]]));
test.run(10);
```

A scheduled callback may change drives, pulses, mocks, and later scheduling, but
it cannot call `tick`, `run`, or `settle` recursively. One runner boundary call
therefore commits exactly one transition. While boundary 5 is being evaluated,
`at(5, ...)` is rejected as already active and `at(6, ...)` remains valid.
These callbacks run before participant evaluation and are therefore the proper
place for external-world stimulus; the stricter model callback rules do not
apply to them.

`settle({ maxTicks })` advances until two consecutive complete simulation
snapshots are equal. It throws when the bound is exhausted, including for an
oscillating circuit. Settling deliberately observes the whole circuit for now;
selected observation sets remain a later extension. Future scheduled
external events do not keep it running: `settle()` finds a fixed point under
the inputs active now and may return before an event scheduled for a later tick.

Object adapters, traces, and the physical debug index are implemented below.

## Known and Unknown values

Test sessions use a separate opt-in whole-bus value kernel. Its values are
either `Known(SparseBus)` or `Unknown(origins)`. Unknown is epistemic: it means
that the available model cannot determine the exact bus, rather than merely
marking every value that has a possible dependency. An Unknown broadcaster
makes an aggregated Network unknown, and arithmetic and decider combinators
extend the retained dependency path when they actually read it. Origins are
deduplicated and canonically ordered, including conflicting descriptions for
the same stable origin ID, so device traversal order cannot change diagnostics.

For Deciders without `Each`, condition evaluation uses three values. A known
false child makes `false && Unknown` false, and a known true child makes
`true || Unknown` true. Once the condition is known, only the selected output
branch contributes dependencies, so an Unknown value used solely by the
inactive branch does not contaminate a known result. `Each` may choose a branch
per signal and remains conservatively whole-bus Unknown until the value kernel
supports partial known/unknown buses.

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
test.trace(test.objectInput(chest), test.objectOutput(chest));
test.run(10);

const events = test.traces.timeline();
const document = test.traces.toJSON();
```

`comblang-trace` version 1 stores target metadata separately from events. Every
target records its tick-zero state. Later Known events contain only changed
signals; a removed signal is represented by a change to zero. An event has
`reset: true` at registration and after a transition from Unknown to Known.
Unknown events retain their complete origin paths.

New version 1 documents also include `endTick`, the last committed test tick.
It includes unchanged final ticks and is retained even when no targets were
registered or a test assertion fails. The last delta event is not necessarily
the end of the test.

Targets and events have stable structural IDs and canonical ordering. Repeated
registration of the same target is harmless. `timeline(targetId)` filters one
target without changing event objects or ordering. Trace registration after
tick zero is rejected for now, because the store must not pretend it captured
history that has already elapsed.

`objectInput(handle, connector?)` records the connector's aggregate input from
each committed snapshot. `objectOutput(handle, connector?)` records only that
object connector's own committed contribution, not the Network after other
devices and drives have been aggregated into it. This distinction remains
correct for shared output Networks and self-contamination. The connector may be
omitted only for a single-connector object, and an output target requires a
connector with at least one output Network.

An object output starts as a known empty bus at `T0`, before the object has
participated in a boundary. Its fallback, mock, or model result is recorded at
`T1`; a strict unmodeled fallback therefore produces a Known-to-Unknown event
with the object's provenance. Object target metadata contains stable object,
adapter, instance, and connector IDs in the same `comblang-trace` document as
Network and signal targets.

Chart rendering is intentionally outside the trace store. The browser's
read-only Test trace panel consumes this shared JSON model independently of
the interactive live simulation.

### Reading a saved trace

`TraceReader` from `@comblang/simulator` restores captured values without
re-executing source or advancing a simulator:

```ts
const reader = new TraceReader(document);
const target = reader.targets[0]!;
const finalValue = reader.read(target.id, reader.endTick); // BusValue

for (const row of reader.snapshots({
  fromTick: Math.max(0, reader.endTick - 31),
  toTick: reader.endTick,
  targets: [target.id],
})) {
  // row.tick; row.values: [{ target, value: Known(...) | Unknown(...) }]
}
```

The tick range is inclusive. Omit `targets` to read every registered target;
an empty list produces tick rows without values. The iterator is lazy and
replays only selected target histories, so a small window near the end of a
long unchanged trace does not expand every earlier tick. `read()` performs a
single-target lookup. Returned buses are copies: changing one cannot alter
later reads or another row.

Network, selected-signal, object-input, and object-output columns remain
distinct targets. In particular, a selected-signal trace is not a complete
Network snapshot, and an object-output trace is its isolated contribution,
not the aggregate wire bus. Quality and Unknown origin paths are retained;
zero deltas remove signals and Known resets clear earlier state.

The reader checks target IDs, tick-zero snapshots, event ordering/duplicates,
int32 changes, selected-signal identity, and resets after Unknown. Unknown
targets and out-of-range tick queries throw instead of inventing zero values.
Input arrays may be unsorted; events are ordered per target during loading.
Legacy v1 documents without `endTick` use the latest event tick and expose
`hasExplicitEndTick === false`: an unrecorded quiet tail cannot be recovered.
This reader is shared infrastructure; the browser uses the same range queries
for its saved test-history table.

### Browser test-history table

Register targets with `session.trace(...)` before advancing the test clock.
After the run, choose **View trace** on a result or select the test in the
**Test trace** panel. Failed assertions keep all history captured before the
failure. Tests without registered targets show an explanation rather than an
invented all-zero circuit history.

The overview has one column per recorded target and up to three signal/value
lines in each cell, followed by an overflow count. Click a target header or
choose it in **View** to display one column per signal. Quality-qualified
signals remain distinct. An Unknown cell is labelled explicitly; expand it
to inspect origin descriptions and dependency paths. Network, selected-signal,
object-input, and isolated object-output targets are separate observations.
Network display names travel with each test result as `traceNetworkNames`,
so the browser does not resolve IDs against a different execution.

**Start tick**, **Ticks per page** (1–256), and **Previous/Next** select an
inclusive read-only window; by default the panel opens at the last 32 ticks.
Long stable tails remain browseable through `endTick`. This does not change
the live simulation's selected tick, snapshots, play/pause state, or editors.
Source or test edits invalidate the displayed history immediately; a pending
test result from the old source cannot restore a stale trace. This selection
is presentation state, not another execution of the circuit or test body.

The collapsible **Inspect source scopes and combinators** area browses the same
test's `comblang-debug` snapshot. A selected Network/signal trace lists every
source alias and connected physical Producer, labelled as reading/writing the
bus. Source buttons select exact spans; **Configuration** shows physical IDs,
configuration and placement. The scope selector distinguishes repeated function
calls and loop iterations. Failed debug queries open their exact scope when it
exists, while failure line buttons select the test-editor location. See
[portable debug inspection](debug-index.md#portable-inspection-and-browser-navigation)
for identity rules and the current object-adapter mapping boundary.

## Debug index

`elaborateDirectPlan(plan)` returns both `circuit` and an immutable `debug`
index. It maps exact lexical function/loop scopes and source spans to the
physical Networks and Producers created by that execution:

```ts
const execution = elaborateDirectPlan(plan);
const test = execution.createTestSession();
const stage = execution.debug.root.child('function Stage');

const local = stage.network('local');
const firstProducer = stage.combinator(1);

test.drive(local, [[SIGNAL_A, 5]]);
test.tick();
test.expect(local).toContain([[SIGNAL_A, 5]]);
```

Missing and ambiguous queries throw deterministic `DebugQueryError` values.
Repeated calls use sibling scopes such as `function Stage` and
`function Stage #2`. The test-only transform supports
`const dut = t.instantiate(Stage, input)` and the completed execution exposes
its physical value and unique root through `execution.instance('dut')`. See the
[runtime debug index](debug-index.md) for the two-phase capture contract, query
rules, and retained metadata.

Structural assertions are available through `execution.structure(dut.$)`.
They recursively inspect physical producer counts, named Networks/Producers,
placement, configuration, zero-tick aliases, and shortest combinator latency.
They operate entirely on EG and `DebugIndex`; they neither create a probe nor
advance the test clock. Failure uses structured `DBG2001` expected/actual
details. The complete matcher contract is documented with the
[runtime debug index](debug-index.md#structural-assertions).

## Generic object adapters

At tick zero, `adaptObject(adapter, instance)` registers a future typed object's
stable identity and named connector mapping without changing EG/NCIR. A
connector declares the Networks aggregated for input and the Networks receiving
its output contribution. `readObjectInput(handle, connector)` returns the
current Known/Unknown aggregate.

An adapter may supply per-instance `defaultOutput(instance, connector)` and
class-level `classDefaultOutput(connector)` values. They are resolved and copied
once at registration, then contribute at every synchronous boundary with
ordinary Network aggregation. Unknown defaults retain their origin and gain the
object device ID in their dependency path. Registration and handles are bound
to one `TestSession`, and new objects cannot be registered after tick zero.

The complete fallback order is explicit mock/model, instance default, class
default, then the session's global object policy. The global default is strict
Unknown; `{ objects: { default: 'zero' } }` selects a known empty bus, while a
function can return a connector-specific sparse bus, Known/Unknown value, or
mode. Custom policies run and are copied once at registration, so tick-dependent
external behavior remains a reactive model. See
[generic object test adapters](object-test-adapters.md) for the complete
contract and Phase 6 boundary.

Persistent manual output is available through
`mock(object, connector?).output(values)`. Omitting the connector requires an
object with exactly one connector. Values are copied immediately; another
`output` replaces the previous override, while `clear()` restores the copied
adapter default or silence. Manual output uses the connector's declared output
Networks, participates in ordinary aggregation, may be changed from `at(...)`,
and remains visible on the connector input snapshot when wiring feeds the
object's output back into its input.

Reactive connector behavior is available through
`model(object, { initialState, step }, connector?)`. The runner calls
`step({ input, state, tick })` once per connector and boundary. The transition
reads committed snapshot/state `T`; returned `{ state, output? }` becomes
visible only at `T+1`. State is copied and recursively frozen. A failed kernel
boundary publishes neither its Network output nor its model state, so a retry
starts from the same `T`.

`step` is a synchronous transition function, not an imperative test callback.
It may read its frozen input/state/tick and return next state/output, but it may
not mutate the `TestSession`, providers, traces, topology, or clock through a
closure. Arbitrary JavaScript side effects outside the model API (such as
appending to a captured array) cannot be rolled back if a later participant
fails; model authors must therefore keep `step` functionally pure with respect
to the external world. Transactionality covers only the state and output
returned through the model API.

Mock and model share one explicit-provider slot per connector and replace each
other. Clearing only the still-active controller restores the resolved fallback.
An omitted model output is deliberate silence, not a request for fallback.
Scheduled callbacks can install or replace a model before that boundary
evaluates. The complete contract is documented in
[reactive models](object-test-adapters.md#reactive-models).

## Browser workbench

The current web workbench has a separate `circuit.test.js` editor. Its draft is
stored independently from `main.factorio.ts`; recompiling the circuit does not
overwrite test code. `Add test` appends another test block.

Each `test(name, callback)` executes against a fresh elaborated circuit in a
separate worker. A runaway test is terminated by the UI budget instead of
blocking the editor. Results show every passing or failing test, and failures
include structured assertion details, debug/structural codes and candidates;
assertion/runtime stacks are mapped back to their source line. Every result also
carries its session's `comblang-trace` document. A syntax error is visible but
may lack a line until test parsing shares the compiler worker without
duplicating TypeScript in the small test worker. The temporary JavaScript API
exposes:

```js
test('example', ({ network, drive, clear, pulse, tick, run, expect, expectSignal }) => {
  const A = Signal('virtual', 'signal-A');
  drive(network('input'), [[A, 7]]);
  tick(2);
  expectSignal(network('output'), A).toBe(8);
});
```

The callback additionally receives `execution` and `session`. They expose the
complete debug hierarchy, structural assertions, direct trace registration,
and newer testbench APIs without repeatedly widening the temporary convenience
wrapper.

The runner calls `session.finish()` when the synchronous callback returns or
throws. Every later mutating call is rejected, including one scheduled by a
detached Promise or `queueMicrotask`, so completed results cannot be changed by
late callbacks. Async bodies remain unsupported. Session sealing protects
state correctness; terminating a disposable browser worker remains the
availability boundary for runaway microtask loops, and stronger CLI process
isolation is deferred with the hardened sandbox.

`runDirectPlanTests` in `@comblang/runtime` owns this result contract. The web
worker is a thin availability wrapper, while
`factorio-dsl test [--json] source.factorio.ts circuit.test.js` invokes the same
runner under Node. Consequently CLI JSON and browser messages preserve the same
failure kind, code, details, candidates, source position, and trace schema.

This is an execution surface for the Phase 5 functionality, not the final test
language syntax. The runner, `TestSession`, assertions, and result model do not
depend on the callback spelling, so a later test compiler can replace it. The
worker is an availability boundary, not yet the deferred hardened module
sandbox.

The old single-signal bar waveform has been replaced by two table views:

- overview rows are ticks and columns are Networks; a cell shows up to three
  `type/signal: value` entries followed by an overflow count;
- selecting a Network changes columns to every signal seen on that Network and
  keeps ticks as rows, making pipelines, disappearing signals, and exact values
  easy to compare.

Both live tables scroll horizontally on narrow screens. Their model remains
separate from DOM rendering. The read-only **Test trace** panel uses the shared
`comblang-trace` replay API; it does not replace or mutate the live simulation.

The live circuit view starts paused with one explicit all-zero `T0`; absent
signals are displayed and read as zero. `Play`/`Pause`, `Step`, `Run N`, and
`Reset` control an interactive browser simulation. Complete history is retained
for the compiled source, while the table shows a configurable window of 32
ticks by default. A tick can be selected from a row or by number.

The selected snapshot can be edited by Network and structural Signal identity,
including optional quality. Setting zero removes that sparse entry, while
clearing a Network removes every entry. Editing or stepping from an older tick
truncates its former future and creates a new deterministic branch. Double-click
loads a concrete signal cell into the editor; double-clicking an empty or
multi-signal overview cell selects its tick and Network so a previously absent
signal can be entered in the retained form.
