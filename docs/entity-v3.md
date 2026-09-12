# Entity v3 foundation

CombLang now contains the internal, versioned foundation for generic Factorio
Entity records plus a narrow host-bound source surface. This document describes
the implemented data and transport boundary and internal physical preview; it
does not claim typed facades or verified native Factorio behavior.

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

The internal typed subset maps a rule to one profile-owned feature and the native
field `control_behavior.circuit_condition`. The plan-side value contains only the
rule key, a non-empty selection of allowed input lanes, and one pure comparison
of a concrete Signal with a signed int32 constant. Non-synthetic profiles need
verified positive evidence for that exact rule before typed construction or
replay; the shared synthetic fixture uses unknown evidence only to exercise the
architecture and is not native Factorio proof.

The deprecated v3 `{ mode: "typed", payload }` envelope remains accepted as an
opaque compatibility snapshot. It is cloned and frozen, but it does not grant
rule, feature, native-field, connector, or evidence authority; blueprint
preview rejects it with a source-aware `BP1001`.

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
without a provider. Successful host-authorized v3 lowering additionally emits
one `ResolvedSourceCircuit` envelope around the physical `NativeCircuitIrV3`.
It contains only cloneable topology, physical Entity records, provenance,
signals, and context/profile identities; it contains no profiles, resolver,
provider, functions, execution objects, or trusted context. The main thread
validates, detaches, freezes, and uses this snapshot for blueprint and
simulation preview. It never replays the v3 plan, and an identity-only replay
transport remains powerless to construct an Entity. The reported
`entityReplayIdentity` is a future cache identity. There is no
compilation-result cache consuming it yet, so the foundation does not claim
cache invalidation or reuse.

The resolved-circuit envelope is deliberately separate from Direct Plan v3:

```ts
interface ResolvedSourceCircuit {
  readonly format: 'comblang-resolved-source-circuit';
  readonly version: 1;
  /** Correlation only; this never grants replay or profile authority. */
  readonly planFingerprint: string;
  readonly ir: NativeCircuitIrV3;
}
```

Its profile-free validator rejects unknown fields, malformed context and
provenance, duplicate physical identities, dangling Network references,
invalid placement/configuration, cross-record database mismatches, and
inconsistent resolved colors or connector ordinals. The fingerprint catches
accidental stale or cross-source responses; it is not an authority token. A
runtime hydration facade exposes stable, runtime-local Network handles and
fresh simulation kernels; physical Entities remain inert topology records and
do not become simulator devices.

## Host-bound source subset

The implemented public source constructor is deliberately exact:

```ts
// In a host embedding with a matching reviewed profile:
const entity = Entity('assembling-machine-3');
const canonical = Entity('entity:assembling-machine-3');
const same = Entity(prototypes.entity['assembling-machine-3']);
entity.bind('circuit', 'red', input, 'input');
const red = entity.port('circuit', 'red');
```

This example is conditional on the host installing a matching
`TrustedEntityReplayContext`, profile set, and prototype resolver. The default
website runtime and ordinary CLI profile selection provide static prototype data
but do not install that trusted Entity authority, so the real
`assembling-machine-3` example is not runnable out of the box. A host embedding
or a test may inject a reviewed provider profile (or a clearly labelled synthetic
fixture) before compiling the source.

The additional accepted source form is intentionally limited to the typed
single-condition slice:

```ts
const machine = Entity('synthetic-shared-two-color', {
  rule: 'shared-circuit-condition',
  lanes: ['shared-red', 'shared-green'],
  condition: NativeCondition(Signal('virtual', 'signal-A'), '>', 0),
}).at(10.5, -2, 8);
```

`NativeCondition` is not a circuit `Condition` and cannot be forged by copying
its visible fields. It carries one concrete Signal, one supported comparator,
and one safe integer canonicalized to signed int32. The accepted profile maps
that detached comparison directly onto the Entity's declared native field,
without a Decider combinator or a tick. The synthetic example proves the
compiler path only; it is not native Factorio conformance evidence.

