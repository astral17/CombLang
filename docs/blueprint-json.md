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
factorio-dsl parameters list [--json] [--project <comblang.json>] [--prototypes <database.json>] [--prototype-identity <id>] [source.factorio.ts]
factorio-dsl blueprint export [--json] [--parameters | --overrides <values.json>] [--label <text>] [--output <document.json>] [--prototypes <database.json>] [--prototype-identity <id>] <source.factorio.ts>
factorio-dsl blueprint export [--json] [--parameters | --overrides <values.json>] [--label <text>] [--output <document.json>] --project <comblang.json> [--prototype-identity <id>] [source.factorio.ts]
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
node apps/cli/dist/main.js blueprint export --project examples/prototype-stack/comblang.json
```

`parameters list` describes declarations from one source execution. Save a
parameterized source as `numeric.factorio.ts` and list its detached descriptors
in declaration order:

```sh
node apps/cli/dist/main.js parameters list --json --prototypes database.json numeric.factorio.ts
node apps/cli/dist/main.js parameters list --project comblang.json
```

The JSON result is `{ "ok": true, "parameters": [...] }`, with compile
diagnostics when present. Plain output shows each ID, kind, JSON-quoted label and
JSON default; a source with no declarations prints `No parameters declared.`
Labels and defaults may repeat; IDs distinguish declarations only within this
execution. Plain-mode warnings go to stderr; JSON-mode warnings stay in the
diagnostic list. Compile errors return failure diagnostics and
no partial listing. As with export, exact combinators may need the selected
Entity-capable prototype environment.

Default export uses concrete defaults and emits no parameter metadata, even
when the source declares parameters. The label defaults to `CombLang generated
circuit`; Decider expansion retains the 1024-row limit. Explicit `--parameters`
requests numeric native metadata from that same owning compilation; it never
falls back to concrete output after rejection. Without declarations, both modes
produce an ordinary document without empty parameter rows. Concrete
`--overrides` mode accepts only an empty array when there are no declarations.

`--project` reuses a CLI project profile's one configured source and prototype
database for listing and export. Omitting the positional source selects the
configured source; one explicit source replaces it. The `--project` filename
resolves from the current working directory; paths configured inside that file
resolve from its directory. An explicit source, override file and `--output`
resolve from the current working directory. Listing and export ignore the
configured test path entirely and do not read, compile or execute that file.
Project diagnostics and prototype
identity selection follow the same rules as `check` and `test`; an explicit
`--prototype-identity` may repeat a project pin or pin an unpinned project.
Malformed export arguments are rejected before project or provider loading.
This remains one source compilation, not multi-file project linking.

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

For concrete local overrides, write a JSON array using the listed declaration
IDs and the runtime adapter's `{ id, value }` shape. For example, if the source
declares two numeric parameters in that order:

```json
[
  { "id": 0, "value": 11 },
  { "id": 1, "value": 42 }
]
```

Then export the bound concrete circuit (this mode cannot be combined with
`--parameters`):

```sh
node apps/cli/dist/main.js blueprint export --prototypes database.json --overrides values.json --output chosen.json numeric.factorio.ts
```

Overrides are a full snapshot against the source's original defaults, not a
delta: omitted IDs reset to their declared defaults. Keep explicit entries even
when their value equals the default; in particular, an explicit override for an
unused declaration must retain the runtime adapter's `CP1001` error. IDs are
local to this listing/source execution, follow declaration order and are not
stable across source edits or dynamic executions. A separate list and export
command execute source separately, so a dynamic source is not implicitly pinned
to the earlier listing.

The override file is ordinary JSON and is read as bounded UTF-8 input (1 MiB
maximum) before project/provider loading or source execution. Its array, ID,
Signal and slot semantics are validated by the existing runtime binding adapter;
there is no second CLI validator, label-keyed format or `id=value` syntax. For a
source without declarations only `[]` is accepted; any other override input is
an explicit error, never ignored. Binding failures keep their `CP1000`/`CP1001`
codes, semantic paths and declaration spans, and do not create an output file or
fall back to defaults.

Concrete binding supports only the existing exact source slots: Arithmetic's
direct numeric operand or Signal output; Constant's direct filter Signal/count
and section numeric multiplier; Decider's direct right-hand numeric threshold;
and Selector `select`'s numeric/Signal index or `count`'s Signal output. Other
slots, source expressions on parameter handles and unsupported declarations
remain explicit errors; this command does not add Factorio-native substitution
or formula evaluation. See the [parameter guide](native-objects-deciders-and-parameters.md)
for the complete source and model limits.

The optional `--prototype-identity <id>` pins the provider identity, with the
same validation as `check`/`test`. Source executes once per invocation. Ordinary
export and native-template mode use original defaults; concrete `--overrides`
export uses the chosen bound values. Neither mode evaluates formula metadata.
Numeric `variable`, `formula`
and `dependent` fields are preserved opaquely. Native formula validity,
original-value substitution and placement are not verified. Signal declarations,
unsupported slots/expressions, unused parameters, ambiguous equal originals and
non-int32 originals fail explicitly in `--parameters` native-metadata mode. See
the precise supported slots and native
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
before source execution. Exactly one source is accepted without `--project`; a
project accepts zero or one explicit source. `--` ends option parsing for literal
filenames beginning with `-`. Project linking, `--format`, and `--exchange` are
unsupported here. Exchange encoding is a separate command. The web panel also
offers both [concrete parameter controls](#optional-worker-local-parameter-binding)
and the separate [numeric native-metadata export mode](#web-blueprint-panel).

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

## Optional Worker result export

The existing compiler Worker `parse` request accepts optional cloneable
`blueprintExport: { parameters?: boolean; label?: string }` data. Omitting it
preserves the previous response shape and performs no extra native projection.
An empty record requests concrete JSON; `parameters: true` requests the same
supported numeric metadata as the CLI, from the exact Worker-local compilation.
With no declarations, both requested modes return an ordinary concrete document.
The default label is `CombLang generated circuit` and the expansion bound remains
1024 rows. Explicit `false` and an empty label are accepted.

```ts
const request = {
  kind: 'parse',
  revision: 7,
  file: { path: 'simple.factorio.ts', text: 'const output = new Network();' },
  blueprintExport: { parameters: true, label: 'My circuit' },
};
// Post this ordinary data to the existing compiler Worker.
```

The existing `parsed` response echoes the revision and adds only an optional
`result.blueprintExport` union:

```ts
type BlueprintExportResult =
  { ok: true; document: FactorioBlueprintJson } | { ok: false; diagnostics: readonly Diagnostic[] };
