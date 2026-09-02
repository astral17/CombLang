# Phase 4: ownership and multi-network design

This document defines the intended semantic boundary for Phase 4. `destination.take(source)`, function-scoped `Readonly`/`Ref` borrows, explicit `Move<Network>` call/return transfer and slot replacement, ordinary shared-identity aliases, and immutable `pair(a, b)` input views are frozen and implemented. Other syntax below remains design material unless the [current language reference](language-reference.md) says otherwise.

Phase 4 makes physical circuit topology explicit in the type and runtime models. A `Network` is an affine handle to one logical wire network: it may be read many times and referenced by ordinary JavaScript aliases, but those aliases share one ownership token rather than cloning ownership. Consuming that token invalidates every stale view. The phase also adds an immutable view over the two wire colors without turning that view into another writable network.

## Goals

- distinguish ownership from read-only and mutable borrowing;
- make zero-tick physical network union explicit and consuming;
- preserve ownership facts across functions and ordinary executed JavaScript containers;
- represent a Factorio input connector reading both red and green wires with `pair(a, b)`;
- keep input aggregation separate from producer output fan-out;
- report a static error only when invalidity is certain, and defer value-dependent cases to the elaboration runtime;
- preserve source and dynamic-instance provenance in every ownership diagnostic.

Phase 4 does not add multi-file modules, a hardened security sandbox, Factorio object constructors, physical wire routing, or the final blueprint codec.

The compiler permits producer attachment through both `const` and `let` Network bindings. This is now intentional: `const` prevents JavaScript rebinding, while topology writability comes from the Network capability. Use `let` only when the binding itself must be replaced, for example after a consuming function returns a fresh ownership generation.

## Capability model

The capability wrappers use valid TypeScript type syntax. Their public names and the operation matrix below are now frozen.

| Form                | Meaning                                     | Read signals | Attach a producer | Consume or transfer |
| ------------------- | ------------------------------------------- | ------------ | ----------------- | ------------------- |
| `Network`           | owned local value or owned return value     | yes          | yes               | yes                 |
| `Readonly<Network>` | shared read-only topology borrow            | yes          | no                | no                  |
| `Ref<Network>`      | mutable, non-owning topology borrow         | yes          | yes               | no                  |
| `Move<Network>`     | ownership accepted by a consuming parameter | yes          | yes               | yes, once           |

Color requirements compose with capabilities:

```ts
Readonly<Network<R>>;
Ref<Network<G>>;
Move<Network>;
```

`const` only prevents rebinding a JavaScript variable. It does not turn an owned Network into `Readonly<Network>` and does not prevent a producer from being physically attached to that Network.

Function parameters annotated as `Readonly<Network>` or `Ref<Network>` receive runtime borrow views. `Move<Network>` consumes the caller's ownership generation and may return a fresh owned view, directly or inside an array/plain object. Direct, provably invalid operations are also rejected by the conservative semantic pass. Runtime generations authoritatively cover local aliases, destructuring, arrays, objects, closures, and executed control flow.

## Function boundaries

The intended common forms are:

```ts
function Scale(input: Readonly<Network>): Network {
  return input * 10;
}

function AddIndicator(output: Ref<Network>, input: Readonly<Network>): void {
  output += IF(input > 0, input);
}

function Advance(input: Move<Network>): Network {
  input += input + 1;
  return input;
}
```

A read-only parameter may feed arithmetic, conditions, selections, and typed Factorio inputs. A mutable reference may additionally receive producer outputs, but the callee cannot consume the caller's Network. Both views expire when the function returns; definite direct escapes are static errors and dynamically hidden escapes fail when returned. Multiple shared borrows may overlap, while an overlapping mutable/shared borrow currently fails conservatively. Color-qualified capability types add real color requirements to the underlying Network.

`Move<Network>` is the only owned parameter mode. It invalidates all caller aliases at entry, permits reads, writes, and consuming transfer, and gives returned ownership a new runtime generation. Arrays and plain objects recursively transfer owned members on return. A duplicated member such as `[input, input]` is a double move. If the callee neither returns the moved owner nor consumes it with `.take(...)`, the value is dropped; stale caller aliases remain invalid. Returning a Network owned by an outer caller without first accepting it through `Move` is rejected as an implicit steal.

Container returns are checked as a graph before transferring any owner. A rejected member does not partially invalidate earlier members. Cycles and shared containers are preserved (the same container is inspected once), along with sparse indices, own-property descriptors, and frozen/sealed/non-extensible state. Containers that do not lead to transferred Networks retain their identity. Getters are not invoked, and Maps/class instances are not traversed; this boundary does not roll back effects from evaluating the return expression.

Bare `Network` parameters are forbidden because an implicit mode would hide whether the call borrows or consumes ownership. Bare `Network` remains valid for local bindings and return annotations.

