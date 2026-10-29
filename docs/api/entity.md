# Entity

[Documentation](../README.md) · [prototypes](prototypes.md) · [Functions](functions.md)

One nominal physical game Entity with source-linked configuration and placement.
An Entity is not automatically a Combinator, readable Network or simulator device.
Select a prototype environment before construction. Its conservative profiles
allow blueprint-eligible prototypes to be constructed and placed. Most provider
profiles retain unknown connector topology; a normalized `single-shared` fact
enables the bounded shared-call wiring described below.

## Signatures

Source fragments; endpoint/rule names are profile-defined, not universal defaults:

```text
Entity(nameOrCanonicalKeyOrExactProviderRecord, configuration?) -> Entity
entity.at(x, y, direction?) -> same Entity
entity.port(connector: string, lane: string) -> Network facet
entity.bind(connector: string, lane: string, network, 'input' | 'output') -> same Entity
entity(readableNetworkOrCombinator, ...moreReadableInputs) -> same Entity
destinationNetwork += entity -> bind declared callable output
```

## Construction and configuration

Prefer short names such as `Entity('lab')`; `Entity('entity:lab')` and the exact
record from `prototypes.entity['lab']` also work. A copied record or a guessed
same-type name does not substitute for the selected prototype. There is no
implicit default Entity prototype. The returned identity and metadata are readonly;
assigning fields does not configure it. Configure at construction and use `.at`
to change physical placement without creating another Entity.

The optional second argument has three disjoint forms:

| Form                                               | Meaning                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| Checked partial Blueprint fragment                 | Validate common fields and the selected prototype's exact documented variant. |
| `{ raw: plainJsonObject }`                         | Preserve bounded native-shaped JSON without schema/behavior claims.           |
| `{ rule, lanes, condition: NativeCondition(...) }` | Apply a rule declared by the trusted profile.                                 |

Do not mix these forms. Checked fields may omit defaults; explicit false/zero and
empty arrays remain explicit. Compiler-owned identity, placement and topology
fields cannot be supplied in configuration: use source placement/connections.
At catalog-declared SignalID positions, same-session `Signal(...)` handles or
valid plain Blueprint SignalID data are accepted. A Signal elsewhere is not a
generic JSON escape.

`raw` still rejects compiler-owned fields, accessors, symbols, cycles and
non-finite numbers; it is bounded to 32 levels, 4096 nodes and 262144 UTF-8 bytes.
It cannot grant connectors, simulation or call authority. A checked fragment
likewise proves only the documented JSON shape, not native behavior.

`NativeCondition(signal, comparator, constant)` is a nominal typed configuration
handle, not a circuit Condition or Producer. It uses a same-session concrete
Signal, `> < = >= <= !=` and a finite safe integer normalized to signed int32.
Only an explicit profile rule maps it to a native field. It adds no Decider or tick.

## Checked Lab example

Complete source; requires the bundled Space Age 2.1.17 provider and its conservative
Entity provisioning (available through the selected workbench/CLI environment).
This is **export-only structural configuration**: it does not simulate Lab
research or provide a default-readable projection. The bundled provider separately
supplies the documented shared circuit connector and its multiple-input call form.

```ts
const prototype = prototypes.entity['lab'];
if (prototype === undefined) throw new Error('Lab prototype is missing');
const lab = Entity(prototype, {
  control_behavior: {
    read_contents: true,
    technology_level_signal: Signal('virtual', 'signal-A'),
  },
});
const placed = lab.at(10, -2, 8);
if (!Object.is(placed, lab)) throw new Error('placement changed identity');
```

One Lab Entity, zero producers. Blueprint output has position `(10, -2)`,
direction 8 and the stated `control_behavior`; its SignalID is ordinary detached
Blueprint data. Its provider profile also permits the shared circuit call below;
that call does not simulate research. Placement does not certify collisions,
reach or game validity.

## Raw configuration example

Complete independent source with the same bundled-provider prerequisite and
export-only boundary. This demonstrates preservation, not schema bypass for
protected fields or verified control behavior:

```ts
const lab = Entity('lab', {
  raw: { control_behavior: { read_contents: false } },
}).at(2, 3);
```

One Lab Entity, zero producers; explicit `false` is preserved in the export.

## Connections and readable projections

`.at` takes finite numeric coordinates and optional integer direction `0..15`.
`.bind` requires an existing live Network and a direction permitted by that
connector; output binding requires a writable destination. It returns the same
Entity. `.port` chooses an exact lane, returning its existing Network facet or
creating a logical Network when that endpoint has not yet been bound. It does
not create a combinator or permanently bind a second incompatible owner.
Network access still follows ownership/capability rules.

