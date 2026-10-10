# Architecture

CombLang is a browser-first TypeScript-shaped circuit DSL. The source path is
shared by the CLI and browser Worker: parse the file, classify DSL-sensitive
JavaScript, transform only the required expressions, execute the transformed
program in a bounded runtime, and validate the recorded circuit.

## Package boundaries

```text
shared values and spans
        |
        +-- factorio signal/int32/constant semantics
        +-- language parser and semantic checks
        +-- compiler descriptors, profiles, IR, replay context, blueprint JSON
        +-- runtime execution, validation, lowering, debug, and hydration
        +-- simulator kernel and testbench adapters
        +-- CLI and browser Worker/UI consumers
```

Compiler descriptor modules are data-only. They do not import the runtime,
source executor, simulator, Node APIs, or browser APIs. Runtime owns execution
and the canonical validation seam; simulator owns tick behavior; blueprint
generation consumes resolved physical IR.

## Host-local numeric expression foundation

The compiler has an internal typed numeric-expression DAG for finite literals,
session-owned number-parameter references, unary negation, and binary addition,
subtraction, and multiplication. Construction validates and freezes the graph
under the existing parameter depth/node/byte limits; a pure evaluator resolves
defaults or host bindings using ordinary JavaScript finite-number arithmetic in
deterministic left-to-right order, preserves negative zero, and memoizes shared
nodes per evaluation. An expression can be built only while its owning
parameter session is open, then evaluated after sealing.

The reviewed host-local use is limited to the `value` of either constant
operand in an Arithmetic template, the constant `condition.compare.right`
threshold in a Decider template (including nested AND/OR conditions), constant
values in both Decider output branches, and Constant template section multipliers
and filter counts. Arithmetic, Decider, and filter-count results require a safe
integer and use their existing int32 normalization. A Constant multiplier instead
requires only a finite double and
passes through the existing Constant canonicalizer, preserving values such as
fractions and negative zero. The symbolic graph does not cross the binding
boundary; returned configurations contain concrete values. Non-unit
multipliers may remain unsupported by the simulator; this host-local
binding/export path does not claim simulator or native Factorio behavior.

This is an internal modeling layer only. It adds no source syntax, Direct
Plan/NCIR/Worker representation, Factorio formula grammar, native operator
mapping, or claim about placement-time Factorio semantics. Native formula and
dependency behavior remains fixture-gated.

## Source and execution

The executed recorder owns one circuit state for a source revision. It tracks
logical Network identity, color constraints, connector capacity, ownership
generations, aliases, transfers, pairs, producer provenance, and Entity
registrations as operations execute. Network union is distinct from equal
resolved color, so independently fixed-red Networks remain distinct inputs.

Execution is transactional around source operations. A failed operation does
not leak a producer, Entity, placement, or ownership mutation. Generated
debug values are cloneable descriptors; runtime handles remain inside the
execution host.

## Canonical Entity pipeline

The public pipeline is one unsuffixed plan, graph, IR, and resolved circuit:

```text
source -> DirectElaborationPlan
       -> validateCanonicalDirectPlan
       -> tryElaborateDirectPlan
       -> ElaborationGraph + NativeCircuitIr
       -> ResolvedCircuit
       -> hydrate / simulate / preview / debug
```

Entity-free plans omit replay context and carry an empty Entity array.
Entity-bearing plans carry identity-only context and enter the same execution
bridge with a trusted host context. The bridge validates one-to-one linked
producer associations, placement ownership, trusted profile family, exact
configuration, connector bindings, topology, and Decider output origins.

Profiles describe connector lanes, configuration rules, evidence, prototype
identity, and optional projections. They are host authority, not transported
capabilities. A profile-set identity is
`entity-profile-set-sha256:<64 lowercase hexadecimal characters>` and is
computed from the complete canonical profile set. Historical profile-set tags
and opaque typed/payload configuration are not accepted.

The current linked computation surface contains Constant, Arithmetic, Decider,
and Selector records. Exact Selector support is limited to `select` and
`count`; other native operations remain explicit unsupported cases. Synthetic
profiles and simulator tests establish implementation behavior only. Native
Factorio conformance requires separate reviewed evidence and fixture-backed
round trips.

## Blueprint import preparation

The blueprint package retains a lossless document and exposes a bounded,
data-only structural inventory and connector-neutral wire references through
dedicated package subpaths. The compiler host explicitly selects trusted Entity
profiles from its replay context, projects their declared physical lanes through
the current exporter mapping convention, and composes those mappings with the
inventory into color-separated connectivity components. Dependency direction
runs from compiler to blueprint; the blueprint package remains independent of
compiler and runtime authority. A complete result means only that this full
document graph is covered by the explicit selections and current mapping rules.
It does not establish executable import, source-generation fidelity, or native
Factorio validity; those require separate policies and evidence.

## Validation and transport

Canonical validators accept unknown values and rebuild frozen data. They reject
accessors, symbol keys, array holes, unknown fields, cycles beyond configured
bounds, invalid references, duplicate IDs, forged associations, and malformed
source metadata. A validated resolved circuit has format
`comblang-resolved-circuit` and a stale-response fingerprint
`plan-fnv1a64:<16 lowercase hexadecimal characters>`.

The resolved snapshot contains only cloneable physical data: Networks,
producers, Entities, topology, provenance, configuration, and identity-only
context. It never contains profiles, providers, resolver functions, trusted
runtime handles, or source closures. Hydration therefore needs no replay
authority and can safely cross the Worker/browser or CLI boundary.

## Ownership and preview

Network values are affine runtime capabilities. Shared/read-only/ref borrows
are checked at function boundaries; `Move<Network>` transfers ownership and
invalidates caller aliases. Pair views expose both colors without merging
logical Networks. Producer attachment consumes explicit connector capacity and
reports source-linked diagnostics for conflicts.

Blueprint JSON is a readable structural preview. It preserves exact resolved
colors, output rows, Entity placement, native-shaped configuration, and one
physical object per linked producer. It is not an exchange-string codec and
does not by itself prove native Factorio behavior.

The Worker keeps compiler assets warm across revisions and serializes parse and
parameter-binding operations through one active slot and one latest-operation
queue. A newly queued parse invalidates its binding capture and supersedes queued
bindings; binds use the warm 1,000 ms budget and do not change parse warmth. The
page's parameter controls submit full override snapshots against the retained
source; accepted bound pairs replace preview, tests, and concrete JSON together,
with a fresh simulation at T0. Native-template export remains a separate mode.
A timed-out or crashed operation replaces the Worker generation. The first cold
parse and later warm parses have separate budgets; a `ready` notification means bootstrap
completed, not that compilation already ran.
