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

## Accepted with limited DSL integration

- callbacks such as `.map(...)` execute normally, but their iterations do not currently add a distinct provenance frame; use an explicit loop when per-iteration diagnostic identity matters;
- ambient time and randomness are currently allowed, so builds need not be reproducible.

## Unsupported

- static or dynamic imports, exports, `import.meta`, and top-level `await`;
- `async` functions, arrows, and methods, `await`, and `for await…of`;
- multi-file module linking;
- asynchronous circuit generation;
- treating optional chaining as a circuit DSL operator;
- relying on full TypeScript type checking or arbitrary TypeScript emit features outside the tested syntax-erasure boundary.

This document describes compatibility, not a security boundary. See [Security model](security-model.md).
