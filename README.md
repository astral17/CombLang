# CombLang

CombLang is an early implementation of a TypeScript-shaped structural HDL for Factorio 2.1 circuit networks. The checked-in design and implementation notes live in [`docs/architecture.md`](docs/architecture.md).

The current repository implements the Phase 3 source compiler and the first executable Phase 4 ownership slice grown from the original Phase 0 skeleton:

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
- immutable `pair(a, b)` both-colors input views with summed signal reads, opposite-color constraints, simulation, and blueprint wiring.

## Roadmap

- [x] Phase 0 — repository/core skeleton: workspaces, shared IDs and spans, CLI, CI, and the browser/Node parser boundary.
- [x] Phase 1 — Factorio semantics kernel: int32 values, sparse buses, arithmetic/decider semantics, wildcards, and synchronous simulation.
- [x] Phase 2 — direct elaboration runtime: EG/NCIR, session-bound handles, attachments, provenance, color solving, and the MemoCell integration slice.
- [x] Phase 3 — executed source compiler: conservative semantic checks, DSL-sensitive JavaScript transformation, runtime elaboration, provenance, color solving, CLI validation, and the browser workbench.
- [ ] Phase 4 — ownership and multi-network syntax
  - [x] Freeze and implement function-scoped `Readonly<Network>` and `Ref<Network>` capabilities, including color-qualified forms and runtime borrow views.
  - [x] Reject ambiguous bare-`Network` parameters and implement explicit `Move<Network>` call/return transfer, including color-qualified and array/plain-object returns.
  - [ ] Track ownership, borrows, aliases, and moved state through lexical scopes, function calls, returns, destructuring, arrays, objects, and executed control flow.
  - [x] Enforce the function-borrow operation matrix: read-only borrows may be read, mutable borrows may receive producer attachments, neither may be consumed, and escaped views expire.
  - [ ] Complete the owned/moved operation matrix across calls, returns, local aliases, and container ownership slots.
  - [ ] Add source-aware diagnostics for illegal copies, writes through `Readonly`, invalid borrow escapes, double moves, and use after move, with runtime checks for cases the semantic pass cannot prove.
  - [x] Freeze and implement explicit zero-tick consuming network transfer as `a.take(b)`; `a += b` and implicit Network copying remain invalid.
  - [x] Implement `pair(a, b)` as an immutable two-network input view, including `pair(a, b)[SIGNAL]`, wildcard selections, summed red/green reads, and opposite-color constraints.
  - [x] Reject `pair(...)` as an attachment destination or ownership carrier; keep producer output fan-out expressed through `.to(...)`, `to(...) +=`, or contextual destructuring.
  - [ ] Unify single- and multi-destination attachment validation, output-signal binding, connector cardinality, color constraints, and source provenance across all supported producer forms.
  - [ ] Carry capability and multi-network descriptors through the transformed runtime, serialized direct-plan boundary, EG/NCIR lowering, CLI, and browser result model.
  - [ ] Freeze Producer identity and its public type surface so reusing one producer fans out one physical output instead of cloning hardware.
  - [ ] Decide whether topology `+=` requires a `let` binding; the current `const`/`let` behavior remains unchanged until stress tests justify a restriction.
  - [ ] Add focused semantic/runtime tests, end-to-end compiler cases, diagnostics documentation, and executable language examples for every ownership transition and `pair` form.
- [ ] Phase 5 — testbench: drive/expect/tick, mocks and models, Unknown values, waveforms, and debug hierarchy.
- [ ] Phase 6 — typed Factorio objects: shared circuit inputs, native single-comparison `enable`, Roboport, Lamp, Constant, logistics entities, belts, displays, and train stops.
- [ ] Phase 7 — exact constructors and native-config stress: Arithmetic, full Decider normal/else output lists, duplicate outputs, `Everything`, Selector, raw entities, LUTs, and large generated configurations.
- [ ] Phase 8 — parameter-ready configuration IR, placement-time `BlueprintFormula`, dependent blueprint parameters, FCIR, and the Factorio 2.1 codec with fixture-backed semantic round trips.
- [ ] Phase 9 — interactive schematic UI with provenance cross-selection, grouping, layout, inspection, and timing views.
- [ ] Phase 10 — physical placement, wire reach verification, relays, and blueprint export.
- [ ] Phase 11 — language-service and execution-environment polish: operator-domain hovers, completions, code actions, semantic tokens, exact native views, composition-safe textarea highlighting/completion and mobile symbol tools, optional reproducible-build policy, and a fully hardened module sandbox.

