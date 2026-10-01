# Network

[Documentation](../README.md) · [Circuit basics](../circuit-basics.md) · [Language reference](../language-reference.md#networks-and-colors)

A logical circuit-wire network carrying Signal counts. It is not one number
and does not itself create a combinator. Its color is required explicitly or
chosen by the topology solver.

## Construction

```ts
const automatic = new Network();
const red = new Network<R>();
const green = new Network<G>();
```

| Form                            | Effect                                                              |
| ------------------------------- | ------------------------------------------------------------------- |
| `new Network()`                 | Create an empty Network with solver-selected color.                 |
| `new Network<R>()`              | Require red wire color.                                             |
| `new Network<G>()`              | Require green wire color.                                           |
| `const n: Network = combinator` | Expose that Combinator's primary Network; create no extra hardware. |

Color is a hard constraint. Two distinct Networks on one connector must have
opposite colors; three do not fit. Separate input and output connectors can
reuse the same colors.

## Signal selection

| Expression                         | Meaning                                                             |
| ---------------------------------- | ------------------------------------------------------------------- |
| `network[A]`                       | Select concrete Signal handle A.                                    |
| `network['iron-plate']`            | Select an item Signal by name.                                      |
| `network[EACH]` or `Each(network)` | Process each signal independently in supported combinator contexts. |
| `network[ANY]` or `Any(network)`   | Decider Anything quantifier.                                        |
| `network[ALL]` or `All(network)`   | Decider Everything quantifier.                                      |

Selections create no hardware and are not ordinary JavaScript numeric reads.
`ANYTHING`/`Anything` and `EVERYTHING`/`Everything` are the long aliases.
A bare Network means `Each` in supported arithmetic/Decider contexts.
The [selection reference](../language-reference.md#network-selections) defines
wildcard restrictions and the concrete-selection function type `NetworkSignal`.

## Operators

| Expression                     | Result or effect                                          |
| ------------------------------ | --------------------------------------------------------- |
| `network * 2`                  | ArithmeticCombinator processing each signal.              |
| `network[A] + 1`               | ArithmeticCombinator with a concrete Signal operand.      |
| `network[A] > 0`               | Circuit Condition for a Decider, not a simulated number.  |
| `destination += combinator`    | Connect one available Combinator output lane.             |
| `destination[A] += combinator` | Connect and bind the physical output to A when supported. |

See the [arithmetic reference](../language-reference.md#arithmetic-combinators)
for all operators. An explicit `Network` annotation on an arithmetic result
exposes only the Combinator's primary output facet.

`destination += network` and `destination += number` are invalid. Use a
Combinator to produce a result, or `.take(...)` to unite owned Networks without
hardware. Entity attachment depends on separate
[Entity capabilities](../language-reference.md#provider--and-host-bound-entities).

## take

**Call:** `destination.take(source)`

**Returns:** the destination receiver.

**Effect:** unite source and destination without adding a combinator or tick.
The destination survives; old aliases of the consumed source become unusable.
This changes topology/ownership during elaboration, not counts on each tick.

Both operands require consumption rights. Readonly and Ref views cannot be
consumed; Move explicitly transfers consuming access into a function. Conflicting
colors and invalid/moved owners are errors. See
[Network transfer](../language-reference.md#explicit-network-transfer) for the
full contract and Combinator-to-Network source behavior.

```ts
const A = Signal('virtual', 'signal-A');
const first = new Network();
const second = new Network();
first += CC(2 * A);
second += CC(3 * A);
first.take(second);
// Use first now, not second. It carries A = 5 from T1.
```

## Complete example

```ts
const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
input += CC(5 * A);
output[A] += input[A] * 2;
```

This builds one Constant and one Arithmetic. T0 is empty; input carries A = 5
at T1 and output carries A = 10 at T2.

## Function capabilities

| Parameter annotation | Access during the call                                                               |
| -------------------- | ------------------------------------------------------------------------------------ |
| `Readonly<Network>`  | Read without attaching or consuming.                                                 |
| `Ref<Network>`       | Read and attach; do not consume.                                                     |
| `Move<Network>`      | Transfer ownership; caller's old aliases become invalid.                             |
| `Network`            | Transparent reference with shared ownership checks; unrestricted capability warning. |

Readonly/Ref views expire when the call ends and must not escape. The
[function reference](../language-reference.md#functions) defines aliasing,
returns, color-qualified capabilities and untyped parameter behavior.

## Related APIs

- [Combinator connections](../language-reference.md#combinators-and-output-connections): two output colors, physical methods and Network narrowing.
- [pair](../language-reference.md#both-colors-input-views): immutable both-colors input view, not a writable destination.
- [join](../language-reference.md#networks-and-colors): unite owned sources into a new Network.
- [Testbench](../testbench.md#executable-files): inspect counts after elaboration using test APIs.
- [Diagnostics](../diagnostics.md): moved owners, expired views and wire conflicts.
