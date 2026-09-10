# Prototype truth sources and September audit follow-up

Status: reviewed static data is the structural input; runtime-only behavior remains
unknown. This records the triage of the September 4 master audit and additional
design notes against the current implementation, not an assertion that every
recommendation has been implemented.

## Three different kinds of evidence

| Layer                        | Authority and intended use                                                                                                                                                       | Not evidence of                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Raw data-stage dump          | Official `factorio.exe --dump-data` output: finalized modded `data.raw`, typed recipe rows, structural prototype fields, and diagnostics from the reviewed static-input pipeline | Runtime-only circuit behavior or environment identity without metadata |
| Pinned API metadata          | Versioned local Factorio API descriptions used to validate the static normalizer and its supported shapes                                                                        | A live game connection or complete capability profile                  |
| Reviewed capability evidence | Explicit, identity-bound evidence accepted for a later feature slice                                                                                                             | Untested features or another mod/version/settings combination          |

The compiler receives a normalized immutable provider, not a raw dump or a live
game connection. The shared input loader can now accept normalized v1 JSON or a
raw `data.raw` dump plus explicit metadata before constructing that provider. The
browser may perform that raw-to-normalized conversion in its Worker; the CLI can
perform the same conversion ahead of time. The simulator continues to consume lowered devices and buses;
it does not become a factory simulator or depend on `packages/prototypes`.

The current schema/normalizer predates this split. Successful validation and a
stable hash do **not** certify native behavior, and coverage flags describe
available data rather than evidence quality. The speculative runtime exporter
transport was removed because no captured runtime fact was shown to add required
structural information unavailable from the final dump plus the pinned schema.

The separate identity-bound evidence manifest now records this distinction without
promoting data into the normalized database. A static source can support structural
references, while only an explicitly reviewed capability source can back a matching
circuit claim. Synthetic manifests are useful contract/format fixtures only; the
repository contains no reviewed capability artifact yet. Source digests identify
bytes but do not establish their truth by themselves.

## Extraction plan

For a custom environment, run the official Factorio command with the desired mods and
startup settings:

```text
factorio.exe --dump-data
```

Use the resulting raw dump from Factorio's `script-output` directory together with
explicit, honest metadata describing that same environment. The browser accepts the
raw dump plus metadata directly, or the existing CLI can normalize them into the v1
database first. The bundled Base + Space Age profile is already checked in and works
without this step; authors cannot prebuild every possible modpack profile.

The extraction path normalizes the final dump's item stack sizes, typed recipe
ingredients/products, `main_product`, categories/energy, entity footprint inputs,
crafting fields, and quality chains. A mandatory companion metadata file records
the game/mod/startup-setting environment because the dump does not identify it.
Unknown fields remain distinct from explicit negative or empty facts.

Raw entity tables are selected from the concrete prototype type catalog derived
from the checked-in 2.1.17 prototype API; an arbitrary top-level table is not
promoted to Entity. Recognized entities remain present when neither ordinary
footprint axis is available. The normalized v1 footprint fields are optional as
an all-or-nothing pair, and no placement dimension is fabricated.

The pinned runtime API description and prototype API snapshot checked for this decision are
the hash-pinned Factorio 2.1.17 / JSON API 6 fixtures under
`tools/factorio-api/fixtures/2.1.17`. Their offline inventory generator and review
manifest are documented in `tools/factorio-api/README.md`. Exporter outputs must
state their own exact version; declarations in manually supplied metadata are not
proof of the version that generated a dump.

In particular:

- Empty-output recipes are legal. Preserve them, including engine sentinel
  recipes; they contribute no entries to the product index.
- Entity tiling dimensions honor explicit `tile_width`/`tile_height` independently,
  then use the prototype API's documented per-axis collision-box fallback. A
  selection box is not a tile footprint; if both sources are insufficient, the
  Entity remains in the normalized database with omitted dimensions.
- Product and ingredient schemas must be validated by role and item/fluid type.
  Do not tighten runtime rules on a mixed raw representation first: raw artifacts
  such as fluid `extra_count_fraction` must not become authoritative runtime facts.
  The normalized v1 policy reports those fields as `PT1004` at canonical paths;
  the raw converter omits known inapplicable fields and emits `PD2003` at their
  exact raw snake_case paths. Applicable malformed values remain `PD1001`.
  Ingredients require exact positive amounts; products accept an exact amount or
  a complete range, with zero allowed for item/fluid products and item values
  bounded by uint16. Normalized ranges are canonical ascending ranges, while raw
  descending product ranges use Factorio's effective `amountMax = amountMin`
  fallback. The public TypeScript model exposes item/fluid ingredient/product
  unions without serializing duplicate role/kind fields. These boundaries have
  explicit regression coverage at the correct source boundary.
- Circuit connector geometry is not proof of behavior-level capabilities. Keep the
  existing identity-bound supplement and evidence-manifest checks; runtime-only
  capability fields remain unknown until a later Phase 6/7 feature slice defines an
  accepted static or reviewed source.