```

`FactorioBlueprintJson` is the readable native document type from
`@comblang/compiler/blueprint-json`; `Diagnostic` is from `@comblang/shared`.
The field belongs to the web application result, not to the canonical source
artifact, Direct Plan or NCIR schema. The whole response is cloneable: it contains
no local execution, parameter handles, registrations, symbolic templates, callbacks
or trusted replay authority. Opaque native formula strings are ordinary document
data, not executable expressions.

Export happens before local capture is stripped, with a single source execution.
Failure of an explicit numeric/native export returns diagnostics and no fallback
document, without adding errors to an otherwise successful compilation pipeline.
Its concrete Plan/ResolvedCircuit remains usable for tests and simulation.
Compile/preflight errors produce a failed requested export using the existing
error diagnostics and do not attempt projection. Warnings remain in the compile
pipeline and do not prevent export. Codes, source spans and related information
are retained; semantic paths appear in diagnostic messages.

Options are checked before provider loading or source execution. Only plain or
null-prototype enumerable data records with boolean `parameters` and string
`label` fields are accepted; present `undefined` fields, accessors, symbols,
unknown keys and wrong types produce a source-independent `WP1005` preflight
error. Labels use the codec's existing 4,194,304-byte UTF-8 limit. Options are
snapshotted immutably without invoking getters. Provider/profile validation,
Worker cache selection and revision/progress behavior remain unchanged; options
do not grant Entity authority or infer a provider. Exact combinators still need
the existing selected profile or trusted Worker-local host environment.

This provides an opt-in result transport, not parameter overrides or a binding
protocol. Native formula evaluation,
original-value substitution, recipe dependencies and placement validity remain
unverified. Default preview/copy and simulation continue to use concrete defaults.

## Optional Worker-local parameter binding

An in-process owner of a `CompilerWorkerRuntime` can opt in to a detached
parameter listing, then bind a full override snapshot against the exact retained
compilation:

```ts
import { CompilerWorkerRuntime } from '../apps/web/src/compiler-worker-request.js';

