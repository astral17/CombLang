# Returned Network ownership

Executed functions may return ordinary JavaScript values containing owned Networks. Arrays, flat or nested objects, shared subobjects, and cycles remain JavaScript containers; the runtime changes only the Network handles whose ownership crosses the function boundary.

## Two-stage return boundary

`inspectReturnValueGraph` snapshots own data-property edges of arrays and plain objects without invoking getters. It records every handle occurrence, including repeated slots, and can rebuild only containers reverse-reachable from a replaced handle. Property descriptors, prototypes, sparse arrays, symbols, integrity state, shared aliases, and cycles are preserved.

`returnOwnedValue` applies the ownership policy to that graph:

1. Treat Combinator, Network, pair, and pair-selection values as opaque handles rather than traversable objects.
2. Reject pair views with `RT2020`; they are read-only connector selections and cannot carry ownership.
3. Preserve an unchanged transparent caller alias without treating it as callee-owned.
4. Validate every other Network through the current function ownership frame.
5. Reject two transferred handles backed by one `NetworkOwnershipState` as an `RT2012` double move.
6. Charge every planned Network transfer against the DSL budget.
7. Only after every charge succeeds, move ownership and rebuild the affected containers.

The ordering is intentional. A caught validation or budget failure cannot leave the caller with a partially moved return value. Combinator handles remain unchanged; their primary/secondary output connections have independent Network ownership state.

## Explicitly typed Network returns

An explicit `Network` or `Readonly<Network>` return uses a narrower front-end policy before the same ownership transfer. An executed Network is checked against an optional `R`/`G` requirement; an executed Combinator supplies its existing primary Network facet. No reserved return Network or extra topology is created. Every other value reports `RT2022` at the return expression.

The ownership layer transfers a Network created or moved into the current function to the caller with a fresh generation. A transparent alias from a bare `Network` parameter is returned at its existing generation without a transfer; `Readonly<Network>` still creates a read-only caller view after an owned transfer succeeds. This single-value path does not recursively traverse containers; unannotated graph returns use the algorithm below.

## Traversal boundary

Only arrays and objects whose prototype is `Object.prototype` or `null` are traversed. Maps, Sets, class instances, functions, accessors, and prototype properties stay opaque ordinary JavaScript. Supporting one of those categories requires an explicit language contract rather than incidental enumeration.
