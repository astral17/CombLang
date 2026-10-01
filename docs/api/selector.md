# Selector

[Documentation](../README.md) · [Network](network.md) · [Combinator](combinator.md) · [Constant](constant.md)

Select a Signal by rank or count distinct input Signals with an exact
SelectorCombinator. Structural Selector Entity construction is a different API.

## Signatures

```text
Selector({ input, operation: 'select', selectMax?, index? }) -> SelectorCombinator
Selector({ input, operation: 'count', output }) -> SelectorCombinator
Selector(prototype, configuration?) -> structural Entity
```

In an Entity/provider context, exact computation requires trusted canonical
`entity:selector-combinator` authority in the
[prototype environment](../prototype-environment.md); a missing base is an error.
With no Entity context or prototype resolver, the same source supports profile-free
Selector computation without a linked Entity. Exact configuration is semantic
source data, not raw Blueprint JSON. A structural selector Entity does not
automatically gain a computation model.

## Parameters and model

| Field       | Accepted value and default                                                |
| ----------- | ------------------------------------------------------------------------- |
| `input`     | Required readable Network or `pair(red, green)`; not a scalar selection.  |
| `operation` | Required exact `'select'` or `'count'`; no computation default.           |
| `selectMax` | Select only; boolean, defaults to true.                                   |
| `index`     | Select only; safe-integer number or current-source Signal, defaults to 0. |
| `output`    | Count only; required current-source Signal, no default.                   |

In the implemented model, input colors are summed by Signal identity first;
zero totals disappear. Select sorts the remaining counts descending for selectMax
true or ascending for false, using canonical Signal identity as its deterministic
tie-breaker. Index is zero-based. A negative or out-of-range index emits an empty
bus. A numeric safe-integer index normalizes to signed int32.

A Signal index reads that Signal's combined input count as the index; it is not
the selected output Signal and is not excluded from ranking candidates. Missing
index Signal means count 0. Count emits the number of distinct non-zero combined
Signals on its configured output, not the sum of their values; empty input gives
zero (absent on the sparse bus).

Each constructor adds one device and one tick from its input. It reads without
consuming the Network owner. The result supports [Combinator](combinator.md)
placement, output attachment and two output lanes; pair colors must fit the
same input connector. There is no output-Signal field on select: the chosen
Signal retains its identity and count.

## Select and count example

Complete source. In a prototype-enabled workbench/embedding host, supply trusted
canonical Selector authority. The tests exercise that linked path; a profile-free
host without Entity/provider context can also run this model:

```ts
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const C = Signal('virtual', 'signal-C');
const TOTAL = Signal('virtual', 'signal-T');
const input = new Network();
const maximum = new Network();
const minimum = new Network();
const count = new Network();
input += CC(5 * A, 2 * B, 7 * C);
maximum += Selector({ input, operation: 'select' });
minimum += Selector({ input, operation: 'select', selectMax: false, index: 0 });
count += Selector({ input, operation: 'count', output: TOTAL });
```

Four devices: one Constant and three Selectors. T0 and T1 outputs are empty;
at T2 maximum has C = 7, minimum has B = 2, and count has TOTAL = 3.
The select defaults are true/0; count has no default output Signal.

## Signal index and two colors

Complete independent source with the same context-dependent Selector prerequisite:

```ts
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const C = Signal('virtual', 'signal-C');
const INDEX = Signal('virtual', 'signal-I');
const red = new Network<R>();
const green = new Network<G>();
const output = new Network();
red += CC(5 * A, 3 * B, 1 * INDEX);
green += CC(4 * C, 1 * INDEX);
output += Selector({ input: pair(red, green), operation: 'select', index: INDEX });
```

Three devices. At T2 the combined INDEX count is 2; descending candidates are
A = 5, C = 4, B = 3 and INDEX = 2. Index 2 emits B = 3, not INDEX.
This deterministic ranking is the current simulator contract, not independent
native tie-breaking conformance evidence.

## Structural Entity overload

Fragment for a configured provider/schema host, not a standalone circuit program:

```text
Selector('selector-combinator', {
  control_behavior: { operation: 'select', select_max: true, index_constant: 0 },
}).at(4, 2)
```

This overload accepts a provider prototype short name/key/record and checked or
raw Entity configuration, verifies the selector-combinator prototype family and
returns an inert Entity. It creates no computation Producer, output Network or
simulator device by itself. Configuration validation and callable capabilities
are separate; see [Entity source API](../language-reference.md#provider--and-host-bound-entities).
The structural catalog's select default does not make exact `operation` optional.

## Restrictions

Only select/count computation is implemented. Exact `random`, `stack-size`,
`rocket-capacity`, `quality-filter`, `quality-transfer` and any other operation
are rejected, even when structural schema fields exist. No `Select`, `Count`,
`Random`, `QualityFilter`, `QualityTransfer` or `Time` computation helper is
introduced by this page. Unsupported field mixtures, missing output/input,
accessors, symbols and invalid indices fail with source-aware diagnostics.

Direct source parameter indices/count outputs have their own capture/binding
restrictions; host-only native metadata is not copied-web support. See
[Blueprint parameters](../native-objects-deciders-and-parameters.md#blueprint-parameter-values).
Related: [Signal](signal.md), [pair inputs](../language-reference.md#both-colors-input-views),
[exact/structural reference](../language-reference.md#provider--and-host-bound-entities)
and [Testbench](../testbench.md#executable-files).
