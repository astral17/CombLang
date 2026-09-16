# Entity v6 cumulative Decider envelope

Entity v6 is the cumulative computation-bearing transport for linked Constant,
Arithmetic, and Decider producers. It is separate from Direct Plan v2, the
structural Entity v3 envelope, Constant-only v4, and Constant/Arithmetic v5.
The v6 plan keeps plan-network references; its EG and NCIR use resolved
physical Network references. The profile-free resolved artifact is
`comblang-resolved-entity-v6` and can be hydrated without providers, profiles,
or resolver authority.

## Exact Decider source form

The exact constructor is a semantic configuration record:

```ts
const gate: DeciderCombinator = Decider({
  condition: input[A] > 0,
  outputs: [input[A], 1 * B],
  elseOutputs: [input[B]],
});
```

The record has exactly the required `condition` field; `outputs` and
`elseOutputs` are independently optional and may be omitted, `undefined`, or
empty. `condition` must be a circuit Condition. Each branch accepts one current
output value or recursively nested plain arrays and records. Flattening
follows insertion order, and repeated rows are preserved; equal SignalIDs are
not merged or deduplicated. At least one row must exist across both branches.
An empty normal branch is allowed when the else branch has rows; an empty else
branch is canonicalized away.

Exact output rows use the existing Decider vocabulary: concrete Signal copies,
bare/`Each` sources, `Anything`/`Everything`, and explicit constant-count
rows. Final post-execution validation remains authoritative for combinations
such as `Each` conditions and `Everything` outputs. A malformed record,
accessor, unknown string/symbol key, cyclic or sparse container, custom
container field, unsupported leaf, or invalid trusted profile fails before
topology, producer, Entity, placement, or debug state is committed.

## Row identity and trust boundary

Each normal or else row has an immutable origin aligned by branch and dense
zero-based ordinal. The origin retains the top-level source boundary that
supplied the flattened value, the dynamic function/loop instance path, and a
syntax intent (`implicit-concrete-copy`, `implicit-each-copy`,
`explicit-wildcard-copy`, `explicit-constant`, or `exact`). Nested leaves may
share the boundary span, but their ordinals remain distinct. The runtime does
not invent provenance for arbitrary JavaScript mutations performed before the
container is supplied. For an exact object literal, a branch row points to its
`outputs`/`elseOutputs` property initializer; for a dynamic record it falls
back to the configuration argument. Direct, aliased, computed, and spread
`when`/`then`/`else` calls retain each top-level argument span.

Origins travel with linked v6 plan, EG, NCIR, resolved, hydration, and debug
data. Entity configuration contains only native condition/output references;
origins do not become provider or Blueprint fields. Direct Plan v2 strips
origins, preserving its previous serialized shape.

A linked Decider requires one trusted canonical
`entity:decider-combinator` profile whose `prototypeType` and provider
prototype data both assert `decider-combinator`. Ambiguous, missing, corrupt,
or same-family substituted profiles are rejected. Provider-backed ergonomic
`IF` and `when` use the same authority when available; profile-free ergonomic
programs remain v2. Exact `Decider` has no profile-free fallback because its
exact Entity contract cannot be established without that authority.

## Version and association rules

The smallest compatible envelope is selected from executed source:

| Source result                                                 | Envelope |
| ------------------------------------------------------------- | -------- |
| profile-free topology                                         | v2       |
| Entity records without linked computation                     | v3       |
| linked Constant only                                          | v4       |
| linked Constant and/or Arithmetic, no linked Decider          | v5       |
| any linked Decider, optionally mixed with Constant/Arithmetic | v6       |

One linked producer and one Entity describe one physical device. The producer
retains topology, output lanes, association ID, and row origins. The Entity
owns its native configuration, identity, and placement. A mutable `when`
producer links only after a branch exists and updates the same Entity as
`.then(...)` or `.else(...)` appends rows. A producer `.at(...)` placement made
before linking transfers to the Entity; the sealed producer has no second
placement authority.

The v6 Decider Entity configuration uses plan references in the plan and IR
references in physical Entity data. Lowering reuses the existing topology
engine, Decider simulator, debug index, resolved transport, and hydration
boundary. It adds no combinator, Entity, or simulator tick beyond the one
linked physical device.

## Blueprint and conformance boundary

`generateEntityComputationBlueprintJsonV6` emits one readable native-preview
`decider-combinator` object for each linked Decider, using producer control
behavior and Entity-owned prototype/placement. Mixed linked Constant,
Arithmetic, and Decider plans emit each linked pair once. The preview is
structural and deterministic; it does not claim Factorio import/export
conformance. Exchange-string encoding, FCIR, reach-aware placement, and
fixture-backed native semantic round trips remain later work.
