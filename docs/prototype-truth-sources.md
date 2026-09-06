# Prototype truth sources and September audit follow-up

Status: `--dump-data` is the primary structural input; optional runtime validation
and native behavior conformance are still pending. This records the triage of the September 4 master
audit and additional design notes against the current implementation, not an
assertion that every recommendation has been implemented.

## Three different kinds of evidence

| Layer                       | Authority and intended use                                                                                                       | Not evidence of                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Raw data-stage dump         | `factorio.exe --dump-data`: finalized modded `data.raw`, typed recipe rows, structural prototype fields, and diagnostics         | Native circuit behavior or environment identity without metadata |
| Runtime structural snapshot | Optional read-only `LuaPrototypes` cross-check for engine-loaded values, runtime-only getters, and captured environment metadata | A required production input or complete circuit behavior         |
| Reviewed behavior fixtures  | Native observations/configuration round trips and explicit conformance cases in a matching environment                           | Untested features or another mod/version/settings combination    |

The compiler receives a normalized immutable provider, not a raw dump or a live
game connection. The simulator continues to consume lowered devices and buses;
it does not become a factory simulator or depend on `packages/prototypes`.

The current schema/normalizer predates this split. Successful validation and a
stable hash do **not** certify native behavior, and coverage flags describe
available data rather than evidence quality. A runtime exporter transport exists,
but no captured runtime fact has been shown to add required structural information
that cannot be recovered from the final dump plus the pinned prototype schema.

## Extraction plan

The extraction path normalizes the final dump's item stack sizes, typed recipe
ingredients/products, `main_product`, categories/energy, entity footprint inputs,
crafting fields, and quality chains. A mandatory companion metadata file records
the game/mod/startup-setting environment because the dump does not identify it.
Unknown fields remain distinct from explicit negative or empty facts.

The runtime API snapshot and prototype API snapshot checked for this decision are
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
  selection box is not a tile footprint.
- Product and ingredient schemas must be validated by role and item/fluid type.
  Do not tighten runtime rules on a mixed raw representation first: raw artifacts
  such as fluid `extra_count_fraction` must not become authoritative runtime facts.
  Zero fluid amounts, product-only probability/ranges, and temperature roles need
  explicit regression coverage at the correct boundary.
- Circuit connector geometry is not proof of behavior-level capabilities. Keep
  the existing identity-bound supplement and observation-provenance checks;
  require reviewed native evidence before populating a complete capability table.
- Duplicate ingredients and numeric limits need their own validation pass after
  the role/source split. Duplicate **products** may be intentional and must remain.

Gate for a bundled first-run database: checked-in reproducible dump plus metadata
inputs from base, Space Age, and a modded override, and native conformance for the
behavior capabilities claimed. A runtime structural capture is optional unless a
concrete divergence makes it necessary. The observation mod still needs execution
in Factorio for behavior evidence.

## Runtime structural exporter decision

The prototype-wide runtime exporter, its transport parser, and its CLI command
were removed after reviewing the 2.1.17 dump. It duplicated final `data.raw`
without demonstrating a structural fact required by CombLang that could not be
recovered from the dump and pinned schema. A narrow runtime probe may be added in
the future only for a concrete, reproducible discrepancy; no generic capture
format is retained speculatively.

## Implemented audit corrections

- Persisted canonical ordering uses lexicographic UTF-16 code units, never host
  locale collation. This applies to normalization, provider collections, identity,
  and setting-object comparison; recipe row order remains significant.
- The normalizer retains empty-output recipes and no longer emits a skip warning
  for them. Version `comblang-factorio-data-dump-v1.6` also uses explicit tile
  dimensions before the documented collision-box fallback.
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
silently migrated or exempted from validation. Regenerating a raw database with v1.5 also
changes its contents and generator metadata, hence its identity.

## Additional design notes: planned, not current syntax

Phase 6 should start with one persistent `Entity(prototype, config)` identity and
a generic modded fallback, then typed facades over that shared implementation.
Placement, inspection, mocks, and circuit connections refer to the same physical
handle. Keep native configuration, circuit conditions, and future logistic
conditions separate. Explicit named connectors are required where the default
would be ambiguous. This does not imply simulating the entire game.

The following language/runtime work is tracked separately from prototype data:

- Define a shared `SignalValueSource` for CC: typed counts, signal/count tuples,
  arrays, maps, and ordinary computed-key objects. Preserve actual JavaScript key
  behavior: `{ A: 5 }` is a string key, not the variable `A`. Specify duplicate
  handling, ordering, and Signal-to-property-key identity before implementation.
- Move parity/color contradiction checks into elaboration operations (including
  fixed colors, pairs, connector inputs, and attachments). A contradiction must
  fail at its first executed operation with source provenance, before subsequent
  JavaScript runs. The current final batch solver does not meet this requirement;
  it should ultimately only orient/materialize already-consistent components.
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
