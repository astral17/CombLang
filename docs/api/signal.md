# Signal

[Documentation](../README.md) · [Network](network.md) · [Language reference](../language-reference.md#signals)

An immutable Signal identity used to select circuit values or configure outputs.
A Signal is a name/type/quality, not a count and not a Network.

## Construction

| Call                          | Meaning                                 |
| ----------------------------- | --------------------------------------- |
| `Signal(name)`                | Item Signal with normal quality.        |
| `Signal(type, name)`          | Explicit namespace with normal quality. |
| `Signal(type, name, quality)` | Explicit namespace and quality.         |

Arguments are strings. One argument does not infer a namespace from the name:
`Signal('signal-A')` means an item, not a virtual Signal.
Names and explicitly supplied qualities must be non-empty and cannot contain
NUL (U+0000); this is an identity-format constraint, not a claim about every
name accepted by Factorio itself.

```ts
const IRON = Signal('iron-plate');
const NORMAL_IRON = Signal('item', 'iron-plate', 'normal');
const RARE_IRON = Signal('item', 'iron-plate', 'rare');
const A = Signal('virtual', 'signal-A');
```

IRON and NORMAL_IRON have the same circuit identity. RARE_IRON is a distinct
Signal: its count does not replace or merge with ordinary iron-plate counts.
This concerns identity in circuit data, not a promise about JavaScript `===`
between independently constructed handles.

**Returns:** a Signal handle registered to the current source elaboration.
Constructing a Signal adds no hardware or ticks. A plain `{ type, name }`
JavaScript object is not a substitute for this handle in source DSL operations.

## Operations

| Form                      | Use                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `network[A]`              | Select A on a Network.                                                             |
| `5 * A`                   | Constant count specification for CC or a Decider output, not an arithmetic device. |
| `output[A] += expression` | Bind a compatible Combinator's output Signal.                                      |
| `String(A)`               | Canonical external SignalRef key.                                                  |
| `{ [A]: 5 }`              | Signal-keyed dictionary, accepted by CC.                                           |

Do not use a Signal as a numeric loop counter or current simulated count.
To inspect counts after compilation, use
[test assertions](../testbench.md#assertions).

## Complete selection example

```ts
const IRON = Signal('iron-plate');
const RARE_IRON = Signal('item', 'iron-plate', 'rare');
const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
input += CC(20 * IRON, 2 * RARE_IRON);
output[A] += input[IRON] + input[RARE_IRON];
```

There are two combinators: a Constant and an addition. At T1 input holds two
distinct iron-plate Signals; at T2 output carries A = 22. Only the explicitly
selected counts participate in the addition.

## String and dictionary keys

The external SignalRef spelling is an encoded item name, `type/name`, or
`type/name/quality` for non-normal quality. For example `String(A)` is
`virtual/signal-A` for the usual virtual A. This is a dictionary/transport key,
not an alternative overload of the Signal constructor.

```ts
const A = Signal('virtual', 'signal-A');
const output = new Network();
output += CC({ [A]: 5, 'iron-plate': 20 });
```

Bare dictionary keys mean items. Numeric/default coercion of a Signal handle is
rejected; its explicit string conversion is supported. Omitted quality and
`normal` normalize to the same identity. See the
[Signal reference](../language-reference.md#signals) for encoding rules.

## Export notes

Signal fields in blueprint JSON omit the default item type. Constant filter
fields have different quality defaults, so an ordinary CC row exports explicit
`quality: 'normal'` rather than relying on omission. This does not make all
quality/filter variants or entity behaviors simulated.

## Errors and related APIs

Non-string constructor arguments, forged Signal objects and incompatible
operand uses are rejected at the source or executed boundary. Dynamic values
are checked when the source runs rather than guessed by static analysis.

- [Network selections](network.md#signal-selection).
- [Constant combinators](../language-reference.md#constant-combinator).
- [Decider outputs](../language-reference.md#decider-combinators).
- [Diagnostics](../diagnostics.md).