const runtime = new CompilerWorkerRuntime();
const parsed = await runtime.handle({ ...request, revision: 7, parameterBinding: true });
const listing = parsed.parameterBinding;
if (listing?.ok && listing.token !== undefined) {
  const bound = runtime.handleBinding({
    kind: 'bind-parameters',
    revision: 8,
    sourceRevision: 7,
    token: listing.token,
    overrides: [{ id: 0, value: 9 }],
  });
}
```

`parameterBinding` is an optional parse-request boolean. The optional
`parsed.parameterBinding` response is outside `result`: successful compilation
returns detached, cloneable declaration descriptors and an opaque token when
there are parameters; a parameter-free compilation returns an empty listing
without a token. Compile errors return their existing error diagnostics and do
not retain a session. A failure of optional native blueprint export does not
prevent binding a successful compilation. Invalid flag data is rejected as
`WP1006` before profile loading or source execution.

The bind request's `revision` is its correlation ID; `sourceRevision` identifies
the parse response that issued the token. The caller contract requires both to
be non-negative safe integers; their meanings must not be conflated. Its `overrides` field is cloneable data
when sent through `postMessage`; omission or `[]` means the original source
defaults, never the last bound values.

The response has `kind: 'bound'` and echoes both revisions. Its `result` is either
`{ ok: true, plan, resolvedCircuit }`—the existing fresh concrete pair—or
`{ ok: false, diagnostics }`. The operation reuses the retained compilation and
does not execute source or reload a profile. `WP1007` reports a missing, expired,
or mismatched token/revision; valid-token binding preserves `CP1000`, `CP1001`,
and `CP1002` diagnostics and source spans. Unexpected binding exceptions become
`WP1008` without a stack or invented source span.

The token routes only to one in-memory session in that Worker runtime; it is not
an authorization credential or persistent identifier. Starting any later parse
expires the slot immediately, including while a newer parse is still in flight.
A failed bind does not expire the current session, so a valid retry can follow.
No source is persisted, and binding does not evaluate native formula metadata or
establish Factorio behavior.

The compiler Worker scheduler routes parse and bind operations through one active
slot and one latest-operation queue. It retains only the current generation's
source revision and token as routing metadata. A newly queued parse clears that
capture immediately and takes precedence over queued bindings; queued bindings
for the current capture coalesce to the latest request. Matched bound responses
release the active slot, while stale responses are not applied. Binding uses the
existing Worker and never recompiles source.

The current page opts into parameter capture on compilation. Its **Circuit
parameters** section lists number and Signal declarations. **Apply** binds the
edited values against that retained source; **Reset** restores the original
declaration defaults and binds an empty override snapshot. Neither action reruns
source. Each successful binding supplies the matching concrete plan and resolved
circuit to preview, independent circuit tests, and concrete blueprint JSON.

Numeric inputs accept fractional values without integer clamping; invalid values
are reported by the Worker at their declaration. Signal fields select a namespace
and accept exact name and optional quality text. Empty quality means omitted/normal;
omitted, empty and `normal` quality compare equally when deciding whether a default
has changed. Signal names and other quality text are not trimmed. Unchanged
declarations are omitted from each full snapshot, including unused declarations.
Errors clear the previous preview, tests and copy payload while retaining edited
fields for a valid retry. Original generated JavaScript remains the source output.

Each successful bind creates a fresh simulation at T0; previous tick edits and
history are not carried over. New Apply/Reset requests can replace a queued bind
with the latest values. Source or prototype-profile changes immediately invalidate
the controls. Worker loss or an expired capture disables Apply/Reset; **Recompile
source** explicitly executes the current source again to obtain a new capture.
Sources without declarations show an empty-parameters message. Parameter drafts
and capture tokens are not saved across reloads or source recompilation. This
browser-local binding behavior does not establish native Factorio acceptance.

### Web blueprint panel

The labelled **Include numeric parameters** checkbox is off by default and is
not saved across reloads. Turning it on recompiles the current source through
the existing Worker and displays its exact native export document. **Copy
blueprint** copies that displayed readable JSON, not an exchange string or an
export-result envelope. With no declarations, the result is ordinary concrete
JSON in either mode. Turning the checkbox off restores concrete artifact export.

Only the supported numeric slots described above are exported. Unsupported
Signal parameters or other export failures show located diagnostics in the
blueprint panel and disable copy; a missing Worker export result is also an
explicit unavailable error, never a concrete fallback. Successful compilation
still permits concrete simulation and circuit tests. Pending recompilation,
source/profile errors and mode changes immediately clear the previous copy
payload. Changing the checkbox does not edit source or test drafts; recompilation
uses the existing fresh-simulation behavior rather than migrating tick state.

While **Include numeric parameters** is checked, Apply/Reset are disabled: this
mode exports the original source template, rather than a bound circuit. Turning it
on recompiles source and resets local parameter edits to the declaration defaults.
Turn it off to edit and bind concrete values again. Native formula strings are
preserved as metadata and are not evaluated locally; template-mode simulation uses
the declared defaults.
Showing or copying a document is not evidence of native placement or formula
validity.

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
