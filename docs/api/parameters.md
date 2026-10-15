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

Use parameters in these exact configurations. Arithmetic operands, Constant
numeric slots, Decider thresholds, and Selector select indices also accept the
limited derived source expressions described below:

| Constructor                           | Field                                                                               | Accepted source value                      |
| ------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------ |
| `Arithmetic`                          | `left`, `right` as constant operands                                                | Number or local numeric expression         |
| `Arithmetic`                          | `output`                                                                            | Signal                                     |
| `Constant`                            | `sections[].filters[].value`                                                        | Number or local numeric expression         |
| `Constant`                            | `sections[].filters[].signal`                                                       | Signal                                     |
| `Constant`                            | `sections[].multiplier`                                                             | Number or local numeric expression         |
| `Decider`, `when`, or `IF`            | Right-hand numeric comparison threshold in `condition`, including nested conditions | Number or local numeric expression         |
| `Selector` with `operation: 'select'` | `index`                                                                             | Number, Signal or local numeric expression |
| `Selector` with `operation: 'count'`  | `output`                                                                            | Signal                                     |

For native typed-formula export, a registered expression in an exact Arithmetic
constant `left`/`right` operand, Constant filter `value`, constant-right
threshold of an exact Decider/`when`/`IF` condition, or numeric `index` of a
Selector `select` can produce a formula row. Constant section multipliers remain
local binding only. Native Signal placeholders are a separate bounded feature
for Constant filter `signal`, exact Arithmetic `output`, Selector Signal
`select.index`, and Selector `count.output` slots. In `select`, that Signal
provides the numeric index from the input network; it does not name the selected
output. In `count`, it names the Signal that receives the count. A referenced
number declaration is retained
as an original row even when its original value has no direct physical slot;
truly unreferenced declarations remain unsupported.

Arithmetic constants, Constant filter counts, Decider thresholds and numeric
Selector indices require finite safe integers, then normalize to signed int32.
Constant section multipliers remain finite doubles. If one parameter is reused
in several fields, its chosen value must satisfy every field's rules. Values
are not rounded or clamped to make a failed binding pass.

A number parameter may form a local source expression with finite numbers and
other owning number parameters using binary `+`, `-`, `*`, `/`, `**` or unary
`-`. Division and exponentiation use finite JavaScript-number semantics inside
this configuration DAG, not Factorio device arithmetic. Zero denominators,
negative bases with non-integral exponents, zero with a negative exponent and
overflow produce a non-finite result and a located `CP1000` error; JavaScript
`0 ** 0` is 1. Fractions are allowed at intermediate nodes, while
the final destination still applies the integer or finite-double rule above. The
opaque result is evaluated by the registered numeric DAG only when it occupies
an exact Arithmetic `left` or `right` constant slot, a direct Constant filter
count, a Constant section multiplier, the right-hand numeric threshold of an
exact Decider, `when(...).then(...).else(...)`, or `IF(condition, then, else)`
condition (including nested AND/OR conditions), or a Selector `select` index.
It creates no device and does not re-execute source during binding. Count,
threshold and Selector-index results must be finite safe integers before existing signed-int32
normalization; multipliers remain finite doubles. Parameter-free JavaScript
arithmetic remains ordinary JavaScript. `%` and bitwise operators remain
unsupported for symbolic expressions; TypeScript `^` remains bitwise XOR, not
power. Derived expressions are not booleans, circuit Conditions or native
formula strings.

### Registered Math functions

The local numeric DAG also captures the original `Math.abs`, `Math.log2`,
`Math.sign`, `Math.min` and `Math.max` functions when a call has at least one
direct owning number parameter or derived numeric expression argument. In this
symbolic form, `abs`, `log2` and `sign` require exactly one argument; `min` and
`max` require 2–255. Every argument must be a finite number, an owning number
parameter or an expression from the same parameter session. Results stay
opaque and are available only in the exact local configuration slots listed
above.

Recognition uses the original function identity, not a `Math`/method spelling:
aliases, destructuring, computed members and getters returning one of these
original functions work. The callee is prepared before its arguments, and
rebinding uses the same captured implementation even if source later changes a
`Math` property. Calls without a direct symbolic argument remain ordinary
JavaScript, including native coercion and arity behavior. Shadowed lookalikes,
other Math methods, and `.bind`/`.call`/`.apply` wrappers do not gain symbolic
support. Native formula projection of these call nodes is structural only;
Factorio formula acceptance, evaluation and placement remain unverified.

