# Entity v3 foundation

CombLang now contains the internal, versioned foundation for generic Factorio
Entity records plus a narrow source surface. Selected built-in and imported
providers provision a conservative fallback profile only for Entity records
whose normalized `blueprintEligible: true` fact is explicit, so construction
and placement are runnable without claiming typed facades or verified native
Factorio behavior. Legacy normalized records that omit this fact remain
queryable but do not gain universal Entity construction authority.

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
Provider-created profiles also retain the provider's exact normalized prototype
`type` as trusted `prototypeType` metadata. This field is host-owned authority,
is included in profile canonicalization and the current
`entity-profile-set-v2-sha256:<64 lowercase hex>` identity, and is omitted from
`EntityProfileRef`, plans, resolved transport, and profile-free NCIR. Older or
synthetic profiles may omit it; omission means unknown rather than wildcard.
The host accepts the historical v1 canonical-content identity only while
replaying an already-bound v3 context; newly emitted refs and transports always
use v2, and future computation-bearing v4 plans must require v2. Future exact
family computation must require an exact match with the selected provider
record. Prototype type alone does not prove connectors, capabilities, or native
Factorio behavior.

Evidence is attached to a capability, currently a configuration rule such as
`native-single-condition`, rather than to the whole profile. `unknown`,
`unverified`, and `verified` values remain distinct, and raw/typed configuration
modes are independent of evidence status. Synthetic profiles cannot claim
verified evidence. Every profile also carries one explicit default read
projection, or `null` when no unambiguous default exists; it is never inferred
from feature ordering. A callable profile may additionally declare one explicit
`callProjection` with exactly one `input` and one `output` connector/lane/color
endpoint. Both endpoints must exist, match their declared lane colors, use
compatible connector directions, and be distinct; this projection is separate
from default reads, configuration rules, and evidence claims. Native
`(nativeConnector, color)` endpoint identity is unique across the entire profile.

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

## Provider- and host-bound source subset

The implemented public source constructor is deliberately exact:

```ts
// With a selected built-in or imported provider:
const entity = Entity('assembling-machine-3');
const canonical = Entity('entity:assembling-machine-3');
const same = Entity(prototypes.entity['assembling-machine-3']);
entity.bind('circuit', 'red', input, 'input');
const red = entity.port('circuit', 'red');
const output = new Network();
output += Entity('reviewed-callable-machine')(input);
const lamp = Lamp('small-lamp', { always_on: false }).at(4, 5, 8);
const roboport = Roboport('roboport', { raw: { request_filters: { sections: [] } } });
const constant = Constant('constant-combinator', { raw: { player_description: 'fixture' } });
```

The browser Worker and CLI create the matching trusted replay context and narrow
provider resolver from the selected immutable provider. The default fallback
profile is intentionally zero-port: it permits construction and `.at(...)`
placement, but does not expose guessed connector lanes, call projections, or
configuration rules. A reviewed provider profile or clearly labelled synthetic
fixture is still required for typed configuration and connector operations.

`Lamp(prototype, configuration?)` is a structural family facade over this same
construction path. It accepts every prototype/configuration form accepted by
`Entity`, requires the selected provider prototype's actual type to be `lamp`,
and returns the same nominal Entity handle and one physical Entity record. It
does not choose `small-lamp` implicitly, infer connector lanes or callable
behavior, translate ergonomic fields, or provide native-conformance evidence.

`Roboport(prototype, configuration?)` provides the same structural facade for
provider prototypes whose actual type is `roboport`. It reuses every Entity
prototype/configuration form and produces the same nominal handle and one
physical record. It does not infer readback or output Networks, connectors,
callable behavior, ergonomic translations, or native-conformance evidence.

`Constant(prototype, configuration?)` is the structural facade for provider
prototypes whose actual type is `constant-combinator`. It accepts the same
prototype/configuration forms as `Entity`, returns one nominal Entity and one
physical record, and adds no Network, Combinator, signal output, connector,
call projection, or simulator authority. `CC(...)` remains the separate
executable ConstantCombinator source with its existing producer and output
Network behavior. Exact `Constant({ isOn, sections })` semantics and a future
shared physical representation are deferred.

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

The untyped native escape hatch is a separate public form:

```ts
const machine = Entity('assembling-machine-3', {
  raw: {
    recipe: 'iron-gear-wheel',
    control_behavior: { read_contents: true },
  },
});
```

The outer object must contain exactly `raw`; it cannot mix `raw` with `rule`,
`lanes`, or `condition`. `raw` must be a plain JSON object and is copied into a
frozen, profile-free Entity configuration. The bounded canonicalizer permits at
most 32 nesting levels, 4096 JSON nodes, and 262144 UTF-8 bytes. It rejects
accessors, symbols, cycles, non-finite numbers, arrays as the root, and scalar
roots at the source argument span.

The raw object maps to fields of one output `BlueprintEntity`. The compiler owns
`entity_id`, `entity_number`, `name`, `prototype`, `position`, `placement`,
`direction`, `connections`, `connectors`, and `wires`; those keys are rejected
with source-aware `RT2027` during source construction and `BP1001` at the
profile-free preview boundary. Other keys, including nested control behavior,
recipes, qualities, sections, filters, false/zero/empty values, and modded keys,
are preserved without validation against Factorio and without granting connector
or callable authority. Entity simulation remains inert/Unknown.

