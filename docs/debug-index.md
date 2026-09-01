# Runtime debug index

Every executed direct plan now exposes an immutable `DebugIndex` alongside the
elaborated circuit:

```ts
const execution = elaborateDirectPlan(plan);

const input = execution.debug.root.network('input');
const stage = execution.debug.root.child('function Stage');
const firstAdder = stage.combinator(1);
const namedCopy = stage.combinator('copy');
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
- `scope.combinator(name)` resolves an explicitly typed Producer binding such
  as `const copy: ArithmeticCombinator = input + 0`; anonymous expressions do
  not acquire synthetic source names;
- `scope.combinators()` returns all physical Producers in source/elaboration
  order;
- `scope.combinators(kind)` filters that list by `arithmetic`, `decider`, or
  `constant` kind.

Network entries retain their source binding and plan names, source span,
instance path, physical ID, internal-binding flag, and whether the declaration
was consumed by a zero-tick ownership transfer. A moved declaration and its
destination can consequently have distinct debug entries that intentionally
share one physical `NetworkId`.

Producer entries retain their optional explicit binding name, source span,
physical ID, exact-scope ordinal, kind-specific ordinal, and immutable
direct-plan descriptor. The descriptor is the current inspection surface for
configuration and explicit placement.

Network entries are also first-class targets of
`execution.createTestSession()`. This permits white-box reads, drives, traces,
and assertions without generating a physical probe or exposing the binding to
ordinary source code. Targets are identity-checked against that execution;
moved entries and entries copied from another execution are rejected.

## Missing and ambiguous results

Queries never select the first plausible match. Missing scopes, Networks, and
combinator ordinals throw `DebugQueryError` with code `DBG1001` and deterministic
candidates. Multiple exact matches throw `DBG1002` with every candidate in
elaboration order.

Dynamic calls are distinct siblings under their caller. The first call keeps
the compact `function Name` segment; later calls use `function Name #2`,
`function Name #3`, and so on. The counter is local to the caller path, so
nested and recursive calls remain navigable without depending on allocated
graph IDs. Named `for` iterations retain their formatted iteration value, while
anonymous loop iterations retain their occurrence number.

Ambiguity is still possible when the source binds the same Producer name more
than once in one exact dynamic scope. Such a query reports every physical
ordinal instead of guessing.

## Test-only DUT capture

The test transform enables `t.instantiate(fn, ...args)` explicitly:

```ts
const program = transformElaborationModule(testFile, { testContextName: 't' });
const plan = executeElaborationProgram(program);
const execution = elaborateDirectPlan(plan);
const dut = execution.instance('dut');

dut.value; // the physical Network/Producer return value
dut.$; // the immutable DebugScope rooted at this call
```

The source spelling must be assigned to a stable binding, for example
`const dut = t.instantiate(Stage, input)`. It executes the already instrumented
function declaration exactly once. The captured function entry becomes a
`DUT dut` scope rather than being structurally reinterpreted, so ordinary and
captured calls create the same Networks, Producers, attachments, and
configuration.

During elaboration, source code may use `dut.value` normally. `dut.$` is only
an opaque token there: locals are not reflected back into production code.
After physical elaboration, `execution.instance('dut')` resolves the same value
to session-bound Network/Producer handles and `$` to the real scope. Network,
Producer, literal, `undefined`, array, and plain-object return structures are
retained recursively. Cyclic or arbitrary host-class return values are rejected
with `RT2026` instead of being copied approximately.

Repeated captures are available in elaboration order through
`execution.instances` or the one-based `execution.instance(index)`. A repeated
textual name makes `execution.instance(name)` deterministically ambiguous; its
scope paths identify the loop/caller instance.

The normal production transform has no `testContextName`, does not reserve or
rewrite `t`, and cannot create a debug capture accidentally. The temporary web
test runner is not yet wired to this transform; that belongs to the remaining
shared runner/CLI/browser ingestion task.

The current API completes the v1 physical string/query hierarchy and DUT-root
capture. Structural assertion matchers remain separate Phase 5 work.
