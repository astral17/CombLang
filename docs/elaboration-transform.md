# Elaboration transform

CombLang keeps ordinary JavaScript control flow and rewrites only DSL-sensitive TypeScript syntax into calls on a hygienic runtime parameter. The transform has two explicit stages:

1. `analyzeElaborationTransform(file)` performs a read-only source prepass.
2. `transformElaborationModule(file)` consumes those facts while visiting and rewriting AST nodes.

The resulting module is ordinary JavaScript parameterized by the executed recorder. It does not contain a second interpreter for loops, functions, arrays, objects, or property access.

## Analysis contract

The prepass owns facts that require whole-file or lexical lookup:

- every source identifier, used to choose `__dsl`, `__dsl_1`, and so on without capturing user code;
- unsupported async syntax, including async modifiers, `await`, and `for await...of`;
- definitely declared Signal and Network bindings;
- destructured bindings whose initializer is known to contain a Network;
- typed Producer slots and their lexical scope, declaration position, array element type, or flat object property type.

`producerTypeForAssignment(target, assignment)` resolves the nearest declaration that is both visible at the assignment and declared before it. An outer Producer annotation must not leak through a same-named block/function/loop/catch binding. Property and element assignments are classified only when their declared container type proves a concrete Producer category.

The prepass intentionally records positive facts, not a general TypeScript type system. Ambiguous values remain ordinary JavaScript until an executed DSL boundary can classify them.

## Rewrite contract

The AST visitor owns local syntax transformations and evaluation order. It consumes the prepass instead of rebuilding name/scope heuristics inside individual node branches. Runtime calls retain source spans, and transform-generated temporaries use the hygienic runtime parameter selected before rewriting.

Unsupported async syntax is retained in the output metadata and rejected by the execution boundary. The transform does not partially execute or silently erase it.

### Enum lowering

`elaboration-transform-enum.ts` owns the complete enum rewrite family. It evaluates the supported side-effect-free numeric subset through the shared language helper, resolves earlier local or enum-qualified members, and emits a frozen runtime object. A known numeric initializer advances implicit numbering; a dynamic initializer is passed back through the main expression visitor and suspends implicit numbering until another explicit numeric constant establishes a new base.

Keeping this rule outside the dispatch visitor prevents enum-specific state from leaking into unrelated binding and expression branches. The semantic preflight remains responsible for source-linked `CL1048` when an implicit member follows a dynamic value; the lowering invariant still rejects such input if the transform is invoked without semantic preflight.

### Control-flow instrumentation

`elaboration-transform-control-flow.ts` owns `if`, conditional expressions, `for`, `for…of`, `for…in`, `while`, and `do…while`. It does not evaluate or unroll them. Conditions remain native JavaScript expressions after their descendants are transformed, then pass through `controlTest` so an executed DSL value cannot be used as JavaScript truthiness accidentally. A conditionless `for (;;)` remains conditionless.

Each actually entered loop body opens a provenance instance and closes it in `finally`. Consequently `continue`, `break`, `return`, and thrown exceptions cannot leave the dynamic instance stack unbalanced. Simple loop bindings contribute their executed name/value; destructuring and other ambiguous initializers use the stable `iteration` fallback rather than inventing a binding identity.

### Function boundaries

`elaboration-transform-functions.ts` owns instrumented function declarations and their direct return statements. Its prologue maps executed identifier parameters to the appropriate implicit Network, `Readonly`, `Ref`, `Move`, or concrete Producer runtime boundary using the original argument span. The body opens one function provenance/ownership frame and closes it in `finally`, including exceptional exits.

Only a return whose nearest function-like ancestor is that declaration receives its declared Network or Producer return contract. Returns inside nested arrows, callbacks, methods, or function expressions remain owned by those JavaScript functions and cannot accidentally transfer the outer function's ownership. Parameter-default and binding-pattern rewriting is supplied as an explicit callback; the function family does not duplicate binding logic.

### Bindings and defaults

`elaboration-transform-bindings.ts` owns identifier, tuple, object, and parameter binding materialization. A direct `new Network<R/G>()` binding receives its stable source name and late alias reader; a nested construction remains anonymous. Other executed initializers pass through contextual Network materialization unless an explicit Producer annotation retains and validates the physical handle.

Tuple and object destructuring emit runtime descriptors for each supported flat destination, including property mapping, color, and concrete Producer kind. Defaults recurse through the same policy, so parameters, destructuring elements, and loop bindings do not gain a separate DSL expression path. Test-only `t.instantiate` also enters here because a direct binding supplies its stable debug instance name; an unbound call instead receives a source-offset identity. Function instrumentation consumes `transformParameter` as an explicit dependency.

### Calls and element access

`elaboration-transform-calls.ts` owns optional chains, direct DSL calls, ordinary direct and member calls, fluent `when(...).then/else` forms, and element reads. Optional operations remain native JavaScript chains: only their descendants are transformed, so computed keys and arguments are still skipped by nullish short-circuiting.

Ordinary calls pass source-bearing argument records to the runtime. Spread arguments expand through `spreadCallArguments`, while member calls prepare the receiver and key before evaluating arguments so both JavaScript order and `this` binding are retained. Direct `eval` deliberately remains native because wrapping it would change its lexical environment.

An element access is rewritten as an executed DSL boundary only when it is a read. Assignment, compound-assignment, increment/decrement, and `delete` targets remain available to their owning operator transform; this prevents a read wrapper from changing JavaScript write semantics. Test-only instantiation is delegated back to the binding component because stable instance naming depends on the surrounding binding.
