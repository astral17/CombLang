# Native objects, Deciders, and blueprint parameters

This document describes the implemented native-object contracts and the
remaining evidence boundaries. Most candidate native-object spellings remain
provisional, while the exact `Constant({ isOn, sections })` and ergonomic
`Section` slices described below are implemented and backed by executable
tests. Captured Factorio 2.1 blueprint fixtures are still required before
claiming native import/export conformance.

Typed-object constructors return separately branded Entity handles, and inferred
declarations preserve that identity. An object is not encoded as a Combinator
merely because it exposes circuit ports. A `Network` context may project one
schema-declared default circuit view without creating hardware; otherwise source
selects an explicit port. See [Combinator and Entity value policy](producer-materialization-policy.md)
for the current value categories and rationale.

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

The IDE should eventually expose the chosen domain, physical object count, and
latency in hovers. This is a presentation layer over semantic facts, not
editor-owned inference.

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

Object schemas should leave room for separate circuit and logistic conditions
where Factorio supports them. Exact constructors and schema-derived field
capabilities remain explicit contracts rather than inferred convenience.

## Native Decider completeness

The source language, lower simulator, and blueprint IR represent ordered normal
and else output lists. Compact syntax supports `IF(condition, then, else)`,
`when(condition).then(...).else(...)`, and false-only
`when(condition).else(...)`. The exact `Decider({ condition, outputs,
elseOutputs })` source form is implemented for the current semantic output
vocabulary; it requires trusted canonical Decider authority and uses the
canonical Entity pipeline. Native fixture verification remains future work.

The current exact slice preserves the native surface without hidden hardware:

- ordered normal and else output lists;
- copy-input-count and constant-count modes;
- concrete, `Each`, `Anything`, and `Everything` selectors only in their native contexts;
- independent input network selections where the Factorio schema permits them;
- exactly one physical Decider and one tick for one source Decider configuration;
- preservation of repeated output SignalIDs.

Exact records require only `condition`; `outputs` and `elseOutputs` are
independently optional and may be omitted, `undefined`, or empty. They accept a
single output value or recursively nested plain arrays and records per branch.
Flattening is ordered and preserves duplicates. An empty normal branch is
valid only when the else branch has rows; an empty else branch is canonicalized
away. A row carries branch, dense ordinal, source
boundary, dynamic instance path, and syntax intent through v6 plan/EG/NCIR/
resolved/debug transport. Nested JavaScript mutations before the final
container is supplied do not receive invented provenance.

Repeated outputs are intentional. For example, copying `A` and emitting constant `1` to `A` yields the sum on the destination Network; the compiler must not deduplicate or combine those rows.

### Each conditions with a concrete output Signal

In final native Each-mode, a copy-count row targeting a concrete SignalID is a
per-candidate operation. It redirects every matching candidate's count to that
output Signal; any sum is only the Network aggregation of those separate
contributions. A constant row targeting the same signal also runs once per
matching candidate. This must never be represented as `sum`, `reduce`, row
fusion, or another algebraic simplification, because those abstractions lose
native row multiplicity.

The current raw source spelling `input[A]` remains valid. `input.into(A)` is the
leading candidate for a future explicit-intent spelling, but it is not frozen or
implemented. If adopted, it is a Decider output descriptor only—not a generic
topology method—and must first be defined for non-Each conditions and verified
for `pair(red, green)` against Factorio fixtures.

Conditions and output arrays may be assembled by arbitrary elaboration-time
JavaScript. Consequently native validity and any clarity detection must run on
the final Decider descriptor after execution; an AST-only check cannot be
authoritative. The current finalizer already rejects an `Each` output without
an `Each` condition and an `Everything` output with an `Each` condition, even
when their rows or conditions were generated dynamically. The implemented
output-row descriptor retains source span, dynamic instance path, ordinal, and
syntax intent (`implicit-concrete-copy`, explicit ergonomic form, or
exact/native). Duplicate rows retain distinct descriptors. Exact constructors
may suppress stylistic advice, but never native correctness validation. The
exact normalizer rejects malformed records and containers atomically before
topology or Entity allocation; the row metadata remains available through the
canonical plan and resolved transport.

