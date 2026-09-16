# Implementation boundaries

The source compiler, Phase 4 ownership model, and Phase 5 MVP testbench are implemented. Phase 5.5's static prototype environment, browser-first profile, provenance, and integrity boundary are complete. The internal synthetic Entity configuration slice is implemented; remaining runtime-only Entity capabilities stay open for later Phase 6/7 slices. Major folders are workspace packages, while finer-grained architecture folders (`language/parser`, `compiler/ir`, and so on) remain source modules inside those packages until scale justifies independent publishing.

Allowed dependency direction:

```text
apps/web ──> language, compiler, runtime, prototypes, simulator, factorio, shared
apps/cli ──> language, compiler, runtime, prototypes, shared
runtime ───> compiler, factorio, prototypes, simulator, shared
compiler ──> language, factorio, shared
language ──> shared, TypeScript
simulator ─> factorio, shared
layout ────> shared
renderer ──> shared
prototypes > standalone normalized data/provider boundary
```

The compiler and simulator packages must remain free of DOM, Monaco, and framework dependencies. Renderer contracts are neutral data; browser rendering belongs in `apps/web`.

Static data-stage dumps, pinned API metadata, and later reviewed capability evidence
are separate evidence layers. The current raw normalizer is transitional;
[Prototype truth sources](prototype-truth-sources.md) records the extraction
decision and remaining conformance work. Prototype facts stay out of the simulator.

## Current slice

Entity v3 execution validates replay, reuses the resolved producer topology,
lowers declaration names to physical Network IDs once, exposes parallel debug
entries, and maps physical objects onto the generic object-test boundary. A
successful host-authorized v3 compilation also emits a detached
`ResolvedSourceCircuit` containing the canonical physical NCIR. The browser
validates and freezes that snapshot, then hydrates simulation and blueprint
previews without profiles, replay, or Entity construction authority. The
host-bound source subset now lowers direct `Entity(prototype)` calls and
explicit `.port(...)`/`.bind(...)` operations into that same v3 path. Its
public two-argument form accepts three disjoint configuration forms: a partial
schema-checked `BlueprintEntity` fragment resolved from the selected provider
prototype's actual `type`, the bounded profile-free `{ raw }` form, or exact
`{ rule, lanes, condition }` data with the nominal `NativeCondition(...)`
helper. Checked fragments combine common fields with an exact variant when
available and otherwise use a common-only structural schema; successful checks
lower to the existing raw physical payload. Session `Signal(...)` handles are
detached at declared SignalID positions. None of these checks assert native
compatibility or simulation behavior. `.at(...)` replaces placement on the same
physical record, and all forms preserve one Entity identity and create no
hidden Producer, Network, Decider, or tick.
Typed facades, raw native import, and verified native import behavior remain
pending; see [Entity v3](entity-v3.md).

The Phase 7 computation slice uses separate Entity v4, cumulative v5, and
cumulative v6 envelopes. v4 remains Constant-only; v5 is selected when any
Arithmetic producer is linked and may mix linked Constant and Arithmetic. v6
is selected when any Decider producer is linked and may mix linked Constant,
Arithmetic, and Decider. Exact
`Arithmetic({ left, operation, right, output })` requires trusted base
`entity:arithmetic-combinator` authority with matching prototype type. The v5
validator requires the current SHA-256 profile-set identity, checks exact
family/configuration/association equality, and rejects linked producer
placement because placement belongs to the Entity. Validated v4/v5/v6 plans reuse
the v2 topology engine transiently, then restore their association in graph and
NCIR without creating a second physical object. Their profile-free resolved
snapshots and hydration paths carry identity-only context, not profiles,
providers, or resolver authority. The public exact Constant/Arithmetic/Decider
forms and provider-backed `CC`/ergonomic Arithmetic/IF/when share their linked
physical representation when the matching trusted base profile is available;
without that authority, profile-free behavior retains its legacy envelope
(exact Decider rejects the missing authority). Synthetic/
internal tests and readable blueprint preview do not establish native Factorio
conformance.
The default website and ordinary CLI now provision a conservative, provider-
bound zero-port fallback profile only for Entity records whose normalized
`blueprintEligible: true` fact is explicit. Presence in `data.raw`, a familiar
prototype type, or a safe-looking name is not enough. This grants construction
and placement only; it does not invent connectors, configuration logic, or
native behavior.

