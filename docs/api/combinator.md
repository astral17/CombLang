# Combinator

[Documentation](../README.md) · [Network](network.md) · [Circuit basics](../circuit-basics.md)

A physical circuit device with a primary output Network and up to two output
wire colors. Keep its handle when you need placement or both output lanes.
Creating and naming the handle does not postpone hardware creation.

## Creation and result types

| Source expression                        | Physical result                                              |
| ---------------------------------------- | ------------------------------------------------------------ |
| `input * 2`                              | ArithmeticCombinator.                                        |
| `IF(condition, thenOutput, elseOutput?)` | DeciderCombinator.                                           |
| `when(condition).then(...)`              | DeciderCombinator.                                           |
| `CC(...)`                                | ConstantCombinator.                                          |
| `Selector({ ... })`                      | SelectorCombinator for currently supported exact operations. |

Exact constructors and their provider requirements are described in the
[language reference](../language-reference.md). A generic Entity with a matching
prototype name does not automatically acquire computation or this output API.

Exact `Constant({ sections: [...] })` accepts a direct current-session number
parameter in a section's `multiplier`, with a required finite-double default.
Host-local binding updates the same Constant Producer and linked Entity, including
fractional multipliers, without source execution or hardware changes. Count slots
still require safe integers and normalize to int32. Default `1` remains ordinarily
simulatable; non-unit values keep the existing `FC1003`/Unknown model boundary.
Native symbolic multiplier export remains unsupported (`CP1002`), while ordinary
concrete export works. No binding UI, formula syntax or `CC`/Section parameter
scaling is added. See the
[complete source and host example](../native-objects-deciders-and-parameters.md#constant-multiplier-parameters).

## Network context

Ordinary reads and signal selections on a Combinator use its primary output
Network. An explicit `Network` annotation exposes only that facet; it adds no
hardware and cannot recover a second output or physical methods afterward.

```ts
const A = Signal('virtual', 'signal-A');
const input = CC(5 * A);
const physical = input[A] * 2;
const output: Network = physical;
```

The physical handle remains `physical`; `output` is its primary Network view.
This builds a Constant and one Arithmetic stage, with output A = 10 at T2.
Because this example only exposes the final Network without reading or attaching
it in source, it also reports the non-fatal unused-output warning `CL2001`.
Function returns annotated `Network` also narrow to that primary view; return a
concrete Combinator type when callers need physical methods or both outputs.

## Output connections

Exact `Arithmetic({ left, operation, right, output })` accepts a concrete Signal,
`Each` or a direct current-session Signal parameter in `output`. Numeric parameter
operands and that output compile to concrete defaults on the same physical device.
Host-local binding can override them without new hardware or source execution;
bare Signal parameters are not valid input operands or Network property keys.
Native Signal metadata export remains unsupported (`CP1002`); ordinary concrete
preview/export and simulation still work. There is no binding UI. See the
[complete source and host example](../native-objects-deciders-and-parameters.md#arithmetic-output-signal-parameters).

| Form                                         | Effect                                                 |
| -------------------------------------------- | ------------------------------------------------------ |
| `output += comb`                             | Attach the next available output lane.                 |
| `to(output, mirror) += comb`                 | Attach both output lanes to two destinations.          |
| `output[A] += comb`                          | Attach and explicitly bind a compatible output Signal. |
| `to(output, mirror)[A] += comb`              | Bind that Signal on both outputs.                      |
| `comb.to(output)`                            | Fluent equivalent of one attachment.                   |
| `comb.to(output[A])` or `comb.to(output, A)` | Fluent single-destination Signal binding.              |
| `comb.to(output, mirror, A)`                 | Fluent two-destination Signal binding.                 |

`.to(...)` returns the same physical handle. Signal binding changes its
existing output configuration, not its hardware count. Compatible binding is
required; wildcard and multiple-output Decider configurations have restrictions.
See [output connections](../language-reference.md#combinators-and-output-connections).

Primary and secondary lanes carry the same result on opposite colors. The
secondary lane is created lazily, at most once. A third attachment is an error.
Aliases do not create extra lanes. `.to(output[A], mirror[A])` is invalid;
use the two-destination form with the Signal as its final argument.

```ts
const A = Signal('virtual', 'signal-A');
const input = CC(5 * A);
const comb = input[A] * 2;
const output = new Network<R>();
const mirror = new Network<G>();
output += comb;
mirror += comb;
```

Both outputs carry A = 10 at T2 from one multiplier. Repeating the _expression_
instead, such as `output += input[A] * 2; mirror += input[A] * 2;`, creates two
different multipliers. Keep one handle to reuse one physical device.

## at

**Call:** `comb.at(x, y, direction?)`

**Returns:** the same physical handle.

**Effect:** set exact blueprint coordinates without changing computation,
connections or tick count. It may be called before or after attaching output
lanes. Coordinates must be finite numbers. Direction is an integer 0–15,
including a numeric enum value; omission defaults to 4.

```ts
const A = Signal('virtual', 'signal-A');
const input = CC(5 * A);
const output = new Network();
const comb = input[A] * 2;
output += comb;
comb.at(10.5, -2, 8);
```

Unplaced devices use automatic preview positions. Placement currently does not
prove wire reach or collision-free physical construction in Factorio.

## Destructuring output Networks

```ts
const A = Signal('virtual', 'signal-A');
const input = CC(5 * A);
const comb = input[A] * 2;
const [output, mirror]: [Network<R>, Network<G>] = comb;
```

Destructuring projects the same stable primary/secondary Networks, not two new
devices. Reading each as a Network does not allocate another output lane.
Repeat aliases/destructuring do not make a third color available.
This projection-only example likewise reports `CL2001` until the output is
read or attached by the source; the Networks can still be inspected in tests.

## Errors and related APIs

An output never read or connected produces warning `CL2001`; the device remains
in the plan. Duplicate destinations, incompatible Signal bindings or a third
output lane fail with source-aware diagnostics. `.as(SIGNAL)` is not supported;
bind a Signal at the destination instead.

- [Network](network.md): selection, wire union and capabilities.
- [Arithmetic](../language-reference.md#arithmetic-combinators).
- [Deciders](../language-reference.md#decider-combinators).
- [Constants and sections](../language-reference.md#constant-combinator).
- [Functions](../language-reference.md#functions): physical versus Network returns.
- [Diagnostics](../diagnostics.md).