- Duplicate ingredients and numeric limits need their own validation pass after
  the role/source split. Duplicate **products** may be intentional and must remain.

Boundary for the bundled first-run database: checked-in reproducible static data,
explicit metadata for the selected environment, identity-bound provenance, and
integrity verification. For custom profiles, the same boundary accepts either the
official raw dump plus explicit metadata or its normalized v1 result. This structural
boundary is complete. Per-Entity behavior
and capability verification is deliberately deferred to the Phase 6/7 feature
slices; no game execution or user-collected artifact is required by the shipped
browser product.

The deterministic asset generator/check now provides the release seam for those
inputs, and the confirmed Space Age profile is checked in under
`packages/prototypes/generated/`. Its sidecar pins the raw dump, metadata,
normalized output bytes, schema versions, and database identity; it does not turn
structural extraction into runtime behavior evidence or supply missing environment
provenance. The browser uses this structural asset as its first-run profile, and
its integrity check is part of the completed Phase 5.5 boundary. No generic runtime
capture format is retained.

## Implemented audit corrections

- Persisted canonical ordering uses lexicographic UTF-16 code units, never host
  locale collation. This applies to normalization, provider collections, identity,
  and setting-object comparison; recipe row order remains significant.
- The normalizer retains empty-output recipes and no longer emits a skip warning
  for them. Version `comblang-factorio-data-dump-v1.9` also uses explicit tile
  dimensions before the documented collision-box fallback, role/kind-aware
  normalized recipe projection, and canonical amount normalization for raw
  product ranges.
- Explicit malformed recipe booleans and `main_product` values fail with `PD1001`
  and a raw field path. A nonempty raw main-product name must identify exactly
  one product namespace. Repeated rows in that namespace are allowed; matching
  both item and fluid is ambiguous. Empty string means no main product.
- `canCraft` was removed in favor of `isBasicCraftingCompatible`. This checks only
  category overlap and the coarse `supportsFluids` flag. Missing facts/unknown
  prototypes throw instead of returning a misleading negative answer. `true`
  does not validate fluidbox routing, temperatures, limits, surfaces, quality,
  machine configuration, or exact native craftability. A future richer query
  should return yes/no/unknown with reasons and evidence.

### Identity migration

Fixing locale collation can change hashes of databases whose ordering differs
under locale collation, without changing their schema version. The checked-in
minimal pinned example keeps its identity: its ordering is unaffected. The
corrected pre-v1 implementation retains the `comblang-prototypes-v1-sha256:` prefix.
Pins that no longer match are intentionally rejected; there is no compatibility
fallback. Reload the JSON without a stale pin, inspect the new identity, and
explicitly update project/supplement pins as appropriate. In the browser, select
the JSON again if the cached identity no longer matches. Old entries are not
silently migrated or exempted from validation. Regenerating a raw database with
v1.9 also changes its contents and generator metadata, hence its identity. Older
valid schema-v1 JSON retains its recorded generator label when loaded; the loader
does not rewrite it to the current raw converter identity.

## Additional design notes: planned, not current syntax

Phase 6 should start with one persistent `Entity(prototype, config)` identity and
a generic modded fallback, then typed facades over that shared implementation.
Placement, inspection, mocks, and circuit connections refer to the same physical
handle. Keep native configuration, circuit conditions, and future logistic
conditions separate. Explicit named connectors are required where the default
would be ambiguous. This does not imply simulating the entire game.

The following language/runtime work is tracked separately from prototype data:

- Implemented: the shared `SignalValueSource` for CC accepts typed counts,
  signal/count tuples, nested arrays, maps, and ordinary computed-key objects.
  It preserves actual JavaScript key behavior (`{ A: 5 }` is an item-name string
  key, not the variable `A`), executed ordering, duplicates, zeros, source paths,
  and canonical Signal property keys without accepting arbitrary iterables.
- Implemented: parity/color contradiction checks run during elaboration operations
  (including fixed colors, pairs, connector inputs, and attachments). A
  contradiction fails at its first executed operation with source provenance,
  before subsequent JavaScript runs. The final solver only
  orients/materializes already-consistent components.
- Implemented initial policy: simple bare `Network` parameters and direct Networks
  passed to untyped function-declaration parameters receive non-consuming read-only
  borrows, with one declaration warning per compilation. Ordinary generic values
  remain unchanged. Automatic writable inference is not implemented; writes require
  explicit `Ref`, and `Move` remains the only consuming parameter boundary. See
  [ownership rules](ownership-and-multi-network.md) for the supported scope.
- Implemented: poison a TestSession after a failed scheduled callback/boundary. Callbacks can
  already have mutated drives, mocks, and schedules before throwing. Do not permit
  retrying that partially applied boundary as if it were atomic. Reads of the last
  committed snapshot, traces, and model state remain available; all further
  mutation/advancement is blocked. Scheduled callbacks and participant failures
  have separate regression coverage. Out-of-boundary validation/assertion errors
  and `settle` non-convergence do not poison the session.

These items do not require replacing the ownership state machine. Full module
sandbox hardening and optional reproducible-build policy remain low-priority
Phase 11 work.