The parser returns the official TypeScript AST plus CombLang-owned diagnostics and stable source spans. Both the CLI and browser workbench call that same API. The browser invokes it through a revisioned Web Worker protocol and ignores stale responses; later compiler phases can extend that protocol without moving heavy work back to the UI thread.

The initial simulator kernel follows the architectural two-phase rule: every device reads the immutable tick `T` snapshot, all device outputs are collected, and only then is tick `T + 1` committed.

The direct elaboration runtime now creates frozen, session-bound Network and Combinator handles. It records a small Elaboration Graph, lowers logical network references into NCIR, solves color equality/inequality constraints with a deterministic parity DSU, and instantiates arithmetic/decider devices for synchronous simulation. The solver uses paired red/green color classes, generalized to return a complete assignment and structured conflicts. A direct MemoCell test is the Phase 2 vertical slice: two native combinators, four attachments, feedback, fan-out, and retained state.

The Factorio kernel exposes `Signal(name)` for the default item namespace and `Signal(type, name, quality?)` for explicit identities. The one-argument form normalizes to the same `{ type: "item", name }` identity as `network["name"]`; blueprint generation omits that default item type. The lowercase `signal(...)` spelling delegates to the same implementation. Import-time omission rules for other Factorio contexts remain Phase 8 conformance work.

The bootstrap direct-plan compiler resolves top-level `Signal(...)` constants and `network[SIGNAL]` element access without executing source. It remains a regression oracle. The production CLI and browser instead transform these operations and classify their executed runtime values.

Phase 3 started with a read-only semantic side table over the official TypeScript AST. That conservative checker now rejects only definite DSL errors before execution. Its lexical state is one `SemanticScope` stack: resolving the nearest binding happens before reading its Network, Network-array, capability, or Producer-slot facts. An ordinary or unknown local binding therefore forms an explicit barrier and cannot inherit an outer binding's DSL category; adding a new fact kind cannot require a separate manually synchronized scope stack. The static direct-plan compiler remains a bootstrap regression oracle and is not the production execution model.

The implemented Phase 3 pipeline is `conservative semantic preflight -> syntax-preserving DSL instrumentation -> bounded JavaScript execution with authoritative runtime domain dispatch -> EG`. Ordinary JavaScript functions, loops, branches, arrays, and objects are executed by the JavaScript engine. Instrumented operators dispatch from their executed value categories: ordinary values retain JavaScript behavior, while runtime-branded DSL values construct circuit descriptors. The browser runs that JavaScript in a terminable Worker; the CLI uses the same transform/runtime path without requiring the web app. Consequently, supporting a new compile-time loop shape must never require adding a corresponding source-template matcher. The supported compatibility surface is recorded in [Compile-time JavaScript](compile-time-javascript.md).

`compileSourceProgram` in the isolated `@comblang/runtime/source-compilation` entry point owns that complete stage sequence and its append-only diagnostic order. Keeping it outside the lightweight runtime barrel prevents the TypeScript parser from entering the main UI and test Worker bundles. Its local result may contain an `ExecutedDirectPlan` or host-bound `ExecutedEntityDirectPlan`; `sourceCompilationArtifact` explicitly removes that host-local value and retains the serializable v2/v3 plan, generated JavaScript, summaries, diagnostics, prototype-environment identity, and (only after successful host-authorized v3 lowering) a detached `ResolvedSourceCircuit`. The browser compiler Worker transports only this artifact. A Worker request carries only cloneable Entity replay identity; an injected host adapter resolves trusted profiles and prototype methods after the boundary. The CLI invokes the parsed-file variant after `parseProject`, aggregates the same pipeline diagnostics, and reuses the local execution for tests.

After a serializable compilation artifact reaches the browser main thread, the workbench creates one `SourceCircuitArtifact`. Its generated blueprint and fresh simulation kernels are shared by the overview, interactive simulation, and JSON preview. v2 still elaborates its producer-only plan locally; v3 instead validates the matching `ResolvedSourceCircuit` and hydrates its already-resolved physical IR. Resetting or branching a trace creates a fresh simulation kernel over that immutable circuit; it does not replay source, consult profiles, or lower the plan again. The Worker transport deliberately remains serializable and contains no runtime handles, functions, profiles, or `Map` instances.

