# Runtime debug index

Every executed direct plan now exposes an immutable `DebugIndex` alongside the
elaborated circuit:

```ts
const execution = elaborateDirectPlan(plan);

const input = execution.debug.root.network('input');
const stage = execution.debug.root.child('function Stage');
const firstAdder = stage.combinator(1);
const loopAdder = stage.child('for i=0').combinator(1);
```

The index is built after physical elaboration. Its entries therefore connect
source provenance to the actual `NetworkId` and `ProducerId` values in the
executed circuit instead of describing a second, approximate topology. Reading
the index never advances simulation, re-executes the source program, or exposes
function locals to the program being elaborated.

## Scopes and queries

`execution.debug.root` is the module scope. `child(name)` descends one exact
function or loop provenance segment, and `execution.debug.scope(path)` resolves
an absolute segment array. Queries do not search parents or descendants:

- `scope.network(name)` resolves a source-level Network binding in that exact
  scope;
- `scope.combinator(index)` resolves a one-based physical Producer ordinal in
  that exact scope;
- `scope.combinators()` returns all physical Producers in source/elaboration
  order;
- `scope.combinators(kind)` filters that list by `arithmetic`, `decider`, or
  `constant` kind.

Network entries retain their source binding and plan names, source span,
instance path, physical ID, internal-binding flag, and whether the declaration
was consumed by a zero-tick ownership transfer. A moved declaration and its
destination can consequently have distinct debug entries that intentionally
share one physical `NetworkId`.

Producer entries retain their source span, physical ID, exact-scope ordinal,
kind-specific ordinal, and immutable direct-plan descriptor. The descriptor is
the current inspection surface for configuration and explicit placement.

## Missing and ambiguous results

Queries never select the first plausible match. Missing scopes, Networks, and
combinator ordinals throw `DebugQueryError` with code `DBG1001` and deterministic
candidates. Multiple exact matches throw `DBG1002` with every candidate in
elaboration order.

Ordinary repeated calls currently share their lexical `function Name` scope.
If both calls create a local binding named `local`, `network('local')` is
therefore deliberately ambiguous. Phase 5 `instantiate(fn, ...args)` will give
a selected DUT a unique debug root; until then callers may inspect the scope's
`networks` entries and their distinct `planName` and physical IDs without an
unsafe first-match rule.

The current API is the physical-index foundation. Named combinator queries,
stable DUT roots for repeated calls, and structural assertion matchers remain
separate Phase 5 work.
