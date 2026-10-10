# CombLang

CombLang is a browser-first TypeScript-shaped circuit DSL for Factorio 2.1, with shared compiler/runtime support for the CLI and browser Worker. It has no backend or project-owned Factorio component. The checked-in architecture and implementation notes live in [`docs/architecture.md`](docs/architecture.md).

The current repository implements the completed Phase 0–7 foundation, from the parser and Factorio semantics kernel through executed TypeScript-shaped source, ownership, testbench/prototype environments, persistent schema-configured Entity handles, and exact generated combinator configurations:

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
- [x] Phase 4 — ownership, multi-network syntax, eager Combinator identity/output lanes, semantic/runtime boundary hardening, session values, and complete CLI/browser/EG/NCIR acceptance coverage.
- [x] Phase 5 — deterministic testbench, external-world adapters, traces and interactive timelines; browser-first prototype environments with reproducible `factorio.exe --dump-data` normalization, bundled and custom modpack profiles, identity-bound provenance, persistence, integrity checks, and offline lifecycle.
- [x] Phase 6 — persistent physical Entity identity, provider-authorized generic and modded construction, explicit connector binding and placement, profile-free replay transport, bounded raw and schema-checked Blueprint configuration, structural family facades, and separately tracked structural/implementation/native evidence.
- [x] Phase 7 — exact Constant/Arithmetic/Decider and deterministic Selector computation; linked physical Entity transport; ergonomic Constant sections; generated one-device condition/output configurations; bounded provenance, replay, blueprint, CLI/Worker, and model acceptance with native-evidence limits kept explicit.
- [ ] Phase 8 — blueprint exchange, symbolic parameters, formulas, and native export.
  - [x] Implement a bounded, lossless single-blueprint exchange codec with explicit handling of unsupported roots, unknown safe fields, large numeric lexemes, cancellation, and browser/Node compression capability errors. Codec round trips alone do not establish native behavior.
  - [x] Compose a bounded read-only blueprint entity/wire inventory, explicit host-selected profile projection and color-separated endpoint components through dedicated blueprint package subpaths. Retain lossless original nodes, duplicate/dangling diagnostics and unsupported-representation notices. Omitted entity arrays mean an empty inventory; missing or mismatched profile selections and incomplete endpoint coverage block all components. Complete analysis under the exporter convention is not executable import or native validity.
  - [x] Decode explicit exported Constant and Arithmetic control-behavior shapes into existing configurations, preserving ordered sections/rows, qualities, finite-double multipliers, operations, Each and per-operand red/green selection through supplied host references. Unsupported fields and omission rules remain located coverage failures; this is not arbitrary native compatibility or source generation.
  - [ ] Generate literal source for the supported configurations, then assemble and verify a supported full blueprint's compiled topology/configuration. Keep unknown fields and unsupported connections lossless instead of silently dropping them; structural round trips do not establish native behavior.
  - [x] Use one immutable FCIR/native export projection and field emitter for readable blueprint JSON; keep FCIR separate from simulation and preserve parameter-free export behavior.
  - [x] Preserve per-operand/per-output red-green selection and nested AND/OR semantics in the current blueprint preview, with bounded condition expansion and executed-source tests. Native round-trip evidence is still pending.
  - [x] Retain independently supplied Factorio 2.1.17 parameter documents as lossless fixtures with provenance hashes, covering numeric formula strings, identifier dependencies, and quality constraints. These establish document shape, not placement or formula behavior.
  - [x] Preserve ordered number/id parameter metadata through the existing FCIR validator and native emitter, with immutable shared-budget validation and complete metadata comparisons against the supplied exports. Source-driven native allocation and parameter semantics remain separate work.
  - [x] Capture source number/Signal declarations with concrete defaults in reviewed exact Arithmetic, Constant, Decider and Selector slots, including Arithmetic output Signals and finite-double Constant section multipliers. Bind physical-producer templates into concrete NCIR or a strictly matching Direct Plan/ResolvedCircuit pair without leaking symbolic values into transport artifacts. Native symbolic multiplier/Signal/formula export remains unsupported.
  - [x] Export owning-source number declarations used directly in Constant filter counts, Arithmetic constant operands, Selector select indices and Decider right-number thresholds, including nested AND/OR conditions and duplicated native rows, through the existing FCIR/native emitter. Preserve signed-int32 originals, declaration order, repeated nominal uses, qualities and topology; reject ambiguous equal originals across distinct handles. CLI source export is available with explicit `--parameters`, Worker requests can opt into a cloneable native export result, and the web blueprint panel exposes it through the default-off **Include numeric parameters** checkbox for JSON preview/copy. Native placement evidence remains open.
  - [x] Add a local binding adapter with detached declaration descriptors and declaration-ID overrides; validate number/Signal values with source-linked diagnostics, preserve nominal handles privately, and return fresh concrete pairs without re-executing source. Each bind starts from original defaults, and failed overrides leave prior results intact.
  - [x] Retain one optional parameter-binding session in the compiler Worker runtime, with cloneable descriptors and an opaque instance-local token. Any newer parse expires it immediately; default callers retain no session. This establishes local ownership, not Worker message routing or page controls.
  - [x] Route parameter-bind requests and concrete-pair responses through the Worker message protocol without re-executing source; preserve declaration diagnostics and reject expired captures. Request correlation and capture revisions remain distinct.
  - [x] Serialize parse/bind operations through the existing browser Worker scheduler, coalesce queued bindings, prioritize newer source, and reject stale or wrong-generation completions. Bind timeout/crash expires the session without silently recompiling source.
  - [x] Add browser number/Signal parameter controls with Apply/Reset against the retained compilation, fresh T0 simulation and independent tests from the matching bound pair, revision-consistent concrete JSON/copy, and explicit recompilation after capture loss. Native-template export remains separate from concrete binding.
  - [ ] Verify parameter controls in a real browser, including mobile editing, offline use, source/profile changes, and asynchronous clipboard completion; automated mapping and in-process consumer tests are not browser evidence.
  - [x] List source parameter descriptors through the CLI and export concrete JSON with declaration-ID overrides, one source execution per invocation, project/profile selection, source-linked errors and exclusive output creation. Keep native-template export separate and declaration IDs local to their source execution.
  - [x] Run CLI tests with concrete declaration-ID overrides from the same owning compilation. Preserve matching Entity-bearing pairs, independent T0 sessions, quality identity, source-linked setup failures, project paths and existing JSON/plain reporting.
  - [x] Use shared Signal identity in timeline queries and edits, treating omitted quality and explicit normal alike while retaining distinct qualities. Cover both aliases through retained Worker binding, CLI tests and concrete JSON without changing topology or mixing artifact pairs.
  - [ ] Expand beyond the reviewed exact source slots without changing topology or re-executing source.
  - [x] Add an internal, bounded typed numeric-expression DAG and pure default/binding evaluator for literals, number-parameter references, negation, addition, subtraction, and multiplication. This is not Factorio formula syntax or native-formula semantics.
  - [x] Use registered numeric expressions in host-local Arithmetic constant operands, Decider `condition.compare.right` thresholds and `mode: 'constant'` output values (including nested AND/OR thresholds and both output branches), plus Constant section multipliers and filter counts. Arithmetic/Decider/count results require safe integers before their existing int32 normalization; Constant multipliers remain finite doubles. Host support does not enable native formula export.
  - [x] Support source number-parameter expressions with addition, subtraction, multiplication and negation in exact Arithmetic constant operands, direct Constant filter counts and section multipliers. Reuse the registered DAG for defaults and binding without extra hardware, preserving independent Signal/count capture, ordinary JavaScript coercion, caught exceptions and returned-container identity. Native derived-expression export remains explicitly unsupported.
  - [x] Verify local Arithmetic/Constant expressions through CLI listing, concrete export and independent tests, plus cloneable Worker binding and existing preview/test/JSON consumers. Cover default/override/reset, quality identity, failed-binding retry and explicit native-export rejection without rerunning retained source. These automated checks do not replace real browser/offline/native acceptance.
  - [x] Preserve explicitly supplied numeric `variable`, opaque `formula` strings and `dependent` metadata with required concrete defaults in host-only source native export. Metadata is immutable and bounded; local simulation/binding still use defaults or overrides, not formulas. Preservation is not native formula validity or placement evidence.
  - [ ] Add native recipe/property dependency semantics and deterministic allocation of an unused original value when omitted; no dummy physical combinators. Formula reference/cycle validation and native formula evaluation remain unverified.
  - [ ] Bind and export number/Signal parameters plus one reviewed recipe/property dependency, with independently exported Factorio fixtures for parameter indices, formulas, defaults, and native edit/round-trip behavior.
  - [x] Run Entity-bearing browser tests and preview from strictly matching Plan/ResolvedCircuit pairs with one shared fingerprint implementation, preserving debug/alias lookup, independent sessions, and the trusted replay boundary.
  - [ ] Make parameterized compilation, tests, preview, and export agree across CLI, Worker, and offline browser use.
  - [ ] Complete fixture-backed acceptance and document unsupported native semantics explicitly before closing the phase.