Bindings and element reads use the executed value as their final discriminator. A combinator-valued declaration retains the already-created physical handle; an explicit `: Network` only narrows it to the existing primary output facet. Ordinary JavaScript values pass through unchanged. Element reads select a Signal only when their executed receiver is a Network facet; array and object reads retain JavaScript behavior, and write/update targets are deliberately left native. This removes declaration-name topology and recursive container conversion without pretending that JavaScript has operator overloading.

Runtime-only Networks, Combinators, pairs, selections, destinations, conditions, and typed counts are registered nominally in session-local registries. Their public-looking `kind` fields remain useful for internal debugging, but guards never trust those fields: an ordinary configuration object remains ordinary JavaScript, and a handle created by another elaboration session is not accepted implicitly.

The runtime value shapes and their nominal `RuntimeValueRegistry` now live in a dedicated internal module rather than in the execution coordinator. Ownership validation and transitions are isolated behind `ElaborationOwnershipPolicy`: borrow creation/release, moves, returns, dropped ownership, consuming transfer, and color requirements share one tested state machine. `ElaborationOperatorPolicy` separately owns source-operator normalization, condition inversion, nominal JavaScript-versus-DSL value-category dispatch, arithmetic/condition producer construction, and exact native-JavaScript fallback semantics. The coordinator supplies session-bound guards, provenance, and plan-recording callbacks through an explicit dispatch context.

Every Network input reference crossing the direct-plan, EG, or NCIR boundary is explicitly discriminated as either `{ refKind: "single", network }` or `{ refKind: "pair", networks: [first, second] }`. A pair has no synthetic primary Network: all consumers must handle both colors intentionally. This incompatible schema cleanup advances `comblang-direct-plan`, `comblang-eg`, and `comblang-ncir` to version 2. The elaboration-JavaScript envelope is also version 2: it carries the compiler-selected hygienic runtime-parameter identifier alongside the generated code, and the executor validates that identifier before constructing the function.

Normalized producer input traversal is centralized in `producer-network-references`. Its occurrence view retains descriptor order and repeated normal/else Decider output rows; its topology view expands pairs and returns frozen distinct Network IDs in first-use order. Color constraints, debug graph analysis, native blueprint wiring, and circuit metrics consume that topology view instead of maintaining separate condition/output walkers.

Resolved NCIR timing uses the same topology view through `analyzeCircuitGraph`. It builds all Producer dependencies for every Network driver, condenses feedback SCCs, and computes an order-independent longest depth over the resulting DAG. Feedback count and unknown device latency remain separate facts; condensed depth is structural and never presented as proof of convergence. The precise metric is documented in [Circuit graph metrics](circuit-graph-metrics.md).

`CircuitColorConstraints` owns the compiler's stateful parity DSU independently of source execution and presentation code. Networks receive stable registration ordinals; `same`, `different`, and fixed-color constraints are checked as they are added, retain their reason/provenance on conflicts, and do not implicitly register unknown IDs. `resolve` is observational: anchored components follow their fixed color, while the earliest registered member of every free component is deterministically red regardless of union order. The `solveCircuitColors` API is a compatibility wrapper over this engine.

The executed source recorder owns one such engine for its complete lifetime. Its opaque physical Network identity is the ownership-state object rather than the mutable display name, so aliases, function-return rebinding, moves, and zero-tick `take` do not lose color history. Logical Network union is tracked separately from DSU color parity: two independent fixed-red Networks have the same color but are not the same connector input. Network creation/fixed requirements, pair creation, combinator input/output connectors, and `take` register constraints immediately. The first contradiction is therefore attributed to the source operation that closes the inconsistent prefix instead of being deferred to Direct Plan replay.

Recorder lifecycle is `active -> failed` after a confirmed DSL-domain failure and `active -> sealed` after successful finalization or an uncaught source exit. A failed recorder retains its first error: user code may catch it and continue ordinary JavaScript, but the next circuit-recording call and finalization return that original failure. Execution-API frames mark domain participation only when a DSL operation records work; exceptions from ordinary methods, getters, coercions, and callbacks that happen to cross the instrumented bridge do not poison the recorder. Replay still validates the serialized final topology as an independent trust boundary.

