# Current language reference

This document describes the implemented source compiler, ownership/multi-network runtime, and prototype-provider access. The Phase 5 testbench has its own reference; Phase 5.5 static prototype profiles are complete, while runtime-only capability fields remain unknown for later feature slices. The language is intentionally narrower than its eventual scope.

Phase 3 elaborates one self-contained source file synchronously. Static or dynamic imports, exports, `import.meta`, `async` functions/arrows/methods, `await`, and `for await…of` report `CL1036` before execution. The executable envelope independently blocks async syntax if semantic preflight is bypassed, so a delayed microtask cannot mutate an already finalized circuit plan. Multi-file linking belongs to a later compiler phase. This boundary is separate from the fully hardened sandbox deferred to Phase 11.

## Signals

One argument creates the same default item Signal used by a name-only Network selection. Two or three arguments provide an explicit Factorio namespace and optional quality:

```ts
const CHEST = Signal('chest');
const A = Signal('virtual', 'signal-A');
const IRON = Signal('item', 'iron-plate');
const QUALITY_A = Signal('virtual', 'signal-A', 'legendary');
```

`Signal("chest")` normalizes internally to `{ type: "item", name: "chest" }`. Factorio blueprint JSON omits the default item `type`, so the exported field contains only `name`. The optional third string carries Factorio quality. Literal non-string arguments are rejected by the semantic checker; dynamic arguments are accepted until elaboration and then validated from their executed values.

The reserved read-only `prototypes` value mirrors the supported subset of
Factorio's `LuaPrototypes` tables when a Prototype DB is explicitly injected
into the compilation environment. For example,
`prototypes.item['iron-plate']` and
`prototypes.virtual_signal['signal-A']` return normalized immutable prototype
records. `prototypes` cannot be shadowed by a user declaration. A source file
that reads it without an active Prototype DB receives `EX1004`; current
CLI project profiles and `--prototypes`, plus browser-local JSON selection, provide
that environment. The browser also offers the integrity-checked bundled first-run
profile.

The source value returned by `Signal(...)` is a nominal handle registered to the current elaboration session. A plain JavaScript object with `type` and `name` fields remains an ordinary object and is not accepted as a Signal operand or Network selection. Once a valid handle enters a direct plan, its identity is serialized as the structural `{ type, name, quality? }` Signal ID used by IR, simulation, and blueprint JSON. Name-only `network["chest"]` remains an explicit shorthand and does not require constructing a handle first.

Source Signal handles can also become ordinary JavaScript computed-property keys:

```ts
const A = Signal('virtual', 'signal/A');
const counts = { [A]: 5 };
// The actual key is: signal:v1/virtual/signal%2FA/
```

The external key is exactly
`signal:v1/<type>/<encodeURIComponent(name)>/<encoded non-normal quality or empty>`.
`String(A)` returns that key, while numeric/default coercion is rejected. The
codec treats omitted quality and explicit `normal` as the same Factorio Signal
identity, accepts every Signal namespace, and rejects malformed/noncanonical percent encoding. This external
format does not replace the internal `signalKey` used by circuit buses.

Only source-created nominal handles have this coercion. The public structural
`Signal(...)` helper in `@comblang/factorio` still returns an ordinary frozen
object, and `Signal('signal:v1/virtual/signal-A/')` still means an item with that
literal name. The canonical property-key form is accepted by `CC` dictionaries;
an ordinary bare string key remains item shorthand.

## Provider- and host-bound Entities

The current public Entity surface is intentionally small. When a built-in or
imported provider is selected, the Worker/CLI derives a trusted replay context
and a conservative zero-port fallback profile only for each prototype whose
normalized `blueprintEligible` fact is explicitly true:

```ts
// In a host embedding with a matching reviewed profile:
const machine = Entity('assembling-machine-3');
const canonical = Entity('entity:assembling-machine-3');
const fromTable = Entity(prototypes.entity['assembling-machine-3']);

machine.bind('circuit', 'red', input, 'input');
const redPort = machine.port('circuit', 'red');
```

The fallback profile is enough for `Entity(...)` construction and `.at(...)`
placement, including the `assembling-machine-3` example. It deliberately has no
connectors, call projection, configuration rules, or native behavior. A
matching reviewed profile (or clearly labelled synthetic fixture) is still
required for `port`, `bind`, callable Entities, and typed configuration. An
omitted `blueprintEligible` fact in legacy normalized input is unknown and does
not authorize construction.

For an untyped native configuration escape hatch, use exactly one `raw` field:

```ts
const machine = Entity('assembling-machine-3', {
  raw: {
    recipe: 'iron-gear-wheel',
    control_behavior: { read_contents: true },
  },
});
```