- [ ] Phase 9 — interactive schematic UI with provenance cross-selection, grouping, layout, inspection, and timing views.
  - [ ] Preserve associated source `//` comments as optional combinator descriptions through IR/export; define ambiguous comment attachment and explicit-description precedence, provide an export opt-out, and verify native round trips.
  - [ ] Navigate from rendered combinators to exact original source expressions, retaining call/loop instance context, revision, and tab/file identity.
  - [ ] Offer undoable, revision-checked `.at` write-back from physical placement drags; initially allow only unique producer sites and literal coordinates. Keep schematic-only layout separate; require explicit decisions for variables, loops, helpers, and multi-instance origins.
- [ ] Phase 10 — physical placement, wire reach verification, relays, and placement-aware blueprint export.
- [ ] Phase 11 — project modules, language services, and execution-environment polish: multi-file TypeScript projects, operator-domain hovers, completions, code actions, semantic tokens, exact native views, mobile editing tools, optional reproducible-build policy, and a fully hardened module sandbox.
  - [ ] Replace the fixed source/test-file roles with a browser-local project of arbitrary named TypeScript files and author-selected circuit/test entrypoints. Local library modules share the same project graph; no filename is inherently special.
  - [ ] Resolve local imports/exports and execute each linked module with stable file-scoped diagnostics and provenance; test modules may import project helpers without requiring a separate language. Preserve one circuit elaboration per build and independent test sessions.
  - [ ] Persist, import, and export complete projects offline, migrating existing per-tab source/test drafts without overwriting them. Keep the module graph compatible with static GitHub Pages hosting and reserve an explicit, versioned import surface for a future bundled standard library.
  - [ ] Verify Each-to-concrete copy-count behavior, constant-row interaction, duplicate multiplicity, conditional subsets, and `pair(red, green)` selections against exported Factorio fixtures; never lower these rows as a sum/reduce.
  - [ ] Decide whether the provisional `input.into(A)` spelling is valid only in final Each-mode after conformance evidence; keep it Decider-output-specific and leave raw `input[A]` legal.
  - [ ] Enable `decider.each-concrete-copy` as a note/hint only after its legal native behavior, explicit-intent spelling, and fixture evidence are complete.

