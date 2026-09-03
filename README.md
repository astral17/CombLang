# CombLang

CombLang is an early implementation of a TypeScript-shaped structural HDL for Factorio 2.1 circuit networks. The checked-in design and implementation notes live in [`docs/architecture.md`](docs/architecture.md).

The current repository implements the Phase 3 source compiler, the complete Phase 4 ownership/multi-network surface, and its 4.5/4.6 boundary-hardening passes grown from the original Phase 0 skeleton:

- one parser API shared by Node and the browser;
- stable source file IDs and half-open source spans;
- normalized syntax diagnostics;
- a CLI that checks syntax, DSL semantics, executed elaboration, topology, and wire colors;
- a responsive source editor with CodeMirror 6 on desktop and a native mobile textarea fallback;
- a reload-safe draft isolated per browser tab, a persistent compiler Worker, and production offline asset caching;
- a responsive browser workbench with generated-JavaScript inspection, live circuit statistics, a waveform, and copyable blueprint JSON;
- initial `SignalId`, Factorio `int32`, `SparseBus`, network aggregation, and synchronous tick-kernel primitives;
- arithmetic and decider combinator evaluation, including wildcard and one-tick device adapters;
- a direct elaboration runtime that builds EG/NCIR, solves red/green constraints, and materializes a synchronous simulation;
- package boundaries for compiler, runtime, layout, and renderer.
- explicit zero-tick `destination.take(source)` Network union with runtime move tracking and EG/NCIR identity collapse.
- executable `Readonly<Network>` and `Ref<Network>` function borrows with alias-safe runtime enforcement, expiry checks, and color-qualified requirements.
- explicit `Move<Network>` function transfer with caller-alias invalidation, owned returns, and recursive array/plain-object return handling.
- ordinary variable, destructuring, array, and object aliases that share one Network ownership token, with `slot = Transform(slot)` replacement after a `Move<Network>` return.
- immutable `pair(a, b)` both-colors input views with summed signal reads, opposite-color constraints, simulation, and blueprint wiring.

## Roadmap

