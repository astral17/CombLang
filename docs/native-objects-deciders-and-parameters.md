# Native objects, Deciders, and blueprint parameters

This document records accepted post-Phase-3 design constraints for Phases 6–8. It does not describe syntax implemented by the current compiler. Candidate spellings remain provisional until backed by executable tests and captured Factorio 2.1 blueprint fixtures.

Phase 4.5 fixed the declaration rule before these objects are implemented: a typed-object constructor returns a separately branded Entity handle and inferred declarations preserve that identity. It must not pass through combinator Producer auto-materialization. A `Network` context may project exactly one schema-declared default circuit view without creating hardware; otherwise source selects an explicit port. See [Producer and Entity materialization policy](producer-materialization-policy.md) for the six benchmark programs and rationale.

## Three semantic times

CombLang must keep three domains separate:

1. TypeScript/JavaScript elaboration time generates topology and configuration.
2. Blueprint placement time resolves native Factorio blueprint parameters and formulas.
3. Circuit runtime evaluates signals, combinators, and synchronous ticks.

A JavaScript number, a placement-time numeric parameter, and a circuit signal count are different values even when the same operator token is used. The operator classifier therefore needs explicit domains rather than a rule that only asks whether either operand is a Network:

```text
CompileTime
BlueprintFormula
CircuitArithmetic
CircuitCondition
TypedDescriptor
Invalid
```

The IDE should eventually expose the chosen domain, physical object count, and latency in hovers. This is Phase 11 presentation over semantic facts, not editor-owned inference.

## Native object conditions

Typed Factorio objects may expose native enable/disable conditions. The ergonomic candidate is:

```ts
Inserter({
  enable: IRON_PLATE < 100,
})(storage);
```

Inside an object `enable` field, a bare Signal means that signal on the object's actual shared circuit input. Signal-to-signal and Signal-to-int32 comparisons are native configuration. The accepted comparator set must come from the target Factorio schema.

An object condition is not a general Decider condition tree. If the entity supports only one comparison, this must be rejected rather than silently inserting a Decider and a tick:

```ts
Inserter({
  enable: IRON_PLATE > 0 && IRON_PLATE < 100,
})(storage); // planned error
```

The user can construct the additional combinator explicitly and feed its result to the entity. Likewise, when several object features share one physical circuit connector, they read the same red/green aggregate input; the compiler must not invent feature-specific ports.

Object schemas should leave room for separate circuit and logistic conditions where Factorio supports them. Exact constructors and schema-derived field capabilities belong to Phase 6 and Phase 7.

## Native Decider completeness

The lower simulator and blueprint IR already represent normal and else output lists. The source language currently supports ordered multi-output `.then(...)` but not `.else(...)`.

Phase 7 must complete the native surface without hidden hardware:

- ordered normal and else output lists;
- copy-input-count and constant-count modes;
- concrete, `Each`, `Anything`, and `Everything` selectors only in their native contexts;
- independent input network selections where the Factorio schema permits them;
- exactly one physical Decider and one tick for one source Decider configuration;
- preservation of repeated output SignalIDs.

Repeated outputs are intentional. For example, copying `A` and emitting constant `1` to `A` yields the sum on the destination Network; the compiler must not deduplicate or combine those rows.

`Everything` remains a first-class wildcard rather than compile-time expansion. Feedback patterns may use an O(1) normal update and an O(n) generated initialization list in `.else(...)`. Wildcard behavior for zero-valued signals and feedback bootstrap must be proven against the simulator and captured Factorio fixtures before the rotating-state benchmark becomes an acceptance test.

Permanent self-initializing topology is preferred over temporary combinators that are deleted after startup. Entity lifecycle and topology mutation must not be introduced implicitly by a convenience form.

## Blueprint parameter values

Blueprint parameters are placement-time configuration, not runtime circuit objects. Candidate declarations include:

```ts
const item = Param.signal('Item');
const limit = Param.number('Limit', 100);
```

Uses such as `storage[item]`, `CC(limit * item)`, object filters, recipes, and native conditions remain symbolic until blueprint placement. A numeric expression over parameters becomes a typed `BlueprintFormula` AST and creates no combinator or tick.

Configuration-facing IR should admit symbolic values without infecting the concrete simulator bus:

```text
ConfigSignal = SignalId | BlueprintSignalParameter
ConfigNumber = int32 | BlueprintNumberParameter | BlueprintNumericExpr
ConfigRecipe = RecipeId | BlueprintRecipeParameter
```

The concrete side of this boundary is already explicit in NCIR as `ConcreteConfigSignal`, `ConcreteConfigNumber`, and `ConcreteConfigCondition`. Decider outputs are likewise split into `mode: "copy"` and `mode: "constant"` rows. Phase 8 extends the configuration layer above these concrete categories; it does not make the simulator bus symbolic.

The exact types may live in a parameterized configuration layer before FCIR. NCIR simulation continues to use concrete `SignalId -> int32` buses. Tests instantiate parameters from supplied values or defaults before normal elaboration and simulation; a missing required value is a test/configuration error.

## Dependencies and formulas

Dependent parameters form a graph. Recipe ingredients, recipe products, numeric formulas, and parameter properties are typed dependency nodes; users do not manage native parameter indices. The compiler topologically assigns backend ordering and rejects cycles.

Formula expressions should be stored as an AST, not an opaque string. The final set of operators, functions, parameter properties, and dependency kinds must follow captured capabilities from the target Factorio version.

## Conformance boundary

The serializer is not considered correct from prose documentation alone. Phase 8 needs small checked-in exported-blueprint fixtures covering at least:

- signal and numeric parameters;
- reuse of one parameter in several fields;
- recipe, entity, quality, ingredient, and product dependencies;
- numeric formulas and parameter properties;
- Constant, Arithmetic, Decider, object condition, filter, and recipe fields;
- omission/defaulting rules for SignalIDs;
- encode/decode and semantic round trips.

The workflow is `Factorio export -> decoded normalized JSON -> golden fixture -> codec -> round-trip test`. Until those fixtures exist, exact native field names and serialization shapes remain open.

## Phase mapping

- Phase 4 settles Network/Producer ownership, `take`, `pair`, and the separation between `const`/`let` rebinding and topology capability.
- Phase 5 testbenches remain concrete; Phase 8 later adds parameter instantiation before those tests enter the existing simulator.
- Phase 6 introduces typed objects, shared connector inputs, and native object conditions.
- Phase 7 completes exact native combinator/object configuration and the feedback/duplicate-output stress cases.
- Phase 8 introduces parameter-ready configuration IR, `BlueprintFormula`, dependent parameters, FCIR, and the fixture-backed Factorio codec.
- Phase 11 presents operator-domain facts in language services and finishes composition-safe mobile editing tools.

Across all phases, no convenience syntax may hide a physical entity, change tick latency, clone a reused Producer, deduplicate native output rows, or turn placement-time parameters into runtime signals.
