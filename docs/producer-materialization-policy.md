# Combinator and Entity value policy

This document records the Phase 4 migration from transient producers to physical combinator values. The filename is retained so older links keep working; the previous declaration-materialization policy is superseded.

## Decision

Arithmetic expressions, `CC`, `IF`, and `when` create physical combinators immediately. A public `Combinator` is also readable as a `Network`: its Network facet is its primary output connection. An explicit `Network` annotation narrows the visible API but neither creates a network nor clones or erases the combinator.

| Executed initializer              | Inferred declaration                  | Explicit context                                                                                                            |
| --------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| arithmetic, `IF`, `when`, or `CC` | the precise physical combinator value | `Network` exposes the same value's primary Network facet; `Combinator` or a concrete combinator type retains the handle API |
| existing `Network`                | the same logical network              | compatible Network contexts preserve its identity                                                                           |
| future typed object constructor   | a persistent Entity handle            | a schema may expose explicit circuit ports; Entity identity is never inferred from a Network                                |
| ordinary JavaScript value         | the executed value                    | validation occurs only at a DSL boundary                                                                                    |

`Producer` remains a deprecated compatibility spelling for `Combinator`. New APIs, documentation, and diagnostics use `Combinator`.

## Output connections

Every combinator owns one physical output port and up to two stable logical output connections:

1. the primary connection exists eagerly and is the Network facet used by ordinary reads;
2. the secondary connection is created lazily when a second distinct destination is requested;
3. the two connections use opposite wire colors when both exist;
4. a third distinct output attachment fails immediately.

These are two connections of one physical output, not two combinators and not two different computed values. Destructuring projects the same stable pair:

```ts
const [primary, secondary] = input + 0;
```

Sequential attachment consumes the same pair:

```ts
out += input + 0;
mirror += input + 0;
```

## Binding and container invariants

- Naming a combinator adds provenance only. It does not materialize, attach, or clone anything.
- Repeated reads use the primary Network facet and never duplicate hardware.
- Arrays, objects, closures, and function returns contain ordinary runtime values. The compiler does not recursively rewrite their contents into Networks.
- An explicit `Network`, `Readonly<Network>`, or `Network[]` annotation narrows the source API at that boundary; it does not change runtime identity.
- Output use is tracked dynamically against the central combinator registry. A combinator left without any destination produces `CL2001`; no hidden `$unused` network is synthesized.
- Logical-network identity and red/green color parity are separate relations. Equal colors do not merge independent networks.

For example, this creates ten arithmetic combinators in the callback and ten more in the loop. The array stores their Network-facing values without contextual materialization:

```ts
const base = CC(5 * SIGNAL_A);
const values: Network[] = Array.from({ length: 10 }, (_, index) => base * (index + 1));

const out = new Network();
for (let index = 0; index < values.length; index++) {
  out += values[index] * values[index];
}
```

## Functions

A `Network` or `Readonly<Network>` parameter receives the primary facet of a combinator argument. A concrete combinator parameter retains physical configuration methods while its inherited Network facet remains read-only inside the function. Returning a combinator type preserves its handle; returning `Network` deliberately exposes only the primary facet to the caller.

Untyped parameters remain ordinary JavaScript parameters and are checked dynamically when their values reach a DSL operation.

## Mutable decider builder

`when(condition)` creates a `DeciderCombinator` immediately. `.then(...)` and
`.else(...)` mutate that registered physical object and return the same handle.
Either branch may be configured first. Repeated calls append rows to the
selected branch rather than creating another combinator; the final linked
Entity configuration is derived from that one descriptor when the plan seals.

## Future Entity values

Phase 6 typed objects must use a separately branded `EntityValue`. An Entity has persistent physical identity for placement, inspection, mocks, and circuit ports; it must not inherit from `Network` merely because it can read or emit signals. Any Entity-to-Network view is an explicit, schema-owned port projection and creates no extra entity, combinator, or tick.

## Implementation ownership

- `CombinatorRegistry` owns physical identity, descriptors, branch mutation, provenance, primary/secondary output connections, and attachment cardinality.
- `combinator-handle-policy` validates public and concrete combinator annotations.
- `combinator-attachment-policy` selects and attaches an output connection.
- `combinator-output-policy` applies output-signal restrictions without changing physical identity.
- Network argument, parameter, and return policies project or narrow the primary facet without deep traversal.
- The color constraint solver keeps logical-network union separate from red/green parity.

The static direct-plan compiler remains a legacy structural oracle while the executed runtime is authoritative for JavaScript control flow and value identity. New behavior must not depend on its old temporary-network model.

## Acceptance boundary

The migration is complete when immediate combinator identity, stable two-connection fan-out, container storage, function parameter/return narrowing, mutable `when`, source-linked diagnostics, online color validation, and unused-output warnings all agree in the CLI and browser worker. There must be no contextual deep materialization, affine single-attachment lifecycle, or runtime `$unused` sink.
