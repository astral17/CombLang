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

Status: **in progress**.

Completed ingress foundation:

- Top-level Network/Producer collections have an explicit size boundary before runtime allocation.
- Producer entries must be objects with known tags, valid provenance, instance paths, and attachment arrays.
- Transfer and pair descriptors validate shape, provenance, paths, cardinality, distinctness, and referenced Network names.
- Attachment references are rejected as `RT1004` at ingress rather than reaching partial runtime allocation.
- New malformed-payload diagnostics include JSON-style paths such as `$.producers[0].destinations[0]`.
- Regression coverage includes `producers: [null]`, an unknown Producer tag, a malformed pair, and an unknown attachment Network.

Validation: **923 tests in 87 files**, format check, and typecheck pass.

Still required to complete F06: canonical frozen reconstruction without the remaining plan cast; exhaustive nested arithmetic/condition/output/debug/diagnostic validation with depth limits; `output`/`outputs` normalization; and making replay consume only the canonical result.
