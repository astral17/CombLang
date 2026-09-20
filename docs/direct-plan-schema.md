# Direct plan schema

`DirectElaborationPlan` is the cloneable data boundary between executed source
and runtime validation. The canonical public type is exported from
`@comblang/compiler/direct-plan-schema`; the schema module owns descriptors and
does not execute source or allocate runtime objects.

```ts
interface DirectElaborationPlan {
  readonly format: 'comblang-direct-plan';
  readonly networks: readonly DirectPlanNetwork[];
  readonly producers: readonly DirectPlanProducer[];
  readonly entities: readonly EntityPlanRecord[];
  readonly context?: EntityReplayContextRef;
}
```

The envelope has no numeric lineage marker. `entities` is always an array and
`context` is present only for Entity-bearing plans. The current producer union
contains arithmetic, decider, constant, and selector records plus the
ownership, alias, pair, debug, provenance, and capability descriptors needed
by executed source. Entity-bearing producers may carry one `entityId`; the
associated Entity owns placement and physical identity.
When a Constant producer is linked to an Entity, it may also retain the exact
canonical Constant configuration so richer sections and filters participate in
the Producer-to-Entity equality check.

`validateCanonicalDirectPlan(value, context?)` accepts unknown data, checks
plain records and arrays, rejects accessors/symbols/holes/unknown keys, applies
bounds, validates topology and source metadata, and reconstructs a deeply
frozen canonical value. It validates trusted replay context, profile family,
configuration equality, one-to-one producer associations, placement ownership,
and Decider output origins before allocation. Entity-free plans do not need a
trusted context.

`tryElaborateDirectPlan` is the one execution entry point. It returns one
canonical graph, native circuit IR, debug index, test session, and detached
resolved snapshot. `elaborateDirectPlan` is the exception-oriented wrapper.
Consumers do not select a historical reader or reinterpret a different
descriptor shape.

## Descriptor ownership

- `networks` declares logical names, fixed colors, generations, and provenance;
- `producers` describes computation, destinations, output rows, placement
  restrictions, association IDs, and provenance;
- `entities` describes physical profile references, configuration, connector
  bindings, placement, and provenance;
- aliases, transfers, pairs, capabilities, and debug instances preserve
  executed ownership and source-visible behavior;
- `context` carries only database/profile-set/evidence/policy identities.

Plan-side Network references are declaration names. Lowered graph and IR
references are allocated physical Network IDs. The conversion is explicit and
is validated together with color constraints, connector capacity, and
producer destinations.

## Resolved transport

`ResolvedCircuit` is the profile-free physical transport. Its exact format is
`comblang-resolved-circuit` and its stale-response correlation field is
`plan-fnv1a64:<16 lowercase hexadecimal characters>`. The fingerprint is not
authority or integrity proof.

`parseResolvedCircuit` and `validateResolvedCircuit` validate the detached
physical IR directly. `hydrateResolvedCircuit` consumes only that snapshot;
it receives no profile set, provider, resolver, function, or runtime handle.
Blueprint, simulation, Worker, browser, CLI, debug, and testbench consumers
share this boundary.

## Dependency direction

```text
executed source recorder
          |
          v
direct-plan-schema + entity + IR descriptors
          |
          v
canonical validation and lowering
          |
          v
resolved transport -> simulator / blueprint / testbench / UI
```