Remaining work covers additional reviewed prototype capabilities, fixture-backed native parameter/formula semantics, interactive schematic editing and safe write-back, physical placement validation, multi-file project linking and language services, reproducible builds, and a fully hardened sandbox.

## Documentation

Start with the [documentation index](docs/README.md) for task-oriented navigation
and the distinction between user guides, language reference, and embedding APIs.

- [Getting started](docs/getting-started.md) — install, validate, build, and run the browser workbench.
- [Circuit basics](docs/circuit-basics.md) — complete runnable examples explaining Signals, Networks, hardware, ticks, connections, functions, and loops.
- [Current language reference](docs/language-reference.md) — the exact implemented syntax, diagnostics, and known gaps.
- [Ownership and multi-network contract](docs/ownership-and-multi-network.md) — affine ownership, borrows, consuming transfer, read-only `pair`, and its acceptance matrix.
- [Native objects, Deciders, and parameters](docs/native-objects-deciders-and-parameters.md) — native-object contracts, semantic domains, and conformance requirements.
- [Prototype environment](docs/prototype-environment.md) — normalized static data, asset loading, and the environment-identity boundary.
- [Circuit graph metrics](docs/circuit-graph-metrics.md) — resolved NCIR dependencies, DAG depth, feedback SCCs, and unknown-latency propagation.
- [Pinned Factorio API inputs](tools/factorio-api/README.md) — versioned local schemas, hashes, license, reviewed ControlBehavior coverage, and offline regeneration.
- [Prototype evidence and data boundaries](docs/prototype-truth-sources.md) — static-data authority, identity migration, and the boundary between profiles and runtime evidence.
- [Runtime debug index](docs/debug-index.md) — exact lexical scopes, physical Network/Producer mappings, deterministic queries, and current ambiguity boundary.
- [Source-linked schematic editing](docs/source-linked-schematic.md) — current source provenance and the limits of schematic navigation and source write-back.
- [Executable testbench](docs/testbench.md) — the current JavaScript test API, clock, assertions, traces, and browser/CLI behavior.
- [Testbench acceptance](docs/testbench-acceptance.md) — runnable MemoCell/object examples, layered coverage, and the tested simulator boundary.
- [Generic object test adapters](docs/object-test-adapters.md) — stable object identity, connector snapshots, default output injection, and the mock/model policy boundary.
- [Combinator and Entity value policy](docs/producer-materialization-policy.md) — eager combinator output lanes, Network narrowing, and profile-backed Entity identity.
- [Entity pipeline](docs/entity-pipeline.md) — canonical profiles, replay authority, configuration, linked computation, resolved transport, hydration, and native-evidence limits.
- [Diagnostics](docs/diagnostics.md) — compiler/runtime code families and the most common actionable errors.
- [Troubleshooting](docs/troubleshooting.md) — source diagnostics, intent-specific solutions, hardware effects, and current restrictions.
- [Blueprint JSON preview](docs/blueprint-json.md) — generated structure, wiring model, and current limitations.
- [Architecture notes](docs/architecture.md) — package boundaries, lowering decisions, runtime invariants, and implementation status.
- [Direct plan schema](docs/direct-plan-schema.md) — stable elaboration transport, versioning, validation ownership, and dependency direction.
- [Elaboration transform](docs/elaboration-transform.md) — source prepass, hygienic runtime bridge, lexical Producer slots, and AST rewrite boundary.
- [Returned Network ownership](docs/return-ownership.md) — container graph traversal, atomic ownership transfer, aliases, cycles, and double-move rules.
- [Compile-time JavaScript](docs/compile-time-javascript.md) — supported metaprogramming subset and explicit compatibility limits.
- [Security model](docs/security-model.md) — current trusted-source assumption and Worker/CLI isolation limits.