Borrowed values must not outlive their owner. The checker should reject a definite borrow escape. If ordinary JavaScript control flow or a dynamically selected container element prevents proof, the runtime must validate the actual handle state instead of the checker guessing.

## Copying, containers, and destructuring

Ordinary assignment does not copy Network ownership. It creates another JavaScript reference to the same logical Network and ownership generation:

```ts
let a = new Network();
let alias = a;
const values = [a];
```

`a`, `alias`, and `values[0]` may all be read or used as topology destinations while that generation is current. Moving or consuming the Network through any one of them invalidates every stale alias. A genuinely independent Network requires `new Network()` or contextual materialization from another producer.

Executed Network values are frozen nominal handles. Mutable ownership and borrow state is stored in a session-local `WeakMap`, not as an `ownership` or `borrow` property on the source-visible object. Consequently reflection cannot replace the owner, generation snapshot, capability, or borrow lifecycle, and copying visible fields cannot forge a valid handle. Plans and diagnostics still retain the same Network names and declaration provenance.

Arrays and objects remain supported. They may own Networks, and reading `arr[i]` or `record.output` may borrow the contained handle for circuit expressions and producer attachment. Phase 4 must preserve that identity through dynamic indexing:

```ts
const output = new Network();
const stages: Network[] = [new Network(), new Network()];

for (let i = 0; i < stages.length; i++) {
  output += stages[i] * 2;
}
```

Passing a dynamically read slot to a `Move` parameter invalidates its old generation at runtime, and owned Networks returned in arrays/plain objects receive fresh views. The replacement spelling is ordinary TypeScript assignment:

```ts
let current = new Network();
const stages: Network[] = [new Network()];
const state = { current: new Network() };

current = Advance(current);
stages[i] = Advance(stages[i]);
state.current = Advance(state.current);
```

JavaScript evaluates the right side before storing the returned fresh owner in the target. Any alias captured before the call remains stale and reports `RT2012`; if the callee drops ownership instead of returning it, later stale use reports `RT2019`. A computed target follows ordinary JavaScript evaluation rules, so save a side-effectful index in a local variable when it must be evaluated once.

Producer destructuring is not a Network copy. Forms such as `let [a, b] = input + 0` attach one physical producer output to two fresh logical destination Networks. Those Networks receive independent ownership and the existing opposite-color output constraint.

Producer handles have their own affine physical identity. `Producer` is the common annotation; `ArithmeticCombinator`, `DeciderCombinator`, and `ConstantCombinator` additionally validate the native entity kind at declarations, function parameters, returns, flat array/object destructuring, and later writes to direct, array, or flat inline object slots carrying those annotations. Passing through a parameter, container slot, destructuring binding, or `.at(...)` creates no entity and does not change identity. Exactly one attachment operation may consume that identity; physical fan-out must name both destinations in that one operation. Only the completed execution can decide whether a dynamically stored value was later attached, so `CL2001` is emitted during finalization for identities that remain unused rather than at the slot assignment.

## Explicit consuming transfer

CombLang needs an operation that physically unifies two logical Networks without adding a combinator or a tick. The source Network is consumed because both names would otherwise pretend to identify independent topology after the union.

The accepted syntax is:

```ts
destination.take(source);
```

After the call, `destination` owns the unified Network and `source` is moved. The transformed runtime tracks the actual handle through aliases and containers, the direct plan records an ordered transfer, and EG/NCIR lowering collapses both identities without adding hardware or a tick. The method name itself communicates consumption; the older `destination.merge(move(source))` draft is intentionally not the documented target.

This form is invalid:

```ts
destination += source; // Network is not a Producer
```

`let alias = source` is valid, but it aliases the same ownership token rather than copying it. After `destination.take(source)`, both `source` and `alias` are stale.

Required errors include use after move, double move, consuming a `Readonly` or `Ref` value, and a transfer whose fixed color requirements become contradictory. Dynamic errors must point to the consuming call and include the declaration or earlier move as related provenance.

## Read-only two-network input

`pair(a, b)` represents one physical input connector reading one red and one green Network:

```ts
pair(a, b)[SIGNAL_A];
Each(pair(a, b));
Anything(pair(a, b));
Everything(pair(a, b));
```

The two Networks remain distinct and must resolve to opposite wire colors. Factorio then sums matching signal values across the red and green wires. `pair` borrows both inputs and never consumes or merges them.

The implemented view is immutable. It may appear wherever an implemented producer accepts a both-colors input, but it cannot be used as a destination or ownership carrier:

```ts
pair(a, b) += producer; // CL1042
destination.take(pair(a, b)); // CL1042
```

`pair` is intentionally different from producer fan-out:

| Intent                                      | Form                                      |
| ------------------------------------------- | ----------------------------------------- |
| read two input Networks on one connector    | `pair(a, b)`                              |
| attach one producer to one selected Network | `producer.to(output[SIGNAL_A])`           |
| attach one producer to two output Networks  | `producer.to(first, second, SIGNAL_A)`    |
| free two-Network selected destination       | `to(first, second)[SIGNAL_A] += producer` |
| contextually create two output Networks     | `let [first, second] = producer`          |

`pair(a, b)[SIGNAL]` is a read selection. Forms such as `.to(pair(a, b))` or `to(pair(a, b)[SIGNAL]) += producer` mix input and output concepts and are rejected. Dynamically aliased misuse receives `RT2020`. The serialized plan and NCIR retain both input Networks, the simulator sums both buses, and blueprint generation wires both resolved colors.

Every implemented output spelling now converges before plan serialization: contextual Network materialization and tuple/object fan-out, `Network +=`, free `to(...)[SIGNAL] +=`, and fluent `.to(..., SIGNAL)` share producer identity, one/two-destination cardinality, duplicate checks, writability checks, output binding, attachment provenance, and the downstream opposite-color constraint. Dynamic destination cardinality failures use `RT2003` through `RT2005`; incompatible executed output binding uses `RT2023` with producer and destination provenance.

## Static and runtime enforcement

The non-executing semantic pass remains conservative. It should diagnose only facts established for every possible execution, for example a direct write through a known `Readonly<Network>` parameter or an unconditional use after a known move.

The transformed runtime owns the final decision when a value comes from dynamic indexing, ordinary function return values, a branch, or an imprecisely typed object. Every Network handle therefore needs an identity and state visible to the elaboration session:

```text
owned -> borrowed temporarily -> owned
owned -> moved
moved -> invalid for all later topology operations
```

Runtime enforcement must use the same diagnostic result path as other elaboration failures. It must not leak a raw JavaScript exception, and the CLI and browser must report the same code, primary span, related spans, and dynamic instance path.

## Implementation order and completion criteria

1. Freeze capability names and consuming-transfer syntax in executable acceptance examples.
2. Add capability facts and definite ownership diagnostics to the semantic side table.
3. Add session-bound runtime ownership state and conservative fallback checks.
4. Carry ownership through function calls, returns, containers, destructuring, and control flow.
5. Implement consuming zero-tick transfer through EG and NCIR color constraints.
6. Implement `pair` selections and both-colors connector lowering.
7. Consolidate all attachment forms on one destination/cardinality/output-signal validation path.
8. Expose identical results through `factorio-dsl check` and the browser workbench. Implemented: CLI JSON and the browser plan retain executed `capabilityUses`, `networkTransfers`, and `networkPairs`; the validated direct-plan execution result retains capability audit metadata beside EG/NCIR.
9. Document stable diagnostics and move accepted syntax into the current language reference.

Phase 4 is complete when each capability transition and `pair` form has semantic, transformed-runtime, EG/NCIR, CLI, and end-to-end tests; uncertain static cases are proven by runtime tests; and no candidate syntax is described as implemented before those tests pass.

The completion audit is checked at these boundaries:

| Boundary                        | Executable evidence                                                                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conservative semantic certainty | `packages/language/src/semantic.test.ts` covers capability declarations, definite writes/consumption, aliases, containers, bare parameters, and definite `pair` misuse.                                     |
| Source transformation           | `packages/compiler/src/elaboration-transform.test.ts` covers borrow/move rebinding, dynamic slots, attachment forms, and pair selection dispatch.                                                           |
| Executed ownership authority    | `packages/runtime/src/elaboration-program.test.ts` covers successful and invalid Readonly/Ref/Move transitions, stale aliases, containers, closures, `take`, every supported pair read, and dynamic misuse. |
| EG/NCIR lowering                | `packages/runtime/src/direct-plan.test.ts` carries capability, transfer, and pair descriptors together through source execution, identity collapse, pair operands, color solving, and simulation.           |
| User-facing pipelines           | `apps/cli/src/main.test.ts` and `apps/web/src/compile-source.test.ts` verify successful descriptor serialization plus structured source-aware failures.                                                     |
| Cross-layer dispatch contract   | `packages/runtime/src/language-contract.test.ts` proves ordinary JavaScript names remain native while DSL handles reach one physical plan.                                                                  |

This matrix closes Phase 4. Future Entity handles and object ports build on it in Phase 6 rather than reopening Network ownership semantics.

## Open decisions

- whether producer handles need capabilities beyond the implemented `Producer`, `DeciderCombinator`, `ArithmeticCombinator`, and `ConstantCombinator` annotations;
- whether `pair` is restricted to exactly two Networks permanently or later generalized under another name;
- ownership rules for asynchronous functions once asynchronous elaboration exists.
