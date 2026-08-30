# Current language reference

This document describes the syntax implemented in the current Phase 3 compiler slice. It is intentionally narrower than the target language in the architecture analysis.

Phase 3 elaborates one self-contained source file synchronously. Static or dynamic imports, exports, `import.meta`, and top-level `await` report `CL1036` before execution. An `async` function declaration is syntactically accepted, but the current elaborator does not await Promises and therefore does not support asynchronous circuit generation. Multi-file linking belongs to a later compiler phase. This boundary is separate from the fully hardened sandbox deferred to Phase 11.

## Signals

One argument creates the same default item Signal used by a name-only Network selection. Two or three arguments provide an explicit Factorio namespace and optional quality:

```ts
const CHEST = Signal('chest');
const A = Signal('virtual', 'signal-A');
const IRON = Signal('item', 'iron-plate');
const QUALITY_A = Signal('virtual', 'signal-A', 'legendary');
```

`Signal("chest")` normalizes internally to `{ type: "item", name: "chest" }`. Factorio blueprint JSON omits the default item `type`, so the exported field contains only `name`. The optional third string carries Factorio quality. Literal non-string arguments are rejected by the semantic checker; dynamic arguments are accepted until elaboration and then validated from their executed values.

## Networks and colors

```ts
const automatic = new Network();
const red = new Network<R>();
const green = new Network<G>();
```

`R` and `G` are hard wire-color requirements. Networks without a fixed color are assigned deterministically by the topology solver. Two distinct logical Networks used on the same physical connector must receive opposite colors; three distinct Networks on one connector are invalid.

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

## Arithmetic producers

```ts
const doubled: Network = input * 2;
const sum: Network = left + right;
out += input * 2 + 1;
out[RESULT] += left[A] + right[B];
```

Supported operators are addition, subtraction, multiplication, division, modulo, power, shifts, and bitwise AND/OR/XOR. Parentheses and left-associative grouping are preserved. Each circuit operation creates one arithmetic combinator; compile-time-only integer subexpressions are folded.

The transformed module dispatches operators from their executed values. When neither operand is a circuit DSL value, JavaScript coercion, loose/strict equality, relational comparison, and lazy `&&`/`||` short-circuit behavior are preserved. When operands are Networks, selections, producers, or circuit Conditions, the same syntax records physical arithmetic or native decider condition groups.

Without an explicit destination signal, arithmetic uses the first concrete input signal from left to right when one exists, otherwise native `Each` output.

`expression.as(SIGNAL)` explicitly binds the output Signal of the same arithmetic or compact-decider producer. It does not allocate another combinator or tick. A destination such as `out[SIGNAL]` may repeat the same constraint, but conflicting Signal identities are rejected.

`.as(...)` belongs to the producer expression, not to the resulting `Network`. A function declared to return `Network` therefore has to apply `.as(...)` inside its body. Calling `Gate(...).as(SIGNAL)` across that return boundary is `CL1043` (or `RT2021` when the boundary is only known during execution); assigning the result to a local Network cannot change this rule.

## Decider producers

Compact and fluent spellings share the same one-decider lowering:

```ts
const copied: Network = IF(input > 0, input);
const selected: Network = IF(input[A] > 0, input[A]);
const fluent: Network = when(input[A] > 0).then(input[A]);
```

`when(...).then(...)` accepts multiple native output specifications while still creating exactly one decider:

```ts
when(a > 0).then(a, 2 * SIGNAL_A, b);
```

Here bare Networks mean `Each(network)` in output context. The compiler validates all output filters and the combined input-connector color capacity as one physical device.

Output entries remain ordered and are not deduplicated. Two entries targeting the same SignalID intentionally sum on the output Network, matching native Factorio behavior.

Conditions support signed int32 constants on either side, explicit signal-to-signal comparisons, `&&`, `||`, parentheses, and `!`. Boolean normalization does not allocate extra combinators.

Constant-count Each output is a decider output specification, not multiplication hardware:

```ts
const colors: Network = IF(input > 0, 0x00ff00 * EACH);
```

The decider emits the constant for every active `Each` candidate. The count must fit signed int32.

An ergonomic `.else(...)` branch and the exact `Decider({...})` constructor are not implemented yet.

## Constant combinator

```ts
const constants: Network = CC(5 * A, -2 * B);
out += CC(5 * A);
to(first, second) += CC(5 * A, -2 * B);
```

Each argument is an int32 literal multiplied by a declared Signal value. A Signal may occur only once in one `CC` call.

## Materialization and attachment

A typed declaration contextually materializes a producer:

```ts
const out: Network = a + b;
const gated: Network = IF(out[A] > 0, out[A]);
```

The annotation is optional when the initializer actually produces hardware at execution time:

```ts
const input = CC(5 * A);
const gated = IF(input[A] > 0, input[A]);
const scaled = gated * 2 + 1;
```

An explicit combinator-handle annotation suppresses that automatic Network materialization when the producer must be configured or attached later:

```ts
let comb: DeciderCombinator = when(input > 0).then(input);
output += comb.as(RESULT).at(10, 4);
```

