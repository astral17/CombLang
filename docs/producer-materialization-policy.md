# Producer and Entity materialization policy

This document closes the Phase 4.5 design gate for default declaration materialization. It compares the six representative programs requested by the architecture review and fixes the rule that Phase 6 typed objects must follow. Object constructor and testbench spellings below remain provisional; the value-category decision is not.

## Decision

CombLang uses separate nominal categories for transient combinator producers and persistent Entity handles:

| Executed initializer                            | Inferred declaration             | Explicit context                                                                                                                  |
| ----------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| arithmetic, `IF`, `when`, or `CC` producer      | materialize one output `Network` | `Producer` or a concrete combinator annotation preserves the unmaterialized handle                                                |
| future typed object constructor                 | preserve the Entity handle       | `Network` may project one schema-declared default circuit view; classes without exactly one default view require an explicit port |
| existing `Network` or ordinary JavaScript value | preserve the executed value      | validate only when the explicit DSL context requires a particular category                                                        |

An Entity handle is not reclassified as a combinator `Producer` merely because the entity can source signals or accept circuit connections. It has persistent physical identity for placement, inspection, test mocks, and debug hierarchy. Both categories use session-local nominal branding, but they have different materialization rules.

This is option C from the review: combinator expressions retain the current value-oriented default, while typed objects retain identity by default. The apparent asymmetry is intentional because the lifetimes differ. A combinator producer is an unattached construction value that must eventually acquire an output destination; an Entity constructor already denotes the physical object itself.

## Why not change every declaration to Producer

Option B would make `const dx = x1 - x2` retain an `ArithmeticCombinator`. Every later arithmetic use would then need contextual projection and a cache ensuring that repeated uses of the same producer attach it once. It changes current inference, makes simple mathematical code depend more heavily on language-service hovers, and provides no benefit to typed objects once Entity identity is represented as its own nominal category.

Option A, applying automatic Network materialization to every future object, preserves current implementation uniformity but loses the value needed by `test.mock(entity)`, placement, and structural inspection. Requiring an explicit entity type on nearly every object declaration would make inference actively harmful.

## Representative programs

### 1. Scale

```ts
function Scale(input: Readonly<Network>): Network {
  const scaled = input * 10;
  return scaled;
}

const input = new Network();
const output = Scale(input);
```

`scaled` is one materialized Network backed by one arithmetic combinator. No Producer annotation is needed.

### 2. Distance calculation

```ts
const dx = x1 - x2;
const dy = y1 - y2;
const squaredX = dx * dx;
const squaredY = dy * dy;
const distanceSquared = squaredX + squaredY;
```

Each named intermediate is a Network and repeated `dx`/`dy` reads fan out without cloning their producers. An eventual integer square-root implementation composes on `distanceSquared`; it does not change declaration materialization.

### 3. MemoCell

```ts
function MemoCell(input: Readonly<Network>): Network {
  const out = new Network();
  const memory = new Network();
  to(out, memory) += input + 0;
  to(out, memory) += IF(input == 0 && memory != 0, memory);
  return out;
}
```

Explicit topology destinations stay Networks. The two producer expressions are consumed immediately by their fan-out attachments.

### 4. RGB indicator

```ts
const red = IF(level[A] > 0, 1 * RED);
const green = IF(level[A] > 1, 1 * GREEN);
const blue = IF(level[A] > 2, 1 * BLUE);
```

The three inferred bindings are Network values. If exact placement or delayed attachment is required, the user opts into handles with `DeciderCombinator` annotations.

### 5. Requester chest and test mock

```ts
const chest = RequesterChest({ requestFromBuffers: true })(filters);
const contents: Network = chest;

test.mock(chest).output(contentsFixture);
```

The inferred `chest` binding remains an Entity handle, so mocking and inspection retain physical identity. The explicit `Network` context projects the class's one schema-declared default circuit output without replacing `chest`. If the final schema uses a named port instead, the equivalent spelling will be `chest.contents`; the identity rule is unchanged.

### 6. Assembler and test mock

```ts
const assembler = Assembler({ setRecipe: true, readContents: true })(recipe, control);
test.mock(assembler).crafting({ recipe: IRON_GEAR_WHEEL, progress: 0.5 });
```

The declaration keeps the Entity handle even though the object consumes circuit Networks and may expose status signals. Because an assembler may have several semantic circuit views, no implicit Network projection is allowed unless its schema designates exactly one default. Otherwise source must select an explicit port.

## Implementation constraints for Phase 6

1. Add a separately branded `EntityValue`; do not encode it as `{ kind: "producer" }` or infer it from user-visible fields.
2. The declaration materializer must preserve `EntityValue` in inferred contexts and keep the existing combinator behavior.
3. A contextual Entity-to-Network projection creates no combinator, tick, or second physical entity.
4. Projection must be schema-driven. Zero or several candidate default circuit views produce a source-aware ambiguity error.
5. Entity aliases retain one physical identity across mocks, placement, inspection, and any projected Networks.
6. Explicit combinator annotations continue to preserve affine Producer identity and the single-attachment rule.

The executable runtime benchmark fixes the first four programs today. RequesterChest and Assembler become executable acceptance cases when their typed schemas and the Phase 5 testbench exist.

## Current lifecycle boundary

`ProducerLifecycle` is the executed recorder's identity authority for transient combinators. Registration may observe several wrapper values with the same opaque identity, but attachment state, debug captures, and unused finalization remain shared. It records the direct-plan index at attachment so a later `t.instantiate(...)` capture can amend the existing descriptor rather than clone the entity or leave a dangling capture ID. `producer-attachment-policy` owns output-connector cardinality, duplicate/reattachment diagnostics, and the ordered writable-capability gate; the recorder provides the concrete lifecycle lookup and capability callback. Output-Signal compatibility is isolated in `producer-output-policy`; it transforms a wrapper without changing physical identity and retains creation/binding provenance in `RT2023`.