```javascript
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const C = Signal('virtual', 'signal-C');
const D = Signal('virtual', 'signal-D');
const E = Signal('virtual', 'signal-E');
const F = Signal('virtual', 'signal-F');
const amount = Param.number('Amount', 8, { variable: 'x' });
const output = new Network();
output += Constant({
  sections: [
    {
      filters: [
        { signal: A, value: amount },
        { signal: B, value: Math.abs(amount - 20) },
        { signal: C, value: Math.log2(amount) },
        { signal: D, value: Math.sign(amount - 20) },
        { signal: E, value: Math.max(amount, 16) },
        { signal: F, value: Math.min(amount, 4) },
      ],
    },
  ],
});
```

The local defaults are 8, 12, 3, -1, 16 and 4. Binding Amount to 16 changes
the concrete counts to 16, 4, 4, -1, 16 and 4 without rerunning the source.
The typed native exporter can structurally represent these calls in supported
formula slots, but that output is not Factorio conformance evidence.

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

| Mode                                         | Values used                                                                                             | Result                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Ordinary compilation/export                  | Declared defaults                                                                                       | Concrete circuit and JSON, without parameter metadata |
| Apply/Reset or CLI `--overrides`             | Chosen values; omitted IDs use defaults                                                                 | Concrete circuit and JSON, without parameter metadata |
| CLI `--parameters` or **Include parameters** | Original defaults plus supported numeric/Signal metadata and bounded typed Constant/Arithmetic formulas | Native parameter-template JSON                        |

Concrete overrides and native-template export cannot be combined. The workbench
disables Apply/Reset while **Include parameters** is checked.

Native-template export supports number declarations used directly as Constant
filter counts, Arithmetic constants, Decider right-hand thresholds or numeric
Selector select indices. Numeric originals must fit signed int32 and remain
present in the exported fields. Registered numeric expressions can additionally
produce bounded formula rows from exact Arithmetic `left`/`right` constant
operands, direct Constant filter counts, constant-right Decider thresholds and
numeric Selector select indices, as described below. Signal declarations in
Constant filter `signal`, exact Arithmetic `output`, Selector select-index
Signal, and Selector count-output slots follow the separate bounded contract
below.
Symbolic section multipliers, unused declarations and conflicting originals
fail explicitly in that mode. When a typed formula is present, its physical
circuit must contain only linked Constant, Arithmetic, Decider and Selector
producers; without typed formulas, existing direct-number export support for
Decider/Selector remains unchanged. Native Signal export accepts only linked
Constant, Arithmetic and Selector producers, with Signal handles restricted to
Constant filter `signal`, exact Arithmetic `output`, Selector `select.index`
Signal and Selector `count.output` slots. Native replacement also affects
matching concrete Signal literals in eligible Constant, Arithmetic and
Selector fields; nominal independence in local binding does not establish
independence in Factorio placement.

### Bounded typed native numeric formulas

A registered local numeric expression in an exact Arithmetic constant operand,
Constant filter count, constant-right Decider condition threshold, or
Selector `select` index can produce a derived native formula row. This is a
narrow structural export, not general formula parsing or native validation.
Each dependency must be an owned number declaration with an explicit valid
variable and no formula/dependent metadata. Its declared original is retained
whether or not that value occurs directly in a physical slot; no dummy field or
device is added. The native Signal gate accepts linked Constant, Arithmetic and
Selector producers; Signal handles use the exact fields described in the
bounded Signal section. Selector formula
projection has no Factorio placement evidence. In the example, `Amount` also
appears in direct Arithmetic and Decider slots; the formula slots are separate:

```javascript
const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const output = new Network();
output += Arithmetic({
  left: amount,
  operation: 'add',
  right: (amount * 2 + 3) * 5,
  output: A,
});
const input = new Network();
const gate = when(input[A] > amount && input[A] < amount * 2).then(input[A]);
output += gate;
gate.then(2 * A);
```