`raw` must be a plain JSON object. The runtime copies and freezes it with bounds
of 32 levels, 4096 nodes, and 262144 UTF-8 bytes. Accessors, symbols, cycles,
non-finite numbers, root arrays, and scalar roots are rejected. The outer
configuration cannot mix `raw` with the typed `rule`/`lanes`/`condition` form.
Compiler-owned BlueprintEntity fields (`entity_id`, `entity_number`, `name`,
`prototype`, `position`, `placement`, `direction`, `connections`, `connectors`,
and `wires`) are rejected. Other fields are preserved for blueprint preview,
but are not checked against Factorio and do not add connectors, call authority,
or simulation behavior; Entity objects remain inert/Unknown.

The accepted typed configuration and placement subset is:

```ts
const machine = Entity('synthetic-shared-two-color', {
  rule: 'shared-circuit-condition',
  lanes: ['shared-red', 'shared-green'],
  condition: NativeCondition(Signal('virtual', 'signal-A'), '>', 0),
}).at(10.5, -2, 8);
```

`NativeCondition(signal, comparator, constant)` requires a concrete current
session Signal, a comparator from `> < = >= <= !=`, and a finite safe integer;
the constant is canonicalized to signed int32. The returned value is a nominal
configuration handle, not a circuit `Condition`, Network, Producer, boolean,
or forgeable data record. The profile maps the comparison directly onto one
physical Entity's native circuit-condition field, so this operation adds no
Decider combinator and no simulation tick. The example is a synthetic
host-embedding fixture, not a claim of native Factorio compatibility.

`Entity(prototype)` accepts one or two arguments: a short prototype name (the
preferred spelling), its internal canonical key, or the same object identity
returned by the selected `prototypes.entity` table, optionally followed by the
public configuration object shown above. The selected provider resolves that
prototype to one trusted fallback or reviewed profile before allocating a
nominal physical Entity. `Entity` is
reserved and only a direct identifier call has this meaning; ordinary object
members such as `object.Entity`, `object.port`, and `object.bind` remain native
JavaScript operations.

`machine.port(connector, lane)` selects an explicit connector lane. The exact
four-argument `machine.bind(connector, lane, network, direction)` form binds
that lane to an existing Network, with `direction` equal to `input` or
`output`. Both operations preserve source spans, physical Entity identity, and
Network ownership validation. `entity.at(x, y, direction?)` accepts finite
numeric coordinates and an integer direction from `0` through `15`, mutates
the existing physical record, and returns the same live Entity view. The
callable form is implemented for a trusted profile that declares an explicit
input/output `callProjection`:

```ts
const input = new Network();
const output = new Network();
output += Entity('reviewed-callable-machine')(input);
```

The call accepts exactly one readable Network argument, including a
Combinator's readable primary output, binds it to the declared input endpoint,
and returns the same live Entity handle. `Network += entity` binds the declared
output endpoint, so the inline form creates one physical Entity and no hidden
Producer, Network, or tick. Identical repeat bindings are idempotent; conflicts,
stale handles, profiles without a call projection, and invalid destinations are
source-aware errors. Ordinary objects and structural lookalikes keep normal
JavaScript call behavior. Typed facades and reviewed native import remain
outside the current language surface.

The browser Worker request transports only replay identity metadata. Source
Entity authority is available only when a host adapter resolves the detached
transport to a matching `TrustedEntityReplayContext` and prototype resolver;
transport-only compilation cannot construct an Entity.

## Networks and colors

```ts
const automatic = new Network();
const red = new Network<R>();
const green = new Network<G>();
```

`R` and `G` are hard wire-color requirements. Networks without a fixed color are assigned deterministically by the topology solver. Two distinct logical Networks used on the same physical connector must receive opposite colors; three distinct Networks on one connector are invalid.

An explicit `Network` assertion or annotation narrows a Combinator to its exact primary output Network:

```ts
const producer = input + 1;
const primary: Network = producer;
const alsoPrimary = producer as Network;
```

This creates no hardware and does not expose Combinator attachment methods. It also never falls back to the secondary output lane. Use `Move<Network>` when a function should acquire the next available Combinator output lane.

To unite one or more owned inputs without hardware, use the reserved `join` helper:

```ts
const merged = join(first, second);
const fromArray = join(...networks);
```

`join` returns a new owned Network and records zero-tick transfers only. Combinator inputs acquire primary and then a lazily created secondary lane; a third occurrence is `RT2028`. The complete operation is failure-atomic, including fixed-color validation and secondary-lane creation. `Readonly`/`Ref` values, `pair(...)`, selections, duplicate exact Networks, and empty calls are invalid.

## Network selections

A bare Network means native `Each` in supported arithmetic and decider contexts. These forms are equivalent:

```ts
input;
Each(input);
input[EACH];
```

A typed signal selection reads only one signal:

```ts
input[A];
```

The semantic checker rejects a definitely invalid key such as `input[5]`, but does not guess the type of a dynamic key. A string selection such as `input["chest"]` is equivalent to `input[Signal("chest")]`: both normalize to the item Signal `{ type: "item", name: "chest" }`, and generated blueprint fields omit that default item `type`. This shorthand does not infer arbitrary namespaces from a prototype name, so virtual selections use an explicit identity such as `input[Signal("virtual", "signal-A")]`. Indexing `networks[i]` remains ordinary collection access when `networks` is a `Network[]`; the executed element is subsequently classified by the DSL operation that consumes it.