Public DSL annotations are parsed once in the language package. Semantic preflight and executable transform consume the same small `DslTypeSyntax` model for owned/borrowed/moved Networks, color requirements, concrete Combinator handles, array containers, and the recursive executed parameter contracts used by supported unions and primitive/nullish branches. Bare Network parameters are transparent references; explicit capabilities retain their narrower ownership behavior. This parser intentionally recognizes only the stable DSL surface; it does not attempt TypeScript assignability or general symbol resolution. `Producer` remains a deprecated source alias for `Combinator` during migration.

Arithmetic, `CC`, `IF`, and `when` create physical Combinators and eager primary output Networks at operator/call execution time. `CombinatorRegistry` owns physical identity, mutable configuration, placement, debug captures, one eager primary lane, and one lazy stable secondary lane. The public Combinator is a Network subtype, but internally it contains an output port rather than being collapsed into one Network. Repeated reads use primary; direct destructuring projects stable lanes; connections consume primary then secondary; a third independent output connection is `RT2028`.

The ownership boundary uses the same lane policy for every context-sensitive acquisition. A `Combinator` passed to `Move<Network>` consumes its next available output lane, selecting primary first and creating secondary lazily; a third request is `RT2028`. An explicit or static `Network` narrowing such as `producer as Network`, `const out: Network = producer`, or a typed `Network` return exposes the exact primary Network view and never grants hidden Combinator authority or falls back to the secondary lane.

This replaces the Phase 4.5 transient Producer/materialization choice. Ordinary arrays and objects remain ordinary containers because Combinators already satisfy Network read contexts. Future persistent Entity handles remain separately branded and do not inherit Network automatically. The revised six-program decision is recorded in [Combinator and Entity value policy](producer-materialization-policy.md).

NCIR now names its concrete configuration domains as `ConcreteConfigSignal`, `ConcreteConfigNumber`, and `ConcreteConfigCondition`. The number domain is admitted only through the shared safe-integer-to-int32 boundary. Decider output rows are a discriminated `copy`/`constant` union, so a row cannot accidentally request both modes or neither. These are concrete simulation values; Phase 8 may add parameter and formula variants in a higher configuration layer without widening `SparseBus` or the synchronous simulator.

Executed function declarations, untyped or DSL-relevant parameter boundaries in arrows/function expressions, explicit return boundaries, and every ordinary loop body (`for`, `for…of`, `for…in`, `while`, and `do…while`) are instrumented with balanced instance-stack scopes. `try/finally` preserves stack correctness across `return`, `break`, `continue`, and exceptions. Runtime descriptors snapshot paths such as `function MemoCell`, `for i=7`, and `while #2`. Provenance bookkeeping is not charged to the numeric limit; only circuit-recording DSL operations are. The browser retains its independent wall-clock worker termination for source that loops without touching the DSL.

The bootstrap direct-plan lowerer remains useful as a differential-test oracle, but it is no longer a web-compiler fallback. Every browser source revision now goes through transformed JavaScript execution and records the same serializable `comblang-direct-plan` boundary before EG/NCIR.

The legacy bootstrap direct-plan lowerer recursively lowers a left-associative Network/literal arithmetic tree and still has its own temporary naming. It is a differential oracle only. The production executed transform creates each physical Combinator immediately and feeds later operations from its primary output Network; it emits no `$tmp` Producer operand path. Neither path performs identity elimination, reassociation, or combinator fusion.

Pure integer subtrees are folded before the direct plan is emitted. Folding keeps safe-integer compile-time semantics and rejects non-integral results and division/modulo by zero. The executed configuration boundary canonicalizes every finite safe integer entering a physical circuit operand to signed int32; fractions, non-finite numbers, and unsafe integers fail before a plan is accepted.

The arithmetic source subset also resolves local `const` integer bindings declared before the function return. Binding evaluation is recursive and cached per direct function call, with explicit cycle diagnostics. Purely numeric bindings affect constants in the plan but never add a producer or tick stage; the web proof reports folded operator count separately from physical stages.