`Producer` is the common handle type. The more precise public types are `DeciderCombinator`, `ArithmeticCombinator`, and `ConstantCombinator`; use the precise type when it is known. Declarations, later writes to supported typed slots, function parameters, and function returns check both that the executed value is still an unmaterialized producer and that its physical combinator kind matches the annotation. Passing a handle through a typed parameter preserves its physical identity. A function may return one of these types to preserve the producer handle across its return boundary. Returning `Network` instead intentionally hides producer-only methods. Producer handles represent one physical entity and remain single-attachment values: storing one does not clone it, fluent `.as(...)`/`.at(...)` wrappers retain the same physical identity, and attaching any alias twice is `RT2006`.

Producers may pass through dynamically indexed arrays and ordinary objects. Assignment itself is not treated as a discarded producer expression because later use cannot be decided there. After the executed module finishes, the runtime checks every created physical producer identity: a value later returned or attached has no warning, while a producer still abandoned in a container receives `CL2001` and an internal unused sink so its topology is still validated. `CL1044` reports a statically definite annotation mismatch at a declaration, assignment, argument, or `return`; dynamically determined mismatches use `RT2022` at the executed type boundary.

Flat array and object destructuring may validate handles individually without materializing them:

```ts
const handles = [arithmetic, gate];
let [a, d]: [ArithmeticCombinator, DeciderCombinator] = handles;

const record = { producer: d, label: 'gate' };
let { producer }: { producer: DeciderCombinator } = record;
```

These annotations validate the executed slot values and retain their original physical identities. Destructuring one bare producer into several producer handles is rejected because that spelling would imply cloning; put independently created handles in an ordinary container first. Network producer-destructuring remains the distinct output-fan-out operation described below.

A direct handle variable, a concrete producer array, or a flat inline typed object property also validates every later assignment:

```ts
let arithmetic: ArithmeticCombinator;
arithmetic = input + 0;

let gates: DeciderCombinator[] = [];
gates[0] = when(input > 0).then(input);

let table: { seed: ConstantCombinator } = {};
table.seed = CC(1 * A);
```

A definitely wrong kind is `CL1044`. If the right side comes from a dynamic call or container read, the semantic checker does not guess; the executed assignment validates it and reports `RT2022` on that expression when necessary. Lexical shadowing is respected. This slice recognizes direct annotations, `ProducerType[]`/`Array<ProducerType>`, and flat inline object property annotations; general named TypeScript type resolution remains later language-service work.

The elaboration runtime materializes those producer values under their declaration names. It leaves ordinary numbers, strings, arrays, objects, Signals, and existing Networks unchanged. Likewise, `value[SIGNAL]` is dispatched from the executed receiver, so a Network returned by an ordinary JavaScript function can be selected without repeating `: Network` on the receiving variable. A `Network[]` element read is classified from the value obtained at execution, so `output += networks[i] * 2` works inside compile-time loops. A heterogeneous or otherwise unknown collection is not rejected statically: execution succeeds for Network elements and reports an attachment error if it reaches a non-Network element. Ordinary JavaScript element reads remain reads. For `+=`, identifiers, properties, and array/object elements are classified from their executed value: a Network destination attaches a producer, while non-DSL values retain native JavaScript addition and assignment. A member receiver and computed key are each evaluated exactly once. Other element assignments and updates remain native JavaScript operations.

Existing Networks use `+=`:

```ts
out += a + b;
out += IF(a > 0, a);
```

One producer can attach to two distinct Networks:

```ts
to(first, second) += a + b;
to(first, second)[RESULT] += left[A] + right[B];
(left + right).to(first[RESULT]);
(left + right).to(first, second, RESULT);
```

A free destination set binds its output Signal as `to(first, second)[SIGNAL]`. The fluent producer form instead uses `.to(first, second, SIGNAL)`, because an element selection after `.to(...)` would occur after that method has already attached the producer. `.to(first[SIGNAL], second[SIGNAL])` remains invalid. The output binding adds no combinator. Two destinations share one physical output connector and therefore receive opposite wire colors. The right side of `Network += value` must be a combinator producer. Constants and `Network += Network` are deliberately rejected rather than invoking JavaScript object coercion.

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

This first transfer slice freezes the consuming-transfer spelling and runtime moved state. Function capabilities and both-colors input views are described below. General local ownership-copy rules and explicit moves into and out of container slots remain planned Phase 4 work.

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

Output fan-out remains a separate operation: use `producer.to(first, second)`, `to(first, second) += producer`, or contextual tuple/object destructuring. A pair is only an input-side view.

Array or flat object destructuring provides the contextual fan-out form for a newly created producer:

```ts
let [a, b]: [Network, Network] = input + 0;
let [green, inferred]: [Network<G>, Network] = input + 1;
let [left, right] = input + 2;
let { primary, mirror }: { primary: Network<R>; mirror: Network } = input + 3;
```

One physical producer is attached to the two declared Networks, so they must resolve to opposite wire colors. Tuple/object type entries apply independently; omitted annotations are inferred from the executed producer value. The same syntax used with an ordinary JavaScript array or object retains normal destructuring behavior. Producer destructuring is currently flat and limited to one or two Network bindings.