`Entity` is a reserved direct DSL value. Its first argument is either a short
prototype name (the preferred spelling) or canonical key resolved by the host
resolver, or the exact
identity of a record returned by the selected host `prototypes.entity` table.
The resolved canonical key must select exactly one fallback or reviewed profile
in the matching `TrustedEntityReplayContext`; the source never supplies a profile reference,
evidence, connector schema, or native ID. `port` takes exactly
`(connector, lane)` and `bind` takes exactly
`(connector, lane, network, direction)`, where direction is `input` or
`output`. Both methods operate only on a nominal Entity handle and retain
source provenance and ownership generation.

The cloneable Worker request carries only `EntityReplayContextTransport`. For a
selected built-in or imported provider, the Worker provisions the fallback
profile set only after it has loaded and validated that provider; request
identity and the `builtin`/`custom` routing label never grant authority. An
injectable host callback remains available for explicitly host-bound contexts.
The main-thread preview consumes the resolved physical snapshot returned by a
successful Worker compilation and does not require the host resolver again.

`Entity(prototype)` also accepts one public configuration object. The typed form
has exactly `rule`, `lanes`, and `condition` fields. The condition must be the nominal
`NativeCondition(signal, comparator, constant)` value created in the same
execution session; the runtime translates it to the existing typed
`control_behavior.circuit_condition` configuration before profile validation.
`entity.at(x, y, direction?)` mutates the existing physical record, returns the
same live view, and accepts finite coordinates plus an integer direction from
`0` through `15`. Neither form allocates a Producer, Network, or hidden
Decider. For a profile with an explicit `callProjection`, the implemented
callable subset accepts exactly one readable Network argument (including a
Producer's readable primary output), binds it to the declared input endpoint,
and returns the same live Entity view. `Network += entity` binds that same
physical Entity to the declared output endpoint; the inline
`output += Entity(params)(input)` form therefore creates one Entity with two
bindings and no hidden topology. Repeated identical bindings are idempotent;
conflicts, stale handles, non-callable profiles, and invalid destinations fail
with source-aware diagnostics. Ordinary objects and structural Entity lookalikes
retain ordinary JavaScript call behavior. Exact Constant section semantics,
reviewed native import, and native Factorio behavior remain separate future work.

## Internal construction and validation

The runtime [Entity registry](../packages/runtime/src/entity-registry.ts) is
session-local and internal. Production construction receives a narrow resolver
derived from the selected `PrototypeProvider`; its database schema/identity
must match the trusted context, and `getEntity(profile.prototypeKey)` must
succeed before an Entity handle is allocated. The provisioning service creates
one deterministic zero-port fallback profile per eligible provider record.
Clearly labelled synthetic resolvers are used only by unit fixtures. A profile
alone is not proof that a prototype exists.

Each construction gets a distinct nominal identity; an alias returns the same
handle. Foreign-session handles and objects that only look like Entity records
are rejected. Configuration, placement, source span, dynamic instance path,
creation revision, and ordinal are snapshotted and frozen. A zero-port Entity
remains a physical record even when it has no producer.

The compatibility raw-payload import seam accepts native data plus explicit
prototype, entity-number, and placement fields. Connector maps, bindings,
wires, support claims, and internal IDs are compiler-owned; topology-shaped
fields are rejected both at that payload boundary and inside the native object.
The public `{ raw }` form is narrower: it supplies only the native
`BlueprintEntity` fields and leaves prototype identity and placement to the
compiler.

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
trusted profile has an explicit default projection; callable input binding uses
that same readable boundary and its separate explicit `callProjection.input`.

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
and red/green input mask. The public two-argument form also accepts a partial
schema-checked BlueprintEntity fragment. It combines the catalog's common
fields with the selected provider prototype's exact `type` variant, or uses a
common-only schema when that type has no variant entry. Missing fields are not
materialized, while explicit `false`, `0`, and empty JSON containers remain
present. Same-session source `Signal(...)` values are detached at declared
SignalID positions before the checked fragment becomes an existing raw
physical payload. This is documented-shape validation only; it adds no schema,
profile, connector, callable, simulation, or native-conformance authority.
Raw configuration is copied onto the existing Entity
before compiler-owned `entity_number`, `name`, `position`, and `direction` are
added; it remains untyped and profile-free. The deprecated opaque v3 typed
envelope is rejected there as well. Physical preview validation is profile-free
and rejects malformed or forged native fields, lane masks, Signals, comparators,
signed int32 constants, and compiler-owned raw keys with source-aware `BP1001`.
Synthetic fixtures establish these
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

1. reviewed raw native import fixtures and Factorio conformance for raw fields;
2. reviewed non-synthetic evidence and Factorio conformance for the native
   single-comparison condition;
3. additional typed/generic acceptance beyond the host-bound source subset;
4. later typed facades and any native-verified claims.

The fallback construction, raw configuration, and placement forms documented
above are implemented for selected built-in and imported providers. Broader
typed facades, reviewed connector/configuration profile wiring, and
native-verified behavior are not implied by this source subset. Without a
selected provider, ordinary circuit-only compilation remains unchanged and
`Entity(...)` has no authority.
