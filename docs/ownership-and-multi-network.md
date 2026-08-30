# Phase 4: ownership and multi-network design

This document defines the intended semantic boundary for Phase 4. `destination.take(source)`, function-scoped `Readonly`/`Ref` borrows, explicit `Move<Network>` call/return transfer, and immutable `pair(a, b)` input views are frozen and implemented. Other syntax below remains design material unless the [current language reference](language-reference.md) says otherwise.

Phase 4 makes physical circuit topology explicit in the type and runtime models. A `Network` is an affine handle to one logical wire network: it may be read many times, but ownership cannot be silently copied or consumed twice. The phase also adds an immutable view over the two wire colors without turning that view into another writable network.

## Goals

- distinguish ownership from read-only and mutable borrowing;
- make zero-tick physical network union explicit and consuming;
- preserve ownership facts across functions and ordinary executed JavaScript containers;
- represent a Factorio input connector reading both red and green wires with `pair(a, b)`;
- keep input aggregation separate from producer output fan-out;
- report a static error only when invalidity is certain, and defer value-dependent cases to the elaboration runtime;
- preserve source and dynamic-instance provenance in every ownership diagnostic.

Phase 4 does not add multi-file modules, a hardened security sandbox, Factorio object constructors, physical wire routing, or the final blueprint codec.

The current compiler permits producer attachment through both `const` and `let` Network bindings. Requiring `let` for topology accumulators is a design candidate, not a Phase 4 assumption; it must first be tested against functions, aliases, containers, and generated code.

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

Function parameters annotated as `Readonly<Network>` or `Ref<Network>` receive runtime borrow views. `Move<Network>` consumes the caller's ownership generation and may return a fresh owned view, directly or inside an array/plain object. Direct, provably invalid operations are also rejected by the conservative semantic pass. Local owned-copy inference, explicit container-slot replacement, and the complete closure/control-flow ownership model remain unfinished.

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

Bare `Network` parameters are forbidden because an implicit mode would hide whether the call borrows or consumes ownership. Bare `Network` remains valid for local bindings and return annotations.

Borrowed values must not outlive their owner. The checker should reject a definite borrow escape. If ordinary JavaScript control flow or a dynamically selected container element prevents proof, the runtime must validate the actual handle state instead of the checker guessing.

## Copying, containers, and destructuring

An owned Network cannot be copied by assignment:

```ts
let a = new Network();
let b = a; // planned error: ownership would be duplicated
```

Arrays and objects remain supported. They may own Networks, and reading `arr[i]` or `record.output` may borrow the contained handle for circuit expressions and producer attachment. Phase 4 must preserve that identity through dynamic indexing:

```ts
const output = new Network();
const stages: Network[] = [new Network(), new Network()];

for (let i = 0; i < stages.length; i++) {
  output += stages[i] * 2;
}
```

Passing a dynamically read slot to a `Move` parameter already invalidates that old slot at runtime, and owned Networks returned in arrays/plain objects receive fresh views. The explicit syntax for atomically taking or replacing an already-owned container slot is not frozen. Whatever spelling is chosen must invalidate exactly the consumed slot or binding at runtime. Static analysis may reject only a definite duplicate, double move, or use-after-move.

Producer destructuring is not a Network copy. Forms such as `let [a, b] = input + 0` attach one physical producer output to two fresh logical destination Networks. Those Networks receive independent ownership and the existing opposite-color output constraint.

Producer handles have their own affine physical identity. `Producer` is the common annotation; `ArithmeticCombinator`, `DeciderCombinator`, and `ConstantCombinator` additionally validate the native entity kind at declarations, function parameters, returns, flat array/object destructuring, and later writes to direct, array, or flat inline object slots carrying those annotations. Passing through a parameter, container slot, destructuring binding, or `.as(...)`/`.at(...)` creates no entity and does not change identity. Exactly one attachment operation may consume that identity; physical fan-out must name both destinations in that one operation. Only the completed execution can decide whether a dynamically stored value was later attached, so `CL2001` is emitted during finalization for identities that remain unused rather than at the slot assignment.

## Explicit consuming transfer

CombLang needs an operation that physically unifies two logical Networks without adding a combinator or a tick. The source Network is consumed because both names would otherwise pretend to identify independent topology after the union.

The accepted syntax is:

```ts
destination.take(source);
```

After the call, `destination` owns the unified Network and `source` is moved. The transformed runtime tracks the actual handle through aliases and containers, the direct plan records an ordered transfer, and EG/NCIR lowering collapses both identities without adding hardware or a tick. The method name itself communicates consumption; the older `destination.merge(move(source))` draft is intentionally not the documented target.

These forms are invalid:

```ts
destination += source; // Network is not a Producer
let alias = source; // no implicit owned copy
```

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
8. Expose identical results through `factorio-dsl check` and the browser workbench.
9. Document stable diagnostics and move accepted syntax into the current language reference.

Phase 4 is complete when each capability transition and `pair` form has semantic, transformed-runtime, EG/NCIR, CLI, and end-to-end tests; uncertain static cases are proven by runtime tests; and no candidate syntax is described as implemented before those tests pass.

## Open decisions

- whether producer handles need capabilities beyond the implemented `Producer`, `DeciderCombinator`, `ArithmeticCombinator`, and `ConstantCombinator` annotations;
- whether attachment through `+=` is restricted to `let` Network bindings;
- explicit syntax for moving values into and out of array/object slots;
- whether `pair` is restricted to exactly two Networks permanently or later generalized under another name;
- exact diagnostic codes and borrow-lifetime rules for closures and asynchronous functions.
