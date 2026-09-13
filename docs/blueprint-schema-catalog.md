# Blueprint schema catalog

`@comblang/prototypes` exports a validated, read-only catalog generated from
the pinned Factorio 2.1.17 API snapshot. It describes the documented
`BlueprintEntity` common fields, all 62 documented entity variants, the 47
variants that declare a `control_behavior` field, their 37 concrete behavior
tables, and the recursive named-schema closure. The built-in loader pins the
catalog to the independently reviewed Factorio 2.1.17 source identity and
checks behavior schemas and variant links before exposing the data.

The catalog is structural data only. Its `documented` status means that the
field or type exists in the pinned API snapshot; it does not grant Entity
construction, connector, callable, simulation, or native-conformance
authority. Implementation and native-evidence statuses are separate fields.
Variant lookup remains exact: a missing variant is not evidence that a provider
prototype exists or that its variant fields are documented. For an actual
provider-owned prototype, the checked fragment resolver combines the common
fields with that exact variant when present, and otherwise returns a
common-only structural schema. This keeps a common-only built-in type usable
without treating a familiar name as provider evidence.

This catalog is different from the prototype database: prototype data records
the concrete names, capabilities, and recipes in a captured Factorio data
environment, while the catalog records the API shape of blueprint JSON. It is
also different from the bounded `{ raw }` Entity escape hatch, which preserves
caller-provided JSON without claiming schema validation or native semantics.

## Checked Entity fragments

`resolveBlueprintEntitySchema(prototype)` accepts the selected provider's actual
prototype record and its `type`, then returns either `documented-variant` or
`documented-common-only`. `validateBlueprintEntityFragment(...)` checks a
partial plain JSON fragment against that result. It supports scalar literals,
arrays, tuples, unions, dictionaries, object fields, and recursive named
references with bounded depth, node, and UTF-8 byte budgets. Compiler-owned
common fields are rejected at their JSON paths. Missing fields are not errors,
and catalog defaults are not materialized by the compiler.

The validation result is one of `valid` (documented shape), `invalid`, or
`unassessed` (a safely uninterpretable scalar family). The latter is deliberately
not a boolean “supported” claim and points callers to `{ raw: ... }`. The
checked source form lowers to the existing bounded raw physical payload after
validation. It carries no schema, catalog, profile, connector, callable,
simulation, or native-conformance authority across Direct Plan, NCIR, Worker,
or persistence boundaries.

SignalID positions accept ordinary Blueprint data such as `{ name: 'signal-A' }`
or `{ type: 'virtual', name: 'signal-A' }`. The source `Signal(...)` helper is
the ergonomic nominal form; a same-session handle is detached only at a
catalog-declared SignalID position. Foreign nominal handles, invalid field
shapes, accessors, and symbol keys remain rejected without invoking caller
coercion hooks.

## Schema-family coverage

The generated catalog characterization covers all 62 entity variants and the
complete 113-reference closure. The following matrix records the current
representative checked evidence without treating it as a native Factorio
compatibility claim:

| Family             | Structural catalog coverage            | Checked validation evidence                               | Raw fallback | Native evidence |
| ------------------ | -------------------------------------- | --------------------------------------------------------- | ------------ | --------------- |
| Logistics          | Full generated variant/reference graph | `logistic-container` request sections and filters         | Available    | Not captured    |
| Belts              | Full generated variant/reference graph | `transport-belt` network settings and read mode           | Available    | Not captured    |
| Displays           | Full generated variant/reference graph | `display-panel` text, icon, and nested parameters         | Available    | Not captured    |
| Train stops        | Full generated variant/reference graph | `train-stop` station, color, limits, and control behavior | Available    | Not captured    |
| Filters            | Full generated variant/reference graph | `inserter` filter mode, positions, and item filters       | Available    | Not captured    |
| Recipes            | Full generated variant/reference graph | `assembling-machine` recipe and control behavior          | Available    | Not captured    |
| Transport settings | Full generated variant/reference graph | `loader` connection type, filter mode, and filters        | Available    | Not captured    |

These representatives are table-driven tests against the generated descriptors,
not a claim that every field is implemented. Known scalar families are checked
by the structural validator; unfamiliar scalar descriptors are reported as
`unassessed` and require the explicit `{ raw: ... }` form. `raw` preserves a
bounded caller payload, but it does not add schema, simulation, or native
authority.

## Regeneration

The generator verifies the SHA-256 manifest for the checked-in 2.1.17 runtime
and prototype API fixtures before reading them. It emits the inventory and the
catalog with locale-independent ordering:

```sh
npm run factorio-api:catalog
npm run factorio-api:catalog:check
```

Updating Factorio requires a new versioned fixture directory, a reviewed
change to `control-behavior-review.json`, regenerated output, and the focused
and full checks. The production package consumes only the generated catalog;
it does not import the large API fixture files and does not send the catalog
through compiler Worker messages.