The bootstrap binding resolver also accepts circuit-valued arithmetic expressions. Its `$local:<call>:<binding>` names belong only to the static oracle. Executed source instead retains a source alias to the combinator's eager primary output, preserving the same physical identity and synchronous tick boundary.

The legacy direct-plan oracle may compose several supported arithmetic functions in top-level typed Network declarations. It processes calls in source order and forwards returned local bindings into call destinations under its structural rules. The production executed compiler instead preserves the returned Combinator or Network identity directly and never infers topology from a declaration name.

Every lowered call contributes a stable `Function:destination` instance-path segment to its networks, producers, and attachments. Runtime provenance copies and freezes these paths so later diagnostics and visualizations can identify an expansion without depending on allocated graph ids.

Compact source deciders now begin with `IF(network > constant, network)`. A finite safe-integer constant may appear on either side and is canonicalized to signed int32; reversed forms such as `40 < network` become `network > 40`. Comparisons may be joined by `&&` and `||`, with a current guard of 64 comparisons and 16 boolean groups. Boolean `!` is pushed into comparisons through De Morgan and comparator inversion, so normalization does not allocate hardware. The predicate remains inside one decider descriptor, the output is copied `Each`, and EG/NCIR therefore retain exactly one physical combinator and one synchronous simulator tick. Unsupported Network-to-Network comparisons and remaining alternate output specifications fail with source-aware diagnostics.

The first alternate decider output specification is `constant * EACH`. It is recognized only in the output slot of `IF` or `when(...).then(...)`, where it lowers to wildcard `Each` with `copyCountFromInput: false` and an int32 constant. The multiplication token therefore creates no arithmetic producer. The synchronous decider emits that constant for each active `Each` candidate, matching the native constant-count mode.

Bare Network values already mean native `Each` in arithmetic operands and compact decider contexts. The explicit spellings `Each(network)` and `network[EACH]` now normalize to that same semantic selection before producer lowering. They add no graph node and are deliberately distinct from typed `network[SIGNAL]` selection. `Anything` and `Everything` remain separate wildcard descriptors rather than aliases of `Each`.

Compact decider conditions also preserve the native quantifiers from `Anything(network)` / `network[ANYTHING]` and `Everything(network)` / `network[EVERYTHING]`. They lower to one wildcard comparison over the selected logical Network, including canonicalization when the int32 constant is written on the left.

The same explicit selections are available as copy-count outputs. `Anything(network)` deterministically copies one matching signal and is valid with both Each and non-Each conditions. `Everything(network)` copies the selected input bus and is rejected when a condition uses Each, matching the native device restriction. An explicit wildcard output also cannot be rebound through `destination[SIGNAL]`; both invalid forms are rejected before a circuit is produced.

`Any` and `All` are source aliases for `Anything` and `Everything`. Element access accepts the corresponding `ANY` and `ALL` tokens. All spellings normalize through one name resolver before condition or output lowering, so aliases never survive as distinct IR or runtime concepts.

The first existing-destination source form is `output += Function(input)`. The compiler lowers the supported function body directly into the already declared output Network, so attachment itself remains zero-tick. It never interprets `Network += Network` as a merge; that form receives a dedicated diagnostic. Explicit zero-tick physical union is spelled `destination.take(source)` and consumes the source Network. `join(...inputs)` is the atomic multi-input form: it returns a newly owned Network, records only zero-tick transfers, and creates no Producer.

`join` accepts one or more owned Network or Combinator values. Repeated Combinator occurrences acquire output lanes in source order (primary, then lazy secondary); repeated exact Network inputs, borrowed views, pairs, selections, and unsupported values are rejected. Input validation, fixed-color constraints, output-lane creation, ownership transfers, and signal/topology descriptors commit as one transaction, so a caught failure leaves every input and output lane available for a later valid operation.

`Function(input).to(first, second)` is the first source-level topology form that makes color inference observable. Both attachments share one physical producer output, remain separate logical Networks, and therefore receive a `different` color constraint. The runtime either assigns one red and one green deterministically or reports `RT2010` when fixed colors make the pair impossible.

One fluent destination may be selected directly as `producer.to(output[A])`. Fan-out instead uses `producer.to(first, second, A)`: its plain Network destinations remain distinct color-constrained outputs, while the final Signal binds the one native producer output mode. `producer.to(first[A], second[A])` is intentionally invalid because selected Networks are read-oriented values, not a writable pair.

