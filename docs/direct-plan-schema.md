# Direct plan schema

`DirectElaborationPlan` is the serialized boundary between executed source elaboration and circuit validation. Its stable type-only entry point is:

```ts
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
```

The schema module owns descriptors only. It does not parse source, transform TypeScript, execute user code, or lower a plan into the elaboration graph. This keeps runtime, CLI, web-worker protocols, and other transports independent from the bootstrap `compileDirectPlan()` implementation.

The legacy `@comblang/compiler/direct-plan` entry point still re-exports every schema type for compatibility. New production consumers should use `direct-plan-schema`; tests and migration tools may import the legacy entry point when they also need `compileDirectPlan()` as a regression oracle.

## Envelope and versioning

Every accepted plan has the following discriminants:

```ts
interface DirectElaborationPlan {
  readonly format: 'comblang-direct-plan';
  readonly version: 2;
  // networks, producers, metadata, diagnostics
}
```

`format` identifies the transport family. `version` changes when an existing reader cannot safely interpret the descriptor. Optional fields may be added only when their absence has a defined meaning for the current version. Consumers must not silently reinterpret an unsupported version.

The internal computation-bearing Entity slices use separate plan/graph/NCIR
types. Version 4 is the Constant-only envelope; version 5 is cumulative for
linked Constant and Arithmetic. A linked producer may reference one physical
`EntityId`, but the association does not add a second placement or hardware
record. v2/v3 validators and resolved readers intentionally reject v4/v5,
while the v4 and v5 readers remain strict and separate.

The runtime remains the authoritative validator: `tryElaborateDirectPlan()` returns structured diagnostics, while `elaborateDirectPlan()` throws the same diagnostic for exception-oriented callers. A TypeScript type assertion or deserialized JSON is not proof that a plan is valid.

`validateDirectPlanEnvelope(value)` is the transport-facing first stage. It accepts `unknown` and exhaustively checks the format/version envelope, Network declarations, Producer unions and references, bounded Decider/debug trees, optional metadata, and embedded diagnostics before a runtime graph is allocated. A successful result contains a known-field-only, deeply frozen canonical plan plus prepared declaration/alias/capability lookups. Runtime replay consumes that canonical copy, never the caller-owned payload.

For version 2 Deciders, ingress normalizes an absent `outputs` list to `[output]` and makes the first ordered row the compatibility `output` view. An explicitly present empty `outputs` list remains empty so an else-only configuration does not acquire a normal output. Repeated rows retain their order and multiplicity.

Resolved topology, ownership transitions, native mode compatibility, and color consistency still belong to elaboration because they require relationships across otherwise valid descriptors.

For host-authorized Entity compilation, the resulting physical NCIR is carried
in the separate cloneable `ResolvedSourceCircuit` envelope. It is not an
optional field on Direct Plan v2 or v3. The Worker may transport the plan and
resolved circuit together. The v1 envelope also carries a deterministic
`planFingerprint` for accidental stale-response correlation; it grants no
authority. A main-thread consumer must validate the resolved envelope and use
its frozen physical IR rather than replaying a v3 plan without the trusted
profile authority.

The v4 computation envelope is a separate `comblang-resolved-entity-v4`
transport, and v5 uses `comblang-resolved-entity-v5`. Both carry only
canonical physical linkage, producer topology, Entity-owned
placement/configuration, and identity-only replay context. Their hydrators do
not receive profiles, providers, resolver functions, or runtime handles. v5
adds strict Arithmetic configuration and mixed Constant/Arithmetic
associations; exact Constant support remains limited to the existing
conservative `constantConfigurationToSparseBus` model. Each deterministic
`planFingerprint` is stale-response correlation only, not a cryptographic
integrity or authority claim.

## Descriptor groups

- `networks` declares logical Network identities and optional fixed colors.
- `producers` declares arithmetic, decider, and constant combinators, their inputs, outputs, destinations, source spans, instance paths, and optional placement.
- `networkAliases`, `networkTransfers`, and `networkPairs` retain executed zero-hardware Network relationships.
- `capabilityUses` retains ownership-boundary audit metadata.
- `debugInstances` and Producer capture IDs retain source-visible debug structure.
- `diagnostics` carries non-fatal diagnostics discovered while recording the plan.

All source-aware descriptors retain `SourceSpan` and dynamic `instancePath` where applicable. Transport code should preserve them verbatim so validation, tests, blueprint errors, and future scheme-to-source navigation can report the originating execution site.

## Dependency direction

The intended dependency flow is:

```text
source transform + executed recorder
              |
              v
      direct-plan-schema
              |
              v
 runtime validation and EG/NCIR lowering
              |
              v
 simulator / blueprint / testbench / UI
```

The schema may depend on shared value contracts such as `SignalId`, `SourceSpan`, and IR operator/color string unions. It must not import the TypeScript compiler, source parser, bootstrap lowerer, runtime, simulator, Node APIs, or browser APIs.