- [x] Phase 0 — repository/core skeleton: workspaces, shared IDs and spans, CLI, CI, and the browser/Node parser boundary.
- [x] Phase 1 — Factorio semantics kernel: int32 values, sparse buses, arithmetic/decider semantics, wildcards, and synchronous simulation.
- [x] Phase 2 — direct elaboration runtime: EG/NCIR, session-bound handles, attachments, provenance, color solving, and the MemoCell integration slice.
- [x] Phase 3 — executed source compiler: conservative semantic checks, DSL-sensitive JavaScript transformation, runtime elaboration, provenance, color solving, CLI validation, and the browser workbench.
- [x] Phase 4 — ownership, multi-network syntax, Producer identity, semantic/runtime boundary hardening, opaque session values, and complete CLI/browser/EG/NCIR acceptance coverage.
- [x] Phase 5 — deterministic testbench, external-world adapters, Unknown propagation, traces, and debug hierarchy
  - [x] Define a browser/Node-neutral `TestSession` over an already elaborated circuit; test operations must never mutate EG/NCIR topology or re-execute source elaboration.
  - [x] Freeze the synchronous test clock: every participant reads snapshot `T`, all combinators and reactive models evaluate independently, and their writes commit together to `T+1` regardless of traversal order.
    - [x] Prevent scheduled callbacks from advancing time reentrantly or scheduling work into the boundary already being evaluated; callbacks may still schedule later boundaries.
    - [x] Reject TestSession/provider/trace/topology mutation during participant evaluation, independently guard both simulation kernels, and keep scheduled pre-boundary stimulus legal.
    - [x] Seal each TestSession after its synchronous test body so delayed Promise/microtask callbacks cannot mutate a completed result; document model purity and the limits of rollback for arbitrary JavaScript side effects.
  - [x] Introduce the MVP whole-bus lattice `Known(SparseBus) | Unknown(origins)` with epistemic semantics, deterministic origin canonicalization, three-valued AND/OR short-circuiting, and inactive-branch elimination for non-`Each` Deciders.
  - [x] Keep ordinary production simulation on the concrete fast path while allowing a test session to opt into Known/Unknown propagation without widening `SparseBus` itself.
  - [x] Implement persistent `drive(network, values)`, replacement, `clear(network)`, and one-boundary `pulse(network, values)` external broadcasters with canonical Signal identity and int32 conversion.
  - [x] Define testbench drives as external circuit participants that bypass source-level `Readonly`/`Ref` capabilities while moved debug targets and handles/debug entries from another execution remain invalid.
  - [x] Implement signal and whole-bus assertions: exact value/bus, partial containment, empty/support checks, known/unknown checks, and failures that report tick, target, expected/actual values, and Unknown dependency chains.
  - [x] Implement `tick()`, `tick(count)`, scheduled `at(tick, callback)`, bounded `run(count)`, and `settle({ maxTicks })`; settling uses observed whole-circuit state equality and fails clearly for oscillation/non-convergence.
  - [x] Build a shared `DebugIndex` from lexical bindings, source spans, function-call instance paths, loop provenance, Networks, and physical Producers without exposing function locals to ordinary production code.
  - [x] Implement test-only `t.instantiate(fn, ...args)` so `dut.value` has topology identical to an ordinary call while the completed execution resolves `dut.$` to only that captured debug scope root.
  - [x] Provide the v1 string/query hierarchy for `network(name)`, `combinator(name/index)`, nested calls, repeated function calls, and loop instances; ambiguous and missing queries are deterministic diagnostics rather than first-match guesses.
  - [x] Add structural assertions over a debug scope and its descendants: physical producer counts by kind, Network/Producer presence, placement/config inspection, zero-tick aliases, and shortest combinator tick latency without advancing simulation.
    - [x] Carry the executed Producer ID explicitly into the debug index and visit typed IR Network references for latency instead of relying on producer array position or recursive string matching.
  - [x] Define the generic object circuit-adapter protocol before typed Phase 6 objects: connector input snapshots, output injection, session-bound instance identity, and copied adapter-level defaults, proven with a test-only adapter.
  - [x] Implement persistent manual `mock(entity, connector?).output(bus)` injection through the adapted object's real output Networks; replacement and `clear()` preserve defaults, normal aggregation, scheduling, and self-contamination behavior.
  - [x] Implement reactive `model(entity, { initialState, step })`; the runner invokes `step({ input, state, tick })` exactly once per tick and commits returned output/state atomically only at the next boundary.
  - [x] Resolve unmodeled object output in the order explicit mock/model → per-instance default → class default → global policy, with strict `Unknown` as the default and explicit `zero`/custom policies.
  - [x] Implement trace registration for selected signals, whole Networks, object inputs, and object outputs; store tick-zero plus sparse/delta changes and expose deterministic JSON/timeline queries without coupling storage to a chart renderer.
    - [x] Whole-Network and selected-signal targets, tick-zero capture, Known/Unknown transitions, sparse signal deltas, removals, timeline filtering, and deterministic `comblang-trace` JSON.
    - [x] Object input aggregates and isolated committed object-output contributions, including Known/Unknown transitions and stable object/connector metadata.
    - [x] Treat colliding trace IDs for different targets as an invariant violation while keeping repeated registration of the same target idempotent.
  - [x] Surface test results, assertion diagnostics, debug queries, and waveform data consistently through runtime APIs, CLI JSON, and the browser result model; keep visual waveform rendering a consumer of the shared trace model.
    - [x] Browser-local editable test file, isolated worker execution, pass/fail list with assertion/runtime source locations, independent draft persistence, and responsive test editor/results panes.
    - [x] Browser circuit timeline with a compact `ticks × Networks` overview and selectable `ticks × signals` detail table.
    - [x] Interactive all-zero `T0`, reset/play/pause/step/run controls, configurable history window, historical tick selection/branching, and quality-aware snapshot editing with double-click shortcuts.
    - [x] Shared browser/Node test-result model, per-test trace documents, structured assertion/debug failures, browser result transport/presentation, and `factorio-dsl test --json`.
    - [x] Shared delta-trace replay with explicit final tick, Known/Unknown and quality preservation, validated history, and lazy selected-target tick ranges; legacy v1 traces retain an explicitly inferred horizon.
    - [x] Browse a selected test's shared trace in a separate read-only overview/detail table with bounded tick windows, quality-aware columns, Unknown origin inspection, execution-local Network names, and mobile layout.
    - [x] Add shared per-test debug snapshots and exact failure scopes, with browser navigation from recorded Network/signal targets to all source aliases and connected physical Producers, configuration/placement inspection, and source/test editor selection.
  - [x] Add focused kernel/lattice/mock/model/query tests plus end-to-end feedback, pulse, settle, Unknown-chain, hierarchy, structural, CLI, and browser-adapter cases; checked-in MemoCell and synthetic-object testbenches run through both shared runners and CLI JSON without topology changes.
  - [x] Document the executable testbench language/API and its separation from compile-time assertions, Factorio conformance fixtures, and future Phase 6 typed-object state adapters; publish runnable acceptance programs and the coverage matrix.
  - [x] Preserve caller bindings for already-existing Networks returned by functions in the debug/query result (`const output = MemoCell(input)` supports `network('output')`); retain physical identity, source provenance, scope ambiguity, final initialized scalar bindings, and moved-alias rejection. Covered by passing acceptance and runtime regressions.
