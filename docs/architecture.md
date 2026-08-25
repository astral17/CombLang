# Implementation boundaries

This repository grew from the Phase 0 skeleton into the completed Phase 3 source compiler. Major folders are workspace packages, while finer-grained architecture folders (`language/parser`, `compiler/ir`, and so on) remain source modules inside those packages until scale justifies independent publishing.

Allowed dependency direction:

```text
apps/web ──> language, compiler, simulator, layout, renderer
apps/cli ──> language, compiler, simulator
runtime ───> compiler, factorio, shared
compiler ──> factorio, shared
simulator ─> factorio, shared
layout ────> compiler, shared
renderer ──> shared
```

The compiler and simulator packages must remain free of DOM, Monaco, and framework dependencies. Renderer contracts are neutral data; browser rendering belongs in `apps/web`.

## Current slice

The parser returns the official TypeScript AST plus CombLang-owned diagnostics and stable source spans. Both the CLI and browser workbench call that same API. The browser invokes it through a revisioned Web Worker protocol and ignores stale responses; later compiler phases can extend that protocol without moving heavy work back to the UI thread.

The initial simulator kernel follows the architectural two-phase rule: every device reads the immutable tick `T` snapshot, all device outputs are collected, and only then is tick `T + 1` committed.

The direct elaboration runtime now creates frozen, session-bound network and producer handles. It records a small Elaboration Graph, lowers logical network references into NCIR, solves color equality/inequality constraints with a deterministic parity DSU, and materializes arithmetic/decider devices for synchronous simulation. The solver uses paired red/green color classes, generalized to return a complete assignment and structured conflicts. A direct MemoCell test is the Phase 2 vertical slice: two native combinators, four attachments, feedback, fan-out, and retained state.

The Factorio kernel exposes `Signal(name)` for the default item namespace and `Signal(type, name, quality?)` for explicit identities. The one-argument form normalizes to the same `{ type: "item", name }` identity as `network["name"]`; blueprint generation omits that default item type. The lowercase `signal(...)` spelling delegates to the same implementation. Import-time omission rules for other Factorio contexts remain Phase 8 conformance work.

The bootstrap direct-plan compiler resolves top-level `Signal(...)` constants and `network[SIGNAL]` element access without executing source. It remains a regression oracle. The production CLI and browser instead transform these operations and classify their executed runtime values.

Phase 3 started with a read-only semantic side table over the official TypeScript AST. That conservative checker now rejects only definite DSL errors before execution. The static direct-plan compiler remains a bootstrap regression oracle and is not the production execution model.

The implemented Phase 3 pipeline is `semantic classification -> DSL-sensitive AST transform -> bounded JavaScript execution -> EG`. Ordinary JavaScript functions, loops, branches, arrays, and objects are executed by the JavaScript engine. Only circuit-sensitive operators and contextual materialization are rewritten to the allowlisted `__dsl` runtime. The browser runs that JavaScript in a terminable Worker; the CLI uses the same transform/runtime path without requiring the web app. Consequently, supporting a new compile-time loop shape must never require adding a corresponding source-template matcher.

Variable materialization and element reads now use the executed value as their final discriminator. A producer-valued declaration is materialized under its source name even without an explicit `: Network`, while ordinary JavaScript values pass through unchanged. Element reads similarly select a Signal only when their executed receiver is a Network; array and object reads retain JavaScript behavior, and write/update targets are deliberately left native. This removes declaration-name pattern matching from runtime-returned Network selection without pretending that JavaScript has operator overloading.

A producer-valued declaration records its physical producer once and materializes one output Network. Reusing that Network in several downstream expressions fans out the same physical result; it does not re-execute or clone the producer expression. The executed-runtime suite fixes this invariant with one `dx = input - 1` feeding both `dx * dx` and `dx + 10`.

Executed functions and every ordinary loop body (`for`, `for…of`, `for…in`, `while`, and `do…while`) are instrumented with balanced instance-stack scopes. `try/finally` preserves stack correctness across `return`, `break`, `continue`, and exceptions. Runtime descriptors snapshot paths such as `function MemoCell`, `for i=7`, and `while #2`. Provenance bookkeeping is not charged to the numeric limit; only circuit-recording DSL operations are. The browser retains its independent wall-clock worker termination for source that loops without touching the DSL.