Compact decider conditions also support native quantifiers:

```ts
Anything(input);
input[ANYTHING];
Everything(input);
input[EVERYTHING];

// Short aliases
Any(input);
input[ANY];
All(input);
input[ALL];
```

The same forms can be used as copy-count outputs:

```ts
const one: Network = IF(input > 0, Anything(input));
const all: Network = IF(Anything(input) > 0, Everything(input));
```

`Anything` deterministically selects one matching signal. `Everything` copies the selected bus and cannot be combined with an `Each` condition. Explicit wildcard outputs cannot be rebound with `destination[SIGNAL]`; invalid physical combinations are rejected before a circuit is produced.

`Any` is an exact source alias of `Anything`, and `All` is an alias of `Everything`. Their element-access spellings are `ANY` and `ALL`. The aliases do not change selection order, topology, or generated hardware.

An `Anything` or `Everything` condition must currently emit a specific signal, for example `IF(Anything(input) > 0, input[A])`. Native `Each` output requires an `Each` condition and is rejected for quantifier conditions.

## Arithmetic combinators

```ts
const doubled: Network = input * 2;
const sum: Network = left + right;
out += input * 2 + 1;
out[RESULT] += left[A] + right[B];
```

Supported operators are addition, subtraction, multiplication, division, modulo, power, shifts, and bitwise AND/OR/XOR. Parentheses and left-associative grouping are preserved. Each circuit operation creates one arithmetic combinator; compile-time-only integer subexpressions are folded.

The transformed module dispatches operators from their executed values. When neither operand is a circuit DSL value, JavaScript coercion, loose/strict equality, relational comparison, and lazy `&&`/`||` short-circuit behavior are preserved. When operands are Networks, selections, combinators, or circuit Conditions, the same syntax records physical arithmetic or native decider condition groups.

Without an explicit destination signal, arithmetic uses the first concrete input signal from left to right when one exists, otherwise native `Each` output.

Output Signal binding belongs to the attachment: use `out[SIGNAL] += expression`,
`to(out)[SIGNAL] += expression`, or `expression.to(out, SIGNAL)`. Combinator
`.as(...)` is deliberately not a second spelling and reports `CL1043` (or
`RT2021` when only the executed receiver proves it is a DSL value).

## Decider combinators

Compact and fluent spellings share the same one-decider lowering:

```ts
const copied: Network = IF(input > 0, input);
const selected: Network = IF(input[A] > 0, input[A]);
const fluent: Network = when(input[A] > 0).then(input[A]);
```

`IF` has explicit true and optional false branches. `when` offers the same
shape fluently, including a false-only form:

```ts
const compact = IF(a > 0, [a, 2 * SIGNAL_A], { fallback: b });
const fluent = when(a > 0)
  .then(a, 2 * SIGNAL_A)
  .else(b);
const falseOnly = when(a > 0).else(b);
```

Each branch accepts one output, nested arrays, or ordinary objects; arrays and
object values are recursively flattened in JavaScript iteration order. Bare
Networks mean `Each(network)` in output context. Both branches remain native
`outputs`/`else_outputs` of one physical Factorio 2.x decider. The compiler
validates all output filters and the combined input-connector color capacity as
one device.

Output entries remain ordered and are not deduplicated. Two entries targeting the same SignalID intentionally sum on the output Network, matching native Factorio behavior.

A concrete copy-count output has a less obvious meaning when the final
condition uses native `Each`:

```ts
const result: Network = when(input != 0).then(input[A]);
```

This does not read `A` once. For every signal that passes the `Each` condition,
the decider copies that candidate's input count into output Signal `A`. Thus
`B=10, C=20, D=-5` produces `A=25`. Adding a second row `1 * A` produces
`A=28`, because the constant row also contributes once per matching candidate.
The operation is native per-Each redirection, not a precomputed sum or reduce.
An explicit ergonomic spelling such as the provisional `input.into(A)` remains
unimplemented until Factorio conformance tests settle non-Each and red/green
pair behavior; raw `input[A]` remains legal.

Conditions support finite safe-integer constants on either side; each is canonicalized to signed int32 when it enters the circuit configuration. They also support explicit signal-to-signal comparisons, `&&`, `||`, parentheses, and `!`. Boolean normalization does not allocate extra combinators.

Constant-count Each output is a decider output specification, not multiplication hardware:

```ts
const colors: Network = IF(input > 0, 0x00ff00 * EACH);
```

The decider emits the constant for every active `Each` candidate. The count must be a finite safe integer and is canonicalized to signed int32.

The exact `Decider({...})` constructor remains Phase 7 work.

## Constant combinator