- [ ] Phase 5.5 — external prototype environment foundation
  - [x] Add a versioned normalized Prototype DB, structural/referential/index validator, immutable LuaPrototypes-shaped `prototypes.*` tables plus derived collections/query helpers, deterministic environment identity, browser/Node JSON boundary, and synthetic base/modded fixtures in a dedicated package.
  - [x] Inject the provider explicitly into compiler consumers; keep prototype facts out of the simulator and avoid a global mutable registry.
    - [x] Reserve source `prototypes`, route it through the hygienic elaboration bridge, and thread an optional provider through runtime, browser compiler, and CLI library entry points with source-linked missing-environment diagnostics.
    - [x] Construct/select the provider in CLI `check`/`test` via `--prototypes`, validate optional `--prototype-identity` pins before source execution, and report the selected identity and coverage in JSON.
    - [x] Construct/select the provider inside the browser compiler Worker from cloneable normalized JSON, return verified environment metadata, and reuse it by identity without structured-cloning provider methods.
  - [ ] Load validated databases from CLI project options and browser-local files/cache, with an explicit built-in vanilla/Space Age first-run profile and no silent fallback for pinned projects.
    - [x] Load an explicit CLI database file with structured validation/I/O failures and no implicit fallback; isolate providers between invocations.
    - [x] Add browser-local JSON selection, identity-keyed IndexedDB persistence, tab-local active selection, reload restoration, explicit disable, and pinned rehydration after Worker restart.
    - [x] Add explicit versioned CLI project profiles with project-relative source/test/database paths, optional identity pins, and conflict/missing-profile diagnostics before source execution.
    - [ ] Generate and validate the built-in vanilla/Space Age first-run database.
  - [ ] Build an offline normalizer for native `factorio.exe --dump-data` output, supplementing it with a narrow Lua `prototypes` probe only for missing derived facts; verify base, Space Age, and modded-override fixtures.
    - [x] Normalize resolved item subtypes, fluids, multi-category recipes and 2.x count/temperature defaults, qualities, virtual signals, recipe categories, and bounding-box entity footprints; expose it through `factorio-dsl prototypes normalize` with explicit environment metadata and loss warnings.
    - [x] Smoke-test the external dump without making repository code or tests depend on `../Analysis`.
    - [x] Preserve independent and shared product probabilities plus statistics/productivity exclusions as distinct validated facts, including identity/JSON/provider coverage and a full external-dump smoke check.
    - [ ] Resolve spoilage/fluidbox fields and derive or probe exact circuit capabilities; then lock base, Space Age, and modded-override conformance fixtures.
- [ ] Phase 6 — typed Factorio objects: shared circuit inputs, native single-comparison `enable`, Roboport, Lamp, Constant, logistics entities, belts, displays, and train stops.
- [ ] Phase 7 — exact constructors and native-config stress: Arithmetic, full Decider normal/else output lists, duplicate outputs, `Everything`, Selector, raw entities, LUTs, and large generated configurations.
  - [x] Validate the currently implemented `Each`/`Everything` output compatibility against the final post-execution Decider descriptor, including dynamically generated rows and conditions.
  - [ ] Verify Each-to-concrete copy-count behavior, constant-row interaction, duplicate multiplicity, conditional subsets, and `pair(red, green)` selections against exported Factorio fixtures; never lower these rows as a sum/reduce.
  - [ ] Preserve per-output source span, dynamic instance path, ordinal, and implicit/explicit/exact syntax intent through the final generated Decider descriptor; extend authoritative post-execution validation as the exact surface grows.
  - [ ] Decide whether the provisional `input.into(A)` spelling is valid only in final Each-mode after conformance evidence; keep it Decider-output-specific and leave raw `input[A]` legal.
  - [ ] Add configurable diagnostic levels and visibility, stable semantic rule IDs, categories, per-rule overrides, generated-diagnostic grouping/deduplication, and bounded provenance details before enabling `decider.each-concrete-copy` as a note/hint.
