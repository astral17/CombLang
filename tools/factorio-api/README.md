# Pinned Factorio API inputs

This development-only tool owns the machine-readable Factorio API inputs used
to review CombLang's native entity and control-behavior coverage. The current
snapshot is Factorio **2.1.17**, JSON API schema **6**.

The repository contains the runtime and prototype JSON snapshots plus the
documentation license under `fixtures/2.1.17/`. `manifest.json` pins every file
by SHA-256. The generator verifies all hashes and API metadata before reading
the schemas, then verifies the separately reviewed class assignment and the
40/37/3/47 control-behavior baseline. The schema catalog separately reviews
all 62 documented `BlueprintEntity` variants, so a new API class or variant
fails generation until `control-behavior-review.json` is deliberately reviewed.

Run:

```sh
npm run factorio-api:inventory
npm run factorio-api:inventory:check
npm run factorio-api:catalog
npm run factorio-api:catalog:check
```

The first command regenerates `generated/control-behaviors.json`; the second
checks it byte-for-byte. The catalog commands generate and check
`packages/prototypes/generated/blueprint-schema-catalog-2.1.17.json` using the
same pinned fixtures. Ordering is explicit UTF-16 code-unit ordering, so it
does not depend on the host locale. All commands are local and make no network
requests. Ordinary `build` does not run this tool and neither production code
nor generated provenance references a sibling `Analysis` directory.

When updating Factorio, add a new versioned fixture directory rather than
overwriting an old snapshot. Update its hashes, change `snapshotVersion`, review
every class/wave and changed variant, regenerate the inventory, and commit those
changes together. Schema presence documents Factorio's API shape; it does not
claim that CombLang implements, simulates, or has natively verified a field.

The 2.1.17 review found the expected 40/37/3/47 control-behavior baseline and
62 documented `BlueprintEntity` variants. Its API delta adds the
`elevated-rail-above-metal` render layer and adjusts an unrelated runtime method
overload.
