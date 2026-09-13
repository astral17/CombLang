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
Unknown lookup results are explicit, so a modded or unsupported variant is
not silently treated as documented.

This catalog is different from the prototype database: prototype data records
the concrete names, capabilities, and recipes in a captured Factorio data
environment, while the catalog records the API shape of blueprint JSON. It is
also different from the bounded `{ raw }` Entity escape hatch, which preserves
caller-provided JSON without claiming schema validation or native semantics.

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
