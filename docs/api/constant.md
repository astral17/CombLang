# Constant and Section

[Documentation](../README.md) · [Signal](signal.md) · [Combinator](combinator.md) · [Arithmetic](arithmetic.md)

Produce fixed Signal counts with one ConstantCombinator. Use CC for rows and
Constant/Section when ordered section configuration matters.

## Signatures

```text
CC(row, ...) -> ConstantCombinator
CC(section, ...) -> ConstantCombinator
CC() -> empty ConstantCombinator
Constant({ isOn?, sections? }) -> ConstantCombinator
Section(row, ...) -> data-only Section
Section({ active?, group? }, row, ...) -> data-only Section
finiteNumber * Section(...) -> scaled data-only Section
```

These are source globals, not host-library imports. Structural
`Constant(prototype, configuration?)` constructs an Entity instead; it does not
gain the computation/output API merely because the prototype is a combinator.
See [Entity construction](../language-reference.md#provider--and-host-bound-entities).

## CC rows

| Row form                        | Interpretation                                           |
| ------------------------------- | -------------------------------------------------------- |
| `5 * A`                         | Typed Signal count, not multiplication hardware.         |
| `[A, 5]` or `['iron-plate', 5]` | Signal/count tuple; an unqualified string means an item. |
| Nested arrays of rows           | Flatten recursively in executed order.                   |
| `Map<Signal\|string, count>`    | Preserve Map entry order.                                |
| `{ [A]: 5, 'iron-plate': 2 }`   | SignalRef-keyed dictionary in `Object.keys` order.       |

Counts must be finite safe integers, normalized to signed int32. For example
4,294,967,297 becomes 1; fractions and unsafe integers fail, not round.
Ordered zeros and duplicate Signal rows remain in the configuration; the
implemented model sums duplicate counts. A JavaScript Map/object still obeys
its normal key overwrite rules before CC receives it. Arbitrary iterables are
not accepted in place of these row containers.

Complete profile-free source demonstrating every row form:

```ts
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const output = new Network();
output += CC(
  5 * A,
  [A, 0],
  [[B, -2]],
  new Map([
    [A, 3],
    ['iron-plate', 4],
  ]),
  { [B]: 7, 'copper-plate': 2 },
);
```

One device. T0 is empty; at T1 A = 8, B = 5, iron-plate = 4 and copper-plate = 2.
The zero row is retained even though it contributes no count.

## Empty CC

Complete profile-free source:

```ts
const output = new Network();
const empty = CC().at(1, 2);
output += empty;
```

An empty argument list or empty generated list still creates one physical device.
It emits no signals at T1 but supports placement and output attachment. An
unattached device reports non-fatal `CL2001`; empty does not mean no hardware.

## Exact Constant parameters

| Field                    | Default and meaning                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `isOn`                   | `true`; entity-wide output switch.                                                             |
| `sections`               | `[]`; ordered sections, not native one-based index records.                                    |
| Section `active`         | `true`; section contributes when active and isOn.                                              |
| Section `group`          | Omitted; optional string preserved in export.                                                  |
| Section `multiplier`     | `1`; finite number, not int32 count.                                                           |
| Section `filters`        | `[]`; ordered `{ signal, value }` rows (also accepted CC row forms).                           |
| Filter `signal`, `value` | Required in a direct row; a current-source Signal or SignalRef string, and safe-integer count. |

`Constant({})` is an empty exact Constant. The configuration is semantic data,
not raw Blueprint `control_behavior` or logistic filter JSON. All exact Constants
require trusted canonical `entity:constant-combinator` authority in the
[prototype environment](../prototype-environment.md). Raw-row CC also works
profile-free; if trusted base authority is present, it links the physical Entity.

Complete source; requires that trusted Constant base profile:

```ts
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const output = new Network();
output += Constant({
  sections: [
    {
      filters: [
        { signal: A, value: 4294967297 },
        { signal: A, value: 0 },
      ],
    },
    { active: false, filters: [{ signal: B, value: -2 }] },
  ],
});
```

One device; at T1 A = 1 and B = 0. Default isOn/active/multiplier values are
true/true/1, and the inactive section plus duplicate/zero filters remain in export.
Setting `isOn: false` disables emitted counts without removing the configuration.

## Section

A Section is a nominal data fragment, not a device or Network. Options accept
only `active` and `group`, defaulting to true and omitted; the multiplier starts
at 1. A finite number on the left of `*` sets the section multiplier without
integer conversion. A scaled Section cannot be scaled again; this is not a
chain of multiplier operations. `Section(...) * 0.5` is not the scaling form. CC accepts
either all raw rows or all nominal Sections from the same source execution,
never a mixture. Section order becomes native section order in one device.
Section-based CC requires the same trusted Constant base authority as exact Constant.

Complete independent source with that prerequisite, suitable for sparse simulation:

```ts
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const output = new Network();
const primary = Section(2 * A, 0 * A);
const backup = Section({ active: false }, 4 * B);
output += CC(primary, backup);
```

One device; at T1 A = 2 and B = 0. Constructing the two fragments adds no hardware.

### Rich sections and simulation boundary

Complete source; requires trusted Constant authority. This is an export/configuration
example, not a supported sparse-simulation example:

```ts
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const output = new Network();
const primary = 0.5 * Section(1 * A, 2 * B);
const backup = 3 * Section({ active: false, group: 'backup' }, 4 * A);
output += CC(primary, backup);
```

One device retains multiplier 0.5 / 3, inactive backup and group in Blueprint JSON.
The sparse simulator rejects group/non-unit-multiplier configurations with `FC1003`,
even when a section is inactive. The Known/Unknown value model records unsupported
configuration as Unknown. Neither is proof of native multiplier/group behavior.

## Quality and hardware

An omitted ordinary Signal quality means normal. An omitted native logistic
filter quality instead denotes any quality: export writes explicit `quality: 'normal'`
for ordinary unqualified constant rows. This source API does not expose a separate
any-quality constant-filter syntax; do not omit quality in hand-edited native JSON
and assume it has the same semantics.

Supported Constants emit their fixed counts at T1 from an initially empty model;
they do not consume inputs. The result supports [Combinator](combinator.md)
`.at(...)`, `.to(...)` and two output lanes. Section creation has no ticks or topology.

## Restrictions

Malformed rows, symbol/accessor fields, cyclic or sparse arrays and bounded-depth
overflow are errors. Exact records accept only the listed semantic fields;
Section options do not accept raw `multiplier` or `filters` fields. No additional
native slot-capacity or placement guarantee is implied by these examples.

Direct source parameters and host-only export are separate from web copied
blueprints: see [Blueprint parameters](../native-objects-deciders-and-parameters.md#blueprint-parameter-values).
Related: [Decider output rows](decider.md#conditions-and-outputs), [Network](network.md),
[detailed Constant reference](../language-reference.md#constant-combinator) and
[Testbench](../testbench.md#executable-files).
