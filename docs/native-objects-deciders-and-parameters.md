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
boundary, dynamic instance path, and syntax intent through canonical plan/EG/NCIR/
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

The source language supports an initial, concrete-binding subset of configuration
parameters. A declaration requires a label and a concrete default:

```ts
const item = Param.signal('Item', Signal('item', 'iron-plate'));
const limit = Param.number('Limit', 100);
```

`Param` is reserved. Supported slots are an exact Arithmetic configuration's
direct numeric operand, an exact Constant filter's direct Signal or count, an
exact Decider condition's direct right-hand numeric threshold, and exact
Selector `select`'s `index` (number or Signal) or `count`'s `output` (Signal).
Selector `selectMax` remains concrete; other Selector operations and slots are
not parameterized. The defaults compile once into an ordinary concrete Plan
and NCIR. Parameters are not JavaScript numbers, booleans, or loop bounds;
arithmetic on a handle, control-flow use, coercion, and arbitrary function calls
are rejected. Unsupported declaration forms report a source diagnostic
(`CL1050` for malformed syntax; `CP1000` for an invalid concrete default).

In a host-local compilation, `listSourceCompilationParameters(compilation)`
returns declaration labels, defaults, spans, and nominal handles. The host may
pass `{ parameter, value }` overrides to
`bindSourceCompilationParameters(compilation, bindings)`, which returns a fresh
concrete NCIR using the exact paired execution. Omitted overrides use the
declared defaults. For callers that need a replayable result,
`bindSourceCompilationCircuit(compilation, bindings)` returns an immutable
`{ plan, resolvedCircuit }` pair with the same concrete values in both artifacts.
The pair is validated by the strict `executeResolvedDirectPlan` replay check;
the default Plan cannot be combined with a separately bound NCIR. Both APIs
bind the exact owning compilation without re-executing source, and repeated
bindings produce independent results. A copied or foreign compilation and
foreign parameter handles are rejected. The original Plan, NCIR, topology, and
physical identities are not mutated. Handles and captured templates are not part of
`SourceCompilationArtifact`; do not serialize or send them across a Worker
boundary. Binding must happen in the host that owns the original compilation.
The bound pair contains only concrete Plan and ResolvedCircuit data; it is not
attached to the default artifact.
The artifact also omits generated JavaScript containing private parameter-capture
calls; the local compilation result retains that diagnostic view. Source receives
an opaque view distinct from the nominal handle exposed by the host API. Reads,
reflection, destructuring, and enumeration of that source view are rejected with
a located diagnostic; valid configuration slots canonicalize it to the original
host handle. Host-side declaration metadata remains available through the
host-local API.

For an internal host-only native export, the same source-compilation module
provides `exportSourceCompilationNativeBlueprint(compilation, options)`.
It returns an immutable, validated `NativeBlueprintFcir` for the existing
`emitNativeBlueprintJson` emitter. Options use the existing
`NativeBlueprintProjectionOptions`: an explicit `label` and positive
`maxDeciderConditionRows`. This entry point accepts only the exact owning
compilation with captured declarations and a successfully lowered circuit;
copied results and detached transport artifacts have no export authority.
Missing capture or circuit reports `TypeError`, as in the concrete binding APIs.
Export performs one default binding and normal native projection, without
executing source again or changing the original concrete artifacts.

Every declaration in this export subset must be a number parameter used only
as a direct exact Constant filter count or Arithmetic constant operand
(`left` or `right`). Its explicit default is also its
native original and must be an integer in [-2147483648, 2147483647]; it is not
wrapped, rounded or allocated automatically. A zero count remains an explicit
filter, and the native original string is `"0"`, including for a default of
`-0`. Each nominal handle produces one `{ type: 'number', number: String(original),
name: label }` row in declaration order, even when reused in several filters or
devices. Labels need not be unique. Distinct handles with the same original
are rejected at the second declaration, with a reference to the first.

For valid captured compilations, unsupported declarations or uses fail
atomically with `CP1002`, a declaration or Constant/device-call source span,
and a semantic path. Signal and unused parameters, parameterized
Decider/Selector configurations, symbolic multipliers, expression counts and
expression operands are outside this subset. Existing concrete source binding remains
separate and unchanged. Direct source parameter multipliers already fail
source normalization before a completed capture is available; registered
numeric-expression DAGs are internal host APIs, not new source syntax.
Plain unparameterized devices and concrete section multipliers remain allowed.
The exporter verifies each marked count or operand survives normal projection unchanged;
it does not add filters, devices or topology to make an original present.

Local binding is nominal: independently declared handles can be overridden
independently. Native parameter metadata instead names original values.
Ordinary literals equal to a parameter original are allowed and remain
unchanged in the generated document, but native original-value substitution
may replace those literals too. This exporter does not promise their nominal
independence in Factorio, infer replacement scope from every JSON number, or
claim verified native placement behavior.

The CLI and web copy workflow still export concrete configuration without this
host-only parameter metadata. Existing parameter-free export bytes are
unchanged. This subset does not add formula strings, native parameter indices,
recipe/property dependencies, signal placeholders, Worker transport or UI
integration. Simulation remains concrete; native placement, substitution and
formula evaluation require independent Factorio evidence.

Known limitation: this is a source-language feature, not a hardened sandbox.
JavaScript truthiness (`Boolean(parameter)` and `!!parameter`) cannot be trapped
by the opaque view, and arbitrary native callbacks may observe object identity.
Existing control-flow and arbitrary-call guards remain in place but do not
establish general parameter-flow safety. Ordinary non-parameter objects retain
their normal JavaScript property behavior.

## Dependencies and formulas

An internal host-local numeric-expression DAG now covers finite literals,
registered number-parameter references, unary negation, and binary addition,
subtraction, and multiplication, with bounded construction and a pure
default/binding evaluator. This internal foundation neither parses nor emits
Factorio formulas and does not establish native formula arithmetic semantics.
The reviewed host-local integration is limited to Arithmetic constant operand
values, Decider `condition.compare.right` thresholds and `mode: 'constant'`
output values in both normal and else output lists, and Constant section
multipliers and filter counts. A shared expression may occupy a threshold and
multiple ordered output rows; binding evaluates it to concrete values without
coalescing duplicate rows. Arithmetic/Decider results and filter-count
expressions require a safe integer before the existing int32 normalization; a
Constant multiplier is only required to be finite and remains a double in
concrete configuration. This does not add source formula syntax or native
formula fields, establish placement-time Factorio semantics, or imply simulator
support for non-unit multipliers.

Native formula variables and dependent parameters remain future work. Recipe
ingredients, recipe products, native numeric formulas, and parameter properties
will require typed dependency nodes; users should not manage native parameter
indices. A future backend will need to assign ordering and reject cycles.

Native formula expressions should be stored as an AST, not an opaque string.
The final set of operators, functions, parameter properties, and dependency
kinds must follow captured capabilities from the target Factorio version and
independently reviewed Factorio fixtures.

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