A fixed callable profile may still declare one input and one output endpoint.
For provider prototypes whose normalized topology is `single-shared`, provisioning
instead declares one bidirectional connector with red and green lanes and authorizes
shared calls only when its selected provider record has the normalized
`single-shared` fact. The bundled Space Age 2.1.17 provider derives that fact for
the reviewed families below when the actual raw record contains every required
red and green wire point. Orientation arrays describe rendering shapes, not
additional electrical ports.

| Family                                                                                                                                                                                                                    | Construction and configuration                                                                                                                   | Callable wiring                                                                                                                                                                                                           | Simulation and native evidence                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Single CircuitConnectorDefinition: accumulator, agricultural tower, artillery turret, cargo landing pad, lab, lamp, land mine, linked container, programmable speaker, radar, reactor, roboport, space platform hub, wall | Requires the selected provider record to be blueprint eligible. Checked configuration remains limited to the exact documented Blueprint variant. | Shared call is available for records with complete red and green wire points.                                                                                                                                             | Host-side source, solver and Blueprint export are structural checks. Device simulation and native game acceptance are not established. |
| Four orientation definitions: assembling machine, asteroid collector, boiler, display panel, furnace, inserter, mining drill, offshore pump, pipe to ground, pump, rocket silo, splitter, storage tank, train stop        | Same provider eligibility and exact-variant configuration rules. Rocket silo inherits the assembling-machine connector shape.                    | Shared call requires all four definitions and, where declared, every flipped definition to be complete.                                                                                                                   | Same structural-only boundary; no machine-process simulation is added.                                                                 |
| Orientation arrays: container, logistic container, infinity container, temporary container, transport belt, loader, loader-1x1, heat pipe                                                                                 | Same provider eligibility and exact-variant configuration rules.                                                                                 | Container arrays use inherited `direction_count` (default 1); belts require 7, loaders 8, and heat pipes 16 complete definitions. A missing connector leaves that record unknown.                                         | Arrays are shape/orientation coverage, not extra ports; no native acceptance is established.                                           |
| Turrets: turret, ammo turret, electric turret, fluid turret                                                                                                                                                               | Same provider eligibility and exact-variant configuration rules.                                                                                 | Required orientation count follows the documented flags/defaults: 8-way, then 16-way, then 4 for `turret_base_has_direction`, otherwise 1. Each definition must be complete.                                              | Structural export only; firing and other device behavior are not simulated or natively verified.                                       |
| Proxy containers                                                                                                                                                                                                          | Same provider eligibility and exact-variant configuration rules.                                                                                 | Accepts the documented single `CircuitConnectorDefinition` or an array with exactly inherited `direction_count` entries. Either shape describes one shared circuit endpoint.                                              | Structural export only; no proxy behavior simulation or native acceptance is established.                                              |
| Power switches                                                                                                                                                                                                            | Same provider eligibility and exact-variant configuration rules.                                                                                 | Uses only `circuit_wire_connection_point` as the shared circuit endpoint. The separate left/right copper points do not grant circuit authority.                                                                           | Circuit-wire export only; copper wiring, power transfer and native acceptance are not established.                                     |
| Electric poles                                                                                                                                                                                                            | Same provider eligibility and exact-variant configuration rules.                                                                                 | Requires a nonempty dense `connection_points` array with complete direct red/green wire points in every orientation. The array describes one shared circuit endpoint, not multiple ports.                                 | Circuit-wire export only; copper wiring, power transfer and native acceptance are not established.                                     |
| Deferred shapes and connection models                                                                                                                                                                                     | Construction/configuration may still be available when the provider marks a prototype eligible and its variant is documented.                    | No callable authority is inferred for `pipe` or `infinity-pipe` (both APIs describe a tuple of 4 while the raw dump has an array of 16) or rail signals. Dedicated combinators continue through their existing DSL paths. | No pipe/rail simulation or native acceptance claim; rail connector alignment remains unresolved.                                       |

Incomplete connector evidence remains unknown and continues to refuse a shared call
with `RT2027`. A complete checked configuration proves its documented JSON shape,
not every runtime behavior of its ControlBehavior fields.

```ts
const a = new Network();
const b = new Network();
const machine = Entity('assembling-machine-3');
const x = machine(a, b);
a += x;
b += x;
```

The call accepts one or more readable Networks (or primary Combinator outputs)
in one invocation, records them as input attachments and returns the same Entity.
Repeated aliases of the same resolved Network identity are idempotent. The
shared connector holds at most two distinct resolved Network identities after
transfers; argument count alone does not consume capacity. Distinct Networks use
opposite colors. `output += entity` records a writable output attachment, which
may reuse either input Network while preserving both roles. The existing color
solver selects the physical red/green lanes. The exporter emits one physical
Entity and no hidden combinator. This does not add a fixed profile-wide read
projection or machine crafting/output simulation.

