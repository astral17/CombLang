# Pinned Factorio API inputs

This development-only tool owns the machine-readable Factorio API inputs used
to review CombLang's native entity and control-behavior coverage. The current
snapshot is Factorio **2.1.16**, JSON API schema **6**.

The repository contains the runtime and prototype JSON snapshots plus the
documentation license under `fixtures/2.1.16/`. `manifest.json` pins every file
by SHA-256. The generator verifies all hashes and API metadata before reading
the schemas, then verifies the separately reviewed class assignment and the
40/37/3/47 baseline. A new API class or BlueprintEntity variant therefore fails
generation until `control-behavior-review.json` is deliberately reviewed.

Run:

```sh
npm run factorio-api:inventory
npm run factorio-api:inventory:check
```

The first command regenerates `generated/control-behaviors.json`; the second
checks it byte-for-byte. Ordering is explicit UTF-16 code-unit ordering, so it
does not depend on the host locale. Both commands are local and make no network
requests. Ordinary `build` does not run this tool and neither production code
nor generated provenance references a sibling `Analysis` directory.

When updating Factorio, add a new versioned fixture directory rather than
overwriting an old snapshot. Update its hashes, change `snapshotVersion`, review
every class/wave and changed variant, regenerate the inventory, and commit those
changes together. Schema presence documents Factorio's API shape; it does not
claim that CombLang implements, simulates, or has natively verified a field.