Later phases still cover the remaining ownership and multi-network semantics, testbenches, typed Factorio objects, exact constructors, the verified blueprint codec and exchange strings, schematic editing, physical placement, multi-file language services, reproducible builds, and a hardened sandbox.

## Documentation

- [Getting started](docs/getting-started.md) — install, validate, build, and run the browser workbench.
- [Current language reference](docs/language-reference.md) — the exact implemented syntax, diagnostics, and known gaps.
- [Phase 4 ownership design](docs/ownership-and-multi-network.md) — planned affine ownership, borrows, consuming transfer, read-only `pair`, and implementation checkpoints.
- [Native objects, Deciders, and parameters](docs/native-objects-deciders-and-parameters.md) — planned Phase 6–8 semantic domains and conformance requirements.
- [Diagnostics](docs/diagnostics.md) — compiler/runtime code families and the most common actionable errors.
- [Blueprint JSON preview](docs/blueprint-json.md) — generated structure, wiring model, and current limitations.
- [Architecture notes](docs/architecture.md) — package boundaries, lowering decisions, runtime invariants, and implementation status.

Signal identity is structural. `Signal("chest")` is the same default-item shorthand as `network["chest"]` and produces the internal identity `{ type: "item", name: "chest" }`; blueprint JSON omits that default `item` type. Explicit namespaces use `Signal("virtual", "signal-A")`, while `Signal("virtual", "signal-A", "normal")` also carries quality. The lowercase `signal(...)` helper remains a compatibility alias for internal/runtime code. Broader import-time omission/defaulting rules still require Phase 8 Factorio conformance fixtures.

The source compiler recognizes top-level Signal declarations and specific Network selection in compact deciders. For example, `IF(input[SIGNAL_A] > 40, input[SIGNAL_A])` tests and copies only signal A; unrelated signals on the same circuit network are not emitted. Arithmetic may bind its physical output explicitly with `out[RESULT] += left[A] + right[B]`, `.to(out[RESULT])`, or `.to(out, mirror, RESULT)`. Without an explicit destination binding, the first concrete signal operand from left to right is the deterministic fallback.

The direct runtime milestone is covered by a two-combinator MemoCell integration test. It constructs feedback and fan-out through `network`, `arithmetic`, `decider`, and `attach`, then verifies that the stored signal survives after the external input disappears.

The homepage uses the architecture-defined executable path for every source revision: classify TypeScript, transform DSL-sensitive AST nodes, execute the remaining JavaScript in a persistent time-bounded Web Worker, then elaborate the recorded plan. The Worker keeps compiler assets loaded across edits, retains only the newest queued revision while busy, and is terminated and replaced after a crash or timeout. Functions and compile-time loops are real JavaScript metaprogramming rather than compiler-recognized templates.

The earlier static direct-plan compiler remains as a regression oracle for differential tests, but the web compiler no longer selects it as a fallback. A construct either executes through the transformed runtime or receives an execution diagnostic.

Nested left-associative circuit arithmetic is lowered structurally. For example, `input * 10 + 5` creates two arithmetic combinators, an explicit temporary Network, and a two-tick waveform; it is never collapsed or reassociated.

Ordinary integer-only subexpressions are evaluated during elaboration. Thus `input * (2 + 3)` emits one physical arithmetic combinator with constant `5`, while invalid compile-time arithmetic and constants outside signed `int32` are reported before runtime execution.

Arithmetic functions may bind those values to local `const` names before the return expression. Bindings can depend on earlier bindings and are memoized per function call; purely numeric bindings remain compile-time, while circular definitions receive a dedicated diagnostic. The homepage example exposes both physical producer/tick counts and folded-operation counts.

