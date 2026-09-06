# Implementation task status

This log tracks the post-audit implementation cards separately from the phase roadmap. A task is marked complete only when every required external or browser evidence gate has run; code-complete work with a pending gate remains explicit.

## F01 — Isolate the offline cache

Status: **implemented; browser upgrade gate pending**.

- Cache names include the CombLang application namespace, encoded Service Worker scope path, and shell version.
- Activation deletes only obsolete versions inside the current scope namespace. Foreign applications, sibling Pages paths, and the ambiguous legacy global cache remain untouched.
- Precache discovery, warm-up messages, and fetch interception accept only URLs inside the registered application scope.
- Offline reads use the current named cache rather than a global `caches.match` search.
- VM-backed CacheStorage tests cover foreign/sibling preservation, scoped warm-up, own-cache reads, and outside-scope fetch rejection.
- A production build was loaded once from `localhost:4173`, its only preview process was stopped, and the application shell then reloaded successfully offline through the installed Service Worker.

Still required for full lifecycle acceptance: exercise an actual version upgrade with two sibling path deployments in a browser and verify that the new shell plus compiler/test Workers remain available offline after activation. No server is left running by this check.

## F02 — Preserve diagnostics from every compilation stage

Status: **complete in the current web compilation boundary**.

- Compilation diagnostics are append-only across environment/profile preflight, parse, semantic validation, executed elaboration, and lowering.
- Success and exception paths retain earlier warnings, including their primary and related source spans.
- CLI and browser hosts share one execution-failure normalizer for stable codes, messages, primary spans, and related information.
- `pipelineDiagnostics` provides the authoritative ordered browser/Worker transport view. Existing parse-only `diagnostics` and non-parser `compilerDiagnostics` remain compatibility projections.
- The browser editor, status summary, and first-error selection consume the combined list without duplicating parser diagnostics.
- Regression coverage includes successful lowering with a warning, execution failure after a warning, environment-before-parser ordering, and the existing invalid-profile source sentinel.

Validation: **902 tests in 85 files**, format check, typecheck, and complete CLI/web production builds pass. The existing Vite large-chunk warning remains.

## F03 — Share normalized producer input traversal

Status: **complete**.

- The compiler owns one pure traversal for arithmetic operands, every nested Decider condition leaf, normal outputs, else outputs, and single/pair Network references.
- The occurrence view preserves descriptor order and repeated rows. The topology view expands pairs and returns frozen distinct Network IDs in first-reference order.
- Runtime color constraints, debug structural graph queries/documents, and native blueprint wiring consume the same topology view.
- Constants and constant rows without an explicit input do not create circuit inputs.
- Focused integration coverage proves both members of a pair, repeated rows, an else-only native input, and an else-only input participating in connector color conflicts.

Validation: **907 tests in 86 files**, format check, typecheck, and complete CLI/web production builds pass. The existing Vite large-chunk warning remains.

The browser's temporary Direct Plan depth heuristic remains separate by design; F08 replaces it with resolved NCIR graph/SCC analysis after the common compilation artifact exists.

## F04 — Stateful parity DSU

Status: **complete**.

- `CircuitColorConstraints<Id>` incrementally registers Networks and applies same, different, and fixed-color constraints without depending on the source runtime or DOM.
- A rejected contradictory relation leaves the accepted semantic relations intact; path compression remains an observational optimization.
- Conflicts retain their reason and opaque provenance, while relations and fixed colors reject unknown IDs instead of registering them implicitly.
- Resolution is deterministic across union orders: the earliest registered member orients each free component to red, and the fixed anchor orients constrained components.
- `solveCircuitColors` remains the compatible batch API and delegates to the same stateful engine.
- Tests compare every prefix of a small graph with a BFS oracle and cover a contradictory triangle, fixed anchors, isolated nodes, unknown IDs, equal and repeated relations, repeated resolution, post-resolution mutation, and alternate union orders.

Validation: **913 tests in 87 files**, format check, typecheck, and complete CLI/web production builds pass. The existing Vite large-chunk warning remains.

Next task: F05, online color constraints and a failed recorder lifecycle.

## F05 — Online constraints and failed recorder lifecycle

Status: **complete**.

- The source recorder registers color identities at Network creation and checks fixed requirements, pairs, producer inputs, attachments, and zero-tick transfers incrementally.
- Opaque ownership state is the stable color identity across aliases, moves, function-return rebinding, and display-name changes.
- The first inconsistent operation now reports its own source span immediately; replay retains the same topology checks as an independent boundary.
- A confirmed DSL-domain failure poisons the recorder and remains the result even if user source catches it. Ordinary JavaScript may continue, but later DSL recording and finalization rethrow the first failure.
- Ordinary methods, getters, coercions, and callbacks crossing the execution bridge do not poison the recorder merely because they throw.
- Successful finalization and uncaught source exits seal the recorder against delayed asynchronous DSL mutations.
- Regression coverage includes the contradictory pair prefix, caught and uncaught failures, producer input/output connectors, inferred parameter colors, fixed-color and pair-collapsing transfers, stable renamed/aliased identities, ordinary bridge exceptions, and delayed callbacks after success or throw.