The source executes once and declares only `Amount`. Native-template export
keeps the physical Arithmetic defaults `first_constant: 5` and
`second_constant: 65`, and the final Decider thresholds 5 and 10. After the real
declaration it appends the Decider formula row `{ type: 'number', number: '10',
formula: '(x * 2)', dependent: true }`, then the Arithmetic row for 65. Local
binding to 9 reevaluates the same physical slots as 9/18 and 9/105, with no
parameter metadata in concrete JSON; it does not rerun source or create another
device.

In typed-formula mode, every supplied numeric `metadata.variable` must be valid
and unique. Each dependency must be an owned number declaration with an
explicit `metadata.variable` matching `[A-Za-z][A-Za-z0-9_]*`; built-ins `abs`,
`log2`, `sign`, `max`, `min` and recipe-reference names such as `p12_recipe` are
reserved. A declaration referenced only inside a typed expression is still
used and its explicit original row is exported; truly unreferenced declarations
remain errors. A dependency must not itself declare `formula` (even an empty
string) or `dependent: true`. Typed formula export requires a linked
physical circuit containing only Constant, Arithmetic, Decider and Selector
producers. It
accepts finite numeric literals, including decimal/scientific values outside
int32, and registered `+`, `-`, `*`, `/`, `**` and unary-negation nodes.
The raw evaluated default must itself be signed int32 and match its physical
field; fractional or out-of-range defaults are rejected. This does not relax
declared numeric-original bounds or the local integer-destination rules.
Literal text uses the shortest round-trip decimal spelling; positive exponent
plus signs are omitted (for example, `1e+21` renders as `1e21`). This bounded
structural spelling is not a claim of complete MathExpression grammar support or
native Factorio acceptance. Output is fully parenthesized without folding or
reassociation and respects bounded node and byte limits. Repeated identical
default/formula pairs share one row across all four families. Different formulas
for the same derived original, or collision with any declared number original,
reject atomically with located `CP1002`.

Real declaration rows retain declaration order. Generated rows follow collection
order: Selector select indices first, Decider templates and recursive leaves
second, Arithmetic templates third (left then right within each template), then
Constant templates in section/filter order. This preserves existing Constant-only
ordering and does not promise global source order across families.

Generated rows are derived exporter metadata, not source declarations or new
local handles; they have no fabricated `name` or variable. Physical counts and
placement remain unchanged. Factorio may replace ordinary numeric literals
matching a parameter original as well, unlike local nominal binding. Only typed
local expressions in exact Arithmetic constant operands, direct Constant count
slots, constant-right Decider thresholds and Selector numeric select indices
receive this treatment; symbolic multipliers and derived expressions in other
slots remain unsupported. Native formula projection maps source `**` to native
`^` and fully parenthesizes both operands and the expression tree. Division and
power formulas are only structurally projected: the pinned generic
MathExpression grammar lists `/` and `^`, but this feature has no Factorio
formula evaluation or placement evidence. In TypeScript, `^` still means
bitwise XOR. Opaque formula strings remain opaque.

#### Formula-only dependency example

`Amount` is referenced only by a typed formula here. Export still retains its
declared original row (`5`) followed by the derived row (`10`); the only
physical count remains `10`. Binding Amount to 7 changes that count to 14, and
reset restores 10. No dummy device or physical count of 5 is introduced. These
rows are structural native-template output, not evidence that Factorio accepts
or evaluates the generated function formula.

```javascript
const amount = Param.number('Amount', 5, { variable: 'x' });
const output = new Network();
output += Constant({
  sections: [
    {
      filters: [{ signal: Signal('virtual', 'signal-A'), value: Math.abs(amount * 2) }],
    },
  ],
});
```

#### Bounded division example

The expression DAG evaluates `amount / 2 + 3` to 8 at the default Amount of 10.
Binding Amount to 14 gives 10; binding it to 11 produces 8.5 and is rejected in
this integer Constant-count slot. The generated native row retains the same
tree as `((x / 2) + 3)` with original 8; this is structural export, not a claim
that Factorio has accepted or evaluated this formula.

```javascript
const amount = Param.number('Amount', 10, { variable: 'x' });
const output = new Network();
output += Constant({
  sections: [
    {
      filters: [
        { signal: Signal('virtual', 'signal-A'), value: amount },
        { signal: Signal('virtual', 'signal-B'), value: amount / 2 + 3 },
      ],
    },
  ],
});
```

#### Bounded finite-literal example