Color constraints are generated per physical connector, not per combinator as a whole. A producer reading two distinct logical Networks generates a `different` constraint for its input connector; two destinations generate the corresponding constraint for its output connector. Input and output colors do not constrain each other. Source functions may now accept two Network arguments, and explicit signal-to-signal IF comparisons lower to the native decider right-signal operand, making input-side inference and fixed-color conflicts observable without constructing the runtime graph manually.

The direct source attachment layer also recognizes `destination += expression` and `to(first, second) += expression`. Bare Network operands lower to independently selected `Each` operands; the simulator evaluates two-Each arithmetic lane by lane over the union of both selected signal supports. Color solving remains global across Network identities, so constraints from separate producers can form a conflicting odd cycle even though input and output connector sides of one combinator remain independent. Declaration-only plans are elaborated as well: unconstrained components receive the deterministic red representative unless fixed otherwise, allowing the UI to show the complete current assignment before any producer exists.

A typed declaration may narrow an executed Combinator without a preceding empty Network: `const out: Network = a + b`, `const out: Network = IF(...)`, and `const out: Network = when(...).then(...)`. The annotation exposes the already-existing primary output Network and hides physical configuration methods; it creates no attachment, entity, temporary Network, or tick.

Signal-constrained destinations use `out[SIGNAL] += producer`, `to(out, mirror)[SIGNAL] += producer`, `producer.to(out[SIGNAL])`, or the fluent fan-out form `producer.to(out, mirror, SIGNAL)`. The SignalID becomes the physical arithmetic output signal while attachment topology and color constraints remain unchanged. Specific input operands retain their independent Network selections, so `out[C] += left[A] + right[B]` reads A and B from opposite input wire colors and emits only C. When no destination signal is present, the first concrete input signal from left to right is the documented fallback.

Arithmetic and compact-decider output signals are bound only at a destination: `out[SIGNAL] += producer`, `to(out, mirror)[SIGNAL] += producer`, `producer.to(out[SIGNAL])`, or `producer.to(out, mirror, SIGNAL)`. Lowering forwards that SignalID into the existing producer descriptor; it never inserts a combinator, Network, attachment, or tick. The rejected `.as(...)` draft is deliberately not a second output-binding API.

`combinator-output-policy` owns Signal rebinding independently from connection syntax. `CombinatorRegistry` stores the effective binding and first-binding provenance beside the physical identity; descriptor replacements reapply it atomically, retain the original Each input selection, and emit `RT2023` with later-operation, first-binding, and creation provenance when a binding is incompatible. Every alias observes the same configuration.

`when(condition)` registers an incomplete physical Decider immediately. `.then(...)` and `.else(...)` mutate its registry state and re-register the complete input set against the online connector constraints. Finalization reports `RT2022` for a builder with no branch. Every other combinator whose output was never read or connected receives `CL2001`; its dangling primary output remains real, and no `$unused` Network is synthesized.

`CombinatorRegistry` replaces `ProducerLifecycle`. It follows one physical identity across aliases and typed wrappers, owns capture IDs, shared mutable configuration, canonical output binding, output-lane state, placement, and usage tracking, and serializes each device exactly once only after synchronous execution completes.

`combinator-handle-policy` is the category gate for explicit `Combinator`, `ArithmeticCombinator`, `DeciderCombinator`, and `ConstantCombinator` annotations. `Producer` is accepted only as a deprecated compatibility alias. A mismatch is `RT2022`; a valid binding adds a debug name to the same opaque identity rather than wrapping or cloning the physical object.

`network-argument-policy` owns the executed call-argument category boundary. It accepts an opaque Network or projects a Combinator's primary facet, rejects every other executed value with source-linked `RT2015`, validates readability before creating a callee capability view, and carries the direct argument expression span into the later borrow/move check. It creates no hardware and performs no container traversal.

`network-parameter-policy` applies the next function-boundary stage after argument resolution. Shared and mutable parameters create an ownership-policy borrow and an opaque `readonly`/`ref` view; `Move` rejects pair views, transfers the owner into the active function frame, and brands the new generation. The policy chooses direct argument provenance over the declaration fallback and returns it with the handle. The recorder alone appends `capabilityUses` and dynamic `instancePath`, while `elaboration-ownership` remains the authority for conflicts, lifetime, and generation mutation.