- [ ] Phase 8 — parameter-ready configuration IR, placement-time `BlueprintFormula`, dependent blueprint parameters, FCIR, and the Factorio 2.1 codec with fixture-backed semantic round trips.
- [ ] Phase 9 — interactive schematic UI with provenance cross-selection, grouping, layout, inspection, and timing views.
- [ ] Phase 10 — physical placement, wire reach verification, relays, and blueprint export.
- [ ] Phase 11 — language-service and execution-environment polish: operator-domain hovers, completions, code actions, semantic tokens, exact native views, composition-safe textarea highlighting/completion and mobile symbol tools, optional reproducible-build policy, and a fully hardened module sandbox.

Later phases cover prototype profiles, typed Factorio objects, exact constructors, the verified blueprint codec and exchange strings, schematic editing, physical placement, multi-file language services, reproducible builds, and a hardened sandbox.

## Documentation

- [Getting started](docs/getting-started.md) — install, validate, build, and run the browser workbench.
- [Current language reference](docs/language-reference.md) — the exact implemented syntax, diagnostics, and known gaps.
- [Phase 4 ownership design](docs/ownership-and-multi-network.md) — completed affine ownership, borrows, consuming transfer, read-only `pair`, and its acceptance matrix.
- [Native objects, Deciders, and parameters](docs/native-objects-deciders-and-parameters.md) — planned Phase 6–8 semantic domains and conformance requirements.
- [Prototype environment](docs/prototype-environment.md) — the Phase 5.5 normalized modded-data provider, Factorio exporter, loading, and environment-identity boundary.
- [Runtime debug index](docs/debug-index.md) — exact lexical scopes, physical Network/Producer mappings, deterministic queries, and current ambiguity boundary.
- [Executable testbench](docs/testbench.md) — the current JavaScript test API, clock, assertions, traces, and browser/CLI behavior.
- [Phase 5 acceptance](docs/phase-5-acceptance.md) — runnable MemoCell/object examples, layered coverage, and the completed MVP boundary.
- [Generic object test adapters](docs/object-test-adapters.md) — stable object identity, connector snapshots, default output injection, and the mock/model policy boundary.
- [Producer and Entity materialization policy](docs/producer-materialization-policy.md) — the Phase 4.5 benchmark decision for inferred Networks, explicit combinator handles, and future typed-object identity.
- [Diagnostics](docs/diagnostics.md) — compiler/runtime code families and the most common actionable errors.
- [Blueprint JSON preview](docs/blueprint-json.md) — generated structure, wiring model, and current limitations.
- [Architecture notes](docs/architecture.md) — package boundaries, lowering decisions, runtime invariants, and implementation status.
- [Compile-time JavaScript](docs/compile-time-javascript.md) — supported metaprogramming subset and explicit compatibility limits.
- [Security model](docs/security-model.md) — current trusted-source assumption and Worker/CLI isolation limits.

Signal IDs in plans, IR, and blueprint data have structural identity. Source values returned by `Signal(...)` are nevertheless nominal handles registered to the current elaboration session, so an ordinary `{ type, name }` configuration object cannot accidentally enter DSL dispatch. `Signal("chest")` is the same default-item shorthand as `network["chest"]` and produces the internal identity `{ type: "item", name: "chest" }`; blueprint JSON omits that default `item` type. Explicit namespaces use `Signal("virtual", "signal-A")`, while `Signal("virtual", "signal-A", "normal")` also carries quality. The lowercase `signal(...)` helper remains a compatibility alias for internal/runtime code. Broader import-time omission/defaulting rules still require Phase 8 Factorio conformance fixtures.