Finite literals may be fractional or exceed int32 inside a registered expression.
With Amount 10, `amount * 0.5 + 1` has raw default 6 and binds to 8 at Amount 14;
Amount 11 produces 6.5 and is rejected by this integer Constant-count slot. The
large intermediate `(amount + 2147483648) - 2147483647` has raw default 11 and
remains eligible for native projection because its final value is signed int32.
The generated formulas are `((x * 0.5) + 1)` and
`((x + 2147483648) - 2147483647)`; physical defaults remain 10, 6 and 11.
This is structural export, not a claim that Factorio accepts or evaluates either
formula.

```javascript
const amount = Param.number('Amount', 10, { variable: 'x' });
const output = new Network();
output += Constant({
  sections: [
    {
      filters: [
        { signal: Signal('virtual', 'signal-A'), value: amount },
        { signal: Signal('virtual', 'signal-B'), value: amount * 0.5 + 1 },
        {
          signal: Signal('virtual', 'signal-C'),
          value: amount + 2147483648 - 2147483647,
        },
      ],
    },
  ],
});
```

#### Bounded power example

`**` follows JavaScript-number semantics in the local DAG. With Amount 3, the
two derived Constant counts are 10 and 8; binding Amount to 4 produces 17 and 16. The native template keeps the physical defaults and writes derived rows
using native `^` syntax: `(((x) ^ (2)) + 1)` and `((2) ^ (x))`. This is a
bounded structural projection, not evidence that Factorio accepts or evaluates
these formulas.

```javascript
const amount = Param.number('Amount', 3, { variable: 'x' });
const output = new Network();
output += Constant({
  sections: [
    {
      filters: [
        { signal: Signal('virtual', 'signal-A'), value: amount },
        { signal: Signal('virtual', 'signal-B'), value: amount ** 2 + 1 },
        { signal: Signal('virtual', 'signal-C'), value: 2 ** amount },
      ],
    },
  ],
});
```

A user-returned final placement export for a separate Constant-only generated `(x * 2)` case records
normal virtual A=9 and B=18 at Amount=9 ([Factorio 2.1.21 fixture](../../fixtures/blueprint-exchange/factorio-2.1.21/generated-number-formula-placed.txt)).
This is one bounded native placement observation: current mods were unspecified,
save/reopen was not observed, and the export has no `wires` field, so it says
nothing about wired layouts. It does not validate other generated operators,
functions, Arithmetic, Decider or Selector formula placement, other formula
slots, versions or mod configurations. No native Decider or Selector formula
placement evidence is recorded.

The generic MathExpression reference in the
[pinned Factorio 2.1.21 API input](../../tools/factorio-api/fixtures/2.1.21/runtime-api.json)
documents `+`, `-`, `*`, `/`, `^`, parentheses, and the built-ins `abs`, `log2`,
`sign`, `max` and `min`.
The typed exporter supports registered nested `+`, `-`, `*`, `/`, `**`, unary
negation, and calls to `abs`, `log2`, `sign`, `min` and `max` under the
argument and slot restrictions documented above. This is not a general parser
for the referenced grammar. In TypeScript,
`^` is bitwise XOR, not exponentiation; only the private native projection
translates registered `**` nodes to `^`. Explicit native `formula` metadata
remains opaque: local binding does not parse or evaluate it.

### Bounded native Signal export

The native exporter supports concrete item, fluid, or virtual Signal defaults
with omitted or normal quality when their parameter handles occupy Constant
filter `signal`, exact Arithmetic `output`, Selector select-index Signal or
Selector count-output slots. For example,
`Param.signal('Material', Signal('iron-plate'))`
and `Param.signal('Coolant', Signal('fluid', 'water', 'normal'))` use the same
bounded path as a virtual Signal. Source runs once and retains each complete
concrete default for ordinary local binding. Native export allocates the first
free `parameter-0` through `parameter-9` name, reserving names already present in
eligible Constant rows, Arithmetic `first_signal`, `second_signal`, and
`output_signal` fields, Selector `select.index_signal`, and Selector
`count.count_signal`, and emits an ID parameter with the declaration label
and normal-quality `=` condition. The concrete source default is neither
persisted as a native placement default nor used to constrain the namespace
selected when placing the template.

Constant example (requires the selected environment's existing Constant
provisioning capabilities):

