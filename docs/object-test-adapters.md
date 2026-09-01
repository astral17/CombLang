# Generic object test adapters

Phase 5 defines a simulator-level boundary for testing future typed Factorio
objects without introducing those Phase 6 classes early. A
`CircuitObjectAdapter<Instance, ConnectorName>` maps one object instance onto:

- a stable adapter ID and stable per-adapter instance ID;
- named circuit connectors;
- the logical Networks aggregated as each connector's input;
- the logical Networks receiving each connector's output contribution;
- optional per-instance and adapter/class default outputs for each connector.

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

## Default output resolution

`defaultOutput(instance, connector)` is resolved exactly once during
registration and is the per-instance level. If it returns `undefined`,
`classDefaultOutput(connector)` supplies the adapter/class level. Values are
copied into the binding. At every synchronous boundary the selected value
contributes to every declared output Network. It aggregates normally with
combinators, external drives, and other objects. An Unknown default gains the
object's stable device ID in its dependency path.

Output resolution uses this order:

1. explicit mock or reactive model;
2. per-instance default;
3. class/adapter default;
4. global policy, strict Unknown by default.

The global policy is configured when the session is created:

```ts
new TestSession(kernel); // strict Unknown
new TestSession(kernel, { objects: { default: 'zero' } });
new TestSession(kernel, {
  objects: {
    default: ({ adapterId, instanceId, connector }) =>
      connector === 'inventory' ? [[SIGNAL_A, 10]] : 'unknown',
  },
});
```

A custom policy may return a sparse bus, explicit Known/Unknown value,
`'zero'`, `'unknown'`, or `undefined`; the last two both select strict Unknown.
It is invoked once at registration only when neither instance nor class has a
default, and its result is copied. Dynamic behavior belongs in `model`, not in
the default policy. Connectors without output Networks do not need resolution
and do not invoke the policy.

Strict Unknown origins identify the exact adapter, instance, and connector.
This makes an assertion failure explain which external behavior was omitted,
while normal device provenance records how that value reached the assertion.
Providers remain in `TestSession`, rather than `CircuitObjectAdapter`, so object
schemas do not depend on one test syntax.

## Persistent manual mocks

Select an adapted object and, when necessary, one of its output connectors:

```ts
const output = test.mock(probe, 'circuit');

output.output([[SIGNAL_A, 10]]);
output.output([[SIGNAL_A, 20]]); // replaces 10; it does not aggregate with it
output.clear(); // removes the override and restores the resolved fallback
```

The connector argument may be omitted only when the object has exactly one
connector. A selected connector must declare at least one output Network. Mock
values may be a `SparseBus`, signal/value iterable, or explicit Known/Unknown
`BusValue`; they are copied immediately.

The persistent manual value contributes to the connector's declared output
Networks at every boundary and aggregates normally with drives, combinators,
and other objects. Calling `output(...)` again replaces only that connector's
manual contribution. `clear()` removes it and reveals the resolved instance,
class, or global fallback.

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

`step` must be synchronous and functionally pure with respect to the external
world. It cannot mutate `TestSession`, install or clear providers, register
objects, traces, or devices, or advance/schedule the clock through a captured
reference. Such calls fail during participant evaluation instead of taking
effect in traversal order. Only the returned state/output is transactional;
arbitrary host-language side effects such as writes to a captured array cannot
be rolled back if another participant later fails.

Model state is structured-cloned and recursively frozen both initially and
after every transition. It may contain literals, arrays, and plain objects, but
not class instances or other mutable host objects. `output` accepts the same
Known/Unknown and sparse-bus forms as a mock. Omitting it means explicit silence
for that boundary rather than falling through to the adapter default.

There is one explicit provider slot per connector. Installing a model replaces
the active mock or older model; calling a mock controller's `output(...)`
replaces the active model. A stale controller cannot clear a newer provider.
Clearing the active provider reveals the resolved fallback. Models may be
installed or replaced by `at(tick, callback)` before participants evaluate that
boundary.

## Object traces

The generic trace store accepts object ports alongside Networks and signals:

```ts
test.trace(test.objectInput(probe, 'circuit'), test.objectOutput(probe, 'circuit'));
```

The input target records the aggregate of the connector's declared input
Networks. The output target records the object's isolated committed
contribution before it is aggregated with other participants on the output
Networks. Both use the shared sparse/delta `comblang-trace` document and retain
Known/Unknown transitions. Output is known empty at `T0` and first reflects the
fallback, mock, or model after the first successful boundary.

## Phase boundary

The synthetic adapter tests prove stable identity, multi-Network input
snapshots, copied default output, manual/model replacement and clear, scheduled
changes, immutable transactional model state, multi-output single evaluation,
self-contamination, instance/class/global resolution, strict Unknown and zero
policies, ordinary aggregation, Unknown provenance, foreign-handle rejection,
tick-zero registration, and isolated object input/output traces. Phase 6 typed
objects can implement the same mapping with real connector schemas without
changing the adapter or trace contracts.
