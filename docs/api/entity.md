# Entity

[Documentation](../README.md) · [prototypes](prototypes.md) · [Functions](functions.md)

One nominal physical game Entity with source-linked configuration and placement.
An Entity is not automatically a Combinator, readable Network or simulator device.
Select a prototype environment before construction. Its conservative profiles
allow blueprint-eligible prototypes to be constructed and placed; connectors,
typed configuration and callable/read projections need an explicit matching profile.

## Signatures

Source fragments; endpoint/rule names are profile-defined, not universal defaults:

```text
Entity(nameOrCanonicalKeyOrExactProviderRecord, configuration?) -> Entity
entity.at(x, y, direction?) -> same Entity
entity.port(connector: string, lane: string) -> Network facet
entity.bind(connector: string, lane: string, network, 'input' | 'output') -> same Entity
entity(readableNetworkOrCombinator) -> same Entity
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
This is **export-only structural configuration**: no Lab research simulation,
connectors, read projection or callable behavior is supplied.

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
Blueprint data. Placement does not certify collisions, reach or game validity.

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

A callable profile declares one input and one output endpoint. `entity(input)`
accepts exactly **one** readable Network (or primary Combinator output), binds
the input, and returns the same Entity. `output += entity` binds the declared
output. Only one successful invocation is allowed per physical Entity, including
through aliases, containers and returned views. A second call reports `RT2030`
at that invocation with a related location for the first, even with the same
Network. A failed first call does not consume the allowance or leave binding
changes; JavaScript argument evaluation is not undone. Reuse the returned handle
for outputs. A compatible manual input `.bind` does not consume the call allowance.
Explicit identical `.bind` operations are idempotent; a different Network/direction
on the same endpoint conflicts. Reuse the same output handle, not another Entity
construction. A second independent output is not implicitly a free lane.

Using an Entity as an arithmetic input or readonly Network argument requires an
unambiguous declared default read projection. That projection is not necessarily
the callable output, and neither is inferred from the prototype's circuit flags.
Select an explicit `.port` when appropriate. A fallback Lab has neither form.

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

No `.enable` property setter, `.clone` API or multi-input callable form is released.
Generic Entity has no physical Combinator methods/configuration API merely because
its prototype resembles a combinator. Shared-port free-output/multi-input ideas
are not supported behavior. Not every game Entity/control field is simulated or
connectable. Reviewed typed rules and checked/raw structural payloads are distinct.

See [Blueprint schema catalog](../blueprint-schema-catalog.md) for field coverage,
[pinned control-behavior inventory](../../tools/factorio-api/README.md) for the
documented native shapes, and [Entity source reference](../language-reference.md#provider--and-host-bound-entities)
for precise capability limits. Exhaustive per-entity field examples remain separate
work; neither catalogs nor these compiler tests establish native conformance.