```ts
const channel = Param.signal('Channel', Signal('virtual', 'signal-A'));
const material = Param.signal('Material', Signal('iron-plate'));
const coolant = Param.signal('Coolant', Signal('fluid', 'water', 'normal'));
const output = new Network();
output += Constant({
  sections: [
    {
      filters: [
        { signal: channel, value: 5 },
        { signal: Signal('virtual', 'signal-A'), value: 13 },
        { signal: material, value: 7 },
        { signal: Signal('iron-plate'), value: 17 },
        { signal: coolant, value: 11 },
        { signal: Signal('fluid', 'water'), value: 19 },
      ],
    },
  ],
});
```

Mixed Constant/Arithmetic example:

```javascript
const channel = Param.signal('Channel', Signal('virtual', 'signal-A'));
const input = CC(2 * Signal('virtual', 'signal-A'));
const output = new Network();
output += Constant({
  sections: [
    {
      filters: [
        { signal: channel, value: 5 },
        { signal: Signal('virtual', 'signal-A'), value: 13 },
      ],
    },
  ],
});
output += Arithmetic({
  left: input[Signal('virtual', 'signal-A')],
  operation: 'add',
  right: 3,
  output: channel,
});
```

Selector index/count example:

```javascript
const index = Param.signal('Index', Signal('virtual', 'signal-A'));
const countOutput = Param.signal('Count output', Signal('virtual', 'signal-B'));
const input = new Network();
const selected = new Network();
const counted = new Network();
selected += Selector({ input, operation: 'select', index });
counted += Selector({ input, operation: 'count', output: countOutput });
```

The two placeholders target `index_signal` and `count_signal`, respectively.
The select index Signal supplies a numeric count from the Selector input; it
does not rename the selected output. The count output Signal names the result
that receives the number of distinct non-zero input Signals. This example is
structural only; native Factorio selection and placement remain pending.

The Constant example allocates `parameter-0` through `parameter-2`; the mixed
example uses `parameter-0` for virtual A. Every matching eligible occurrence is
replaced—including ordinary concrete Constant rows, Arithmetic Signal fields,
and Selector `index_signal`/`count_signal` fields—while counts and unrelated
circuit fields remain intact. Native metadata
is based on normalized source identity, not the local nominal handle. A local
override to B changes only marked `channel` slots; an ordinary equal A row/input
stays A under local binding. The concrete source default remains the local
binding default; a generic native ID row does not promise which namespace/name
is selected at placement. Repeated uses of one handle are supported, but
distinct handles with the same normalized original are not. Any eligible
concrete field with the same name but a different namespace or quality is
ambiguous and rejects with a located error.

This slice accepts direct Constant filter Signal slots, exact Arithmetic
output slots, Selector select-index Signal slots and Selector count-output
slots, in circuits whose producers are linked Constant, Arithmetic or Selector
producers; any physical Entity must be linked to its producer. Arithmetic
Signal parameters are not supported in input operands or Network keys. Numeric
Selector index parameters and formulas keep their existing numeric path.
Non-normal qualities, virtual wildcards, source defaults named `parameter-N`,
placeholder-pool exhaustion, unused declarations, Decider/other producers and
Signal use in any other native slot reject atomically with located `CP1002`.
No general native replacement, formula evaluation, or broader native acceptance
is implied. For one user-reported placement of this generated
virtual/normal Constant template in Factorio 2.1.21 (mods unspecified), both
matching Constant rows became virtual signal-B with counts 5 and 13; iron-plate
and water, the red wire, relative layout and directions were preserved. This
evidence covers only the Constant example, not Arithmetic output or Selector
Signal substitution.
The placed export contains no parameter metadata. This bounded report is not an
independently run game gate. Item/fluid placement and selection, Arithmetic or
Selector Signal placement, parameterized save/reopen, other qualities or native
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
fluent `when`, or `IF` condition, or a Selector `select` numeric index described above.
Do not use derived expressions for
modulo/bitwise operations, ordinary JavaScript comparisons,
truthiness, coercion, property access, parameter keys, compact arithmetic, other
Constant fields, Decider outputs, other Selector fields, negated conditions, or
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
derived count in a supported slot retains its dependency originals without a
direct physical use, but still requires explicit native variables and direct
leaf metadata; neither result claims Factorio formula semantics.