The source compiler recognizes top-level Signal declarations and specific Network selection in compact deciders. For example, `IF(input[SIGNAL_A] > 40, input[SIGNAL_A])` tests and copies only signal A; unrelated signals on the same circuit network are not emitted. Arithmetic may bind its physical output explicitly with `out[RESULT] += left[A] + right[B]`, `.to(out[RESULT])`, or `.to(out, mirror, RESULT)`. Without an explicit destination binding, the first concrete signal operand from left to right is the deterministic fallback.

The direct runtime milestone is covered by a two-combinator MemoCell integration test. It constructs feedback and fan-out through `network`, `arithmetic`, `decider`, and `attach`, then verifies that the stored signal survives after the external input disappears.

The homepage uses the architecture-defined executable path for every source revision: classify TypeScript, transform DSL-sensitive AST nodes, execute the remaining JavaScript in a persistent time-bounded Web Worker, then elaborate the recorded plan. The Worker keeps compiler assets loaded across edits, retains only the newest queued revision while busy, and is terminated and replaced after a crash or timeout. Functions and compile-time loops are real JavaScript metaprogramming rather than compiler-recognized templates.

The earlier static direct-plan compiler remains as a regression oracle for differential tests, but the web compiler no longer selects it as a fallback. A construct either executes through the transformed runtime or receives an execution diagnostic.

Nested left-associative circuit arithmetic is lowered structurally. For example, `input * 10 + 5` creates two arithmetic combinators, an explicit temporary Network, and a two-tick waveform; it is never collapsed or reassociated.

Ordinary integer-only subexpressions are evaluated during elaboration. Thus `input * (2 + 3)` emits one physical arithmetic combinator with constant `5`. At the executed circuit boundary, finite safe integers are canonicalized to signed int32 (`4294967295` becomes `-1`); fractions, non-finite numbers, and unsafe integers are rejected.

Arithmetic functions may bind those values to local `const` names before the return expression. Bindings can depend on earlier bindings and are memoized per function call; purely numeric bindings remain compile-time, while circular definitions receive a dedicated diagnostic. The homepage example exposes both physical producer/tick counts and folded-operation counts.

Local `const` bindings may also hold circuit expressions. Their result is materialized as a deterministic `$local:<call>:<name>` Network, so splitting an expression across named statements does not fuse combinators or erase tick boundaries. The homepage exposes the friendly local name in its resolved-color chips while retaining the complete internal identity in the plan inspector.

Multiple arithmetic Network functions can be composed through typed top-level Network declarations. Calls are lowered in source order, returned local results can feed the declared call destination directly, and the resulting cross-function pipeline retains one producer and one synchronous tick per circuit operation.

Lowered graph nodes and attachments carry stable function-call instance paths (for example, `Scale:middle`) for source-aware diagnostics and future nested visualizations.

The compact `IF(condition, output)` source form supports Network, concrete-signal, and wildcard selections; safe-integer constants canonicalized to signed int32; signal-to-signal comparisons; bounded `&&`/`||` groups; and boolean negation. Comparisons are canonicalized before the complete predicate lowers to exactly one decider combinator, retaining one-tick behavior and rejecting invalid native condition/output combinations.

In decider output context, `IF(input > 0, 0x00ff00 * EACH)` is a typed output specification rather than circuit arithmetic. The one decider emits the constant count for every signal that satisfies its `Each` condition; it does not allocate an arithmetic combinator or add a tick. Counts use the same safe-integer-to-int32 configuration boundary; malformed forms are rejected before a circuit is produced.

An existing top-level Network can receive a supported function producer through `output += Scale(input)`. This records a zero-tick output attachment to the declared Network rather than materializing another Network or combinator. `Network += Network`, unknown destinations, and unsupported right-hand values fail explicitly.

The TS-valid multi-destination form `Scale(input).to(output, mirror)` attaches the same physical producer to two logical Networks without merging them. Because a Factorio output connector has one red and one green circuit connector, the color solver constrains these two destinations to opposite colors; incompatible fixed `<R>/<G>` declarations produce a source-aware `RT2010` conflict.

Arithmetic and decider combinators constrain each physical connector independently. Two distinct logical Networks read by one input connector must use opposite colors, just as two destinations on one output connector must; three distinct Networks exceed connector capacity. There is deliberately no equality or inequality relation between a combinator's input and output colors because Factorio exposes separate red and green connectors on both sides. The current source slice demonstrates input inference with a two-argument signal comparison such as `IF(value[SIGNAL_A] > threshold[SIGNAL_A], value[SIGNAL_A])`.