The bootstrap direct-plan lowerer remains useful as a differential-test oracle, but it is no longer a web-compiler fallback. Every browser source revision now goes through transformed JavaScript execution and records the same serializable `comblang-direct-plan` boundary before EG/NCIR.

The transform recursively lowers a left-associative Network/literal arithmetic tree. Every circuit binary node becomes one producer, inner results materialize into deterministic `$tmp:N` Networks, and the source proof advances one synchronous tick per producer. No identity elimination, reassociation, or combinator fusion is performed.

Pure integer subtrees are folded before the direct plan is emitted. Folding keeps safe-integer compile-time semantics, rejects non-integral results and division/modulo by zero, and applies strict signed-`int32` validation only where the resulting constant enters a physical circuit operand.

The arithmetic source subset also resolves local `const` integer bindings declared before the function return. Binding evaluation is recursive and cached per direct function call, with explicit cycle diagnostics. Purely numeric bindings affect constants in the plan but never add a producer or tick stage; the web proof reports folded operator count separately from physical stages.

The same binding resolver accepts circuit-valued arithmetic expressions. A physical result receives a deterministic `$local:<call>:<binding>` Network and its declaration span becomes the output attachment origin. Cached binding resolution ensures the named operation is lowered once, while subsequent expressions consume that Network and preserve its synchronous tick boundary.

Top-level typed Network declarations may compose several supported arithmetic functions. The compiler processes calls in source order, makes each completed destination available to later calls, and forwards a returned local binding into its call destination when it has not already been materialized elsewhere. Ambiguous already-materialized aliases fail explicitly instead of silently creating an unproduced destination.

Every lowered call contributes a stable `Function:destination` instance-path segment to its networks, producers, and attachments. Runtime provenance copies and freezes these paths so later diagnostics and visualizations can identify an expansion without depending on allocated graph ids.

Compact source deciders now begin with `IF(network > constant, network)`. A signed int32 constant may appear on either side; reversed forms such as `40 < network` are canonicalized to `network > 40`. Comparisons may be joined by `&&` and `||`, with a current guard of 64 comparisons and 16 boolean groups. Boolean `!` is pushed into comparisons through De Morgan and comparator inversion, so normalization does not allocate hardware. The predicate remains inside one decider descriptor, the output is copied `Each`, and EG/NCIR therefore retain exactly one physical combinator and one synchronous simulator tick. Unsupported Network-to-Network comparisons and remaining alternate output specifications fail with source-aware diagnostics.

The first alternate decider output specification is `constant * EACH`. It is recognized only in the output slot of `IF` or `when(...).then(...)`, where it lowers to wildcard `Each` with `copyCountFromInput: false` and an int32 constant. The multiplication token therefore creates no arithmetic producer. The synchronous decider emits that constant for each active `Each` candidate, matching the native constant-count mode.

Bare Network values already mean native `Each` in arithmetic operands and compact decider contexts. The explicit spellings `Each(network)` and `network[EACH]` now normalize to that same semantic selection before producer lowering. They add no graph node and are deliberately distinct from typed `network[SIGNAL]` selection. `Anything` and `Everything` remain separate wildcard descriptors rather than aliases of `Each`.

Compact decider conditions also preserve the native quantifiers from `Anything(network)` / `network[ANYTHING]` and `Everything(network)` / `network[EVERYTHING]`. They lower to one wildcard comparison over the selected logical Network, including canonicalization when the int32 constant is written on the left.

The same explicit selections are available as copy-count outputs. `Anything(network)` deterministically copies one matching signal and is valid with both Each and non-Each conditions. `Everything(network)` copies the selected input bus and is rejected when a condition uses Each, matching the native device restriction. An explicit wildcard output also cannot be rebound through `destination[SIGNAL]`; both invalid forms are rejected before a circuit is produced.

`Any` and `All` are source aliases for `Anything` and `Everything`. Element access accepts the corresponding `ANY` and `ALL` tokens. All spellings normalize through one name resolver before condition or output lowering, so aliases never survive as distinct IR or runtime concepts.

The first existing-destination source form is `output += Function(input)`. The compiler lowers the supported function body directly into the already declared output Network, so attachment itself remains zero-tick. It never interprets `Network += Network` as a merge; that form receives a dedicated diagnostic and will remain reserved for explicit ownership-aware merge syntax.

