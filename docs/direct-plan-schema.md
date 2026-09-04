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

The runtime remains the authoritative validator: `tryElaborateDirectPlan()` returns structured diagnostics, while `elaborateDirectPlan()` throws the same diagnostic for exception-oriented callers. A TypeScript type assertion or deserialized JSON is not proof that a plan is valid.

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
