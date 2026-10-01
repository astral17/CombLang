# Functions

[Documentation](../README.md) · [Network](network.md) · [Combinator](combinator.md) · [Entity](entity.md)

Functions execute ordinary source-time JavaScript and build reusable circuit
structures. Calling a function or running a loop does not advance simulation
time. Each executed combinator operation creates hardware; that hardware's
pipeline stages determine tick delays.

## Signatures

These are source contract fragments, not library imports:

```text
function Build(input, factor) { ... }
function Build(input: any, factor: number) { ... }
function Read(input: Readonly<Network> | number) { ... }
function Alias(input: Readonly<Network>): Readonly<Network> { return input; }
function Transform(input: Move<Network>): Network { ... }
```

## Parameters

| Annotation                    | Executed contract                                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Omitted or `any`              | Preserve the actual value: ordinary JS, Network or physical Combinator. A Network reference triggers `CL2002` without upgrading its existing capability. |
| `Network`                     | Transparent Network reference retaining existing capabilities; emits `CL2002` once per parameter declaration when a Network is received.                 |
| `Readonly<Network>`           | Read, but do not attach or consume; call-scoped borrow.                                                                                                  |
| `Ref<Network>`                | Read and attach, but do not consume; exclusive call-scoped borrow.                                                                                       |
| `Move<Network>`               | Transfer ownership into the function; old caller aliases become invalid immediately.                                                                     |
| `Readonly<Network> \| number` | Select the admitted branch from the executed value; ordinary branch adds no borrow.                                                                      |

Typed Network parameters accept a Combinator's primary Network facet, not its
physical configuration methods. Concrete physical types such as
`ArithmeticCombinator` preserve the corresponding physical handle; their
parameter Network access is readonly. `<R>`/`<G>` inside Network capabilities
is a real wire-color requirement, not documentation. Dynamic mismatches are
checked at execution, and provable violations may be rejected earlier.

## Returns

A physical `Combinator`/`ArithmeticCombinator`/`DeciderCombinator`/
`ConstantCombinator` return preserves that device's configuration API and
output connections. A `Network` return exposes only the primary Network facet;
it does not add an adapter device or recover the physical API through a cast.
A fresh or moved callee-owned Network transfers to the caller. An unchanged
unrestricted caller alias may return without a move.

An explicit single `Readonly<Network>` return may create a fresh readonly view
of a live Network owned outside the returning function, at the same identity
and generation. The callee's original parameter borrow still expires; this
does not permanently freeze the original owner. A fresh callee-owned output
can also transfer to the caller and become readonly. Neither form promotes
readonly access to ownership. See [return ownership](../return-ownership.md)
and [capability details](../language-reference.md#functions) for nested lifetimes,
containers, stale generations and color requirements.

## Untyped reusable builder

Complete source; no prototype prerequisites. Ordinary numeric calls stay JS;
circuit calls preserve the resulting Arithmetic handle and its `.at` method.

```ts
const A = Signal('virtual', 'signal-A');
function Scale(input, factor) {
  return input * factor;
}
if (Scale(4, 2) !== 8) throw new Error('ordinary numeric call changed');
const input = new Network();
input += CC(5 * A);
const multiplied = Scale(input, 2).at(4, 2);
const output = new Network();
output += multiplied;
```

This Network-valued untyped call emits warning `CL2002`; the ordinary numeric
call does not. One Constant and one Arithmetic. Output A is 0 at T1 and 10 at T2.
Calling `Scale(input, 2)` again would create another Arithmetic device.

## Readonly alias

Complete source; no prototype prerequisites:

```ts
function Alias(input: Readonly<Network>): Readonly<Network> {
  return input;
}
const input = new Network();
const output = Alias(input);
```

One logical Network, zero devices, zero delay. `output` reads the same wire as
`input` and cannot receive attachments or participate in `.take`. The original
owner can still write after the call; moving/consuming it invalidates old aliases.

## Fresh readonly output

Complete source; no prototype prerequisites:

```ts
const A = Signal('virtual', 'signal-A');
function Increment(input: Readonly<Network>): Readonly<Network> {
  return input + 1;
}
const input = new Network();
input += CC(5 * A);
const output = Increment(input);
```

One Constant and one Arithmetic, not an alias. Output A is 0 at T1 and 6 at T2.
The returned primary Network is readonly; the caller cannot call physical methods
or convert it to a writable Ref merely by adding a type annotation.

## Explicit ownership return

Complete source; no prototype prerequisites:

```ts
const A = Signal('virtual', 'signal-A');
function Advance(input: Move<Network>): Network {
  return input;
}
const input = new Network();
input += CC(5 * A);
const oldAlias = input;
const advanced = Advance(input);
```

One Constant; no new device or delay in `Advance`. `advanced` carries A = 5
at T1. Ownership/generation changed, unlike readonly Alias: do not use `input`
or `oldAlias` afterward. A later read through an old handle reports `RT2012`.

## Unrestricted alias warning

Complete source; intentionally emits warning `CL2002`, not a compilation error:

```ts
function Shared(input: Network): Network {
  return input;
}
const input = new Network();
const output = Shared(input);
```

Zero devices, same Network identity, no ownership transfer. Choose explicit
Readonly/Ref/Move parameters when the function needs a restricted contract;
do not change the annotation merely to hide a warning.

## Union branch

Complete source; no prototype prerequisites:

```ts
const A = Signal('virtual', 'signal-A');
function Double(input: Readonly<Network> | number) {
  return input * 2;
}
if (Double(4) !== 8) throw new Error('ordinary branch changed');
const input = new Network();
input += CC(5 * A);
const output = Double(input);
```

One Constant and one Arithmetic; output A = 10 at T2. The numeric call adds no
device. A value admitted by neither union branch is rejected at the call argument.

## Restrictions

Source compilation is one synchronous file: no circuit-source imports, async
functions or project module linking. JS branching and loops run at compilation,
not once per simulation tick. Tests are separate ordinary JavaScript files.

Readonly/Ref parameter views expire on return or throw. Owned returns cannot
steal a borrowed input; the explicit single readonly alias exception does not
permit Ref, selection, array/object or expired-parameter closure escapes.
Move invalidates all old aliases and container slots, even when the callee drops
the owner rather than returning it. Readonly-to-Ref/Move and conflicting borrows
remain forbidden. See [Troubleshooting](../troubleshooting.md),
[ownership guide](../ownership-and-multi-network.md) and [Testbench](../testbench.md).
