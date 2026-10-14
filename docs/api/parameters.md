# Param

[Documentation](../README.md) · [Signal](signal.md) · [Arithmetic](arithmetic.md) · [Constant](constant.md) · [Selector](selector.md)

Declare an editable configuration value with a concrete default. A parameter is
not a Network or a signal count that changes every tick: binding changes fields
of already-created hardware, not its topology or the execution of source loops.

## Signatures

Source globals, not importable TypeScript library declarations:

```text
Param.number(label, defaultValue, metadata?) -> opaque number parameter
Param.signal(label, defaultSignal) -> opaque Signal parameter
```

| Argument              | Contract                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `label`               | Required nonblank string. Preserved display text, not a unique key.                                            |
| Number `defaultValue` | Required finite number. Each destination field applies its own numeric rules.                                  |
| `defaultSignal`       | Required current-source `Signal(...)` handle, including optional quality; not a plain `{ type, name }` object. |
| Number `metadata`     | Optional plain data record with `variable?: string`, `formula?: string`, `dependent?: boolean`.                |

Both defaults are positional; there is no `{ default: ... }` wrapper or automatic
default allocation. `Param.signal` accepts exactly two arguments and no metadata.
Creating a declaration creates no combinator, wire or tick delay. Distinct
declarations remain distinct even when their labels and defaults are equal.

The returned source value is opaque. It has no readable `.defaultValue`,
`.metadata`, `.id` or `.value` properties; declarations are listed through the
CLI, browser controls or the embedding API instead.

## Supported fields

Use parameters in these exact configurations. Arithmetic operands, the two
direct Constant numeric slots and Decider thresholds also accept the limited
derived source expressions described below:

| Constructor                           | Field                                                                               | Accepted source value              |
| ------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------- |
| `Arithmetic`                          | `left`, `right` as constant operands                                                | Number or local numeric expression |
| `Arithmetic`                          | `output`                                                                            | Signal                             |
| `Constant`                            | `sections[].filters[].value`                                                        | Number or local numeric expression |
| `Constant`                            | `sections[].filters[].signal`                                                       | Signal                             |
| `Constant`                            | `sections[].multiplier`                                                             | Number or local numeric expression |
| `Decider`, `when`, or `IF`            | Right-hand numeric comparison threshold in `condition`, including nested conditions | Number or local numeric expression |
| `Selector` with `operation: 'select'` | `index`                                                                             | Number or Signal                   |
| `Selector` with `operation: 'count'`  | `output`                                                                            | Signal                             |

Arithmetic constants, Constant filter counts, Decider thresholds and numeric
Selector indices require finite safe integers, then normalize to signed int32.
Constant section multipliers remain finite doubles. If one parameter is reused
in several fields, its chosen value must satisfy every field's rules. Values
are not rounded or clamped to make a failed binding pass.

A number parameter may form a local source expression with finite numbers and
other owning number parameters using binary `+`, `-`, `*` or unary `-`. The
opaque result is evaluated by the registered numeric DAG only when it occupies
an exact Arithmetic `left` or `right` constant slot, a direct Constant filter
count, a Constant section multiplier, or the right-hand numeric threshold of an
exact Decider, `when(...).then(...).else(...)`, or `IF(condition, then, else)`
condition (including nested AND/OR conditions). It creates no device and does
not re-execute source during binding. Count and threshold
results must be finite safe integers before existing signed-int32
normalization; multipliers remain finite doubles. Parameter-free JavaScript
arithmetic remains ordinary JavaScript. Derived expressions are not booleans,
circuit Conditions or native formula strings.

A Signal parameter in a Selector index changes which input Signal provides the
index count; it does not specify the selected output. A Signal parameter is not
a scalar input selection for Arithmetic and cannot replace `input[A]`.
`selectMax`, section `active`/`group`, operations, Network identities and generic
Entity raw configuration are not parameterized by this API.

## Complete circuit example

