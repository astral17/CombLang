# Decider

[Documentation](../README.md) · [Network](network.md) · [Combinator](combinator.md) · [Arithmetic](arithmetic.md)

Choose circuit output rows on every tick using one DeciderCombinator, not a
source-time JavaScript `if`.

## Signatures

```text
IF(condition, thenOutput, elseOutput?) -> DeciderCombinator
when(condition) -> DeciderCombinator
gate.then(output, ...) -> the same DeciderCombinator
gate.else(output, ...) -> the same DeciderCombinator
Decider({ condition, outputs?, elseOutputs? }) -> DeciderCombinator
```

`IF` takes a true branch and optional false branch. `when` creates the device
immediately; `.then` and `.else` append to their branch, returning the same handle.
Aliases see the same mutations. Neither call replaces earlier rows nor creates
another device. A false-only `when(condition).else(...)` is valid; a `when` left
without either branch is not.

## Conditions and outputs

Conditions accept comparisons `>`, `<`, `>=`, `<=`, `==`, `!=` (also strict
equality spellings), signal-to-signal/constant comparisons, `&&`, `||`, parentheses
and `!`. Safe-integer constants normalize to signed int32. Boolean normalization
does not add devices. A circuit Condition configures hardware; using it as a
JavaScript loop/if/ternary test is an error, not a runtime branch on signal counts.

| Output specification              | Effect                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `input[A]`                        | Copy count to concrete Signal A.                                               |
| `2 * A`                           | Emit constant count 2 to A when that branch applies; no multiplication device. |
| `input` or `Each(input)`          | Each output in supported condition contexts.                                   |
| `2 * EACH`                        | Constant count per active Each candidate.                                      |
| `Any(input)` / `All(input)`       | Anything/Everything output, subject to condition compatibility.                |
| Nested arrays or ordinary objects | Flatten values in iteration order; keys are not output Signals.                |

Both branches keep ordered rows, including duplicates; repeated concrete Signal
rows contribute additively. All condition and copy-output sources must fit the
same two-color input connector. A count row is a finite safe integer, normalized
to signed int32; a bare number or Signal handle is not an output row.

Bare Network conditions mean Each. With Each, a concrete copy output redirects
each candidate's count into that Signal, rather than reading that selected Signal
once. Anything/Everything on the left exclude the concrete right-operand Signal
from their candidate set; Each does not. Quantifier output combinations are
restricted: for example Anything/Everything conditions cannot emit Each, and
Anything/Everything cannot have a constant-count wildcard row. See the
[selection compatibility reference](../language-reference.md#network-selections).

## Exact configuration and hardware

Exact `Decider` requires `condition` to be a circuit Condition. Source Boolean
conditions such as `true` are currently unsupported. `outputs` and `elseOutputs`
can be omitted, `undefined` or empty, but at least one row must exist overall.
An empty false branch is omitted from the canonical configuration. Rows use the
same source output vocabulary above, not raw Blueprint `conditions`/`outputs` JSON.

`IF` and `when` work without prototypes. Exact `Decider` requires trusted canonical
`entity:decider-combinator` authority in the
[prototype environment](../prototype-environment.md). With that authority,
ergonomic and exact forms share the linked physical Entity representation.

Every device adds one tick to its inputs. The same primary/secondary output
results, placement and attachment methods are described under
[Combinator](combinator.md). Reading a source does not consume its owner.
Destination Signal binding is limited to compatible single-row branches; later
mutations are checked against the already-bound Signal and input color capacity.

## Compact example

Complete source, profile-free:

```ts
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const C = Signal('virtual', 'signal-C');
const input = new Network();
const output = new Network();
input += CC(6 * A, -2 * B);
output += IF(input[A] > 5 && input[B] < 0, [input[A], 1 * C], { fallback: 7 * C });
```

Two devices. At T1 the input seen by the Decider is still empty, so C = 7;
at T2 its true branch emits A = 6 and C = 1. T0 is empty.

## Fluent mutation example

Complete source, profile-free:

```ts
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const input = new Network();
const output = new Network();
input += CC(6 * A);
const gate = when(input[A] > 3);
const alias = gate;
const appended = alias.then(input[A]).then(1 * B);
appended.else(9 * B);
output += gate;
```

Two devices, not one per method call. At T1 B = 9; at T2 A = 6 and B = 1.
`gate`, `alias` and `appended` refer to one physical Decider. Repeating a branch
call appends rows; calling it without any output specification is invalid.
After attachment, inspect `output` in tests: the old primary Network aliases can
be marked moved when merged into that destination. This does not clone or replace
the physical Decider handle used for mutation.

## Exact example

Complete source; requires trusted canonical `entity:decider-combinator` authority:

```ts
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const C = Signal('virtual', 'signal-C');
const input = new Network();
const output = new Network();
input += CC(6 * A, -2 * B);
output += Decider({
  condition: input[A] > 10,
  outputs: [input[A], 2 * C],
  elseOutputs: [input[B], 3 * C],
});
```

Two devices. The condition stays false: at T2 output B = -2 and C = 3, with A = 0.
The concrete copy and constant rows remain separate ordered output entries.

## Each redirection example

Complete source, profile-free; implemented per-candidate model, not a reduce helper:

```ts
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const C = Signal('virtual', 'signal-C');
const D = Signal('virtual', 'signal-D');
const input = new Network();
const output = new Network();
input += CC(10 * B, 20 * C, -5 * D);
output += when(input != 0).then(input[A], 1 * A);
```

Two devices. Three non-zero candidates emit 10 + 20 - 5 plus three constant
contributions, yielding A = 28 at T2. No new reduce or advisory syntax is implied.

## Restrictions

Missing branches, incompatible wildcard outputs, invalid counts, too many input
colors and a multi-row branch after destination Signal binding are errors.
Exact records reject extra fields, accessors, symbols, cyclic/sparse containers
and unsupported leaves before creating a device. Exact Boolean Conditions and
new Each/reduce helpers are not available.

Source parameter capture and host-only native export have a narrower supported
subset than concrete conditions; see
[Blueprint parameters](../native-objects-deciders-and-parameters.md#blueprint-parameter-values).
Do not infer Worker/copy metadata or native conformance from these model examples.
Related: [Constant rows](constant.md#cc-rows), [Signal](signal.md),
[detailed Decider reference](../language-reference.md#decider-combinators) and
[Testbench](../testbench.md#executable-files).