Validation: **919 tests in 87 files**, format check, typecheck, and complete CLI/web production builds pass. The existing Vite large-chunk warning remains.

Next task: F06, strict Direct Plan payload ingress and replay color validation.

## F06 — Strict Direct Plan payload ingress

Status: **complete**.

Completed ingress foundation:

- Top-level Network/Producer collections have an explicit size boundary before runtime allocation.
- Producer entries must be objects with known tags, valid provenance, instance paths, and attachment arrays.
- Transfer and pair descriptors validate shape, provenance, paths, cardinality, distinctness, and referenced Network names.
- Attachment references are rejected as `RT1004` at ingress rather than reaching partial runtime allocation.
- Arithmetic producers now validate both operand unions, signed-int32 constants, SignalIDs, operations, output unions, and single/pair input Network references before replay. Unknown inputs retain `RT1003`; malformed fields identify their JSON path.
- Decider producers now validate bounded condition trees, every comparator/leaf/reference, compatibility and native output rows, and both normal/else output arrays. Condition depth is capped before recursive lowering.
- Constant outputs and common producer metadata now validate SignalIDs, int32 counts, binding/capture strings, globally unique capture IDs, and finite placement with a native direction range.
- Debug-instance value graphs and embedded diagnostics are validated recursively with reference, shape, size, and depth checks before debug reconstruction.
- Successful ingress rebuilds a known-field-only, deeply frozen canonical plan. Legacy Deciders without `outputs` receive a canonical ordered list, while explicit empty normal-output lists remain intact for else-only configurations.
- Replay, debug indexing, and capability reporting consume only that canonical plan; mutation of or extra fields on the caller payload cannot alter execution after validation.
- New malformed-payload diagnostics include JSON-style paths such as `$.producers[0].destinations[0]`.
- Regression coverage includes `producers: [null]`, an unknown Producer tag, a malformed pair, an unknown attachment Network, and malformed arithmetic operands/operations/outputs.

Validation: **964 tests in 87 files**, format check, and typecheck pass.

## F07 — Shared compilation artifact and host service

Status: **complete**.

- The browser main thread creates one immutable `SourceCircuitArtifact` for each accepted Direct Plan.
- The source proof, interactive controller, and blueprint JSON preview share its executed circuit instead of independently calling `elaborateDirectPlan`.
- Simulation reset, tick editing, and history rebasing now create fresh simulation kernels over the same immutable circuit. They no longer replay the Direct Plan, while still discarding stale trace state.
- Plan-only compatibility entry points remain for focused callers and tests; the production UI uses the artifact-taking APIs.
- `compileSourceProgram` now owns parse, preflight, semantic validation, transform, executed source recording, Direct Plan replay, and the append-only diagnostic order in one browser/Node-neutral runtime module.
- The local result retains its `ExecutedDirectPlan`; `sourceCompilationArtifact` strips host-local handles, functions, and maps into a structured-clone-safe Worker artifact.
- Prototype identity is part of that artifact whenever an explicit environment is selected.
- The compiler Worker and CLI are thin hosts over the common service. CLI project diagnostics no longer duplicate parser errors, and single-file success, warning, parser, semantic, execution, and topology-error results have parity coverage.
- Compilation-stage instrumentation proves one core lowering per service invocation. The CLI test host reuses that execution while creating a fresh isolated `TestSession` for every test case.

Validation: **974 tests in 89 files**, format check, typecheck, and complete CLI/web production builds pass. The isolated entry point keeps the main UI at about 626 kB and the test Worker at about 77 kB; the existing Vite large-chunk warning remains.

Next task: F08, replace the Direct Plan preview heuristic with resolved NCIR graph/SCC metrics.

## F08 — Resolved circuit graph metrics

Status: **complete**.

- `analyzeCircuitGraph` builds Producer dependencies from resolved NCIR rather than source or serialization order.
- Every driver of an input Network participates. Input discovery uses the shared topology traversal, including pairs, nested conditions, copied outputs, and else-only inputs; zero-tick aliases are already canonical physical IDs.
- An iterative SCC pass identifies multi-Producer cycles and self-feedback without depending on JavaScript recursion depth.
- Acyclic circuits report the global maximum accumulated device latency. Feedback circuits report separately identified SCCs and a structural depth over the condensed component DAG, never a finite settle-time claim.
- Arithmetic, Decider, and Constant combinators explicitly declare one committed tick. Unrecognised or caller-designated device latency remains unknown and propagates to depth instead of silently becoming one.
- The browser proof now displays graph depth, feedback SCC count, and known/unknown device latency separately. Its compatibility `stages` field is derived from the same NCIR metric.
- Regression coverage includes a three-stage chain followed by an independent Producer, reversed Producer order, a diamond with multiple drivers and a pair input, else-only Decider input, a zero-tick transferred Network, a two-node SCC, self-feedback, downstream work after an SCC, unknown latency, and invalid latency declarations.

