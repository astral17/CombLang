# Entity v4 computation foundation

The internal computation-bearing Entity slice is deliberately a separate
transport from Direct Plan v2 and Entity Direct Plan v3. Its version-4 plan,
graph, NCIR, and resolved envelope are not accepted by the v2/v3 readers.

The first supported association is one Constant producer view linked to one
trusted Entity whose profile has the exact `prototypeType` value
`"constant-combinator"`. The producer keeps the ordinary topology view and
may carry one `EntityId`; it is not another physical object. Placement belongs
only to the Entity record, so a linked producer must omit `placement`.

Before allocation, the v4 validator requires the exact current
`entity-profile-set-v2-sha256:<digest>` replay identity, canonicalizes the
Constant configuration with the Factorio package, and checks that the producer
outputs equal `constantConfigurationToSparseBus(configuration).toJSON()`.
The existing conservative evaluator is the support boundary: `isOn`, active
sections, duplicate/zero filters, int32 values, and ordinary Signal quality are
represented; section groups and non-unit multipliers produce a stable
unsupported diagnostic. No section property is silently discarded.

Version 4 extends the v3 Entity configuration vocabulary rather than replacing
it. An unlinked Entity may still carry a canonical v3 raw, compatibility
opaque-typed, or rule-based typed configuration; only an exact linked Constant
uses the v4 `mode: "constant"` form. Projection into v3 removes that Constant
form only, then retains and resolves the older configurations through their
existing validator and physical-IR paths.

Execution projects the validated producer view through the existing v2
topology engine, then restores the association in version-4 graph and NCIR
records. A linked Constant therefore retains the existing synchronous output
and latency behavior while the physical Entity inventory contains one record.
Structural Entities and ordinary unlinked producers remain separate.

The resolved v4 envelope is profile-free and identity-only. Its parser and
hydrator are separate from `ResolvedSourceCircuit`; hydration needs no
provider, profile set, resolver, or runtime authority. The blueprint adapter
combines the linked producer's topology with the Entity prototype, placement,
and exact Constant sections into one native `constant-combinator` object.
Simulation reuses the conservative Constant model and does not claim native
Factorio conformance.

`planFingerprint` is a deterministic stale-response correlation value, not a
signature, integrity proof, or source of authority. It can correlate a resolved
snapshot with the canonical plan and linked Constant configuration, but cannot
detect a valid physical placement change. The production source compiler, CLI,
and browser Worker still emit and consume v3 artifacts only; this document
describes internal callable helpers rather than a new Worker/CLI protocol or
cold source-replay behavior.

This is an internal foundation. Public `Constant({ isOn, sections })` source
syntax and unifying that facade with `CC(...)` are intentionally deferred to a
later batch; no public DSL overload or UI control is introduced here.
