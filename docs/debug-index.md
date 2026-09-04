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

The index also records logical Network aliases for initialized scalar variables.
For `const output = MemoCell(input)`, `execution.network('output')` and
`execution.debug.root.network('output')` resolve the same physical Network as
the callee's `out`. Neither an extra Network nor a Producer is generated. Caller
and callee entries keep their own source spans and scope paths.

These aliases snapshot the final binding at the end of synchronous elaboration,
including reassignment from loops or closures. They do not track later JavaScript
microtasks. A replaced physical declaration stays inspectable as an internal
`$initial:name` entry; the public name resolves to the final Network. Stale
ownership aliases remain marked moved and cannot be used as test targets.
Readonly returns can still be external test targets, just like physical declarations.

This is not a general JavaScript object inspector: arbitrary container properties,
destructuring aliases of existing Networks, and variables declared without an
initializer do not acquire new logical query entries. Physical declarations remain
in the index even if the source subsequently overwrites a variable with a non-Network
value; an ordinary alias ending in a non-Network value is omitted. Existing physical
destructuring outputs are still indexed. These inspection limits do not restrict
source-level aliasing or circuit connections.

Producer entries retain their optional explicit binding name, source span,
physical ID, exact-scope ordinal, kind-specific ordinal, and immutable
direct-plan descriptor. The descriptor is the current inspection surface for
configuration and explicit placement.

Future rendered-schematic navigation will reuse these origins. Comment-to-description
association and `.at` write-back additionally need revision-aware AST edit anchors;
the current evaluated placement and physical IDs alone are insufficient. See
[source-linked schematic editing](source-linked-schematic.md) for the planned
contract and safeguards around generated instances and computed coordinates.

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

Ambiguity is still possible when the source binds the same Producer or Network
name more than once in one exact dynamic scope, including separate bare blocks
that share one debug path. Queries report every match instead of guessing.

## Portable inspection and browser navigation

`createDebugDocument(execution.debug, execution.circuit.graph)` produces a detached
`comblang-debug` v1 document. It preserves exact scope paths, Network bindings
(including internal and moved aliases), physical Producer IDs/ordinals, and source
spans. Producer records include physical input/output Network IDs, final EG
configuration, and explicit placement. Input discovery visits typed references,
including both sides of `pair` and both Decider branches; strings in configuration
are never treated as Network IDs. Records are joined by physical Producer ID, not
array position.

`inspectDebugNetwork(document, networkId)` returns **all** source bindings and
connected physical Producers. It does not pick one alias after `take`, and it is
structural connectivity, not proof that a conditional dependency is active on a
particular tick. These detached records are inspection data, not session-bound
handles accepted by `TestSession`.

Each successfully elaborated test result carries its own `debug` document beside
its trace, for both passing and failing tests. CLI JSON and browser Worker messages
use the same result shape. Missing/ambiguous debug queries additionally carry
`debugScopePath` when the query has an exact scope; structural assertion failures
carry their selected scope too. Display labels are not parsed to recover identity.

In **Test trace**, expand **Inspect source scopes and combinators** and select an
exact scope. Network/Producer buttons select the corresponding source expression;
**Configuration** displays input/output IDs, placement and configuration. Selecting
a recorded Network or signal shows its aliases and reading/writing Producers
across scopes. Test-created object adapters have no source mapping in the current
trace schema; their object IDs are not guessed to be Producer IDs.

The failed test's line button selects its position in the test editor. Selection
works in CodeMirror and the native textarea without changing code, rerunning tests,
or stepping the simulation. Editing source/tests invalidates this navigation with
the result. No link resolves against another execution or a different source file.
The document is generated transport data; loading arbitrary external debug
documents is not an implemented import surface.

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

## Structural assertions

`execution.structure(scope)` creates a tick-free expectation over that exact
scope and all of its descendants. Omitting the argument selects the complete
module root:

```ts
const structure = execution.structure(dut.$);

structure
  .toHaveProducerCounts({ arithmetic: 2, decider: 1, constant: 0 })
  .toHaveNetwork('mem')
  .toHaveProducer('copy', { producerKind: 'arithmetic' })
  .toHavePlacement('copy', { x: 10, y: 20, direction: 2 })
  .toMatchConfiguration('copy', {
    operation: 'add',
    right: { kind: 'constant', value: 1 },
  })
  .toBeZeroTickAlias('destination', 'consumedSource')
  .toHaveTickLatency(inputDebugEntry, 'output', 2);
```

String Network and Producer selectors search the selected subtree and fail on
ambiguity. Exact entries from `DebugIndex` can be supplied when a repeated name
is intentional. Numeric Producer selectors are one-based preorder indices over
the subtree.

Configuration and placement matchers use recursive partial matching. Producer
counts compare only the explicitly supplied kinds, allowing either focused or
complete expectations. `toBeZeroTickAlias` compares physical `NetworkId`
identity. `toHaveTickLatency` computes the shortest directed dependency path
through physical Producers belonging to the selected subtree; an external
input may be supplied as an exact debug entry.

Failures are structured `StructureAssertionError` values with code `DBG2001`,
scope path, matcher, expected value, and actual value. The expectation reads EG
and `DebugIndex` only: it does not create probes, step a kernel, or change a
`TestSession.currentTick`.

The current API completes the v1 physical string/query hierarchy and DUT-root
capture together with its structural assertion layer.
