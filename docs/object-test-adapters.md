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
Returning `undefined` currently means that the adapter contributes nothing.
The remaining Phase 5 policy will resolve output in this order:

1. explicit mock or reactive model;
2. per-instance default;
3. class/adapter default;
4. global policy, strict Unknown by default.

That policy and mutable providers are not folded into
`CircuitObjectAdapter`; keeping them in the test runner prevents object schemas
from depending on one test syntax.

## Phase boundary

The synthetic adapter tests prove stable identity, multi-Network input
snapshots, copied default output, ordinary aggregation, Unknown provenance,
foreign-handle rejection, and tick-zero registration. Phase 6 typed objects can
implement the same mapping with real connector schemas. Phase 5 mock/model and
object trace targets can consume `TestObjectHandle` without changing the
adapter contract.