`network-return-policy` owns the typed `Network`/`Readonly<Network>` return category. It accepts an existing Network or projects a Combinator's primary facet, applies the declared color requirement, delegates owner transfer to `elaboration-ownership`, and only then brands an optional readonly caller view. A Combinator-typed return bypasses that narrowing and preserves the unrestricted physical handle. `return-owned-value-policy` performs the corresponding atomic validation and replacement for Networks and Combinators inside unannotated array/plain-object return graphs.

`combinator-attachment-policy` validates each output connection request before lane allocation: one or two distinct writable destination Network facets. A shared runtime resolver maps direct Networks and Combinators to their primary facet and rejects pair views; `CombinatorRegistry` then supplies the next unconsumed lane, creating secondary lazily. `RT2003` through `RT2005` cover request cardinality and duplicates; `RT2028` identifies the exact third sequential request. `RT2006` single-attachment semantics no longer exist.

Executed multi-output Deciders retain their normal and else output lists verbatim. Repeated SignalIDs are not deduplicated: native output rows for the same signal intentionally sum on the destination Network. The simulator and executed-runtime tests cover `then(input[A], 2 * A)` producing `input(A) + 2`, `when(condition).else(...)`, and `when(condition).then(...).else(...)`. Exact `Decider({ condition, outputs, elseOutputs })` additionally accepts scalar or recursively nested plain containers, preserves row origins, validates the final descriptor, and links one trusted Entity in v6. Repeated `.then/.else` calls append to the same branch and retain one physical Decider.

Blueprint preview has a separate native-configuration lowering boundary. `blueprint-native-config` resolves NCIR Network references into red/green selections, expands logical Decider trees into the native flat condition rows, translates operations and SignalIDs, and records the complete input Network set for wiring. `blueprint-json` only numbers and places the already-lowered combinators, joins their physical endpoints, and assembles the outer Factorio blueprint object. Missing colors on either an input reference or destination are `BP1001`; the serializer never guesses red as a fallback.

The executed path also preserves Factorio 2.x native decider output multiplicity: `when(condition).then(a, 2 * A, b)` mutates one decider descriptor to contain three output filters. Direct array or flat-object destructuring projects one or two stable output-lane Networks from the same combinator, with independent tuple/property color annotations and the same opposite-color constraint as explicit fan-out.

`CC(count * SIGNAL, ...)` creates a native constant combinator with no input connector. Counts pass through the shared safe-integer-to-int32 configuration boundary and signals are declared typed identities; duplicates are rejected instead of being silently combined. The same physical handle supports Network narrowing, `out += CC(...)`, and `to(first, second) += CC(...)`. At runtime it broadcasts a frozen sparse bus on every synchronous tick, while its one or two output lanes participate in the usual connector color constraints.

Direct-plan attachments are source-aware records rather than bare Network names. The runtime preserves those records independently of producer provenance when building EG, so a generated temporary edge and a final assignment edge can be traced to different source spans. Direct runtime callers may provide the same attachment metadata explicitly; the legacy bare-handle form falls back to producer provenance.

Direct-plan validation has both result-oriented and strict entry points. `tryElaborateDirectPlan` returns stable `RT1xxx` diagnostics and retains the most relevant plan span; `elaborateDirectPlan` throws `RuntimeDiagnosticError` carrying that same diagnostic. Unexpected lower-level failures are contained as `RT1099` rather than leaking an unstructured value through the result API.

The direct runtime uses `RT2xxx` diagnostics for handle ownership, attachment cardinality, output-signal binding, missing outputs, invalid condition groups, connector capacity, and color conflicts. All executed attachment spellings converge before direct-plan serialization, so duplicate/capacity/output-binding failures have the same code and source provenance. Combinator creation or attachment provenance supplies the primary span where available. A color conflict also retains related Network declarations when the failing constraint identifies more than one source-bearing Network.

The checked-in API baseline is Factorio Runtime API 2.1.17 / API version 6. Generated schemas and conformance fixtures must record that version and remain checked into this repository, so builds never depend on sibling directories.

## Deployment and interface invariants