```ts
const constants: Network = CC(5 * A, -2 * B);
const rows = [
  [A, 3],
  [B, -4],
];
const generated = CC(
  [A, 1],
  rows,
  new Map([
    [A, 2],
    ['iron-plate', 50],
  ]),
  { [B]: 7, 'copper-plate': 25 },
);
out += CC(5 * A);
to(first, second) += CC(5 * A, -2 * B);
```

`CC` accepts typed counts (`count * Signal`), `[Signal|string, count]` tuples,
nested arrays of accepted rows, `Map<Signal|string, count>`, and plain objects.
Object keys produced by `[Signal]` use the canonical `signal:v1/` codec; bare
strings mean item Signals. Counts must be finite safe integers and are
canonicalized to signed int32.

Rows preserve executed source order, including zeros and repeated Signal
identities; they are neither sorted, merged, nor deduplicated. Maps preserve
entry order and may retain two different Signal handles with equal identities.
Plain objects follow `Object.keys` order and ordinary overwrite behavior.
Arbitrary iterables, enumerable symbol keys, malformed canonical keys, cyclic
arrays, and nesting beyond the bounded container depth are rejected at the
executed `CC(...)` call.

Factorio's `BlueprintLogisticFilter` differs from an ordinary `SignalID`: an
omitted filter quality means “any quality”, while an omitted SignalID quality
means `normal`. Blueprint export therefore writes `quality: "normal"` explicitly
for an unqualified constant row; otherwise the game can import it as an any-quality
filter that does not represent the requested constant. A user-facing any-quality
constant-filter syntax is not exposed until its behavior is covered by the exact
Constant surface and reviewed compatibility fixtures.

`CC()` is valid and creates one empty physical constant combinator. It emits no signals but can still be placed and attached, for example `CC().at(1, 2).to(out)`. An empty generated list in `CC(...entries)` has the same meaning. Like any other combinator, an unattached standalone `CC()` receives `CL2001`, not an error.

This implemented form creates one default Factorio 2.1 section. Multiple sections, section `multiplier`/`group`/`active`, and the entity-wide `isOn` switch are planned for the Phase 7 exact Constant surface. Their accepted design is documented in [Native objects, Deciders, and blueprint parameters](native-objects-deciders-and-parameters.md); `CC.section(...)` is not executable syntax yet.

## Combinators and output connections

Every hardware-producing expression creates its physical combinator immediately. It also creates a canonical primary output `Network`; there is no later materialization step:

```ts
const input = CC(5 * A); // ConstantCombinator
const gated = IF(input[A] > 0, input[A]); // DeciderCombinator
const scaled = gated * 2 + 1; // ArithmeticCombinator
```

`Combinator` is publicly a subtype of `Network`. Network reads, selections, arithmetic, conditions, `pair`, function Network arguments, and `take` use its primary output facet. A `Network` annotation only narrows the visible API; it creates no entity, wire, or temporary Network:

```ts
const physical = input * 2;
const narrowed: Network = physical;
const reused = physical * physical; // both reads use the same primary output
```

The precise physical types are `ArithmeticCombinator`, `DeciderCombinator`, and `ConstantCombinator`. `Combinator` accepts any of them. `Producer` is retained only as a deprecated compatibility alias for `Combinator`; new source should not use it. Concrete annotations on declarations, parameters, returns, and supported container slots validate the executed physical kind. A definite mismatch is `CL1044`; a dynamically selected mismatch is `RT2022` at the executed boundary.

Physical methods remain available on the combinator handle even after one output lane is connected:

```ts
const comb: ArithmeticCombinator = input + 1;
first += comb; // consumes primary output lane
comb.at(10, 4); // still configures the same physical entity
second += comb; // creates and consumes the stable secondary lane
// third += comb;       // RT2028: both output lanes are already consumed
```

Primary and secondary are two logical Networks carried by the red and green wires of one physical output connector. They are constrained to opposite colors and carry the same combinator result. The secondary lane is created lazily, at most once. Repeating destructuring or using aliases never clones the entity or creates additional lanes.

All connection spellings use the same lane allocator:

```ts
out += a + b;
out[RESULT] += left[A] + right[B];
to(first, second) += a + b;
to(first, second)[RESULT] += left[A] + right[B];
(left + right).to(first[RESULT]);
(left + right).to(first, second, RESULT);
```

The free destination form binds an output Signal as `to(first, second)[SIGNAL]`; fluent syntax uses `.to(first, second, SIGNAL)`. The output binding changes the existing physical configuration and adds no combinator. A destination may be an ordinary Network or a Combinator's primary Network facet; pair views and multi-output destinations must be selected explicitly. `.to(first[SIGNAL], second[SIGNAL])` remains invalid. Empty, duplicate, and over-capacity destination lists report `RT2003`, `RT2004`, and `RT2005`. A third sequential lane request reports `RT2028`. The first output binding is retained for the physical combinator: an incompatible later binding reports `RT2023` at the later operation with both binding and creation provenance. `Network += Network` and `Network += number` remain errors; the callable Entity output form is the separate `Network += entity` case documented above and requires a declared profile projection.

