# Circuit basics

[Documentation](README.md) · [Getting started](getting-started.md) · [Language reference](language-reference.md)

Every TypeScript block on this page is a complete, independent program. Paste
one block at a time into Source. These examples need no custom prototype data.

## Signals are names; Networks carry values

`Signal` identifies a signal, not its current count. `Network` is a logical
circuit-wire network, not one number. The same Network can carry many Signals.
An absent Signal reads as zero. A quality is part of the Signal identity.

```ts
const A = Signal('virtual', 'signal-A');
const IRON = Signal('iron-plate');
const RARE_IRON = Signal('item', 'iron-plate', 'rare');
const input = new Network();
input += CC(5 * A, 20 * IRON, 2 * RARE_IRON);
```

`Signal(name)` means an **item**, not automatic namespace inference. Use
`Signal('virtual', 'signal-A')` for virtual signals. `CC(...)` creates one
Constant combinator; here it emits three distinct signal counts.

## Arithmetic creates hardware

```ts
const A = Signal('virtual', 'signal-A');
const input = CC(5 * A);
const output = new Network();
output[A] += input[A] * 2 + 1;
```

This creates three combinators: one Constant, a multiplication and an addition.
`input[A]` selects just A; `output[A]` explicitly names the result Signal.
`+=` connects the produced output to the destination; it is not a simulation
assignment to the current count of A.

The compiler runs source to **build a circuit**. It does not evaluate future
signal values while building it. The simulator then advances that circuit by
ticks. All Networks start empty at T0; the Constant publishes 5 at T1, the
multiplier publishes 10 at T2 and `output[A]` reaches 11 at T3.

Ordinary JavaScript arithmetic still happens immediately: replacing `* 2 + 1`
with `* (2 + 3)` builds only one arithmetic stage, with constant 5. Parentheses
and circuit operation order are preserved; they are not algebraically optimized
to remove tick delays. Counts use Factorio signed 32-bit arithmetic.

## Conditions configure a Decider

```ts
const A = Signal('virtual', 'signal-A');
const input = CC(5 * A);
const output = new Network();
output += when(input[A] > 3).then(input[A]);
```

This builds one Constant and one Decider. The Decider copies A when its count
is greater than 3, otherwise emits nothing. `IF(condition, thenOutput)` is the
compact spelling. Conditions containing circuit operands describe checks made
by hardware on each tick; they are not JavaScript decisions during elaboration.

For all signals independently, use a bare Network (`input * 2`) or the explicit
`Each(input)` selection. Quantifiers `Any(input)` / `All(input)` have different
Decider semantics: they are not interchangeable with `Each`.
See [Network selections](language-reference.md#network-selections) for legal
wildcard/output combinations.

## Keep the Combinator when you need both output colors

```ts
const A = Signal('virtual', 'signal-A');
const input = CC(5 * A);
const scaled = input[A] * 2;
const output = new Network<R>();
const mirror = new Network<G>();
to(output, mirror) += scaled;
```

There is one multiplier, not two. Its red and green output Networks carry the
same result. `to(...)` binds both outputs. In ordinary reads, a Combinator acts
through its primary output Network.

| Value                               | Meaning                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `const scaled = input * 2`          | Keep the ArithmeticCombinator, including physical methods and output connections. |
| `const scaled: Network = input * 2` | Expose only its primary Network; no extra hardware is created.                    |
| `input[A]`                          | Read one Signal on the Network; it does not create a combinator.                  |

An unspecified color is solved from topology. `<R>` and `<G>` are hard
requirements. Two distinct Networks on one connector must have opposite
colors; a third independent Network cannot fit there. Input and output
connectors of an arithmetic/Decider combinator are separate.

`output += input` is not a wire-union operation and is rejected. Use
`output.take(input)` for a zero-tick union when ownership permits it; the old
input owner becomes unusable. See [ownership](ownership-and-multi-network.md)
before using this inside reusable functions.

## Functions generate reusable subcircuits

```ts
const A = Signal('virtual', 'signal-A');

function Scale(input: Readonly<Network>): Network {
  return input * 2 + 1;
}

const input = CC(5 * A);
const output = Scale(input);
```

`Readonly<Network>` lets the function read the input without consuming it. The
returned `Network` exposes the final arithmetic stage's primary output, not
the Combinator's physical methods or second output. Functions run during
elaboration; calling them twice constructs two subcircuits.

Untyped parameters are allowed too. Use explicit capabilities when you want
restrictions checked: [function reference](language-reference.md#functions).

## Loops generate repeated hardware, not tick-by-tick execution

```ts
const A = Signal('virtual', 'signal-A');
const input = CC(5 * A);
const output = new Network();

for (let i = 1; i <= 3; i++) {
  output += input[A] * i;
}
```

The loop runs once when the source is compiled. It builds three multipliers
whose outputs sum on `output`: A becomes 30 at T2. It does not run one loop
iteration per tick. Arrays and objects can hold circuit handles; ordinary
JavaScript decides which handle a later operation receives.

## When something goes wrong

Start with the diagnostic's source location. Common causes are using a plain
number or Network as a connection source, reusing a consumed owner, asking for
a third output lane, or forcing incompatible wire colors. A `CL2001` warning
means a created Combinator output was never read or connected; it is not a
fatal error and does not remove that physical combinator.

Use [tests](testbench.md#executable-files) to check counts and delays rather than
infer them from the generated JavaScript. For exact configuration syntax, go
to the [language reference](language-reference.md). For entity capabilities,
read its [Entity section](language-reference.md#provider--and-host-bound-entities)
before assuming an arbitrary machine behaves like a combinator.