Requires trusted canonical Arithmetic authority from the configured
[prototype environment](../prototype-environment.md), available in the bundled
workbench profile. Exact constructors and ordinary operator expressions are
different source forms; this example uses the supported exact fields:

```ts
const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5);
const result = Param.signal('Result', Signal('virtual', 'signal-B'));
const input = new Network();
const output = new Network();
input += CC(2 * A);
output += Arithmetic({
  left: input[A],
  operation: 'add',
  right: amount,
  output: result,
});
```

Two devices. T0 is empty; with defaults, output B is 5 at T1 and 7 from T2.
Binding Amount to 11 and Result to `signal-C` with quality `rare` instead emits
rare C = 11 at T1 and 13 from T2. There is no extra adapter, device or tick.
Both declarations may be reused in other supported fields without copying them.

## Edit and bind values

The workbench's **Circuit parameters** section exposes the declarations. **Apply**
binds the edited values against the retained source execution; **Reset** restores
the original defaults. A successful bind starts a fresh simulation at T0 and
uses the matching concrete circuit for tests and blueprint JSON. Source/profile
changes invalidate the capture; **Recompile source** explicitly obtains a new one.

For the circuit above, saved as `parameters.factorio.ts`, the CLI can list the
declarations with a selected prototype database:

```sh
node apps/cli/dist/main.js parameters list --json --prototypes database.json parameters.factorio.ts
```

Write the following to `values.json`, using IDs from that listing:

```json
[
  { "id": 0, "value": 11 },
  { "id": 1, "value": { "type": "virtual", "name": "signal-C", "quality": "rare" } }
]
```

Then export the chosen concrete configuration:

```sh
node apps/cli/dist/main.js blueprint export --prototypes database.json --overrides values.json --output chosen.json parameters.factorio.ts
```

The same values can select the circuit tested by a separate JavaScript test file:

```sh
node apps/cli/dist/main.js test --prototypes database.json --overrides values.json parameters.factorio.ts circuit.test.js
```