`when(condition)` also creates its Decider immediately. `.then(...)` and `.else(...)` mutate central state shared by every alias:

```ts
const gate = when(input > 0);
const alias = gate;
gate.then(input);
alias.else(fallback);
```

The final object is one physical Decider. Every mutation revalidates its input-connector capacity and color constraints online, and a destination Signal bound before `.then/.else` is reapplied when the output descriptor becomes complete. One output in each mutually exclusive `then` and `else` branch may share that binding; adding multiple outputs to either branch reports `RT2023` at that mutation. A `when` left without either branch is `RT2022` at finalization.

Arrays and objects are ordinary JavaScript containers; the runtime does not recursively convert their contents. This works naturally because each combinator is already a Network value:

```ts
const stages: Network[] = Array.from({ length: 10 }, (_, i) => input * (i + 1));
const record: { value: Network } = { value: input + 1 };
const squared = stages[3] * stages[3];
```

Container reads are classified when the value is used. A heterogeneous array is accepted until execution reaches an element that is not valid for the requested DSL operation. Storing and retrieving a combinator preserves physical identity and configuration.

Flat typed destructuring of an ordinary container validates its members as combinator handles:

```ts
const handles = [arithmetic, gate];
let [a, d]: [ArithmeticCombinator, DeciderCombinator] = handles;
```

Direct destructuring of one combinator instead projects output lanes:

```ts
const comb = input + 0;
let [primary, secondary]: [Network<R>, Network<G>] = comb;
let [samePrimary, sameSecondary] = comb;
```

Both pairs refer to the same primary/secondary Network identities. Object destructuring is a compatibility spelling for the same flat projection. More than two Network projections are invalid.

After synchronous execution the runtime warns with `CL2001` when a created combinator output was never read or connected. The physical combinator and its dangling primary output remain in the plan; no `$unused` sink is synthesized. Assignment to a variable or container alone does not suppress the warning because only the completed execution can prove whether the output was used.

## Explicit Network transfer

`destination.take(source)` physically unifies two logical Networks without adding a combinator or a tick:

```ts
const source: Network = input + 1;
const destination = new Network();

destination.take(source);
const output: Network = destination * 2;
```

`destination` survives as the owner of the unified Network. `source` is consumed, and every later executed attempt to select it, read it in an expression, attach to it, or move it again reports `RT2012`. Runtime identity is shared by ordinary JavaScript aliases and containers, so an alias such as `const aliases = [source]` cannot bypass the check. The semantic pass validates only definite method-shape errors and leaves dynamic receiver/argument classification to execution.

The direct plan retains the ordered transfer and its source/instance provenance. Before EG construction, lowering maps all earlier producer references to the surviving runtime handle; EG and NCIR therefore contain one physical Network for the union. Contradictory fixed colors such as `Network<R>` taking `Network<G>` report `RT2014`. Taking itself reports `RT2013`. An ordinary non-Network object may still define its own JavaScript `.take(...)` method.

Ordinary JavaScript aliases of a Network share its runtime ownership token; they are not independent ownership copies. Consuming through any alias invalidates every view of the old generation. A returned fresh owner replaces a mutable binding or container slot through ordinary assignment, such as `current = Advance(current)`, `stages[i] = Advance(stages[i])`, or `state.current = Advance(state.current)`. JavaScript evaluates the consuming call before storing its result. No additional `move(...)` or slot-specific syntax is required.

## Both-colors input views

`pair(a, b)` creates an immutable view of two distinct logical Networks on one physical input connector. The two Networks are constrained to opposite wire colors, and matching signal values are summed exactly as Factorio sums its red and green circuit inputs:

```ts
const inputs = pair(red, green);
const selected: Network = inputs[A] + 0;
const doubled: Network = Each(inputs) * 2;
const copied: Network = IF(Anything(inputs) > 0, Everything(inputs));
```

The view works as a bare Each input, through `pair(a, b)[SIGNAL]`, and with `Each`, `Anything`/`Any`, or `Everything`/`All`. Arithmetic, decider conditions, and copy-count outputs retain both input Networks in the direct plan and NCIR. Simulation reads both buses, while blueprint JSON wires each resolved color to the matching input connector. Constructing the view records its color constraint even if the view is saved before a producer uses it.

`pair` neither merges nor owns its inputs. It cannot receive a producer, be passed to `.to(...)` or `to(...)`, participate in `.take(...)`, satisfy `Move<Network>`, or escape a function as an ownership carrier. Definite source forms report `CL1042`; dynamically aliased forms report `RT2020`. `pair(a, a)` and aliases of the same Network are invalid. Moving either input invalidates older pair views through the ordinary `RT2012` ownership-generation check.

Output fan-out remains a separate operation: use `combinator.to(first, second)`, `to(first, second) += combinator`, or direct tuple/object lane projection. A pair is only an input-side view.

Array or flat object destructuring projects the output lanes of one already-created combinator:

```ts
let [a, b]: [Network, Network] = input + 0;
let [green, inferred]: [Network<G>, Network] = input + 1;
let [left, right] = input + 2;
let { primary, mirror }: { primary: Network<R>; mirror: Network } = input + 3;
```

The two bindings are aliases of its stable primary and secondary Networks, so they must resolve to opposite wire colors. Repeating the destructuring returns the same identities. Tuple/object type entries apply independently; omitted annotations are inferred from the executed combinator value. The same syntax used with an ordinary JavaScript array or object retains normal destructuring behavior. Combinator lane projection is currently flat and limited to one or two Network bindings.

Standalone arithmetic, `CC`, `IF`, and `when(...).then(...)` expressions produce warning `CL2001` when their outputs are never read or connected. Their physical entities and dangling primary Networks remain in the plan; no internal sink is created.

## Explicit preview placement

`.at(x, y, direction?)` records an exact Factorio blueprint position on a combinator:

```ts
const placed = (input + 1).at(10.5, -2, 8);
output += IF(input > 0, input).at(12.5, -2);
```

`.at(...)` may run before or after either output lane is connected because the physical handle remains alive. Coordinates must be finite numbers. Direction may be a numeric compile-time constant or a TypeScript enum member and must resolve to an integer from `0` through `15`; omitted direction currently defaults to `4`. Unplaced combinators use the deterministic preview row. Physical collision, reach, and relay validation are not part of the Phase 3 preview.

## Functions

Ordinary JavaScript functions execute during elaboration and are not limited to a compiler-recognized one- or two-parameter template. Parameters and return values may contain ordinary JavaScript values or circuit DSL values; DSL-sensitive operations inside the body are transformed and classified from their executed operands.

```ts
function Scale(input: Readonly<Network>): Network {
  const factor = 2 + 3;
  const scaled = input * factor;
  return scaled + 1;
}

const output: Network = Scale(input);
```

`Readonly<Network>` and `Ref<Network>` are executable function-parameter capabilities:

| Parameter/value type          | Read signals | Receive producer attachment | Participate in `.take(...)` |
| ----------------------------- | ------------ | --------------------------- | --------------------------- |
| `Readonly<Network>`           | yes          | no                          | no                          |
| `Ref<Network>`                | yes          | yes                         | no                          |
| `Move<Network>`               | yes          | yes                         | yes                         |
| owned Network created locally | yes          | yes                         | yes                         |

```ts
function Connect(output: Ref<Network<G>>, input: Readonly<Network<R>>): void {
  output += input + 1;
}
```

The annotations create runtime views over the actual Network identity; they do not copy topology. Aliases and containers therefore cannot bypass the operation matrix. Multiple `Readonly` views may overlap, while a `Ref` is exclusive and currently cannot overlap either another `Ref` or a `Readonly` view. Both views expire on function return. Returning a borrowed parameter directly reports `CL1040`; a borrow hidden in an executed array/object return reports `RT2017`. `<R>`/`<G>` inside a capability is a real color requirement and a conflict reports `RT2018`.

Every successfully executed capability boundary is serialized in the direct plan as a `capabilityUses` audit descriptor. It records the concrete Network, capability, parameter, optional fixed-color requirement, source span, and dynamic instance path. Direct-plan validation preserves this metadata beside the lowered EG/NCIR circuit; it is visible in CLI JSON and the browser result model but deliberately creates no Factorio entity or wire by itself. Physical effects remain represented by the Network color requirements, `networkTransfers`, `networkPairs`, and producer inputs/attachments.

`Move<Network>` is the explicit consuming parameter mode:

```ts
function Advance(input: Move<Network<R>>): Network {
  input += input + 1;
  return input;
}

const seed: Network = CC(5 * Signal('virtual', 'signal-A'));
const advanced = Advance(seed);
```

Entering `Advance` transfers ownership and immediately invalidates every caller-side alias and old array/object slot that contains `seed`; using one reports `RT2012`. The `Move` view may be read, written, or consumed with `.take(...)`. Returning it transfers a fresh owned view to the caller. Owned Networks nested in arrays and plain objects are transferred recursively, while attempting to return the same owner twice, such as `[input, input]`, is rejected as a duplicate move.

Ownership is affine rather than mandatory-use: a function may consume or drop a `Move` parameter without returning it. The old caller views do not become valid again; trying to use dropped ownership reports `RT2019`. A function also cannot return a caller-owned Network that it never accepted through `Move`; that would be an implicit steal and reports `RT2019`.

Simple parameters in function declarations may omit the capability or the type:

```ts
function Double(input) {
  return input * 2;
}
function Triple(input: Network): Network {
  return input * 3;
}

const input = CC(5 * Signal('virtual', 'signal-A'));
const doubled = Double(input);
const tripled = Triple(input);
const ordinaryNumber = Double(4); // ordinary JavaScript: 8
```

