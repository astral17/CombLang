# Returned Network ownership

Executed functions may return ordinary JavaScript values containing owned Networks. Arrays, flat or nested objects, shared subobjects, and cycles remain JavaScript containers; the runtime changes only the Network handles whose ownership crosses the function boundary.

## Two-stage return boundary

`inspectReturnValueGraph` snapshots own data-property edges of arrays and plain objects without invoking getters. It records every handle occurrence, including repeated slots, and can rebuild only containers reverse-reachable from a replaced handle. Property descriptors, prototypes, sparse arrays, symbols, integrity state, shared aliases, and cycles are preserved.

`returnOwnedValue` applies the ownership policy to that graph:

1. Treat Producer, Network, pair, and pair-selection values as opaque handles rather than traversable objects.
2. Reject pair views with `RT2020`; they are read-only connector selections and cannot carry ownership.
3. Validate every Network through the current function ownership frame.
4. Reject two handles backed by one `NetworkOwnershipState` as an `RT2012` double move.
5. Charge every planned Network transfer against the DSL budget.
6. Only after every charge succeeds, move ownership and rebuild the affected containers.

The ordering is intentional. A caught validation or budget failure cannot leave the caller with a partially moved return value. Producer handles remain unchanged; their affine attachment lifecycle is independent from Network ownership transfer.

## Traversal boundary

Only arrays and objects whose prototype is `Object.prototype` or `null` are traversed. Maps, Sets, class instances, functions, accessors, and prototype properties stay opaque ordinary JavaScript. Supporting one of those categories requires an explicit language contract rather than incidental enumeration.