Only one successful invocation is allowed per physical Entity, including through
aliases, containers and returned views. A second call reports `RT2030` at that
invocation with a related location for the first, even with the same Network. A
failed first call does not consume the allowance or leave attachment changes;
JavaScript argument evaluation is not undone. Reuse the returned handle for
outputs. Repeating an output attachment to the same Network is idempotent. A
second independent output is allowed only while the shared connector still fits
its two physical wires; Networks are never implicitly merged.

For a shared-call Entity, arithmetic, concrete Signal selection, a typed `Network`
initializer, and a readonly `Network` argument resolve reads from its recorded
attachments. One distinct output is reused, including an explicit fixed output
facet. If there is no output and exactly one distinct input after recorded
transfers, the first read lazily creates one uncolored output Network on the same
shared connector; the solver chooses its opposite color. Repeated aliases of one
input count once. The read does not choose or promote an input Network.

Two distinct outputs, no attachments, or multiple distinct inputs without an
output report `RT2032` at the read with attachment locations. A deliberately
declared same-Network input/output is readable as that output and keeps both
roles. Later unrelated connections still use the connector's two-wire capacity.
Direct access through a consumed alias remains invalid even though attachment
resolution follows a proven transfer. This conversion preserves readonly/ref/move
and borrow lifetime checks. Profiles without `single-shared` keep their declared
`defaultReadProjection`; an unknown profile or a never-connected shared Entity
does not gain an implicit read.

### Reading a shared output

Valid source for a bundled `single-shared` profile:

```ts
const input = new Network();
const machine = Entity('iron-chest');
machine(input);
const output: Network = machine;
const doubled = machine[Signal('virtual', 'signal-A')] * 2;
```

With two distinct inputs and no output, the read is intentionally ambiguous:

```ts
const first = new Network();
const second = new Network();
const machine = Entity('iron-chest');
machine(first, second);
const invalid = machine * 2; // RT2032
first += machine;
second += machine;
```

The call remains limited to one successful invocation. Reuse its returned
Entity handle for output attachments and later reads; an inferred output counts
as the connector's second distinct Network.

### Callable Lamp

The bundled Space Age 2.1.17 provider exposes the lamp's shared circuit connector.
Profiles without complete red and green wire-point evidence keep unknown topology
and do not acquire a callable projection. A lamp call attaches the supplied
Network to the physical lamp; it does not add a hidden combinator or simulate
lamp state.

```ts
const signal = Signal('virtual', 'signal-A');
const state = new Network<R>();
state += CC(1 * signal);
const lamp = Lamp('small-lamp', {
  control_behavior: {
    circuit_enabled: true,
    circuit_condition: { first_signal: signal, comparator: '>', constant: 0 },
  },
}).at(4, 5, 8);
lamp(state);
```

## Explicit profile example

Complete source **only in a synthetic embedding fixture**, not in the bundled
workbench environment. The test host supplies the existing
`synthetic-shared-two-color` profile: connector `shared`, input `shared-red`/red,
output `shared-green`/green, default read on `shared-red`, and rule
`shared-circuit-condition` with both lanes. This is not a real Factorio prototype
or native behavior evidence.

```ts
const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
const machine = Entity('synthetic-shared-two-color', {
  rule: 'shared-circuit-condition',
  lanes: ['shared-red', 'shared-green'],
  condition: NativeCondition(A, '>', 0),
}).at(4, 2);
const called = machine(input);
if (!Object.is(called, machine)) throw new Error('call changed identity');
output += called;
output += machine;
const inputPort = machine.port('shared', 'shared-red');
const bound = machine.bind('shared', 'shared-green', output, 'output');
if (!Object.is(bound, machine)) throw new Error('binding changed identity');
function Read(view: Readonly<Network>): Readonly<Network> {
  return view;
}
const observed = Read(machine);
```

One Entity construction and one invocation, two Networks, zero producers and no
hidden delay device. Output reuse and explicit `.bind` reuse the same endpoint;
`inputPort` and `observed` refer to `input`, not an independently computed output.
Only configuration, placement, identity and connections are asserted; this fixture
does not implement a native machine process or promise simulator signal output.

## Restrictions

No `.enable` property setter or `.clone` API is released. Fixed callable profiles
still require exactly one input; multiple inputs are limited to profiles that
authorize a shared connector.
Generic Entity has no physical Combinator methods/configuration API merely because
its prototype resembles a combinator. Shared-port free-output projection is not
general behavior: only a connected shared-call profile can infer one output under
the rules above. Not every game Entity/control field is simulated or connectable.
Reviewed typed rules and checked/raw structural payloads are distinct.

See [Blueprint schema catalog](../blueprint-schema-catalog.md) for field coverage,
[pinned control-behavior inventory](../../tools/factorio-api/README.md) for the
documented native shapes, and [Entity source reference](../language-reference.md#provider--and-host-bound-entities)
for precise capability limits. Exhaustive per-entity field examples remain separate
work; neither catalogs nor these compiler tests establish native conformance.
