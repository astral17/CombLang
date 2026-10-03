# Blueprint JSON preview

The workbench and CLI generate readable Factorio blueprint JSON from the
canonical physical IR:

```ts
import { generateBlueprintJson } from '@comblang/compiler';

const json = generateBlueprintJson(elaboratedCircuit.ir, { label: 'My circuit' });
```

The generator emits ordinary JSON. It does not prepend the exchange-string
version byte, compress, or base64-encode the result.

The separate bounded, lossless exchange codec is documented in
[`blueprint-exchange-codec.md`](blueprint-exchange-codec.md). Its round trips and
self-generated fixtures are not native Factorio conformance evidence.

## Source export CLI

```text
factorio-dsl blueprint export [--json] [--parameters] [--label <text>] [--output <document.json>] [--prototypes <database.json>] [--prototype-identity <id>] <source.factorio.ts>
```

Save this parameter-free source as `simple.factorio.ts`:

```ts
const A = Signal('virtual', 'signal-A');
const output = new Network();
output += CC(5 * A);
```

After building, run from the repository root:

```sh
node apps/cli/dist/main.js blueprint export simple.factorio.ts
node apps/cli/dist/main.js blueprint export --label "My circuit" --output simple.json simple.factorio.ts
```

Default export uses concrete defaults and emits no parameter metadata, even
when the source declares parameters. The label defaults to `CombLang generated
circuit`; Decider expansion retains the 1024-row limit. Explicit `--parameters`
requests numeric native metadata from that same owning compilation; it never
falls back to concrete output after rejection. Without declarations, both modes
produce an ordinary document without empty parameter rows.

Save this numeric example as `numeric.factorio.ts`:

```ts
const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const limit = Param.number('Limit', 111, { formula: 'x * 2', dependent: true });
const output = new Network();
output += Constant({
  sections: [
    {
      filters: [
        { signal: A, value: amount },
        { signal: Signal('virtual', 'signal-B'), value: limit },
      ],
    },
  ],
});
```

Exact combinators require a matching Entity-capable prototype environment.
There is no implicit provider or synthetic profile in the CLI. Replace
`database.json` below with your normalized database containing the selected
combinator prototypes and the capabilities required by existing provisioning:

```sh
node apps/cli/dist/main.js blueprint export --prototypes database.json --parameters --output numeric.json numeric.factorio.ts
node apps/cli/dist/main.js blueprint encode --output numeric.txt numeric.json
```

The optional `--prototype-identity <id>` pins the provider identity, with the
same validation as `check`/`test`. Source executes once; local simulation and
concrete export use defaults, not formula results. Numeric `variable`, `formula`
and `dependent` fields are preserved opaquely. Native formula validity,
original-value substitution and placement are not verified. Signal declarations,
unsupported slots/expressions, unused parameters, ambiguous equal originals and
non-int32 originals fail explicitly. See the precise supported slots and native
limitations in [the parameter guide](native-objects-deciders-and-parameters.md).

Without `--output`, plain stdout contains only native JSON; warnings go to stderr.
With `--json`, stdout contains `{ "ok": true, "document": ... }`, with
`diagnostics` only when nonempty. File output contains only the native document;
stdout reports `Wrote <absolute path>` or `{ "ok": true, "output": ... }`.
Existing files, including the source itself, are never overwritten. The bounded
UTF-8 reader and output byte guard reuse the codec defaults. JSON is prepared
before exclusive file creation; a later I/O error can leave a partial file.

Failures exit with code 2, without publishing a document. Plain errors retain
source locations on stderr; `--json` uses
`{ "ok": false, "error": { "code": ..., "message": ..., "path": ..., "span": ..., "related": ... } }`
with optional error fields and a nonempty diagnostic list for compile errors.
Compiler/export codes such as `CP1002` are retained. Arguments are validated
before source execution. Exactly one source is accepted; `--` ends option parsing
for literal filenames beginning with `-`. Project linking, parameter overrides,
`--project`, `--format`, and `--exchange` are unsupported here. Exchange encoding
is a separate command. Worker/web export remains concrete without metadata
transport or parameter UI.

## Mapping

- arithmetic, decider, constant, and selector producers map to their native
  combinator prototypes;
- resolved Signal IDs retain their type and optional quality, while default
  item type is omitted from exported Signal IDs;
- resolved red/green Networks choose physical connector IDs and deterministic
  wire chains;
- arithmetic and Decider operands retain explicit red/green input selection;
- `pair(red, green)` connects both colors without allocating another device;
- explicit `.at(x, y, direction?)` placement is preserved and remaining
  entities receive deterministic positions;
- one linked producer plus one Entity emits one physical blueprint Entity.
  Placement and native configuration come from the Entity, while topology and
  output behavior come from the producer.
- Constant sections retain their one-based `index`, `active` state, ordered
  filters, `multiplier`, and optional `group`; unqualified filters export
  `quality: "normal"` explicitly. These fields are structurally preserved in
  the preview and do not claim native Factorio multiplier/group semantics.

Raw Entity configuration is copied after bounded JSON validation, with
compiler-owned identity, placement, direction, and wire fields kept separate.
Typed configuration is lowered only when its profile-owned rule and evidence
are valid. Opaque typed/payload values are rejected; they cannot silently
become native preview data.

The exact computation surface currently emits Constant sections, the supported
Arithmetic operations, ordered Decider branches, and Selector `select` or
`count`. Selector operations `random`, `quality-filter`, `quality-transfer`,
`rocket-capacity`, `stack-size`, and `time` remain explicit unsupported
diagnostics. These
outputs are deterministic implementation/model previews, not native Factorio
conformance or import/export round-trip evidence.

Nested Decider conditions are expanded into OR-connected groups of AND
comparisons with a default 1024-row export allocation limit. A missing resolved
operand color, unsupported native field, malformed physical Entity, or excessive
condition expansion fails with a source-aware `BlueprintJsonError`; the
generator never truncates or changes the circuit silently.

## Generated lookup evidence

The acceptance fixture `generated-lookup.factorio.ts` uses an ordinary
JavaScript helper and loop to build one membership condition for keys `10`,
`20`, and `30`, then emits one explicit Decider with two ordered duplicate
`signal-value` rows (`100` and `103`). Every matching key therefore produces
`203`; a missing key produces zero after the one-device tick boundary. The
canonical plan, deterministic test-session model, profile-free resolved
hydration, CLI/Worker artifacts, and blueprint JSON all agree on one physical
entity and its row order. This is exact structural and deterministic CombLang
model evidence only; it is not an arbitrary key-to-value LUT, native Factorio
conformance, or round-trip claim.

The audited validation budgets are explicit implementation limits: Constant
configuration input is bounded to depth 32, 4096 visited nodes, and 262,144
UTF-8 bytes; canonical condition nesting is bounded at 128 levels; detached
plan collections are bounded at 100,000 items; and the executed source path
has a 100,000 circuit-recording DSL-call safety limit. These limits reject or
report the payload; they are not claims about Factorio device capacity.
