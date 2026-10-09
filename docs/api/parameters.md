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

Use parameters directly in these exact configurations:

| Constructor                           | Field                                                                               | Parameter kind   |
| ------------------------------------- | ----------------------------------------------------------------------------------- | ---------------- |
| `Arithmetic`                          | `left`, `right` as constant operands                                                | Number           |
| `Arithmetic`                          | `output`                                                                            | Signal           |
| `Constant`                            | `sections[].filters[].value`                                                        | Number           |
| `Constant`                            | `sections[].filters[].signal`                                                       | Signal           |
| `Constant`                            | `sections[].multiplier`                                                             | Number           |
| `Decider`                             | Right-hand numeric comparison threshold in `condition`, including nested conditions | Number           |
| `Selector` with `operation: 'select'` | `index`                                                                             | Number or Signal |
| `Selector` with `operation: 'count'`  | `output`                                                                            | Signal           |

Arithmetic constants, Constant filter counts, Decider thresholds and numeric
Selector indices require finite safe integers, then normalize to signed int32.
Constant section multipliers remain finite doubles. If one parameter is reused
in several fields, its chosen value must satisfy every field's rules. Values
are not rounded or clamped to make a failed binding pass.

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

| Mode                                                 | Values used                                       | Result                                                |
| ---------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| Ordinary compilation/export                          | Declared defaults                                 | Concrete circuit and JSON, without parameter metadata |
| Apply/Reset or CLI `--overrides`                     | Chosen values; omitted IDs use defaults           | Concrete circuit and JSON, without parameter metadata |
| CLI `--parameters` or **Include numeric parameters** | Original defaults plus supported numeric metadata | Native parameter-template JSON                        |

Concrete overrides and native-template export cannot be combined. The workbench
disables Apply/Reset while **Include numeric parameters** is checked.

Native-template export supports number declarations used directly as Constant
filter counts, Arithmetic constants, Decider right-hand thresholds or numeric
Selector select indices. All originals must fit signed int32 and remain present
in the exported fields. Signal declarations, symbolic section multipliers,
unused declarations and equal originals belonging to distinct parameters fail
explicitly in that mode. Native replacement may also affect ordinary literals
equal to an original; nominal independence in local binding does not establish
independence in Factorio placement.

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

Parameters are supported configuration values, not ordinary JavaScript numbers,
booleans, Signal handles or loop bounds. Do not use `amount + 1`, `5 * result`,
`input + amount`, `IF(input[A] > amount, ...)`, `when(...)` with a parameter
threshold, `parameter * Section(...)`, parameter keys or parameter coercion.
Use exact constructors and the fields above; compact syntax does not implicitly
gain the same parameter support. Internal host numeric-expression APIs do not
enable source formula operators.

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