Signal IDs in plans, IR, and blueprint data have structural identity. Source values returned by `Signal(...)` are nevertheless nominal handles registered to the current elaboration session, so an ordinary `{ type, name }` configuration object cannot accidentally enter DSL dispatch. `Signal("chest")` is the same default-item shorthand as `network["chest"]` and produces the internal identity `{ type: "item", name: "chest" }`; blueprint JSON omits that default `item` type. Explicit namespaces use `Signal("virtual", "signal-A")`, while `Signal("virtual", "signal-A", "normal")` also carries quality. The lowercase `signal(...)` helper remains a compatibility alias for internal/runtime code. Broader import-time omission/defaulting rules still require Phase 8 compatibility fixtures.

The source compiler recognizes top-level Signal declarations and specific Network selection in compact deciders. For example, `IF(input[SIGNAL_A] > 40, input[SIGNAL_A])` tests and copies only signal A; unrelated signals on the same circuit network are not emitted. Arithmetic may bind its physical output explicitly with `out[RESULT] += left[A] + right[B]`, `.to(out[RESULT])`, or `.to(out, mirror, RESULT)`. Without an explicit destination binding, the first concrete signal operand from left to right is the deterministic fallback.

The direct runtime milestone is covered by a two-combinator MemoCell integration test. It constructs feedback and fan-out through `network`, `arithmetic`, `decider`, and `attach`, then verifies that the stored signal survives after the external input disappears.

The homepage uses the architecture-defined executable path for every source revision: classify TypeScript, transform DSL-sensitive AST nodes, execute the remaining JavaScript in a persistent time-bounded Web Worker, then elaborate the recorded plan. The Worker keeps compiler assets loaded across edits, retains only the newest queued revision while busy, and is terminated and replaced after a crash or timeout. Functions and compile-time loops are real JavaScript metaprogramming rather than compiler-recognized templates.

The earlier static direct-plan compiler remains as a regression oracle for differential tests, but the web compiler no longer selects it as a fallback. A construct either executes through the transformed runtime or receives an execution diagnostic.

Nested left-associative circuit arithmetic is lowered structurally. For example, `input * 10 + 5` creates two arithmetic combinators; the first device's eager primary output feeds the second, producing a two-tick waveform. It is never collapsed or reassociated.

Ordinary integer-only subexpressions are evaluated during elaboration. Thus `input * (2 + 3)` emits one physical arithmetic combinator with constant `5`. At the executed circuit boundary, finite safe integers are canonicalized to signed int32 (`4294967295` becomes `-1`); fractions, non-finite numbers, and unsafe integers are rejected.

Arithmetic functions may bind those values to local `const` names before the return expression. Bindings can depend on earlier bindings and are memoized per function call; purely numeric bindings remain compile-time, while circular definitions receive a dedicated diagnostic. The homepage example exposes both physical producer/tick counts and folded-operation counts.