An annotated `Network` parameter receives an unrestricted transparent reference to the executed Network facet without creating a borrow or moving ownership. It emits warning `CL2002` once per declaration when a Network is actually received; explicit `Readonly<Network>` suppresses the warning. Reads, writes, and explicit consumption still consult the shared runtime ownership state. An untyped or `any` parameter preserves the exact executed value: a Network stays a Network, a Combinator stays a Combinator, and ordinary JavaScript values remain unchanged.

Union parameters such as `Network | number`, `Network | undefined`, and `Readonly<Network> | number` select their admitted branch at execution time. Ordinary branches do not create a circuit view; a value matching no branch reports `RT2015` at the call argument. `input: Network<G>` projects the same primary facet and adds a color requirement without creating hardware. A local `: Network` annotation narrows the API, while a `Network` return preserves an unchanged transparent caller alias at the same generation and transfers a Network created by the current function. Explicit `Readonly`/`Ref` borrows still expire on return or throw and cannot escape.

Variables, destructuring bindings, arrays, objects, and closures may hold aliases of one Network. They share the same ownership state and generation. Passing `array[i]` or `record.current` to `Move<Network>` invalidates the old slot value and every other old alias; assign the returned owner back with `array[i] = Transform(array[i])` or `record.current = Transform(record.current)`. A closure that retains a `Readonly`/`Ref` view past the call boundary receives `RT2017` when it later tries to use that expired borrow.

A structural function may declare local Networks, connect combinator outputs to them, and return one of those Networks. Each call receives independent local Networks:

```ts
function MemoCell(input: Readonly<Network>): Network {
  let out = new Network();
  let mem = new Network();
  to(out, mem) += input + 0;
  to(out, mem) += IF(input == 0 && mem != 0, mem);
  return out;
}

const input = new Network();
const output: Network = MemoCell(input);
```

Returning `ArithmeticCombinator`, `DeciderCombinator`, `ConstantCombinator`, or `Combinator` preserves the physical handle and its configuration API. Returning `Network` transfers only its primary Network facet, so the caller cannot recover combinator-specific methods by destructuring or casting. This narrowing is enforced for function declarations and explicitly typed arrow/function expressions as well. Returning an independently owned local Network returns that handle; other local Networks remain private unless returned or connected. A borrowed parameter cannot be promoted to an owned Network return. A function that returns an ordinary value remains ordinary JavaScript, and an error is reported only if the executed value is later used in an incompatible DSL operation.

Each instrumented function boundary receives an independent provenance scope, so generated Networks, combinators, and connections retain the dynamic function path. Async syntax is rejected before execution; imports and multi-module elaboration are not implemented yet.

Default parameter and destructuring expressions are executed only when JavaScript selects the default, and DSL operations inside them use the normal runtime bridge. A binding such as `function Build(input = CC(...))` or `const [input = CC(...)] = []` retains the already-created combinator; Network operations use its primary facet. Earlier-parameter references and ordinary side-effect order are preserved. Combinators created while evaluating a function default retain that invocation's dynamic function path before the body begins.

Static checks resolve user function declarations lexically, including nested declarations. A local binding with the same name does not inherit an outer function's annotations. If the function binding is reassigned, its call signature is treated as uncertain and checked from executed values instead. This uses TypeScript symbol binding only, not TypeScript assignability rules for DSL operators.

Returning an array/plain object inspects its own data properties for Network ownership transfer without invoking getters or custom array iterators. Accessors remain lazy; sparse indices, symbol keys, property descriptors, null prototypes, and frozen/sealed/non-extensible state are preserved when a returned Network requires a new container view. Cycles and shared container references are retained. Ordinary branches without transferred Networks keep their original JavaScript identity, including purely ordinary cycles. A shared container is visited once; two distinct member slots holding the same Network (such as `[input, input]`) remain a double-move error.

All reachable data-member handles are validated before any return transfer. If a later member is borrowed, stale, duplicated, or owned by another function, the failed return leaves earlier members' ownership unchanged, so a `catch` inside the callee can still use them. This is not general JavaScript or circuit-construction rollback: effects performed while evaluating the return expression remain. Maps, class instances, and values hidden behind accessors are not traversed for automatic ownership transfer.

## Executed compile-time control flow

The semantic pass reports only violations it can prove without executing the program. A local parameter or variable whose DSL category is not known stops lookup of an outer binding with the same spelling; it is not assumed to inherit an outer Network fact. The transformed elaboration runtime is authoritative for dynamic operator and method dispatch: the same instrumented syntax may perform ordinary JavaScript work or construct a circuit descriptor depending on the values reached in that execution. The exact supported metaprogramming surface and optional-chain boundary are listed in [Compile-time JavaScript](compile-time-javascript.md).

DSL method arguments may be spread from executed arrays/iterables, for example `combinator.at(...coordinates).to(...destinations)` or `destination.take(...sources)`. These calls retain the usual constraints (two or three placement arguments, one or two output Networks with an optional Signal, exactly one source for `take`); argument count is checked after expansion. Computed method names use the same runtime dispatch as dot access. An ordinary JavaScript method with the same name retains its own argument convention and is looked up once before arguments are evaluated.

