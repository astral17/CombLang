# Entity v3 foundation

CombLang now contains the internal, versioned foundation for generic Factorio
Entity records. This document describes the implemented data and transport
boundary and internal physical preview. It does not define source syntax, typed
constructors, or verified native Factorio behavior.

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
Direct Plan Entity bindings reference Network declaration names; lower graph and
IR Entity bindings reference allocated physical `NetworkId` values. The mapping
between these domains is explicit at the lowering boundary.

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
identity. There is no compilation-result cache consuming it yet, so the
foundation does not claim cache invalidation or reuse.

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

The executed runtime keeps session-local authority views separate from the
singular physical Entity record. Explicit connector/lane projection is cached
on the current view and records the Network name, ownership generation,
direction, and operation provenance; the same endpoint is idempotent, while a
different Network or direction is rejected with the first binding's provenance.
Ownership transfer creates a new nominal view for the same physical `EntityId`
and leaves captured older views stale. A v3 replay snapshot carries the Network
generation and consumed provenance, so canonical validation rejects unknown,
consumed, or stale connector bindings before graph allocation. Entity-to-Network
conversion is available only at a shared readable argument boundary when the
trusted profile has an explicit default projection.

## Physical execution and preview

`tryElaborateEntityDirectPlan` and `elaborateEntityDirectPlan` validate the v3
envelope before runtime allocation, execute the producer topology once, and map
Entity declaration references through the resolved Network handles after transfers.
Each Entity appears once in EG/NCIR, with its physical ID, canonical prototype
name, and trusted native connector ordinal for each bound lane. Missing native
endpoint metadata fails with source provenance. Physical records are detached
and deeply frozen. Lookup accepts an Entity ID or its one-based ordinal;
simulation retains the existing producer behavior and treats Entities as inert.

`generateEntityBlueprintJson` produces a readable preview from self-contained
physical IR. Producers retain their existing numbering; Entities follow in
ordinal order. Explicit placement and direction are retained. Automatic Entity
positions follow producer positions and skip occupied coordinate slots. Bound
Entity lanes join the same Network wire chains as combinators; native connector
ordinal `n` encodes red as `2*n-1` and green as `2*n`. Zero-port Entities remain
visible. Raw/typed configuration is explicitly rejected at preview generation.
Synthetic fixtures establish these internal contracts, not Factorio import
compatibility. The producer-only v2 execution and blueprint paths remain unchanged.

## Deliberately not implemented here

The next implementation boundary covers:

1. raw/typed native payload lowering and native import fixtures;
2. Entity debug and test-session adapter bridges;
3. one fixture-backed native single-comparison condition;
4. generic end-to-end acceptance across source, replay, IR, export, debug, and
   testbench;
5. later typed facades and any native-verified claims.

No public Entity callable syntax or typed facade is implied by the v3 foundation.
