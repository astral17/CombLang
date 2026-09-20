# Entity pipeline

CombLang represents physical Factorio objects with one canonical Entity
pipeline. A source compilation produces a `DirectElaborationPlan`; trusted
host context authorizes profiles and configuration; lowering produces one
`ElaborationGraph` and one `NativeCircuitIr`; the detached physical result is
a `ResolvedCircuit` with format `comblang-resolved-circuit`.

The pipeline keeps compiler authority, physical identity, and preview data
separate:

- `EntityId` identifies one physical Entity allocation.
- An `EntityProfileRef` selects a host-authorized prototype profile.
- Network names in the plan become physical Network IDs during lowering.
- Placement belongs to the Entity, while a linked producer owns topology and
  output behavior.
- A linked Constant, Arithmetic, Decider, or Selector producer has exactly
  one associated physical Entity. Structural Entities remain valid without a
  linked computation.

## Profiles and replay

Profiles are immutable data descriptions of prototypes, connector lanes,
configuration rules, evidence, and optional callable/default projections.
Provider profile data is authority for construction and exact computation;
synthetic profiles exercise schema and ownership behavior but do not claim
native Factorio conformance.

A trusted replay context binds the prototype database, evidence identity,
policy identity, and a canonical profile-set identity. The identity is emitted
as `entity-profile-set-sha256:<64 lowercase hexadecimal characters>` and is
derived from the complete canonical profile set. Historical profile-set tags
are rejected. Cloneable Worker/CLI transport carries only identity metadata;
profiles, providers, resolver functions, and runtime handles remain host-local.

Entity-bearing plans require the matching trusted context before allocation.
Each profile reference is resolved independently, so one plan may contain
structural and linked Entities from different supported families. A profile's
prototype type is an authority hint and never substitutes for connector,
configuration, provider, or evidence checks.

## Configuration

Entity configuration is explicit and data-only:

- `raw` contains bounded native-shaped JSON and keeps compiler-owned topology
  fields separate.
- `typed` names a profile-owned rule, allowed lanes, and a pure native
  comparison. The selected rule must have the required evidence.
- linked computation uses canonical `constant`, `arithmetic`, `decider`, or
  `selector` configuration records with plan-side Network references.

There is no opaque typed/payload escape hatch. Unsupported native behavior is
reported at the configuration boundary instead of being preserved as an
uninterpreted authority-bearing value.

The exact computation surface currently supports Constant sections, the
documented Arithmetic operations, Decider output rows with ordered branch
origins, and Selector `select`/`count`. Selector operations such as `random`,
`quality`, `rocket-capacity`, `stack-size`, and `time` remain unsupported.

## Canonical lowering

`validateCanonicalDirectPlan` performs bounded data validation, exact-key
checks, context/profile checks, association ownership, family equality,
topology, placement, and Decider-origin checks. It reconstructs and freezes
the canonical value instead of retaining caller-owned objects. Entity-free
plans omit replay context and carry an empty Entity array; Entity-bearing plans
carry the matching identity-only context reference.

`tryElaborateDirectPlan` is the single execution entry point. It returns one
canonical graph, IR, debug surface, test session, and resolved snapshot. The
execution bridge uses one canonical public schema.

## Resolved transport and preview

`ResolvedCircuit` is cloneable, profile-free, and provider-free. Its physical
IR contains Networks, producers, physical Entities, provenance, topology,
configuration, and identity-only context. It contains no resolver, profile
set, provider method, function, or runtime handle.

`parseResolvedCircuit` and `validateResolvedCircuit` reject unknown keys,
accessors, symbols, array holes, malformed fingerprints, unknown references,
invalid associations, and configuration mismatches before hydration.
`hydrateResolvedCircuit` consumes only the detached snapshot. Blueprint JSON,
simulation, debug, browser, Worker, and CLI previews all use this canonical
physical result.

Synthetic fixtures and automated simulation tests establish CombLang's model
and transport invariants. They are not native Factorio conformance evidence;
native import/export and exchange-string claims require separate fixture-backed
evidence.