Free DSL identifiers are reserved in v1 and cannot be shadowed by user bindings. This includes constructors/functions and every documented wildcard alias. `CL1045` points at the conflicting declaration. Object property and method names are unaffected: `object.Each`, `{ All() {} }`, `object.to(...)`, and `object.then(...)` retain ordinary JavaScript meaning. A `.then(...)` or `.else(...)` call is statically a Decider combinator mutation only when its chain is rooted at the reserved `when(...)` builder; uncertain receivers are checked from their executed values.

Ordinary functions, `if` branches, arrays, objects, and all JavaScript loop families execute during elaboration. For example, a regular `for` loop can generate compact `IF` attachments:

```ts
const A = Signal('virtual', 'signal-A');
let input = CC(5 * A);
let output = new Network();

for (let i = 0; i < 10; i++) {
  output += IF(input < i, 1 * A);
}
```

The JavaScript engine executes the loop. It produces one constant combinator and ten decider combinators; the compiler does not statically unroll or pattern-match ten copies. The same executable path is used with and without loops; the web compiler has no static-lowering fallback.

TypeScript numeric enums are erased to frozen ordinary objects. Constant numeric expressions and earlier same-enum member references are folded before execution, so `enum Direction { North = 1 << 2, East }` yields `North = 4` and `East = 5`. If an explicit initializer is dynamic, any following member needs its own explicit initializer; `CL1048` rejects ambiguous auto-numbering instead of inventing a value.

An executed circuit comparison produces a circuit `Condition`, not a JavaScript boolean. Using one directly as an `if`/ternary/`while`/`do…while`/`for` test is `RT2024`; this prevents the branded runtime object from silently acting as truthy. Circuit branching belongs in `IF(...)` or `when(...).then(...)`. Conditions still support `!`, while `!` applied to an ordinary value keeps native JavaScript truthiness.

`for…of`, `for…in`, `while`, and `do…while` use that same runtime path. Their bodies are instrumented for provenance rather than statically interpreted, so arrays and object configuration can control generated hardware. Entering or iterating a loop does not consume the numeric DSL-call limit.

Loop-local contextual Networks and following arithmetic are also executed per iteration:

```ts
for (let i = 0; i < 10; i++) {
  let tmp: Network = IF(input < i, 1 * A);
  output += tmp * 2;
}
```

This creates ten Decider primary output Networks, ten deciders, and ten arithmetic combinators. `tmp` is a source alias for the appropriate eager primary lane in each dynamic iteration; repeated names receive stable instance provenance rather than controlling topology.

Browser compilation reuses one Web Worker across revisions and keeps only the newest queued edit while it is booting or busy. The first execution in a Worker generation and any source-profile import have a 15000 ms budget; later warm ordinary or identity-only executions have a 1000 ms budget. Exceeding the applicable request budget terminates and replaces that Worker and reports `EX1002`; the diagnostic may include a cautious `last reported phase` hint for observability. Thus an infinite compile-time loop cannot freeze the interface. This timeout is an availability boundary, not yet the complete untrusted-code sandbox described by the project architecture.

Execution also has a default safety limit of 100,000 circuit-recording DSL calls. Compile-time numeric arithmetic, numeric comparisons, function entry, and loop iteration are not charged. Calls that create or inspect circuit-language values are charged; the limit is still not a Factorio combinator or simulator-tick cap. Exceeding it reports `EX1003`. Function calls and loop bodies contribute instance paths such as `function Scale`, `for i=7`, and `while #2` to every Network, producer, and attachment created inside their dynamic scope.

The current language does not require generation to be reproducible. Code may deliberately use ambient values such as time or randomness; naturally, the resulting blueprint can then differ between compilations. A future reproducible-build mode may restrict or inject those inputs, but full sandbox hardening is currently a low-priority task. The step and wall-clock limits remain because they protect editor availability rather than enforcing determinism.

## Current diagnostic groups

- `CL1xxx` — source lowering and semantic errors
- `CL2001` — non-fatal unused-producer warning
- `CL2002` — non-fatal implicit read-only Network parameter warning
- `EX1xxx` — transformed JavaScript execution errors and availability limits
- `RT1xxx` — direct-plan descriptor/schema failures
- `RT2xxx` — runtime ownership, topology, and color failures

Diagnostics use half-open source spans. A color conflict includes related Network declarations when available.

See the [diagnostics catalog](diagnostics.md) for common codes and corrective actions.

## Not implemented yet

- blueprint import/export and FCIR
- exact `Arithmetic`, `Decider`, `Selector`, and entity constructors
- multi-file module linking and asynchronous top-level elaboration
- testbench syntax, mocks, expectations, and waveform assertions
- general language service and schematic editor

Implemented ownership and `pair` semantics, acceptance criteria, and the few remaining Phase 4 decisions are tracked in the [Phase 4 design](ownership-and-multi-network.md). Candidate syntax in that design is not part of this current reference until implemented and tested.