`Function(input).to(first, second)` is the first source-level topology form that makes color inference observable. Both attachments share one physical producer output, remain separate logical Networks, and therefore receive a `different` color constraint. The runtime either assigns one red and one green deterministically or reports `RT2010` when fixed colors make the pair impossible.

One fluent destination may be selected directly as `producer.to(output[A])`. Fan-out instead uses `producer.to(first, second, A)`: its plain Network destinations remain distinct color-constrained outputs, while the final Signal binds the one native producer output mode. `producer.to(first[A], second[A])` is intentionally invalid because selected Networks are read-oriented values, not a writable pair.

Color constraints are generated per physical connector, not per combinator as a whole. A producer reading two distinct logical Networks generates a `different` constraint for its input connector; two destinations generate the corresponding constraint for its output connector. Input and output colors do not constrain each other. Source functions may now accept two Network arguments, and explicit signal-to-signal IF comparisons lower to the native decider right-signal operand, making input-side inference and fixed-color conflicts observable without constructing the runtime graph manually.

The direct source attachment layer also recognizes `destination += expression` and `to(first, second) += expression`. Bare Network operands lower to independently selected `Each` operands; the simulator evaluates two-Each arithmetic lane by lane over the union of both selected signal supports. Color solving remains global across Network identities, so constraints from separate producers can form a conflicting odd cycle even though input and output connector sides of one combinator remain independent. Declaration-only plans are elaborated as well: unconstrained components receive the deterministic red representative unless fixed otherwise, allowing the UI to show the complete current assignment before any producer exists.

A typed declaration may contextually materialize those direct producer expressions without a preceding empty Network: `const out: Network = a + b`, `const out: Network = IF(...)`, and `const out: Network = when(...).then(...)`. The declaration span becomes the destination attachment provenance, while the initializer retains producer provenance. This is the same zero-extra-tick attachment operation as `out += producer`, not an arithmetic alias or implicit merge.

Signal-constrained destinations use `out[SIGNAL] += producer`, `producer.to(out[SIGNAL])`, or a final fan-out argument such as `to(out, mirror, SIGNAL) += producer`. The SignalID becomes the physical arithmetic output signal while attachment topology and color constraints remain unchanged. Specific input operands retain their independent Network selections, so `out[C] += left[A] + right[B]` reads A and B from opposite input wire colors and emits only C. When no destination signal is present, the first concrete input signal from left to right is the documented fallback.

Arithmetic and compact-decider producers may carry the same output constraint locally as `expression.as(SIGNAL)`. Lowering forwards that SignalID into the existing producer descriptor; it never inserts a combinator, Network, attachment, or tick. When an element-access destination supplies another output constraint, structural Signal identity must agree or compilation rejects the conflict.

`when(condition).then(output)` is normalized through the same bounded condition and single-decider lowering path as compact `IF`. Producer-valued expression statements are legal but suspicious: standalone arithmetic, `IF`, and `when` expressions emit `CL2001` as a warning, then attach to a compiler-owned `$unused` sink. This preserves complete input topology and color validation without treating a dead output as a compilation error; presentation layers omit the internal sink from the user-facing Network list.

Executed multi-output Deciders retain their output list verbatim. Repeated SignalIDs are not deduplicated: native output rows for the same signal intentionally sum on the destination Network. The simulator and executed-runtime test already cover `then(input[A], 2 * A)` producing `input(A) + 2`. Source `.else(...)` and complete native Decider configuration remain Phase 7 work even though the lower simulator and blueprint IR already represent else outputs.

The executed path also preserves Factorio 2.x native decider output multiplicity: `when(condition).then(a, 2 * A, b)` records one decider descriptor with three output filters. Contextual array or flat-object destructuring maps one producer to one or two newly declared destination Networks, with independent tuple/property color annotations and the same output-connector opposite-color constraint as explicit fan-out.

`CC(count * SIGNAL, ...)` lowers to a native constant producer with no input attachment. Counts are compile-time signed int32 values and signals are declared typed identities; duplicates are rejected instead of being silently combined. The same descriptor supports contextual declarations, `out += CC(...)`, and `to(first, second) += CC(...)`. At runtime it broadcasts a frozen sparse bus on every synchronous tick, while its output destinations participate in the usual connector color constraints.