The circuit source executes once for this command; each registered test starts
independently at T0 with the chosen values. A failed bind reports a circuit setup
diagnostic and does not evaluate/register the tests. See
[CLI test overrides](../testbench.md#concrete-cli-parameter-overrides) for the
test report, exit codes and source/profile path rules.

Overrides are a full snapshot against the original defaults, not a delta from
the previous binding. Omitted IDs use defaults; `[]` resets all values. IDs follow
declaration order within one execution and are not persistent identities across
source edits or dynamic executions. Listing and export are separate CLI commands
and each executes source once; neither pins the other's execution.

For a Signal override with the same type and name, omitting `quality` and setting
`quality: 'normal'` select the same ordinary Signal. Both lookup forms read its
chosen count in preview and tests; `rare` or `uncommon` select distinct Signals.
For example, an Arithmetic reading ordinary A also reads an explicitly normal A,
but not rare A. Constant filters export explicit `quality: 'normal'` for both
ordinary spellings; this is not an any-quality logistic filter. Any-quality
filtering is not a Signal parameter input.

Equivalent identities need not produce byte-identical Plan/IR representations.
Each binding still supplies its own matching plan and resolved circuit; do not
mix artifacts from different bindings or reuse earlier edited tick state.

An unused declaration can keep its default. Explicitly overriding it reports
`CP1001`, even if the chosen value equals that default. Binding does not add
dummy hardware to make an unused parameter useful. A binding error produces no
successful default export and does not create the requested output file.

See [CLI options and browser controls](../blueprint-json.md#source-export-cli)
for paths, JSON/plain reporting, capture lifetime and export modes.

## Formula metadata and export modes

These modes have different purposes:

| Mode                                         | Values used                                                                                        | Result                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Ordinary compilation/export                  | Declared defaults                                                                                  | Concrete circuit and JSON, without parameter metadata |
| Apply/Reset or CLI `--overrides`             | Chosen values; omitted IDs use defaults                                                            | Concrete circuit and JSON, without parameter metadata |
| CLI `--parameters` or **Include parameters** | Original defaults plus supported numeric/Signal metadata and bounded typed Constant count formulas | Native parameter-template JSON                        |

Concrete overrides and native-template export cannot be combined. The workbench
disables Apply/Reset while **Include parameters** is checked.

Native-template export supports number declarations used directly as Constant
filter counts, Arithmetic constants, Decider right-hand thresholds or numeric
Selector select indices. Numeric originals must fit signed int32 and remain
present in the exported fields. Registered numeric expressions are additionally
supported only in direct Constant filter-count slots under the bounded contract
below. Signal declarations in Constant filter Signal slots follow the separate
bounded contract below. Symbolic section multipliers, derived Arithmetic or
Decider-threshold expressions, unused declarations and conflicting originals
fail explicitly in that mode. Native replacement may also affect ordinary
literals equal to an original; nominal independence in local binding does not
establish independence in Factorio placement.

### Bounded typed Constant count formulas

A registered local numeric expression in a Constant filter count can produce a
derived native formula row. This is a narrow structural export, not general
formula parsing or native validation. For example:

```javascript
const amount = Param.number('Amount', 5, { variable: 'x' });
const output = new Network();
output += Constant({
  sections: [
    {
      filters: [
        { signal: Signal('virtual', 'signal-A'), value: amount },
        { signal: Signal('virtual', 'signal-B'), value: amount * 2 },
      ],
    },
  ],
});
```

The source executes once and declares only `Amount`. Local binding to 9
reevaluates the physical counts as 9 and 18, with no parameter metadata in
concrete JSON. Native-template export keeps the physical defaults 5 and 10;
real declarations retain source order, then generated rows are appended in
first captured Constant occurrence order. It appends this derived row after the
real declaration: `{ type: 'number', number: '10', formula: '(x * 2)', dependent: true }`.

In typed-formula mode, every supplied numeric `metadata.variable` must be valid
and unique. Each dependency must be an owned number declaration with an
explicit `metadata.variable` matching `[A-Za-z][A-Za-z0-9_]*`; built-ins `abs`,
`log2`, `sign`, `max`, `min` and recipe-reference names such as `p12_recipe` are
reserved. Each dependency must also occur as a direct physical Constant count
and must not itself declare `formula` (even an empty string) or
`dependent: true`. Typed formula export requires a linked Constant-only physical
circuit. It accepts only signed-int32 literals/defaults and the registered `+`,
`-`, `*` and unary-negation nodes; output is fully parenthesized without folding
or reassociation and respects bounded node and byte limits. Repeated identical
default/formula pairs share one row. Different formulas for the same derived
original, or collision with any declared number original, reject atomically
with located `CP1002`.

Generated rows are derived exporter metadata, not source declarations or new
local handles; they have no fabricated `name` or variable. Physical counts and
placement remain unchanged. Factorio may
replace ordinary count literals matching a parameter original as well, unlike
local nominal binding. Only typed local expressions in Constant count slots
receive this treatment; symbolic multipliers, derived expressions in other
slots, division and opaque formula strings remain unsupported or opaque as
appropriate.

A user-returned final placement export for this generated `(x * 2)` case records
normal virtual A=9 and B=18 at Amount=9 ([Factorio 2.1.21 fixture](../../fixtures/blueprint-exchange/factorio-2.1.21/generated-number-formula-placed.txt)).
This is one bounded native placement observation: current mods were unspecified,
save/reopen was not observed, and the export has no `wires` field, so it says
nothing about wired layouts. It does not validate other generated operators,
functions, formula slots, versions or mod configurations.

The generic MathExpression reference in the
[pinned Factorio 2.1.21 API input](../../tools/factorio-api/fixtures/2.1.21/runtime-api.json)
documents `+`, `-`, `*`, `/`, `^`, parentheses, and the built-ins `abs`, `log2`,
`sign`, `max` and `min`.
That generic grammar is broader than this typed exporter, which accepts only
registered nested `+`, `-`, `*` and unary negation. In TypeScript, `^` is
bitwise XOR, not exponentiation, and power syntax is outside this API. Explicit
native `formula` metadata remains opaque: local binding does not parse or
evaluate it.

### Bounded Constant Signal native export

The native exporter supports a concrete virtual Signal default with omitted or
normal quality when its parameter handle occupies a Constant filter Signal
slot. Source runs once and retains that concrete default for ordinary local
binding. Native export allocates the first free `parameter-0` through
`parameter-9` name, reserving names already present in Constant filter rows,
and emits an ID parameter with the declaration label and normal-quality `=`
condition. The source default is not written back into the circuit or stored as
a fabricated native field.

Complete example (requires the selected environment's existing Constant
provisioning capabilities):

```ts
const channel = Param.signal('Channel', Signal('virtual', 'signal-A'));
const output = new Network();
output += Constant({
  sections: [
    {
      filters: [
        { signal: channel, value: 5 },
        { signal: Signal('virtual', 'signal-A'), value: 13 },
        { signal: Signal('item', 'iron-plate'), value: 7 },
        { signal: Signal('fluid', 'water'), value: 11 },
      ],
    },
  ],
});
```

The native template uses the item-default name `parameter-0` for both virtual
A rows, preserving counts 5 and 13; iron-plate and water remain unchanged.
The ordinary A row is replaced because Factorio metadata is based on original
identity, not the local nominal handle. A local override to B changes only the
marked `channel` row(s); the ordinary A row stays A. Repeated uses of one handle
are supported, but distinct handles with the same normalized original are not.
Different namespaces or non-normal qualities sharing the original name are
ambiguous and reject at the declaration.

This slice accepts only direct Constant filter Signal slots and circuits whose
producers are Constant; any physical Entity must be linked to its producer.
Item/fluid defaults, non-normal qualities, virtual wildcards, source defaults
named `parameter-N`, placeholder-pool exhaustion, unused declarations and
Signal use in any other native slot reject atomically with located `CP1002`.
No general native replacement, formula evaluation, or broader native acceptance
is implied. For one user-reported placement of this generated
virtual/normal Constant template in Factorio 2.1.21 (mods unspecified), both
matching rows became virtual signal-B with counts 5 and 13; iron-plate and water,
the red wire, relative layout and directions were preserved. The placed export
contains no parameter metadata. This bounded report is not an independently run
game gate. Parameterized save/reopen, other namespaces, qualities or native
roles, and browser/mobile behavior remain unverified.

Complete metadata example; requires trusted canonical Constant authority:

```ts
const amount = Param.number('Amount', 5, { variable: 'x' });
const limit = Param.number('Limit', 111, { formula: 'x * 2', dependent: true });
const output = new Network();
output += Constant({
  sections: [
    {
      filters: [
        { signal: Signal('virtual', 'signal-A'), value: amount },
        { signal: Signal('virtual', 'signal-B'), value: limit },
      ],
    },
  ],
});
```

One device; default simulation emits A = 5 and B = 111 at T1, not B = 10.
`formula` is an opaque string: no parsing, reference/cycle checks or evaluation
occurs locally. Native export preserves it but does not prove that Factorio
accepts or evaluates it. Metadata is snapshotted; later changes to its input
object do not change the declaration. `{}` means no metadata; explicit false
and empty strings are preserved. Unknown keys, present `undefined`, wrong field
types, accessors and custom inherited records are rejected.

## Restrictions

Parameter handles and derived expressions are opaque configuration values, not
JavaScript numbers, booleans, Signal handles or loop bounds. Derived values may
be retained in locals, arrays, objects and return values, but may only be
consumed in exact Arithmetic numeric constant slots, direct Constant filter
count/multiplier slots, or as the right numeric threshold in an exact Decider,
fluent `when`, or `IF` condition described above. Do not use derived expressions for
division/modulo/power/bitwise operations, ordinary JavaScript comparisons,
truthiness, coercion, property access, parameter keys, compact arithmetic, other
Constant fields, Decider outputs, Selector fields, negated conditions, or
Section scaling. Direct number-parameter circuit comparisons remain supported
where listed above.
Internal host numeric-expression APIs and opaque native formula metadata are
separate from locally evaluated source expressions.

Binding a fractional Constant multiplier preserves its configuration but does
not enable sparse simulation of non-unit multipliers or grouped sections;
the [Constant model boundary](constant.md#rich-sections-and-simulation-boundary)
still applies. Omitted ordinary Signal quality means normal, not any quality.

Malformed declarations report source diagnostics such as `CL1050` or `CP1000`;
unsupported binding/native export can report `CP1001` or `CP1002`. Operator
instrumentation is not a hardened sandbox; JavaScript truthiness is not a valid
way to obtain a parameter's default. Compiler/simulator tests and JSON output
verify the implemented model, not native formula, replacement or placement behavior.

See also [Signal](signal.md), [Decider](decider.md), [Constant](constant.md),
[Selector](selector.md) and the [embedding parameter APIs](../native-objects-deciders-and-parameters.md#descriptor-based-local-binding).

## Local numeric expressions in Arithmetic, Constant and Decider slots

This complete example binds a local expression through a fluent Decider builder.
It reuses existing hardware, captures the final branch configuration (including
the `.else` appended after attachment), and does not emit a native formula:

```typescript
const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5);
const threshold = amount * 2 - 1;
const input = new Network();
const output = new Network();
input += CC(7 * A);
const gate = when(input[A] > threshold).then(input[A]);
output += gate;
gate.else(1 * A);
```

The default threshold is 9; binding Amount to 3 changes it to 5. Binding uses
the retained source execution and does not rerun this code. The equivalent
`IF(condition, then, else)` and exact `Decider` forms accept the same right-hand
threshold. Parameterized materialized forms require trusted canonical Decider
authority. Direct number parameters keep the existing native export rules
across these forms. Native numeric-template export rejects this derived
threshold with located `CP1002`; it remains a concrete local binding, not a
Factorio formula.

This complete example uses only two physical devices. The derived value is
evaluated locally into the exact Arithmetic constant slot; it is not emitted as
a Factorio formula and allocates no expression hardware:

```ts
const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5);
const input = new Network();
const output = new Network();
input += CC(3 * A);
const scaled = (amount + 1) * 2;
output += Arithmetic({
  left: input[A],
  operation: 'add',
  right: scaled,
  output: A,
});
```

At T0 the output is 0; with the default 5 it is 12 at T1 and 15 at T2. Binding
Amount to 9 gives 0, 20 and 23 at those ticks. Reset restores the original
default snapshot. Native numeric-template export rejects this derived expression
with located `CP1002`; direct number parameters in supported native slots remain
a separate feature.

This complete source example also uses one physical Constant. The count
expression is evaluated locally, while a bound non-unit multiplier remains a
concrete configuration and keeps the existing simulator limitation:

```ts
const amount = Param.number('Amount', 5);
const factor = Param.number('Factor', 2);
const scale = Param.number('Scale', 2);
const output = new Network();
output += Constant({
  sections: [
    {
      multiplier: scale * 0.5,
      filters: [{ signal: Signal('virtual', 'signal-A'), value: (amount + 1) * factor }],
    },
  ],
});
```

The default is multiplier 1 and count 12. Binding Amount to 9, Factor to 3,
and Scale to 3 produces multiplier 1.5 and count 30 without changing the
Constant or its topology. Non-unit multiplier simulation remains unsupported
(`FC1003`/Unknown), and native numeric-template export rejects this program
because its symbolic multiplier is outside the supported formula slice. A
derived count alone additionally needs direct physical uses and explicit native
variables for every dependency; neither result claims Factorio formula semantics.
