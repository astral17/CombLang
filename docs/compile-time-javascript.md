# Compile-time JavaScript boundary

CombLang executes a synchronous TypeScript-shaped JavaScript subset during elaboration. The semantic pass is conservative preflight: the transformed runtime is authoritative when an operation's domain depends on its executed values. Ordinary JavaScript values keep ordinary JavaScript behavior; DSL values are dispatched to circuit construction.

## Supported and regression-tested

- function declarations and synchronous calls;
- `if`/conditional expressions and JavaScript short-circuiting for `&&`, `||`, and optional access;
- `for`, `for…of`, `for…in`, `while`, and `do…while`;
- arrays, plain objects, property/element reads and writes, and flat destructuring;
- ordinary numeric/string arithmetic and comparisons;
- ordinary methods named `.as`, `.to`, `.at`, or `.take` when the executed receiver is not a DSL handle;
- TypeScript annotations, capability types, and numeric enums erased before execution.

Control-flow tests remain JavaScript tests; they do not describe circuit branches. A nominal circuit `Condition` such as `input > 0` is therefore rejected with `RT2024` when used directly by `if`, a conditional expression, `while`, `do…while`, or a `for` condition. Use `IF(input > 0, ...)` or `when(input > 0).then(...)` to create a decider. Ordinary values retain exact JavaScript truthiness, including unary `!` for numbers, strings, `null`, arrays, and objects.

Optional element and property-call chains remain native JavaScript and preserve nullish short-circuiting. They are not DSL invocation syntax: use a direct DSL selection or method call when the receiver is a Network or Producer. DSL-sensitive expressions nested in an optional key or argument are still transformed, but native short-circuiting prevents them from executing when the receiver is nullish.

The generated JavaScript calls the elaboration runtime through a compiler-selected parameter name that does not occur anywhere in the source file. User bindings or references named `__dsl`, `__dsl_1`, and similar identifiers remain ordinary JavaScript and force a different bridge name; they neither shadow nor expose the runtime API.

The v1 language reserves all free DSL identifiers. User variables, parameters, destructuring bindings, functions, classes, and enums cannot be named `Signal`, `Network`, `CC`, `IF`, `to`, `when`, `pair`, `Each`/`EACH`, `Anything`/`Any`/`ANYTHING`/`ANY`, or `Everything`/`All`/`EVERYTHING`/`ALL`; such a binding reports `CL1045`. Property names and methods are not free identifiers, so ordinary `object.to(...)`, `object.as(...)`, `object.at(...)`, and `object.take(...)` remain valid. A future lexical symbol-resolution phase may relax this policy.

User function signatures are resolved by lexical symbol identity rather than name matching; a shadowing local binding never inherits an outer function's contract. Reassigned function bindings are left to executed validation. Non-optional calls carry argument provenance through aliases, object/array members, and spreads. Ordinary method receivers, getter-before-argument evaluation, spread iteration order, and direct `eval` scope are retained; this tracing does not consume the circuit-recording DSL-call budget. Optional calls, native callbacks, `super`, and private-method calls retain native invocation and may use the parameter declaration as diagnostic fallback.

Method lookup happens once, before argument evaluation, including ordinary methods named `.to`, `.take`, `.at`, and `.as`. The runtime selects the circuit operation only for a DSL receiver; ordinary objects retain their own methods, getters, and `this`. Arguments remain in their original lexical environment rather than an injected callback, including a suspended `yield` argument. Computed method calls such as `producer['to'](output)` follow the same dispatch. For DSL calls with spread arguments, arity is validated after expansion: `(input + 0).at(...coordinates).to(...destinations)` does not require a statically known array length.

## Accepted with limited DSL integration

Function declarations accept both `function f(input)` and
`function f(input: Network)`. A direct Network value becomes an implicit read-only
borrow with one `CL2002` warning per executed parameter declaration, while an
untyped ordinary value keeps JavaScript behavior. Typed Network parameters also
materialize Producer arguments; generic untyped parameters keep Producer handles.
Writes and consumption require explicit `Ref<Network>` and `Move<Network>`.
This does not infer contracts for arrows, methods, rest-array contents, or
destructuring patterns. See [implicit parameters](ownership-and-multi-network.md)
for lifetime, color, and warning rules.

- callbacks such as `.map(...)` execute normally, but their iterations do not currently add a distinct provenance frame; use an explicit loop when per-iteration diagnostic identity matters;
- ambient time and randomness are currently allowed, so builds need not be reproducible.

Ambient Promise and microtask APIs are not yet removed by the deferred hardened
sandbox. The elaboration recorder is nevertheless sealed as soon as synchronous
module execution completes. A delayed callback that attempts `input + 1`,
`CC(...)`, `new Network()`, or another DSL operation therefore reports `RT2025`
and cannot mutate the completed plan. Asynchronous ordinary-JavaScript side
effects are outside the supported compilation model and must not be relied on.

## Unsupported

- static or dynamic imports, exports, `import.meta`, and top-level `await`;
- `async` functions, arrows, and methods, `await`, and `for await…of`;
- multi-file module linking;
- asynchronous circuit generation;
- treating optional chaining as a circuit DSL operator;
- relying on full TypeScript type checking or arbitrary TypeScript emit features outside the tested syntax-erasure boundary.

This document describes compatibility, not a security boundary. See [Security model](security-model.md).
