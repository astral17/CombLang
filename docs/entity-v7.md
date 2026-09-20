# Entity v7 cumulative Selector envelope

Entity v7 is the cumulative computation-bearing transport for linked Constant,
Arithmetic, Decider, and Selector producers. It is separate from Direct Plan v2,
the structural Entity v3 envelope, and the Constant/Arithmetic/Decider v4-v6
envelopes. A linked Selector selects v7 even when it is the only computation-
bearing Entity in the source; earlier linked producer kinds may be mixed into the
same v7 plan.

The plan, Elaboration Graph (EG), and native circuit IR (NCIR) use semantic
version 7. The cloneable profile-free resolved envelope is
`comblang-resolved-entity-v7`. Its hydrator accepts only the resolved artifact:
it does not receive a provider, profile set, resolver, or runtime Entity handle.

## Exact Selector source form

The exact constructor is a data-only configuration overload:

```ts
const selected: SelectorCombinator = Selector({
  input: pair(red, green),
  operation: 'select',
  selectMax: false,
  index: 0,
});

const counted: SelectorCombinator = Selector({
  input,
  operation: 'count',
  output: Signal('virtual', 'signal-A'),
});
```

`select` accepts a readable Network or `pair(red, green)` input. `selectMax`
defaults to `true`; `index` defaults to signed int32 `0` and may be a finite safe
integer or a current-session nominal Signal. `count` requires a current-session
nominal output Signal. Exact records have operation-specific keys and reject
unknown, mixed, accessor, symbol, cyclic, and sparse data before topology or
physical state is committed.

The exact form requires trusted canonical `entity:selector-combinator` authority
whose asserted and provider prototype type/name are `selector-combinator`.
`Selector(prototype, configuration?)` remains the structural Entity overload and
continues to accept checked or `{ raw }` native-shaped configuration. Structural
and exact calls allocate distinct intended objects; the structural call is not a
Producer and does not acquire the exact simulator or callable surface.

Only `select` and `count` are exact operations in this slice. Exact `random`,
`quality`, `rocket-capacity`, `stack-size`, and `time` fail at the operation field.
They remain available only through the structural/raw Entity surface, subject to
that surface's schema and evidence boundary.

## Association and resolved transport

One exact Selector Producer is linked to one physical selector-combinator Entity.
The Producer retains input topology, output destinations, configuration, source
provenance, and association ID. The Entity owns the native profile, placement,
and physical configuration. Placement is therefore emitted once; hydration never
creates a second default combinator.

The resolved v7 artifact contains only identity-bound physical context, Networks,
Producers, and Entities. It contains no provider, resolver, prototype authority,
or `prototypeType` field. Strict ingress checks the format/version, fingerprint
shape, exact object keys, Network references, Producer-to-Entity association,
Selector family/profile identity, and Producer/Entity configuration equality
before graph or simulation allocation. The fingerprint detects stale artifacts;
it is not a cryptographic authority claim.

## Provisional simulator model

The Selector device is a deterministic CombLang model, not native Factorio
evidence:

- `count` emits the number of distinct non-zero Signals in the combined input
  bus to its configured output Signal;
- `select` orders distinct non-zero rows by count, descending for `selectMax` and
  ascending otherwise, with canonical SignalID order as the tie-break;
- a zero-based `index` selects one row and reproduces that Signal/count; negative
  and out-of-range indexes emit nothing;
- a Signal index reads its int32 value from the same combined input before the
  selection step;
- all devices read tick `T` and commit their output at `T+1`.

Pair input aggregates the red and green buses for this model. These rules are
covered by simulator and runtime tests and must not be presented as Factorio
import, export, or native semantic conformance.

## Blueprint, Worker, and testbench boundaries

`generateEntityComputationBlueprintJsonV7` emits one readable native-preview
`selector-combinator` object per linked Selector. `select` emits `select_max` and
exactly one of `index_constant` or `index_signal`; `count` emits `count_signal`.
Entity-owned placement and resolved wire topology are preserved. The preview is
structural and deterministic, not an exchange-string codec or native round-trip
claim.

The v7 resolved artifact is cloneable across the Worker/browser boundary and can
be hydrated for CLI, browser, debug, trace, and testbench execution without the
source host. Those consumers run the provisional model above. Native Selector
conformance, LUT behavior, fixture-backed Factorio round trips, and Phase 7
completion remain outside this batch.

## Envelope selection

| Executed source result                                          | Envelope |
| --------------------------------------------------------------- | -------- |
| Profile-free topology                                           | v2       |
| Entity records without linked computation                       | v3       |
| Linked Constant only                                            | v4       |
| Linked Constant and/or Arithmetic, no linked Decider/Selector   | v5       |
| Any linked Decider, without linked Selector                     | v6       |
| Any linked Selector, optionally mixed with earlier linked kinds | v7       |