Local `const` bindings may also hold circuit expressions. They retain the physical Combinator and act as source aliases for its eager primary output Network, so splitting an expression across named statements does not fuse devices or erase tick boundaries. The homepage exposes the friendly alias in its resolved-color chips while retaining the physical identity in the plan inspector.

Multiple arithmetic Network functions can be composed through typed top-level Network declarations. Calls are lowered in source order, returned local results can feed the declared call destination directly, and the resulting cross-function pipeline retains one producer and one synchronous tick per circuit operation.

Lowered graph nodes and attachments carry stable function-call instance paths (for example, `Scale:middle`) for source-aware diagnostics and future nested visualizations.

The compact `IF(condition, output)` source form supports Network, concrete-signal, and wildcard selections; safe-integer constants canonicalized to signed int32; signal-to-signal comparisons; bounded `&&`/`||` groups; and boolean negation. Comparisons are canonicalized before the complete predicate lowers to exactly one decider combinator, retaining one-tick behavior and rejecting invalid native condition/output combinations.

In decider output context, `IF(input > 0, 0x00ff00 * EACH)` is a typed output specification rather than circuit arithmetic. The one decider emits the constant count for every signal that satisfies its `Each` condition; it does not allocate an arithmetic combinator or add a tick. Counts use the same safe-integer-to-int32 configuration boundary; malformed forms are rejected before a circuit is produced.

An existing top-level Network can receive a Combinator output through `output += Scale(input)`. This consumes the next free output lane and unifies it with the declared destination without adding a combinator or tick. `Network += Network`, unknown destinations, and unsupported right-hand values fail explicitly.

The TS-valid multi-destination form `Scale(input).to(output, mirror)` attaches the same physical producer to two logical Networks without merging them. Because a Factorio output connector has one red and one green circuit connector, the color solver constrains these two destinations to opposite colors; incompatible fixed `<R>/<G>` declarations produce a source-aware `RT2010` conflict.

Arithmetic and decider combinators constrain each physical connector independently. Two distinct logical Networks read by one input connector must use opposite colors, just as two destinations on one output connector must; three distinct Networks exceed connector capacity. There is deliberately no equality or inequality relation between a combinator's input and output colors because Factorio exposes separate red and green connectors on both sides. The current source slice demonstrates input inference with a two-argument signal comparison such as `IF(value[SIGNAL_A] > threshold[SIGNAL_A], value[SIGNAL_A])`.

Direct output connection follows the architecture syntax: `out += IF(condition, source)`, `out += when(condition).then(source)`, `out += a + b`, and `to(first, second) += combinator`. Arithmetic, `CC`, `IF`, and `when` create physical Combinators and primary output Networks immediately. The first connection consumes primary, the second sequential connection uses one lazy stable secondary lane, and a third reports `RT2027`. An output never read or connected receives non-fatal `CL2001`; its physical combinator and dangling primary remain in the plan without a synthetic sink. In `to(c, d) += a + b`, `a != b` is an input-side constraint and `c != d` is an output-side constraint; the two sides have separate physical connectors, so `a/c` and `b/d` may reuse red/green.

Typed declarations such as `const sum: Network = a + b` narrow the already-created Combinator to its primary Network facet. The annotation hides physical methods but creates no destination, temporary Network, entity, or tick. Without the annotation, inference retains the precise Combinator handle while all Network read contexts still use primary.

The current constant-combinator form is `CC(count * SIGNAL, ...)`, where every signal is a declared `Signal(...)` value and every count is a finite safe integer canonicalized to signed int32. It immediately creates a `ConstantCombinator`, can be narrowed with `const constants: Network = CC(...)`, connected with `out += CC(...)`, or fanned out with `to(first, second) += CC(...)`. `CC` is a synchronous source device with no input connector and repeats the configured values on every tick.

A Combinator may request an exact blueprint position before or after connecting an output lane: `const placed = (input + 1).at(10.5, -2, 8)` or `out += CC(5 * A).at(0.5, 2.5)`. Coordinates are finite Factorio blueprint coordinates; the optional direction accepts a numeric compile-time constant or TypeScript enum value, must resolve to an integer from 0 through 15, and defaults to `4`. Unplaced devices retain deterministic automatic preview placement.

Direct-plan output lanes and zero-tick Network transfers carry their own source spans into the Elaboration Graph. Physical combinator provenance remains attached to the creating expression, while source aliases and connections retain their independent declaration/operation spans.

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
