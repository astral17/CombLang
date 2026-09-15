# Entity v5 cumulative computation envelope

Entity v5 is the cumulative computation-bearing transport for a linked
`Constant` or `Arithmetic` producer. It is separate from Direct Plan v2,
Entity v3, and the Constant-only Entity v4 envelope. A v5 plan carries
plan-network references; its graph and NCIR carry resolved physical Network
references. The v5 resolved artifact is
`comblang-resolved-entity-v5` and is hydrated without provider methods or
profile authority.

## Exact Arithmetic source form

The exact constructor has one semantic configuration record:

```ts
const A = Signal('virtual', 'signal-A');
const input = new Network();
const comb: ArithmeticCombinator = Arithmetic({
  left: input[A],
  operation: 'multiply',
  right: 2,
  output: A,
});
const output = new Network();
output += comb;
```

The record has exactly `left`, `operation`, `right`, and `output`. The
canonical operation names are `add`, `subtract`, `multiply`, `divide`,
`modulo`, `power`, `left-shift`, `right-shift`, `bit-and`, `bit-or`, and
`bit-xor`. Operator symbols remain the ordinary ergonomic expression syntax;
they are not an alternate exact-record spelling.

Each operand is either a safe integer or a readable runtime arithmetic
operand: a concrete Signal selection, a readable Network/Pair/Combinator, or
`Each`. Numbers are canonicalized with Factorio signed-int32 semantics.
`Anything` and `Everything` are not arithmetic operands. Both operands may be
constants because the exact call explicitly requests one physical device.
`output` is a concrete Signal or `Each`/`EACH`; it cannot be a Network,
string, `Anything`, or `Everything`. The returned value is nominally an
`ArithmeticCombinator` and retains normal attachment, output-lane, ownership,
debug, `.at(...)`, and unused-producer behavior.

Exact `Arithmetic` requires trusted base authority for
`entity:arithmetic-combinator`, including the matching
`prototypeType: "arithmetic-combinator"` and provider prototype data. Missing,
corrupt, ambiguous, or same-family modded data is not silently substituted.
The runtime normalizes every field before allocating topology, an Entity, or a
producer association; a caught failure therefore cannot leave a partial
device behind.

## Version and association rules

The smallest compatible envelope is selected from the executed source:

| Source result                                                | Envelope |
| ------------------------------------------------------------ | -------- |
| profile-free topology                                        | v2       |
| Entity records without linked computation                    | v3       |
| linked Constant only                                         | v4       |
| any linked Arithmetic, optionally mixed with linked Constant | v5       |

One linked producer and one Entity describe one physical device. The producer
retains the topology/output view and carries the association ID; the Entity
owns configuration, identity, and placement. A linked producer must not also
carry placement. v5 accepts only Arithmetic and Constant links, checks the
trusted context, profile family, exact configuration, and one-to-one
association before lowering. Linked Deciders remain outside this contract.

Execution reuses the existing topology engine, arithmetic simulator, debug
queries, and native control-behavior preview. The linked Arithmetic blueprint
adapter emits one native `arithmetic-combinator` object using the Entity's
prototype and placement plus the producer's resolved arithmetic configuration.
This is a deterministic preview and synthetic test surface; it is not a claim
of native Factorio import/export conformance. `planFingerprint` is stale
response correlation, not an authority or integrity signature.
