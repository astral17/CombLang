# Compiler Worker export and parameter binding

[Documentation](README.md) · [User export guide](blueprint-json.md)

This reference is for hosts embedding the browser application's compiler Worker.
It describes cloneable messages and Worker-local capture ownership; none of these
methods is a circuit-source DSL operation. For CLI commands and workbench buttons,
use the [user guide](blueprint-json.md#source-export-cli).

The request/response types live in `apps/web/src/worker-protocol.ts`; the
in-process owner is `CompilerWorkerRuntime` from
`apps/web/src/compiler-worker-request.ts`. A real Worker uses the same data through
`postMessage`; the following in-process calls are not a second protocol.

## Result export

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

## Parameter binding

An in-process owner of a `CompilerWorkerRuntime` can opt in to a detached
parameter listing, then bind a full override snapshot against the exact retained
compilation. This is embedding code, not source to paste into the editor.
`prototypeDatabaseJson` below is host-supplied normalized prototype JSON with the
required Constant provisioning capabilities; see [prototype loading](prototype-environment.md).
The source contains a used numeric declaration, unlike the parameter-free
result-export request above:

```ts
import { CompilerWorkerRuntime } from '../apps/web/src/compiler-worker-request.js';

const runtime = new CompilerWorkerRuntime();
const parsed = await runtime.handle({
  kind: 'parse',
  revision: 7,
  file: {
    path: 'bound.factorio.ts',
    text: `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5);
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: A, value: amount }] }] });`,
  },
  prototypeProfile: { source: prototypeDatabaseJson },
  parameterBinding: true,
});
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

## Scheduling and invalidation

The compiler Worker scheduler routes parse and bind operations through one active
slot and one latest-operation queue. It retains only the current generation's
source revision and token as routing metadata. A newly queued parse clears that
capture immediately and takes precedence over queued bindings; queued bindings
for the current capture coalesce to the latest request. Matched bound responses
release the active slot, while stale responses are not applied. Binding uses the
existing Worker and never recompiles source.

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
