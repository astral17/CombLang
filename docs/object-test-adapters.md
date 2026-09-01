# Generic object test adapters

Phase 5 defines a simulator-level boundary for testing future typed Factorio
objects without introducing those Phase 6 classes early. A
`CircuitObjectAdapter<Instance, ConnectorName>` maps one object instance onto:

- a stable adapter ID and stable per-adapter instance ID;
- named circuit connectors;
- the logical Networks aggregated as each connector's input;
- the logical Networks receiving each connector's output contribution;
- an optional adapter-level default output for each connector.

The adapter describes physical circuit participation and identity. It is not a
reactive object model and does not own simulation time.

## Registration and handles

Register a concrete instance before the first test tick:

```ts
const probe = test.adaptObject(adapter, instance);

probe.adapterId;
probe.instanceId;
probe.connectors;
```

Registration normalizes and freezes connector descriptors. Adapter and
instance IDs use ASCII letters, digits, dot, underscore, and hyphen. Connector
names and input/output Network lists must be unique. Registering the same
`adapterId:instanceId` twice in one session is rejected.

The returned `TestObjectHandle` is session-bound. Passing it to another session
does not re-resolve it by textual ID. Registration after tick zero is rejected,
so tests cannot silently add a synchronous participant halfway through a run.
EG/NCIR topology is never mutated.

## Connector input snapshots

`test.readObjectInput(probe, connector)` reads the current committed snapshot
and aggregates every declared input Network with the same whole-bus
Known/Unknown lattice used by the test kernel:

```ts
const input = test.readObjectInput(probe, 'circuit');
```

Known values from red/green or other logical inputs sum with normal int32 sparse
bus behavior. One Unknown input makes the whole connector input Unknown and
retains its canonical origins. A connector with no input Networks reads as a
known empty bus. The returned value is a copy and cannot mutate the snapshot.

## Default output injection

`defaultOutput(instance, connector)` is resolved exactly once during
registration and copied into the binding. At every synchronous boundary that
value contributes to every declared output Network. It aggregates normally
with combinators, external drives, and other objects. An Unknown default gains
the object's stable device ID in its dependency path.

The adapter-level default is deliberately only the lowest implemented hook.
Returning `undefined` means that the adapter contributes nothing until a mock,
model, or later global policy supplies a value. The completed resolution policy
will use this order:

1. explicit mock or reactive model;
2. per-instance default;
3. class/adapter default;
4. global policy, strict Unknown by default.

Explicit mock and model providers are implemented. Per-instance/class defaults
and the global strict/zero/custom policy remain pending. Providers are not
folded into `CircuitObjectAdapter`; keeping them in the test runner prevents
object schemas from depending on one test syntax.

## Persistent manual mocks

Select an adapted object and, when necessary, one of its output connectors:

```ts
const output = test.mock(probe, 'circuit');

output.output([[SIGNAL_A, 10]]);
output.output([[SIGNAL_A, 20]]); // replaces 10; it does not aggregate with it
output.clear(); // removes the manual override and restores the adapter default
```

The connector argument may be omitted only when the object has exactly one
connector. A selected connector must declare at least one output Network. Mock
values may be a `SparseBus`, signal/value iterable, or explicit Known/Unknown
`BusValue`; they are copied immediately.

The persistent manual value contributes to the connector's declared output
Networks at every boundary and aggregates normally with drives, combinators,
and other objects. Calling `output(...)` again replaces only that connector's
manual contribution. `clear()` removes it and reveals the copied adapter-level
default, or silence when there is no default.

Mocks may be changed by an `at(tick, callback)` callback. The new value is
selected before participants evaluate that boundary. When an output Network is
also one of the connector's input Networks, the committed output naturally
appears in the next input snapshot; the runner does not hide this Factorio-style
self-contamination.

## Reactive models

A model is a persistent synchronous provider for one connector:

```ts
const counter = test.model(probe, {
  initialState: { total: 0 },
  step: ({ input, state, tick }) => {
    const total = state.total + readCount(input);
    return { state: { total }, output: [[SIGNAL_A, total]] };
  },
});

counter.state;
counter.clear();
```

As with `mock`, the connector can be passed as the third argument and may be
omitted only for a single-connector object. `step` runs exactly once for that
connector on each boundary, even when its output fans out to several Networks.
It reads connector input, immutable state, and tick from committed snapshot
`T`. Only after every synchronous participant succeeds are its returned state
and output committed for `T+1`. If another device throws, the kernel snapshot
and every model state remain at `T`; retrying evaluates the transition again
from the same state.

Model state is structured-cloned and recursively frozen both initially and
after every transition. It may contain literals, arrays, and plain objects, but
not class instances or other mutable host objects. `output` accepts the same
Known/Unknown and sparse-bus forms as a mock. Omitting it means explicit silence
for that boundary rather than falling through to the adapter default.

There is one explicit provider slot per connector. Installing a model replaces
the active mock or older model; calling a mock controller's `output(...)`
replaces the active model. A stale controller cannot clear a newer provider.
Clearing the active provider reveals the adapter default. Models may be
installed or replaced by `at(tick, callback)` before participants evaluate that
boundary.

## Phase boundary

The synthetic adapter tests prove stable identity, multi-Network input
snapshots, copied default output, manual/model replacement and clear, scheduled
changes, immutable transactional model state, multi-output single evaluation,
self-contamination, ordinary aggregation, Unknown provenance, foreign-handle
rejection, and tick-zero registration. Phase 6 typed objects can implement the
same mapping with real connector schemas. Phase 5 object trace targets can
consume `TestObjectHandle` without changing the adapter contract.
