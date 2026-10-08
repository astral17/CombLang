# Arithmetic

[Documentation](../README.md) · [Network](network.md) · [Combinator](combinator.md) · [Decider](decider.md)

Compute circuit counts with one ArithmeticCombinator per operation. Ordinary
source operators infer an output; the exact constructor specifies every field.

## Signatures

Source forms, not an importable TypeScript library declaration:

```text
left OP right -> ArithmeticCombinator
Arithmetic({ left, operation, right, output }) -> ArithmeticCombinator
```

| Operator | Exact operation |
| -------- | --------------- |
| `+`      | `add`           |
| `-`      | `subtract`      |
| `*`      | `multiply`      |
| `/`      | `divide`        |
| `%`      | `modulo`        |
| `**`     | `power`         |
| `<<`     | `left-shift`    |
| `>>`     | `right-shift`   |
| `&`      | `bit-and`       |
| `\|`     | `bit-or`        |
| `^`      | `bit-xor`       |

This table concerns circuit operands. When both operands are ordinary JavaScript
values, normal JavaScript evaluation applies and creates no hardware.
In particular, `count * Signal` is a [constant row](constant.md#cc-rows), not an
Arithmetic device.

## Parameters and outputs

Exact `Arithmetic` requires all four keys, with no defaults or extra keys:

| Field           | Accepted source value                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `left`, `right` | Finite safe-integer number, concrete Network selection, readable Network/Combinator/pair, or `Each(source)`. |
| `operation`     | One canonical operation name from the table, not the operator character.                                     |
| `output`        | A current-source Signal handle, or `Each` / `EACH`.                                                          |

A bare readable Network, Combinator or pair operand means Each. `Any`/`Anything`
and `All`/`Everything` are not Arithmetic operands. Concrete selections and Each
participate in the existing wildcard compatibility checks; they are not arbitrary
JavaScript numeric values. Safe-integer constants are normalized to signed int32.

For an operator expression, output defaults to the first concrete input Signal
from left to right, or Each when there is none. Bind a compatible output explicitly
at its destination with `output[B] += expression` or `expression.to(output, B)`.
Exact `output` chooses that configuration directly. There is no `.as(...)` method.

## Hardware and methods

Each executed circuit operation creates one physical device, even when written
inside a larger expression. Parentheses and operator grouping determine the stages;
each stage adds one tick. Pure numeric subexpressions create no additional devices.
Keep one handle to reuse a device rather than repeating the expression.

The result supports [Combinator](combinator.md) `.at(...)`, `.to(...)` and two output
lanes. Reading its primary Network does not consume its owner; input wire colors
still must fit one input connector. A `Network` annotation exposes only the primary
Network facet, not a second output or physical methods.

Ordinary operators work without prototype profiles. Exact `Arithmetic` requires
trusted canonical `entity:arithmetic-combinator` authority from the configured
[prototype environment](../prototype-environment.md). When that base authority
is available, ergonomic arithmetic also gets a linked physical Entity. A generic
Entity or same-type modded prototype alone does not establish the exact contract.

## Operator pipeline example

Complete source; no imports or prototype prerequisites:

```ts
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const input = new Network();
const output = new Network();
input += CC(5 * A);
const doubled = input[A] * 2;
output[B] += doubled[A] + 3;
```

One Constant and two Arithmetic stages. `doubled` infers A: it is 0 at T1 and
10 at T2. The final destination binds B: it carries 3 at T1/T2 while the upstream
stage warms up, then 13 at T3. T0 is empty; pipeline delays are not compile-time
execution delays.

## Exact scalar example

Complete source; requires trusted canonical `entity:arithmetic-combinator`
authority. The embedding test host supplies it; configure the real prototype
environment before using this example in a workbench.

```ts
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const input = new Network();
const output = new Network();
input += CC(5 * A);
const multiplied: ArithmeticCombinator = Arithmetic({
  left: input[A],
  operation: 'multiply',
  right: 2,
  output: B,
});
output += multiplied;
```

Two devices; output B is 0 at T1 and 10 at T2. The exact constructor adds no
extra adapter or tick compared with the equivalent bound operator expression.

## Exact Each example

Same trusted Arithmetic prerequisite; complete independent source:

```ts
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const input = new Network();
const output = new Network();
input += CC(5 * A, 2 * B);
output += Arithmetic({ left: Each(input), operation: 'multiply', right: 2, output: EACH });
```

Two devices; at T2 output carries A = 10 and B = 4. Each retains Signal identities
rather than collapsing the bus into one number.

## Restrictions

Exact configuration is a semantic plain data record, not raw Blueprint JSON.
Missing/unknown fields, invalid operations and unsupported quantifiers fail with
source-aware diagnostics. Output binding must remain compatible with the input
wildcard shape; placement does not validate native wire reach or collisions.

Exact constant operands also accept number parameters, and exact `output` accepts
a Signal parameter. These are direct fields, not ordinary operators such as
`input + amount`; see [Param's supported fields](parameters.md#supported-fields).
Concrete binding and opt-in numeric native-template export are different modes.
These examples
verify the implemented compiler/simulator model, not native Factorio conformance.

See also [Constant](constant.md), [Signal](signal.md),
[detailed arithmetic reference](../language-reference.md#arithmetic-combinators)
and [Testbench](../testbench.md#executable-files).
