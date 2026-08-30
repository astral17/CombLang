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

Optional element and property-call chains remain native JavaScript and preserve nullish short-circuiting. They are not DSL invocation syntax: use a direct DSL selection or method call when the receiver is a Network or Producer.

## Accepted with limited DSL integration

- callbacks such as `.map(...)` execute normally, but their iterations do not currently add a distinct provenance frame; use an explicit loop when per-iteration diagnostic identity matters;
- an `async` function may parse, but Promises are not awaited by the synchronous elaborator;
- ambient time and randomness are currently allowed, so builds need not be reproducible.

## Unsupported

- static or dynamic imports, exports, `import.meta`, and top-level `await`;
- multi-file module linking;
- asynchronous circuit generation;
- treating optional chaining as a circuit DSL operator;
- relying on full TypeScript type checking or arbitrary TypeScript emit features outside the tested syntax-erasure boundary.

This document describes compatibility, not a security boundary. See [Security model](security-model.md).
