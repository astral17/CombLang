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
- endpoints belonging to one logical Network are connected as a deterministic wire chain;
- producers with `.at(x, y, direction?)` use their explicit Factorio position and a direction resolved from a numeric constant or TypeScript enum value;
- remaining entities are placed in one deterministic horizontal row.

The generator emits plain JSON only. It does not prepend the exchange-string version byte, deflate, or base64-encode the result.

## Current limitations

This is an early preview rather than the Phase 8 codec:

- placement does not yet diagnose wire reach, footprint collisions, relays, or user groups;
- there is no FCIR layer or semantic import/export round trip yet;
- the generator does not import existing blueprints;
- nested condition-group conformance still needs captured in-game fixtures;
- entity defaults and schema details will be tightened against Factorio import tests;
- omission/defaulting rules outside the implemented default-item `Signal(name)` case still need captured import/export conformance fixtures;
- source Networks without a physical producing endpoint cannot create an external blueprint connection by themselves.

The workbench shows and copies this readable JSON, but it is still a preview rather than a finished exchange-string export or verified round-trip codec.
