# Blueprint JSON preview

The workbench and CLI generate readable Factorio blueprint JSON from the
canonical physical IR:

```ts
import { generateBlueprintJson } from '@comblang/compiler';

const json = generateBlueprintJson(elaboratedCircuit.ir, { label: 'My circuit' });
```

The generator emits ordinary JSON. It does not prepend the exchange-string
version byte, compress, or base64-encode the result.

## Mapping

- arithmetic, decider, constant, and selector producers map to their native
  combinator prototypes;
- resolved Signal IDs retain their type and optional quality, while default
  item type is omitted from exported Signal IDs;
- resolved red/green Networks choose physical connector IDs and deterministic
  wire chains;
- arithmetic and Decider operands retain explicit red/green input selection;
- `pair(red, green)` connects both colors without allocating another device;
- explicit `.at(x, y, direction?)` placement is preserved and remaining
  entities receive deterministic positions;
- one linked producer plus one Entity emits one physical blueprint Entity.
  Placement and native configuration come from the Entity, while topology and
  output behavior come from the producer.

Raw Entity configuration is copied after bounded JSON validation, with
compiler-owned identity, placement, direction, and wire fields kept separate.
Typed configuration is lowered only when its profile-owned rule and evidence
are valid. Opaque typed/payload values are rejected; they cannot silently
become native preview data.

The exact computation surface currently emits Constant sections, the supported
Arithmetic operations, ordered Decider branches, and Selector `select` or
`count`. Selector operations `random`, `quality`, `rocket-capacity`,
`stack-size`, and `time` remain explicit unsupported diagnostics. These
outputs are deterministic implementation/model previews, not native Factorio
conformance or import/export round-trip evidence.

Nested Decider conditions are expanded into OR-connected groups of AND
comparisons with a bounded export allocation limit. A missing resolved operand
color, unsupported native field, malformed physical Entity, or excessive
condition expansion fails with a source-aware `BlueprintJsonError`; the
generator never truncates or changes the circuit silently.