Validation: **983 tests in 90 files**, format check, typecheck, and complete CLI/web production builds pass. The web main bundle remains about 628 kB; the existing Vite large-chunk warning remains.

Next task: F09, pin the Factorio API inventory inputs and generator boundary inside this repository.

## F09 — Pinned Factorio API snapshot and generator boundary

Status: **complete**.

- The Factorio runtime and prototype JSON API schemas are checked in under a versioned `tools/factorio-api/fixtures/2.1.16` directory together with the required documentation license.
- A snapshot manifest records exact Factorio 2.1.16 / JSON API 6 metadata, SHA-256 for every copied file, and the explicit offline regeneration command.
- The development-only generator verifies every hash and both schema headers before producing an inventory. It neither fetches a latest version nor participates in the ordinary production build.
- The generated artifact carries repository-relative provenance only. Compiler, CLI, web, and generator operation do not depend on a sibling analysis workspace.
- `control-behavior-review.json` separately assigns every discovered class to an implementation wave and pins the reviewed 40 classes / 37 concrete / 3 abstract / 47 BlueprintEntity variants baseline. API drift fails closed until the review manifest is deliberately updated.
- Persisted names use explicit UTF-16 code-unit ordering rather than locale collation. `factorio-api:inventory:check` compares regenerated output byte-for-byte.
- Regression coverage verifies the baseline, deterministic isolated generation, portable provenance, code-unit ordering, missing class review, and hash mismatch failure.

Validation: **989 tests in 91 files**, deterministic inventory check, format check, typecheck, and complete CLI/web production builds pass. The pinned raw schemas are excluded from formatter rewrites, and the existing Vite large-chunk warning remains.

Next task: F10, add the read-only runtime structural exporter without conflating API schema presence with captured game facts.

## F10 — Runtime structural exporter

Status: **implemented; native capture gate pending**.

- A dedicated Factorio mod scans runtime `prototypes` without sharing the selected-entity observation probe or inferring circuit capabilities.
- The capture includes items, fluids, recipes, entities, qualities, recipe categories, selected global/per-entity limits, exact active mods and startup settings, collector version, and the pinned API version/hashes.
- Runtime ingredient/product roles and resolved main-product records are preserved. Entity `tile_width`/`tile_height` are captured independently from selection and collision boxes.
- Every fact and startup setting is an explicit `value`, `absent`, `unknown`, or `error` outcome; failed getters never become zero, false, or empty defaults.
- A bounded `PR1001` parser validates complete artifacts, environment consistency, collection identity, nested JSON values, and outcome shapes, then deeply freezes the transport without treating it as a normalized Prototype DB.
- `factorio-dsl prototypes runtime-capture` provides human and JSON inspection. Synthetic fixtures cover false/zero/empty preservation, runtime roles, a 2×3 tile footprint against a 10×10 selection box, errors, unknowns, malformed paths, and immutable output.
- Static guards verify that every accessed field/method exists in the pinned 2.1.16 runtime API, embedded API hashes match F09, and the tool contains no known entity/control/settings mutation calls.

Still required: install the tool in a disposable Factorio environment, produce and review a small base capture, verify explicit startup setting values, and compare native tile dimensions against the matching raw dump. Until that external run, F10 must not be labelled complete and its synthetic fixture is not native evidence.

Validation: **1004 tests in 93 files**, pinned inventory check, format check, typecheck, CLI synthetic-capture smoke test, and complete CLI/web production builds pass. The existing Vite large-chunk warning remains.

Next task after the native gate: F11, introduce the source-aware normalized runtime prototype model while retaining raw-only facts separately.

## F13 — SignalPropertyKey codec

Status: **complete**.

- `encodeSignalPropertyKey` and `parseSignalPropertyKey` implement the canonical `signal:v1/<type>/<name>/<quality>` external key with percent-encoded name and quality components.
- All Signal namespaces round-trip. Omitted quality remains distinct from explicit `normal`; slash, percent, Unicode, and supplementary characters are preserved.
- Parsing requires exact canonical spelling and rejects missing/extra segments, empty names, unknown namespaces, malformed or lowercase/noncanonical percent escapes, and lone UTF-16 surrogates.
- Source-created nominal Signal handles expose a frozen, non-enumerable `Symbol.toPrimitive` function for string/property-key coercion. Numeric/default coercion fails; ordinary structural Signal IDs do not gain coercion behavior.
- Computed object keys and JSON string-key round trips use the external codec without changing internal `signalKey` or semantic `sameSignal` equality.
- Registry coverage verifies that branding retains the original identity and function-valued symbol descriptor. `Signal('signal:v1/...')` remains the existing one-argument item-name construction.

Validation: **1025 tests in 93 files**, pinned inventory check, format check, typecheck, and complete CLI/web production builds pass. The web main bundle remains about 628 kB; the parser Worker increases only by the codec implementation, and the existing Vite large-chunk warning remains.

Next independent task: F14, normalize typed counts, tuples, arrays, Maps, and dictionaries into ordered constant-combinator rows.
