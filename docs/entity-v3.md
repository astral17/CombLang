# Entity v3 foundation

CombLang now contains the internal, versioned foundation for generic Factorio
Entity records. This document describes the implemented data and transport
boundary only. It does not define source syntax, typed constructors, native
Factorio behavior, or a blueprint export contract for Entities.

## Implemented contract

The compiler-owned [Entity vocabulary](../packages/compiler/src/entity.ts)
keeps these identities separate:

- physical `EntityId`;
- prototype and database identity;
- capability-profile identity;
- connector and color-lane keys;
- Network identity;
- placement and export-local numbering.

Direct Plan v3 is a separate envelope from circuit-only Direct Plan v2. A v3
plan carries identity-only replay context and physical Entity records while
retaining the existing producer computation descriptors. The v2 reader does
not accept v3, and v2 is not extended with an optional `entities` field.

## Profiles and evidence

[Entity profiles](../packages/compiler/src/entity-profile.ts) are immutable,
canonical, data-only descriptions of physical connectors, color lanes, and
configuration features. Features do not create ports. A validated replay
context contains a profile set, not one plan-wide profile: each Entity record
selects its own `profileId`, so one plan may contain multiple Entity families.

Evidence is attached to a capability, currently a configuration rule such as
`native-single-condition`, rather than to the whole profile. `unknown`,
`unverified`, and `verified` values remain distinct, and raw/typed configuration
modes are independent of evidence status. Synthetic profiles cannot claim
verified evidence. Every profile also carries one explicit default read
projection, or `null` when no unambiguous default exists; it is never inferred
from feature ordering. Native `(nativeConnector, color)` endpoint identity is
unique across the entire profile.

The checked-in [synthetic fixtures](../packages/compiler/src/entity-fixtures.ts)
cover a zero-port Entity, a shared bidirectional connector with red and green
lanes, and an intentionally ambiguous multi-connector profile. They establish
schema and ownership behavior only; they are not evidence of native Factorio
behavior.

## Replay and transport

[Trusted replay contexts](../packages/compiler/src/entity-replay-context.ts)
bind database, the complete profile-set identity, evidence identity, and policy
identity at the host boundary. Plans reference these identities but cannot
assert capabilities. Each Entity profile reference is resolved independently
against that trusted set; a producer-only v2 adapter therefore does not select
an arbitrary Entity profile.

The minimum cloneable v3 transport contains only the protocol version, source
(`synthetic` or `provider`), database identity, profile-set identity, evidence
identity, and policy identity. Its profile-set identity is derived from the
canonical profile contents, so changing any selected profile changes the
identity. The transport does not contain provider methods, a prototype database
copy, or nominal runtime handles.

Compilation artifacts and the browser compiler Worker request carry detached
transport snapshots. A provider-sourced context must also be checked against a
host-bound trusted profile set and the selected provider before source
execution; an explicitly synthetic context is the only context that can travel
without a provider. The reported `entityReplayIdentity` is a future cache
identity. There is no compilation-result cache consuming it yet, so this batch
does not claim cache invalidation or reuse.

## Internal construction and validation

The runtime [Entity registry](../packages/runtime/src/entity-registry.ts) is
session-local and internal. Production construction receives a narrow resolver
derived from the selected `PrototypeProvider`; its database schema/identity
must match the trusted context, and `getEntity(profile.prototypeKey)` must
succeed before an Entity handle is allocated. Clearly labelled synthetic
resolvers are used only by unit fixtures. A profile alone is not proof that a
prototype exists.

Each construction gets a distinct nominal identity; an alias returns the same
handle. Foreign-session handles and objects that only look like Entity records
are rejected. Configuration, placement, source span, dynamic instance path,
creation revision, and ordinal are snapshotted and frozen. A zero-port Entity
remains a physical record even when it has no producer.

Raw Entity payloads accept only the native data plus explicit prototype,
entity-number, and placement fields. Connector maps, bindings, wires, support
claims, and internal IDs are compiler-owned; topology-shaped fields are
rejected both at the payload boundary and inside the native object.

[V3 validation](../packages/runtime/src/entity-plan-validation.ts) resolves
the trusted context and profile before Entity allocation, validates raw JSON,
references, endpoints, Networks, provenance, and uniqueness, and reports
structured paths. The only migration is an explicit lossless adapter for a
validated producer-only v2 plan; it creates no Entity capabilities. Sending v3
to a v2 reader or forging profile data fails deterministically.

## Deliberately not implemented here

The next batch, LUNA-008, is the review boundary for:

1. generation-safe connector facets and ownership;
2. physical IR and readable blueprint lowering;
3. Entity debug and test-session adapter bridges;
4. one fixture-backed native single-comparison condition;
5. generic end-to-end acceptance across source, replay, IR, export, debug, and
   testbench;
6. later typed facades and any native-verified claims.

No public Entity callable syntax or typed facade is implied by the v3 foundation.