`Entity` is a reserved direct DSL value. Its first argument is either a short
prototype name (the preferred spelling) or canonical key resolved by the host
resolver, or the exact
identity of a record returned by the selected host `prototypes.entity` table.
The resolved canonical key must select exactly one profile in the matching
`TrustedEntityReplayContext`; the source never supplies a profile reference,
evidence, connector schema, or native ID. `port` takes exactly
`(connector, lane)` and `bind` takes exactly
`(connector, lane, network, direction)`, where direction is `input` or
`output`. Both methods operate only on a nominal Entity handle and retain
source provenance and ownership generation.

The cloneable Worker request carries only `EntityReplayContextTransport`. An
injectable host callback may resolve that transport to the trusted profile set
and a host-local prototype resolver. A missing or mismatched callback leaves the
request transport-only and cannot grant Entity authority. The browser's normal
production runtime does not invent profiles; its main-thread preview consumes
the resolved physical snapshot returned by a successful authorized Worker
compilation and does not require the host resolver again.

`Entity(prototype)` also accepts one public configuration object with exactly
`rule`, `lanes`, and `condition` fields. The condition must be the nominal
`NativeCondition(signal, comparator, constant)` value created in the same
execution session; the runtime translates it to the existing typed
`control_behavior.circuit_condition` configuration before profile validation.
`entity.at(x, y, direction?)` mutates the existing physical record, returns the
same live view, and accepts finite coordinates plus an integer direction from
`0` through `15`. Neither form allocates a Producer, Network, or hidden
Decider. The callable form `Entity(...)(input)`, including
`output += Entity(params)(input)`, is reserved and planned; it is not
implemented by the present generic host-embedding slice. Typed facades, raw
native payloads, and native Factorio behavior remain separate future work.

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
typed rule/lane bindings, the pure condition, references, endpoints, Networks,
provenance, and uniqueness, and reports structured paths. The same configuration
canonicalizer is used by the internal registry boundary. The only migration is
an explicit lossless adapter for a validated producer-only v2 plan; it creates no
Entity capabilities. Sending v3 to a v2 reader or forging profile data fails
deterministically.

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

## Physical execution, debug, and object-test bridge

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
visible. The internal typed subset emits a readable native
`control_behavior.circuit_condition` on the existing Entity, including the
resolved concrete Signal, signed int32 constant, Factorio comparator spelling,
and red/green input mask. Raw configuration remains explicitly rejected at
preview generation. The deprecated opaque v3 typed envelope is rejected there
as well. Physical preview validation is profile-free and rejects malformed or
forged native fields, lane masks, Signals, comparators, and signed int32
constants with source-aware `BP1001`. Synthetic fixtures establish these
internal contracts, not Factorio import compatibility. The producer-only v2
execution and blueprint paths remain unchanged.

The executed v3 plan also exposes `execution.debug` Entity entries. Each exact
scope has `entities`, `entity(index | id)`, `entityByGlobalOrdinal`, and
`entityList()` queries. An entry keeps the physical Entity ID, scope-local and
global ordinals, profile, provenance, placement, and the frozen physical record;
it is a separate debug identity from a Producer and does not change Producer
counts or Network queries. The portable `comblang-debug` document carries these
detached Entity entries as inspection data.

`ExecutedEntityDirectPlan.createTestSession()` registers exactly one generic
object-test adapter for each physical Entity in that session. The adapter ID is
`entity-physical-v3`; its safe instance ID is derived from the physical ordinal,
and its connectors group bound physical lanes while preserving stable Network
order and direction. `entityObject(session, id | ordinal)` returns the one
session-local `TestObjectHandle`; a second session receives distinct handles and
a handle from another execution is rejected. The bridge only projects topology:
it creates no native device, configuration behavior, hidden Producer, or native
simulation semantics. It inherits the generic boundary's strict Unknown output
fallback, mock replacement/clear, one model step per connector per tick, input
aggregation, fan-out, self-feedback, and separate input/output traces. Input-only
and zero-port Entities have no synthetic output connector.

## Deliberately not implemented here

The remaining implementation boundary covers:

1. raw native payload lowering and native import fixtures;
2. reviewed non-synthetic evidence and Factorio conformance for the native
   single-comparison condition;
3. additional typed/generic acceptance beyond the host-bound source subset;
4. later typed facades and any native-verified claims.

The configuration and placement forms documented above are implemented. The
callable constructor form remains reserved and planned; raw payload lowering,
broader typed facades, and native-verified behavior are not implied by this
source subset.