Direct producer attachment follows the architecture syntax: `out += IF(condition, source)`, `out += when(condition).then(source)`, `out += a + b`, and `to(first, second) += producer`. After executed elaboration, any physical producer identity still lacking a destination receives the non-fatal `CL2001` warning. This includes standalone expressions and values abandoned in dynamic containers, but not a value stored and attached later. It is lowered into an internal unused sink so input connector capacity and color constraints cannot escape validation. In `to(c, d) += a + b`, `a != b` is an input-side constraint and `c != d` is an output-side constraint; the two sides have separate physical connectors, so `a/c` and `b/d` may reuse red/green. A genuinely impossible global case is an odd constraint cycle such as `a != b`, `b != c`, and `c != a`, which produces `RT2010`.

Typed top-level declarations provide the contextual materialization counterpart to attachment syntax: `const sum: Network = a + b`, `const gated: Network = IF(...)`, and `const gated: Network = when(...).then(...)` create the named destination directly. They use the same producer lowering, topology checks, color constraints, and synchronous tick semantics as `destination += producer`; no extra attachment combinator is introduced.

The current constant-combinator form is `CC(count * SIGNAL, ...)`, where every signal is a declared `Signal(...)` value and every count is a finite safe integer canonicalized to signed int32. It can initialize a contextual Network with `const constants: Network = CC(5 * A, 7 * B)`, drive an existing Network with `out += CC(5 * A)`, or fan out with `to(first, second) += CC(5 * A)`. `CC` is a synchronous source device with no input connector and repeats the configured signal values on every tick; malformed entries and duplicate signals are rejected before a circuit is produced.

A combinator producer may request an exact blueprint position before it is attached: `const placed = (input + 1).at(10.5, -2, 8)` or `out += CC(5 * A).at(0.5, 2.5)`. Coordinates are finite Factorio blueprint coordinates; the optional direction accepts a numeric compile-time constant or TypeScript enum value, must resolve to an integer from 0 through 15, and defaults to `4`. Producers without `.at(...)` retain deterministic automatic preview placement. Reach-aware routing, footprint collision diagnostics, and physical relay insertion remain Phase 10 work.

Direct-plan output attachments carry their own source spans into the Elaboration Graph. Generated temporary links point back to their arithmetic subexpression, while a final link points to the destination declaration instead of borrowing the producer origin.

`tryElaborateDirectPlan()` exposes runtime plan-validation failures as stable diagnostics with source spans. `RT1xxx` covers descriptor/schema failures, while `RT2xxx` covers runtime ownership, topology, condition, attachment, and wire-color failures. The strict `elaborateDirectPlan()` convenience API throws the same structured diagnostic through `RuntimeDiagnosticError` when exception-style control flow is preferable.

## Requirements

- Node.js 22 or newer
- npm 11 or newer

## Commands

```text
npm install
npm run check
npm run build
npm run cli -- check fixtures/language/scale.ts
npm run dev:web
```

For testing from another device on the local network:

```text
npm run dev --workspace @comblang/web -- --host 0.0.0.0 --port 5173 --strictPort
```

The web build uses relative asset URLs and is kept compatible with GitHub project pages. Responsive desktop and mobile layouts are both release requirements.

The CLI `check` command runs TypeScript parsing, the conservative DSL semantic pass, transformed JavaScript elaboration, and runtime topology/color validation. `factorio-dsl test [--json] source.factorio.ts circuit.test.js` additionally executes the same fresh-session JavaScript tests and structured result model as the browser worker, including assertion/debug details and per-test `comblang-trace` documents. Starting the browser workbench is unnecessary for either path.

## Repository map

```text
apps/cli            Node/CI entry point
apps/web            browser compiler workbench and future IDE shell
packages/shared     IDs, spans, diagnostics, Result
packages/language   TypeScript parser adapter and conservative semantic checker
packages/factorio   version-neutral circuit value primitives
packages/simulator  deterministic snapshot-tick kernel
packages/compiler   circuit IR boundary
packages/runtime    elaboration boundary
packages/layout     neutral layout contracts
packages/renderer   neutral scene contracts
fixtures            parser, language, and conformance fixtures
examples            user-facing DSL examples
docs                getting started, language reference, and implementation notes
```
