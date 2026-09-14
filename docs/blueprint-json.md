# Blueprint JSON preview

The browser workbench generates readable, uncompressed Factorio blueprint JSON whenever the current source compiles and elaborates successfully.

```ts
import { generateBlueprintJson } from '@comblang/compiler';

const json = generateBlueprintJson(elaboratedCircuit.ir, {
  label: 'My circuit',
});
```

The returned object has the normal top-level shape:

```json
{
  "blueprint": {
    "item": "blueprint",
    "label": "My circuit",
    "version": 562949953421312,
    "icons": [
      {
        "signal": { "type": "item", "name": "blueprint" },
        "index": 1
      }
    ],
    "entities": [],
    "wires": []
  }
}
```

## Current mapping

- every NCIR arithmetic producer becomes `arithmetic-combinator`;
- every decider producer becomes `decider-combinator`;
- every constant producer becomes a Factorio 2.x section-based `constant-combinator`;
- current resolved Signal IDs always have an internal type; export emits name and optional quality, keeps non-item types, and omits the default item type;
- resolved red/green logical Networks select physical connector IDs;
- arithmetic operands and Decider operands/normal/else copy outputs retain their
  explicit red/green input selection, not just their wire connections;
- `pair(a, b)` inputs connect both resolved colors to the matching input connectors without adding or merging entities;
- endpoints belonging to one logical Network are connected as a deterministic wire chain;
- producers with `.at(x, y, direction?)` use their explicit Factorio position and a direction resolved from a numeric constant or TypeScript enum value;
- remaining entities are placed in one deterministic horizontal row.

The internal Entity v3 preview also lowers a trusted physical typed
`native-single-condition` configuration to the existing Entity's
`control_behavior.circuit_condition`. It emits the resolved concrete Signal,
signed int32 constant, Factorio comparator spelling, and selected red/green
input mask. Raw Entity configuration is copied onto the existing physical
Entity before compiler-owned identity, placement, and direction fields are
added. Its bounded JSON keys are preserved without native validation or
simulation claims; compiler-owned collisions fail with source-aware `BP1001`.
The source-level schema-checked BlueprintEntity fragment uses the same existing
raw physical payload after structural validation, so its output is identical to
an equivalent `{ raw: ... }` payload. It accepts common-only provider types and
plain Blueprint SignalID data at declared SignalID positions, including omitted
`type`; same-session `Signal(...)` values are detached there as the ergonomic
nominal spelling. It does not make native-conformance or simulator claims.
The typed path is synthetic-only until reviewed non-synthetic evidence
and native import fixtures exist. The deprecated opaque v3 typed/payload
envelope is accepted through replay as a compatibility snapshot but is also an
explicit `BP1001` preview failure. The profile-free physical boundary rejects
malformed or forged typed fields before emission.

The internal Entity v4 preview uses `generateEntityComputationBlueprintJson`.
For a linked Constant, the producer remains the topology/output view while the
Entity supplies the one native prototype, placement, and canonical section
configuration. The linked pair therefore emits exactly one
`constant-combinator` object; it does not emit an Entity plus a second default
combinator. Ordinary unlinked producers and structural Entities remain
separate. The v4 simulator and blueprint adapter share the existing
conservative Constant support boundary, so unsupported groups or non-unit
section multipliers are diagnostics rather than guessed native behavior.

The generator emits plain JSON only. It does not prepend the exchange-string version byte, deflate, or base64-encode the result.

Nested Decider conditions are lowered to OR-connected groups of AND comparisons.
`compare_type` on each row describes its link to the preceding row; the first row
of every subsequent group therefore uses `or`. Distribution is required for forms
such as `(A || B) && (C || D)`. This may duplicate comparisons, but never producers,
outputs, or ticks. The truth-table tests cover nested conjunctions/disjunctions;
exact import/export compatibility remains outside this preview.

To prevent exponential preview allocations, `maxDeciderConditionRows` defaults to
1024 expanded rows per Decider. This is an **export-only allocation guard**, not a
language execution limit or a claimed Factorio engine limit. API callers can
explicitly raise it. Excessive expansion or an unrepresentable empty condition
group throws `BlueprintJsonError` (`BP1001`) with the producer source span when
available, rather than returning changed/truncated logic. A missing resolved
operand color also fails instead of silently selecting an input color.

## Current limitations

This is an early preview rather than the Phase 8 codec:

- placement does not yet diagnose wire reach, footprint collisions, relays, or user groups;
- there is no FCIR layer or semantic import/export round trip yet;
- the generator does not import existing blueprints;
- nested condition-group compatibility is deferred to the Phase 8 codec;
- entity defaults and schema details will be tightened against Factorio import tests;
- verified typed Entity import/export and native raw-field conformance remain pending;
- omission/defaulting rules outside the implemented default-item `Signal(name)` case still need captured import/export conformance fixtures;
- public Constant source construction and native import/export conformance remain pending; the internal v4 adapter exports canonical supported sections, active state, and `is_on`, while groups and non-unit multipliers remain explicitly unsupported;
- source Networks without a physical producing endpoint cannot create an external blueprint connection by themselves.

The workbench shows and copies this readable JSON, but it is still a preview rather than a finished exchange-string export or verified round-trip codec.
