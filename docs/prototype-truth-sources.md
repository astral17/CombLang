# Prototype evidence and data boundaries

[Documentation](README.md) · [Loading guide](prototype-environment.md) · [Normalization reference](prototype-normalization.md)

Prototype structure, compiler authority and native behavior are separate.
A validated database identifies its data; a trusted host profile authorizes
specific Entity operations; native evidence establishes what was actually
observed in Factorio. None of these can silently substitute for another.

## Three different kinds of evidence

| Layer                    | Intended use                                                                                | Does not establish                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Raw data-stage dump      | Final modded `data.raw`: names, recipes, stack sizes, structural Entity and quality fields. | Runtime circuit behavior or game/mod identity without companion metadata. |
| Pinned API metadata      | Reviewed field shapes and limits used by the converter/catalog.                             | A live game connection or behavior for an arbitrary modpack.              |
| Reviewed native evidence | Recorded assertions for a specific environment and operation, with traceable inputs.        | Untested operations or a different version/mod/settings combination.      |

The selected environment is an immutable normalized provider. The browser can
convert a raw dump plus explicit metadata in its Worker; the CLI can normalize
them ahead of compilation. No CombLang mod, scenario, headless runner or live
connection is required. See the [loading guide](prototype-environment.md) for
user import and maintainer asset generation.

The [pinned Factorio 2.1.17 API inputs](../tools/factorio-api/README.md) and shipped
Base + Space Age asset provide structural provenance. Hashes prove byte identity,
not the truth of metadata declarations or native conformance. Coverage flags
describe available facts, not their evidence quality.

The simulator consumes lowered devices and buses. It is not a factory simulator
and does not use prototype geometry to infer Entity computation.

## Entity authority

`Entity(prototype, configuration?)` refers to one persistent physical object.
Its blueprint configuration is checked separately from connectors, callable
projections and computation. A normalized `blueprintEligible: true` record can
authorize conservative construction; that fallback does not infer circuit ports
or read behavior.

Explicit trusted host profiles can authorize additional capabilities.
A provider record, circuit flag, evidence-manifest source ID or routing label
alone is not such a profile. See [Entity](api/entity.md) and the
[Entity pipeline](entity-pipeline.md) for the distinct construction, configuration,
connection and simulation boundaries.

## Partial circuit facts and supplements

Omitted `entity.circuit` means unknown. An explicit record contains all nine
boolean fields; an all-false record is a negative assertion, not an empty default.
Complete coverage requires explicit records for every Entity. Do not add false
records merely to satisfy the validator.

`applyEntityCircuitSupplement(database, supplement)` merges explicit facts into
a validated frozen copy without mutating the input. The CLI equivalent is:

```powershell
npm run cli -- prototypes supplement --json prototypes.json circuit-supplement.json enriched-prototypes.json
```

Illustrative **synthetic** supplement, not native Factorio evidence:

```json
{
  "schemaVersion": 1,
  "baseIdentity": "<reported identity of prototypes.json>",
  "entities": [
    {
      "key": "entity:synthetic-container",
      "type": "container",
      "circuit": {
        "read": true,
        "enableDisable": false,
        "readContents": true,
        "setFilters": false,
        "setRequests": false,
        "setRecipe": false,
        "readRecipe": false,
        "readFinishedCraft": false,
        "outputSignals": true
      }
    }
  ]
}
```

Use the exact base identity reported by a CLI check or provider, not the
placeholder above. The nonempty supplement list must reference existing Entities
with matching types. Duplicate Entities, stale base identities, missing/nonboolean
flags and conflicting existing facts are rejected. Matching records are accepted;
there is no implicit overwrite of conflicting assertions.

Adding facts changes the resulting database identity. A subsequent supplement
must target that resulting identity, or combine the assertions against the
original base in one supplement. CLI JSON reports base/result identities and
`{ known, total, complete }` circuit coverage. Full coverage is derived from
the records, not accepted as an unchecked supplement claim.

Identity checks prevent accidental cross-database mixing. They do not verify
manually supplied assertions or create trusted Entity execution profiles.

## Identity-bound evidence manifests

Evidence manifests are separate from the normalized database, provider identity
and compiler cache keys. Inspect one with:

```powershell
npm run cli -- prototypes evidence --json prototypes.json evidence.json
```

Each source has an ID, a `sha256:<64 lowercase hex>` artifact digest and one of
these kinds: `data-raw-structure`, `runtime-structure`,
`reviewed-native-behavior` or `synthetic`. A source-kind label is a declared
classification, not automatic independent verification.

Structural references may use raw/runtime structural sources. A circuit claim
must match an existing database boolean and use a reviewed-native source;
synthetic and structural sources cannot certify behavior. The loaded index
distinguishes `unknown` (no database fact), `unverified` (stored fact without a
reviewed claim) and `verified` (matching reviewed claim). A verified false value
remains false, not unknown.

The checked-in [synthetic manifest](../examples/prototype-stack/evidence.synthetic.json)
demonstrates the format only. It contains no reviewed native behavior evidence.
The shipped browser does not require a user-collected runtime artifact.

## Identity migration

Regeneration can change supported facts, canonical ordering or generator metadata
and therefore the content identity. Existing normalized JSON keeps its recorded
generator identifier when loaded; loading does not rerun the raw converter.

On a pin mismatch, reload without the stale pin, inspect the new database and
explicitly update project/supplement pins if the change is intended. In the
browser, reselect the JSON when its saved identity no longer matches. No stale
pin is silently accepted, and a missing custom profile is not replaced with the
bundled one.

Keep native behavior claims tied to their actual inputs. A successful cache
migration, asset digest check or codec round trip does not establish new native
behavior.