Standalone arithmetic, `IF`, and `when(...).then(...)` expressions produce warning `CL2001`. They are still lowered into an internal unused sink so their input topology and color constraints remain validated.

## Explicit preview placement

`.at(x, y, direction?)` records an exact Factorio blueprint position on a combinator producer:

```ts
const placed = (input + 1).at(10.5, -2, 8);
output += IF(input > 0, input).at(12.5, -2);
```

Apply `.at(...)` before `.to(...)` or `+=` attaches the producer. Coordinates must be finite numbers. Direction may be a numeric compile-time constant or a TypeScript enum member and must resolve to an integer from `0` through `15`; omitted direction currently defaults to `4`. Unplaced producers use the deterministic preview row. Physical collision, reach, and relay validation are not part of the Phase 3 preview.

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

Ownership is affine rather than mandatory-use: a function may consume or drop a `Move` parameter without returning it. The old caller views do not become valid again; trying to use dropped ownership reports `RT2019`. A function also cannot return a caller-owned Network that it never accepted through `Move`; that would be an implicit steal and reports `RT2019`. A bare `Network` parameter is deliberately invalid (`CL1041`) because it would not state whether the call borrows or consumes the value. Use `Readonly<Network>`, `Ref<Network>`, or `Move<Network>` explicitly.

Complete local alias-copy rules and explicit move/replace operations for container slots remain Phase 4 work. Passing `array[i]` to `Move` is already checked dynamically and invalidates that old slot, but there is not yet dedicated syntax that replaces the slot with a returned owner in one operation.

A structural function may instead declare local Networks, attach producers to them, and return one of those Networks. Each call receives independent local Networks:

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

Returning a producer lets the caller materialize or attach it contextually. Returning an independently owned local Network returns that runtime handle; other local Networks remain private unless returned or otherwise attached. A borrowed parameter cannot be promoted to an owned return. A function that returns an ordinary value remains an ordinary JavaScript function, and an error is reported only if the executed value is later used in an operation that requires a Network, Signal, Condition, or Producer.

Each function declaration call receives an independent provenance scope, so generated Networks, producers, and attachments retain the dynamic function path. Async syntax may be parsed inside a function, but Promise-based circuit elaboration is not supported by the current synchronous executor. Imports and multi-module elaboration are not implemented yet.

## Executed compile-time control flow

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

`for…of`, `for…in`, `while`, and `do…while` use that same runtime path. Their bodies are instrumented for provenance rather than statically interpreted, so arrays and object configuration can control generated hardware. Entering or iterating a loop does not consume the numeric DSL-call limit.

Loop-local contextual Networks and following arithmetic are also executed per iteration:

```ts
for (let i = 0; i < 10; i++) {
  let tmp: Network = IF(input < i, 1 * A);
  output += tmp * 2;
}
```

This creates ten private `tmp` Networks, ten deciders, and ten arithmetic combinators. Repeated source names receive stable dynamic instance identities instead of aliasing different iterations.

Browser compilation reuses one Web Worker across revisions and keeps only the newest queued edit while it is busy. An execution exceeding the current 1000 ms budget terminates and replaces that Worker and reports `EX1002`, so an infinite compile-time loop cannot freeze the interface. This timeout is an availability boundary, not yet the complete untrusted-code sandbox described by the project architecture.

Execution also has a default safety limit of 100,000 circuit-recording DSL calls. Compile-time numeric arithmetic, numeric comparisons, function entry, and loop iteration are not charged. Calls that create or inspect circuit-language values are charged; the limit is still not a Factorio combinator or simulator-tick cap. Exceeding it reports `EX1003`. Function calls and loop bodies contribute instance paths such as `function Scale`, `for i=7`, and `while #2` to every Network, producer, and attachment created inside their dynamic scope.

The current language does not require generation to be reproducible. Code may deliberately use ambient values such as time or randomness; naturally, the resulting blueprint can then differ between compilations. A future reproducible-build mode may restrict or inject those inputs, but full sandbox hardening is currently a low-priority task. The step and wall-clock limits remain because they protect editor availability rather than enforcing determinism.

## Current diagnostic groups

- `CL1xxx` — source lowering and semantic errors
- `CL2001` — non-fatal unused-producer warning
- `EX1xxx` — transformed JavaScript execution errors and availability limits
- `RT1xxx` — direct-plan descriptor/schema failures
- `RT2xxx` — runtime ownership, topology, and color failures

Diagnostics use half-open source spans. A color conflict includes related Network declarations when available.

See the [diagnostics catalog](diagnostics.md) for common codes and corrective actions.

## Not implemented yet

- blueprint import/export and FCIR
- ownership types and operations such as `Ref`, `Move`, a possible consuming `take`, and read-only `pair`
- exact `Arithmetic`, `Decider`, `Selector`, and entity constructors
- multi-file module linking and asynchronous top-level elaboration
- testbench syntax, mocks, expectations, and waveform assertions
- general language service and schematic editor

The planned ownership and `pair` semantics are tracked separately in the [Phase 4 design](ownership-and-multi-network.md); candidate syntax there is not part of this current reference until implemented and tested.