Direct-plan attachments are source-aware records rather than bare Network names. The runtime preserves those records independently of producer provenance when building EG, so a generated temporary edge and a final assignment edge can be traced to different source spans. Direct runtime callers may provide the same attachment metadata explicitly; the legacy bare-handle form falls back to producer provenance.

Direct-plan validation has both result-oriented and strict entry points. `tryElaborateDirectPlan` returns stable `RT1xxx` diagnostics and retains the most relevant plan span; `elaborateDirectPlan` throws `RuntimeDiagnosticError` carrying that same diagnostic. Unexpected lower-level failures are contained as `RT1099` rather than leaking an unstructured value through the result API.

The direct runtime uses `RT2xxx` diagnostics for handle ownership, attachment cardinality, missing outputs, invalid condition groups, connector capacity, and color conflicts. Producer or attachment provenance supplies the primary span where available. A color conflict also retains related Network declarations when the failing constraint identifies more than one source-bearing Network.

The checked-in API baseline is Factorio Runtime API 2.1.16 / API version 6. Generated schemas and conformance fixtures must record that version and remain checked into this repository, so builds never depend on sibling directories.

## Deployment and interface invariants

- `apps/web` must remain deployable as static files on GitHub Pages, including project pages hosted below `/<repository>/`. Asset and worker URLs therefore cannot assume the domain root; the Vite base stays relative and has a regression test.
- The production web application remains browser-local and backend-free; the same compiler pipeline is also available through the local CLI. Local web development binds to `0.0.0.0` for testing from phones and other devices on the LAN.
- Every user-facing view must remain usable at narrow mobile widths. Desktop-only density is acceptable for advanced inspectors, but navigation, source editing, diagnostics, tests, and export actions require responsive or deliberately stacked layouts.
- Desktop and mobile rendering are both part of UI verification. A successful build alone is not sufficient evidence for interface changes.
- CodeMirror is an optional desktop editor/view boundary rather than the semantic authority. Its incremental TypeScript grammar handles immediate highlighting, indentation, folding, and completion presentation. Narrow coarse-pointer devices default to a native textarea to preserve reliable mobile keyboard and IME behavior; users can switch either way. The revisioned compiler worker remains authoritative in both modes.
- The native textarea remains the authoritative immediate edit buffer on mobile. Phase 11 may add a non-interactive highlight layer, composition-aware completion edits, and a symbol bar, but must not rewrite the textarea value during IME composition or make a contenteditable widget mandatory.

## Early blueprint JSON preview

`generateBlueprintJson` converts resolved NCIR directly into readable Factorio 2.x blueprint JSON. It creates one entity per arithmetic, decider, or constant producer; maps native control behavior; assigns deterministic row positions; and emits `wires` from resolved logical Network colors and producer connector sides. The web workbench displays this object without exchange-string compression.

This is deliberately pre-FCIR. Placement is a deterministic preview rather than a reach-aware layout, entity-number stability is local to one generation, and import/export semantic round trips remain Phase 8 work. Keeping this boundary explicit prevents the temporary row placer from becoming part of the eventual blueprint codec contract.

## Next slice

Phase 3's executed compiler path is complete. Phase 4 adds affine Network ownership and an immutable both-colors input view without changing the ordinary-JavaScript execution model. Its design and acceptance criteria live in [Phase 4: ownership and multi-network design](ownership-and-multi-network.md).

Later native-object, exact-Decider, and placement-time parameter domains are specified in [Native objects, Deciders, and blueprint parameters](native-objects-deciders-and-parameters.md). They extend configuration values without making the concrete circuit simulator symbolic.

The architectural constraints are:

1. capability annotations and runtime handle state describe topology ownership, not JavaScript binding mutability;
2. the semantic pass rejects only definite ownership violations, while runtime values settle dynamic indexing, container, and branch-dependent cases;
3. zero-tick Network union is explicit and consuming rather than another meaning of `+=`;
4. `pair(a, b)` is a read-only two-color connector view, distinct from output fan-out;
5. ownership and pair diagnostics retain the same source and dynamic-instance provenance through the serialized plan, EG, NCIR, CLI, and browser boundaries.