An implicit concrete copy in Each-mode is legal, so any readability diagnostic
must be a configurable note/hint rather than an unconditional warning. Its
stable semantic rule ID is provisionally
`decider.each-concrete-copy`. Generated occurrences are grouped once per
Decider/rule with bounded related locations to avoid diagnostic spam. The
diagnostic subsystem requirements are recorded in
[Diagnostics](diagnostics.md#planned-configurable-advisories).

`Everything` remains a first-class wildcard rather than compile-time expansion. Feedback patterns may use an O(1) normal update and an O(n) generated initialization list in `.else(...)`. Wildcard behavior for zero-valued signals and feedback bootstrap must be proven against the simulator and reviewed compatibility fixtures before the rotating-state benchmark becomes an acceptance test.

Permanent self-initializing topology is preferred over temporary combinators that are deleted after startup. Entity lifecycle and topology mutation must not be introduced implicitly by a convenience form.

## Constant-combinator sections

The current `CC(5 * A, 7 * B)` form denotes one physical constant combinator with one default section. Factorio 2.1 sections additionally carry an ordered index, optional group, floating-point multiplier, and active state; the whole combinator has a separate `is_on` state.

The ergonomic Section form is:

```ts
const first = 0.5 * Section(1 * A, 2 * B);
const second = 3 * Section({ group: 'backup', active: false }, 1 * C);
const constants = CC(first, second);
```

`Section(...filters)` defaults to active with multiplier `1` and no group.
`Section(options, ...filters)` accepts only the data properties `active` and
`group`. Only `finiteNumber * Section(...)` sets the section multiplier;
`Section(...) * number` is not supported. Raw filters remain the one-section
shorthand. A `CC` call uses either only raw filters or only nominal Sections;
mixing the two forms is rejected instead of guessing which section owns a
filter. Section indices come from source order, and a standalone Section
creates no topology. The former dotted section-helper spelling is not
executable syntax.

The implemented exact form keeps native configuration visible:

```ts
const constants = Constant({
  isOn: true,
  sections: [
    {
      multiplier: 1,
      filters: [5 * A, 7 * B],
    },
  ],
});
```

The implementation retains `active`, `group`, duplicate rows, and non-unit
`multiplier` through the direct plan, canonical circuit, and Blueprint JSON.
The sparse-bus simulator evaluates only active, unit, ungrouped sections and
throws its typed unsupported-configuration error for the rest. The
Known/Unknown value simulator returns a deterministic Unknown origin for those
configurations rather than inventing rounding or group behavior. This is an
implementation boundary, not native Factorio conformance: native multiplier
and group semantics still require exported-blueprint evidence and compatibility
fixtures. Supported convenience and exact forms create one physical
constant-combinator Entity when trusted authority is available and no extra
topology or tick; raw legacy `CC` remains usable without that authority.

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

The concrete side of this boundary is already explicit in NCIR as
`ConcreteConfigSignal`, `ConcreteConfigNumber`, and `ConcreteConfigCondition`.
Decider outputs are likewise split into `mode: "copy"` and `mode: "constant"`
rows. A future parameter layer can extend these concrete categories without
making the simulator bus symbolic.

The exact types may live in a parameterized configuration layer before FCIR. NCIR simulation continues to use concrete `SignalId -> int32` buses. Tests instantiate parameters from supplied values or defaults before normal elaboration and simulation; a missing required value is a test/configuration error.

## Dependencies and formulas

Dependent parameters form a graph. Recipe ingredients, recipe products, numeric formulas, and parameter properties are typed dependency nodes; users do not manage native parameter indices. The compiler topologically assigns backend ordering and rejects cycles.

Formula expressions should be stored as an AST, not an opaque string. The final set of operators, functions, parameter properties, and dependency kinds must follow captured capabilities from the target Factorio version.

## Conformance boundary

The serializer is not considered correct from prose documentation alone. It
needs small checked-in exported-blueprint fixtures covering at least:

- signal and numeric parameters;
- reuse of one parameter in several fields;
- recipe, entity, quality, ingredient, and product dependencies;
- numeric formulas and parameter properties;
- Constant, Arithmetic, Decider, object condition, filter, and recipe fields;
- omission/defaulting rules for SignalIDs;
- encode/decode and semantic round trips.

The workflow is `Factorio export -> decoded normalized JSON -> golden fixture -> codec -> round-trip test`. Until those fixtures exist, exact native field names and serialization shapes remain open.

## Cross-cutting invariants

No convenience syntax may hide a physical Entity, change tick latency, clone a
reused Producer, deduplicate native output rows, or turn placement-time
parameters into runtime signals.