- `apps/web` must remain deployable as static files on GitHub Pages, including project pages hosted below `/<repository>/`. Asset and worker URLs therefore cannot assume the domain root; the Vite base stays relative and has a regression test.
- The production web application remains browser-local and backend-free; the same compiler pipeline is also available through the local CLI. Local web development binds to `0.0.0.0` for testing from phones and other devices on the LAN.
- Every user-facing view must remain usable at narrow mobile widths. Desktop-only density is acceptable for advanced inspectors, but navigation, source editing, diagnostics, tests, and export actions require responsive or deliberately stacked layouts.
- Desktop and mobile rendering are both part of UI verification. A successful build alone is not sufficient evidence for interface changes.
- CodeMirror is an optional desktop editor/view boundary rather than the semantic authority. Its incremental TypeScript grammar handles immediate highlighting, indentation, folding, and completion presentation. Narrow coarse-pointer devices default to a native textarea to preserve reliable mobile keyboard and IME behavior; users can switch either way. The revisioned compiler worker remains authoritative in both modes.
- The native textarea remains the authoritative immediate edit buffer on mobile. Phase 11 may add a non-interactive highlight layer, composition-aware completion edits, and a symbol bar, but must not rewrite the textarea value during IME composition or make a contenteditable widget mandatory.

## Early blueprint JSON preview

`generateBlueprintJson` converts resolved NCIR directly into readable Factorio 2.x blueprint JSON. It creates one entity per arithmetic, decider, or constant producer; maps native control behavior; assigns deterministic row positions; and emits `wires` from resolved logical Network colors and producer connector sides. The web workbench displays this object without exchange-string compression.

`generateEntityComputationBlueprintJson` is the additive v4 adapter. For a
linked Constant it combines the producer's resolved wire endpoints with the
Entity prototype, Entity-owned placement, and canonical Constant sections, so
the output contains one native object number. Unlinked producers and
structural Entities retain the existing separate-object mapping.

`generateEntityComputationBlueprintJsonV5` is the cumulative adapter for
linked Constant and Arithmetic. It uses the Entity prototype/placement and the
producer's resolved native configuration to emit one object per linked device.

`generateEntityComputationBlueprintJsonV6` is the cumulative adapter for
linked Constant, Arithmetic, and Decider. It uses the Entity prototype/
placement and the producer's resolved Decider condition/output configuration
to emit one object per linked device. Row origins remain producer/debug
metadata. The adapter and v6 simulator are structural preview surfaces, not
Factorio conformance claims.

This is deliberately pre-FCIR. Placement is a deterministic preview rather than a reach-aware layout, entity-number stability is local to one generation, and import/export semantic round trips remain Phase 8 work. Keeping this boundary explicit prevents the temporary row placer from becoming part of the eventual blueprint codec contract.

## Next slice

Phase 3's executed compiler path and Phase 4's ownership/multi-network surface are complete. Zero-tick consuming transfer, function-scoped `Readonly`/`Ref` borrow views, explicit `Move<Network>` call/return ownership, shared-generation aliases with ordinary container-slot replacement, and immutable `pair(a, b)` both-colors input views extend the ordinary-JavaScript execution model rather than replacing it. Successful capability uses survive as audit descriptors beside `networkTransfers` and `networkPairs` through the serialized direct plan, validated EG/NCIR execution result, CLI JSON, and browser plan. They do not create hardware; their physical consequences are reflected in color and topology constraints. The acceptance matrix lives in [Phase 4: ownership and multi-network design](ownership-and-multi-network.md).

Later native-object and placement-time parameter domains are specified in
[Native objects, Deciders, and blueprint parameters](native-objects-deciders-and-parameters.md). They extend configuration values without making the concrete circuit simulator symbolic.

The architectural constraints are:

1. capability annotations and runtime handle state describe topology ownership, not JavaScript binding mutability;
2. the semantic pass rejects only definite ownership violations, while runtime values settle dynamic indexing, container, and branch-dependent cases;
3. zero-tick Network union is explicit and consuming rather than another meaning of `+=`;
4. `pair(a, b)` is a read-only two-color connector view, distinct from output fan-out;
5. ownership and pair diagnostics retain the same source and dynamic-instance provenance through the serialized plan, EG, NCIR, CLI, and browser boundaries.