Local `const` bindings may also hold circuit expressions. Their result is materialized as a deterministic `$local:<call>:<name>` Network, so splitting an expression across named statements does not fuse combinators or erase tick boundaries. The homepage exposes the friendly local name in its resolved-color chips while retaining the complete internal identity in the plan inspector.

Multiple arithmetic Network functions can be composed through typed top-level Network declarations. Calls are lowered in source order, returned local results can feed the declared call destination directly, and the resulting cross-function pipeline retains one producer and one synchronous tick per circuit operation.

Lowered graph nodes and attachments carry stable function-call instance paths (for example, `Scale:middle`) for source-aware diagnostics and future nested visualizations.

The compact `IF(condition, output)` source form supports Network, concrete-signal, and wildcard selections; signed int32 constants; signal-to-signal comparisons; bounded `&&`/`||` groups; and boolean negation. Comparisons are canonicalized before the complete predicate lowers to exactly one decider combinator, retaining one-tick behavior and rejecting invalid native condition/output combinations.

In decider output context, `IF(input > 0, 0x00ff00 * EACH)` is a typed output specification rather than circuit arithmetic. The one decider emits the constant count for every signal that satisfies its `Each` condition; it does not allocate an arithmetic combinator or add a tick. Counts must fit signed int32; malformed forms are rejected before a circuit is produced.

An existing top-level Network can receive a supported function producer through `output += Scale(input)`. This records a zero-tick output attachment to the declared Network rather than materializing another Network or combinator. `Network += Network`, unknown destinations, and unsupported right-hand values fail explicitly.

The TS-valid multi-destination form `Scale(input).to(output, mirror)` attaches the same physical producer to two logical Networks without merging them. Because a Factorio output connector has one red and one green circuit connector, the color solver constrains these two destinations to opposite colors; incompatible fixed `<R>/<G>` declarations produce a source-aware `RT2010` conflict.

Arithmetic and decider combinators constrain each physical connector independently. Two distinct logical Networks read by one input connector must use opposite colors, just as two destinations on one output connector must; three distinct Networks exceed connector capacity. There is deliberately no equality or inequality relation between a combinator's input and output colors because Factorio exposes separate red and green connectors on both sides. The current source slice demonstrates input inference with a two-argument signal comparison such as `IF(value[SIGNAL_A] > threshold[SIGNAL_A], value[SIGNAL_A])`.

Direct producer attachment follows the architecture syntax: `out += IF(condition, source)`, `out += when(condition).then(source)`, `out += a + b`, and `to(first, second) += producer`. A standalone arithmetic, `IF`, or `when(...).then(...)` producer receives the non-fatal `CL2001` warning. It is still lowered into an internal unused sink so input connector capacity and color constraints cannot escape validation. In `to(c, d) += a + b`, `a != b` is an input-side constraint and `c != d` is an output-side constraint; the two sides have separate physical connectors, so `a/c` and `b/d` may reuse red/green. A genuinely impossible global case is an odd constraint cycle such as `a != b`, `b != c`, and `c != a`, which produces `RT2010`.

Typed top-level declarations provide the contextual materialization counterpart to attachment syntax: `const sum: Network = a + b`, `const gated: Network = IF(...)`, and `const gated: Network = when(...).then(...)` create the named destination directly. They use the same producer lowering, topology checks, color constraints, and synchronous tick semantics as `destination += producer`; no extra attachment combinator is introduced.

The current constant-combinator form is `CC(count * SIGNAL, ...)`, where every signal is a declared `Signal(...)` value and every count is a signed int32 constant. It can initialize a contextual Network with `const constants: Network = CC(5 * A, 7 * B)`, drive an existing Network with `out += CC(5 * A)`, or fan out with `to(first, second) += CC(5 * A)`. `CC` is a synchronous source device with no input connector and repeats the configured signal values on every tick; malformed entries and duplicate signals are rejected before a circuit is produced.

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

The CLI `check` command runs TypeScript parsing, the conservative DSL semantic pass, transformed JavaScript elaboration, and runtime topology/color validation. It is the normal compiler validation path; starting the browser workbench is unnecessary for source checks.

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
