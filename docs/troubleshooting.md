# Troubleshooting

[Documentation](README.md) · [Language reference](language-reference.md) · [Diagnostic codes](diagnostics.md)

Start with the first error and its source location. Later diagnostics can be
consequences of the same problem. An error prevents successful compilation; a
warning does not. Related source locations can point to an earlier attachment,
move, borrow or color requirement that caused the conflict.

The examples below are independent programs. Each **Rejected** block deliberately
fails. The following block shows a possible resolution, not necessarily an
equivalent circuit: choose it only when its stated intent matches yours. The
final warning example is valid as written and does not require a change. The
shown codes describe these exact examples; uncertain dynamic types can instead
be rejected when the operation executes.

| Symptom                            | Read                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| Attaching a number fails           | [Connection sources](#a-number-is-not-a-connection-source)                        |
| A third output fails               | [Output capacity](#one-combinator-cannot-drive-three-independent-output-networks) |
| A union of red and green fails     | [Fixed colors](#a-network-union-cannot-keep-contradictory-fixed-colors)           |
| An alias stops working after take  | [Consumed owners](#take-consumes-the-source-and-its-aliases)                      |
| Returning a borrowed input fails   | [Borrowed returns](#a-readonly-borrow-cannot-be-returned-as-an-owned-network)     |
| A combinator reports unused output | [Warnings](#unused-output-is-a-warning-not-removed-hardware)                      |

## A number is not a connection source

**Rejected — `CL1034`:**

```ts
const output = new Network();
output += 5;
```

`+=` connects a physical Combinator's output; it does not assign a simulated
number. A count must belong to a Signal. If you intended to generate a constant
count, choose the Signal explicitly and use a Constant:

**Generate 5 on signal A:**

```ts
const A = Signal('virtual', 'signal-A');
const output = new Network();
output += CC(5 * A);
```

This creates one Constant and emits A = 5 from T1. Similarly, attaching a plain
Network with `output += input` is not a wire union. Use `output.take(input)`
for an ownership-consuming zero-tick union, or `output += input + 0` for a
one-tick arithmetic stage. These operations have different physical effects.

## One combinator cannot drive three independent output Networks

**Rejected — `RT2028`:**

```ts
const A = Signal('virtual', 'signal-A');
const input = CC(5 * A);
const comb = input[A] * 2;
const first = new Network<R>();
const second = new Network<G>();
const third = new Network();
first += comb;
second += comb;
third += comb;
```

A physical output has red and green wire colors, not an unlimited number of
independent logical Networks. Aliases do not increase that capacity. If several
consumers should share one electrical network, use the same Network rather than
create a distinct Network per consumer. If a third independent output is truly
needed, explicitly construct additional hardware:

**If three independent outputs are required — additional hardware:**

```ts
const A = Signal('virtual', 'signal-A');
const input = CC(5 * A);
const comb = input[A] * 2;
const first = new Network<R>();
const second = new Network<G>();
const third = new Network();
to(first, second) += comb;
third += input[A] * 2;
```

This has one Constant and two parallel multipliers. All three destination
Networks carry A = 10 at T2. Repeating the multiplication is intentional here;
it is not another attachment of the same device.

## A Network union cannot keep contradictory fixed colors

**Rejected — `RT2014`:**

```ts
const red = new Network<R>();
const green = new Network<G>();
red.take(green);
```

`take` makes both logical Networks one surviving Network. That result cannot
simultaneously satisfy hard red and green requirements. If one side did not
need a fixed color, leave its color to the solver:

**Only if the second Network does not require green:**

```ts
const red = new Network<R>();
const automatic = new Network();
red.take(automatic);
```

Do not remove a fixed requirement just to silence an error if your circuit
actually needs separate red and green wires. Keep separate Networks instead;
[pair](language-reference.md#both-colors-input-views) can read both without
turning them into a writable union.

## take consumes the source and its aliases

**Rejected — `RT2012`:**

```ts
const A = Signal('virtual', 'signal-A');
const source = new Network();
const destination = new Network();
source += CC(5 * A);
const oldAlias = source;
destination.take(source);
const output = new Network();
output += oldAlias[A] + 0;
```

`destination` is the surviving owner. `source` and `oldAlias` refer to the
consumed owner; saving an alias before the transfer does not preserve access.
Read the surviving Network:

**Corrected:**

```ts
const A = Signal('virtual', 'signal-A');
const source = new Network();
const destination = new Network();
source += CC(5 * A);
destination.take(source);
const output = new Network();
output += destination[A] + 0;
```

The union adds no hardware or tick. The explicit arithmetic stage does: output
A becomes 5 at T2. Read [Network ownership](ownership-and-multi-network.md)
before reusing transferred handles in arrays, closures or function calls.

## A readonly borrow cannot be returned as an owned Network

**Rejected — `CL1040`:**

```ts
function Alias(input: Readonly<Network>): Network {
  return input;
}
const input = new Network();
const output = Alias(input);
```

For an alias function that returns its input for reading, preserve readonly
access in the return annotation:

**Corrected — readonly alias, no new hardware or tick:**

```ts
function Alias(input: Readonly<Network>): Readonly<Network> {
  return input;
}
const input = new Network();
const output = Alias(input);
```

The corrected program has one logical Network and zero devices. `output` is a
fresh readonly view of the same Network, not an owned return, a copy or a delay.
The call-scoped parameter borrow ends normally; the original owner `input` may
still receive producer attachments afterward. Reads through `output` see that
same Network. Writing or consuming through `output` remains forbidden; moving
or consuming `input` invalidates old aliases, including `output`.

This exception requires a single explicitly annotated readonly return and live
ownership outside the returning function. Ref parameters, borrowed selections,
unannotated/array/object returns and closures retaining expired parameters do
not gain escape permission. Returning `input + 0` instead would add an Arithmetic
stage and a tick; it does not preserve an alias function's intent.

Changing the parameter to a writable shared reference or transferring ownership
with `Move<Network>` also changes the access contract. Do not apply either just
to silence this diagnostic. See the
[function reference](language-reference.md#functions) for the capability and
return lifetime rules.

## Unused output is a warning, not removed hardware

**Valid with warning — `CL2001`:**

```ts
const A = Signal('virtual', 'signal-A');
CC(5 * A);
```

The Constant was created, but its output was not read or connected by the source.
The device remains in the circuit; the warning does not optimize it away.
Connect it when that is what you intended:

**Connected:**

```ts
const A = Signal('virtual', 'signal-A');
const output = new Network();
output += CC(5 * A);
```

Both programs create one Constant. Only the second has an explicit destination
called `output`. Naming a Combinator or narrowing it to Network alone does not
necessarily count as using the output.

## Unexpected counts or timing without an error

Compilation checks the construction of the circuit, not your intended signal
values. In the browser, start from T0 and advance one tick at a time. Check the
selected Network and Signal quality; omitted signals read as zero. Remember
that loops generate hardware during compilation, not one iteration per tick.

Use [testbench assertions](testbench.md#executable-files) to pin the expected
tick and count. A passing simulator test describes the implemented model; it
does not independently establish native Factorio behavior for every device.
