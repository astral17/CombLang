# Prototype normalization reference

[Documentation](README.md) · [Loading guide](prototype-environment.md) · [prototypes API](api/prototypes.md)

This is the structural data contract for dump converters and embedding hosts,
not a circuit-source API or a complete Factorio crafting model. Authors selecting
a modpack should start with the [loading guide](prototype-environment.md).

`packages/prototypes` validates normalized JSON, copies/freezes accepted records,
constructs read-only providers and computes content identity. The public schema
uses `schemaVersion: 1`. The following rules describe the current implementation,
not historical generator releases.

## Database shape and ordering

| Field                                | Content                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment`                        | Factorio version, expansions, exact mod names/versions, generator identifier, optional startup-settings label/values and informational timestamp. |
| `capabilities`                       | Coverage flags for item stack sizes, fluids, recipes, entities, circuit facts, qualities, recipe categories and virtual signals.                  |
| `items`, `fluids`                    | Canonical key/name; items may include stack size.                                                                                                 |
| `recipes`                            | Categories, energy, ingredients/products, main product and supported recipe flags.                                                                |
| `entities`                           | Name/type, optional blueprint eligibility, footprint, crafting and circuit facts.                                                                 |
| `qualities`                          | Name, level and optional explicit chain link/end.                                                                                                 |
| `recipeCategories`, `virtualSignals` | Canonical key/name.                                                                                                                               |
| `indexes.recipesByProduct`           | Canonical item/fluid key to recipe keys, consistent with recipe products.                                                                         |

Canonical keys include `item:iron-plate`, `fluid:water`,
`recipe:iron-gear-wheel`, `entity:assembling-machine-3`, `quality:normal`,
`recipe-category:crafting` and `virtual:signal-A`. They are record identifiers,
not the short names used to index the singular provider tables.

Prototype arrays, expansions, mods, categories and derived indexes use
deterministic locale-free UTF-16 code-unit ordering. Recipe ingredient/product
row order is significant. Repeated product rows remain in the recipe but do not
duplicate it in the product index.

The validator ignores unknown extension fields and preserves supported optional
facts. Omission, explicit `false`, zero and empty arrays are distinct. Unknown
facts are not silently replaced with negative claims.

## Raw projection and diagnostics

The dump converter reads every item subtype carrying `stack_size`, not only the
literal `item` table. Entity tables come from the concrete type catalog derived
from the pinned [Factorio 2.1.17 API](../tools/factorio-api/README.md). Modded
records in those tables are supported; an unknown top-level table is not guessed
to contain Entities. A new engine Entity type needs a reviewed catalog update.

| Boundary              | Diagnostic        | Meaning                                                                                     |
| --------------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| Normalized validation | `PT1000`–`PT1006` | Invalid schema, value, key/reference, index or JSON, with a structural path.                |
| Raw conversion        | `PD1001`          | Malformed applicable raw field, reported at its raw snake_case path.                        |
| Raw conversion        | `PD2002`          | Per-Entity circuit behavior is unavailable from this extraction; coverage remains false.    |
| Raw conversion        | `PD2003`          | A known field is inapplicable to its item/fluid or ingredient/product role and was omitted. |

Do not treat an omission warning as evidence that the source had no such behavior.
For example, a raw fluid `extra_count_fraction` is not promoted into a supported
fluid-product fact. Supplying that field in strict normalized JSON is an error,
not another omission warning. Successful conversion and absence of warnings do
not establish complete native conformance.

## Recipe amounts and identity

TypeScript exposes precise item/fluid ingredient/product unions. The canonical
`prototype` key supplies the item/fluid discriminant; membership in `ingredients`
or `products` supplies the role. JSON does not duplicate `role`/`kind` fields.

| Role       | Item amount                                            | Fluid amount                                                     |
| ---------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| Ingredient | Exact integer `1..65535`.                              | Exact finite positive number.                                    |
| Product    | Exact integer or complete integer range in `0..65535`. | Exact finite non-negative number or complete non-negative range. |

Products require `amount` or both `amountMin` and `amountMax`, not competing
forms. Normalized ranges are ascending. Raw descending product ranges are
projected to the effective `amountMax = amountMin`. Item-product
`extraCountFraction` is optional in `[0, 1)` and does not replace a missing amount.
Zero products and empty-output recipes, including sentinel/parameter recipes,
are valid; empty-output recipes contribute no product-index entries.

The raw converter applies the supported RecipePrototype defaults: crafting
category when categories are omitted, energy `0.5` and enabled by default. It
retains multiple categories, supported booleans and fluid temperatures. Explicit
malformed booleans or main-product values are errors. A nonempty raw `main_product`
must identify exactly one product namespace; repeated rows in that namespace are
allowed, but matching both item and fluid is ambiguous. Empty string means no
main product. Normalized `mainProduct`, when present, must reference a product.

### Probability and excluded counts

| Raw field                 | Normalized field                  | Role/domain                                                                  |
| ------------------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| `independent_probability` | `independentProbability`          | Products; threshold in `[0, 1]`.                                             |
| `shared_probability`      | `sharedProbability: { min, max }` | Products; `0 <= min <= max <= 1`.                                            |
| `ignored_by_stats`        | `ignoredByStats`                  | Ingredients/products; non-negative uint16 item count or finite fluid amount. |
| `ignored_by_productivity` | `ignoredByProductivity`           | Products; same item/fluid count domains.                                     |

Independent and shared probability metadata are not flattened into one expected
count. Shared intervals retain correlations between rows; an empty interval is
legal. Optional normalized `probability` cannot be mixed with the independent/
shared representation. Excluded counts may exceed the crafted amount; omission
is not replaced with zero or with another field's default.

These are immutable prototype facts. The circuit simulator does not implement
crafting RNG, excluded statistics or productivity.

### Spoilage and fluid routing

| Raw field                                    | Normalized field                   | Role/domain                                                     |
| -------------------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| `percent_spoiled`                            | `percentSpoiled`                   | Item product fraction in `[0, 1)`.                              |
| `always_fresh`                               | `alwaysFresh`                      | Item product boolean.                                           |
| `reset_freshness_on_craft`                   | `resetFreshnessOnCraft`            | Item product boolean.                                           |
| `spoil_weight`                               | `spoilWeight`                      | Item ingredient weight in `[0, 1]`.                             |
| `fluidbox_index`                             | `fluidboxIndex`                    | Fluid ingredient/product uint32 index, including zero sentinel. |
| `fluidbox_multiplier`                        | `fluidboxMultiplier`               | Fluid ingredient/product integer `1..255`.                      |
| `optional_fluidbox_indexes`                  | `optionalFluidboxIndexes`          | Fluid ingredient/product ordered uint32 array.                  |
| `temperature`                                | `temperature`                      | Fluid ingredient/product finite number.                         |
| `minimum_temperature`, `maximum_temperature` | `temperatureMin`, `temperatureMax` | Fluid ingredient bounds.                                        |

Optional fields remain optional rather than being populated with native defaults.
Fluidbox indexes address input/output boxes separately. An optional index list
without `fluidboxIndex` is retained as inactive declarative metadata; consumers
must not invent its base index. Lists preserve order and duplicates and are
copied/frozen. An empty raw Lua-table sentinel `{}` becomes `[]`; normalized JSON
requires an array. No crafting, spoilage or fluid-routing simulation is added.

### Recipe quality and chains

| Raw field             | Normalized field    | Role/domain                                       |
| --------------------- | ------------------- | ------------------------------------------------- |
| `affected_by_quality` | `affectedByQuality` | Item products; boolean.                           |
| `quality_change`      | `qualityChange`     | Item ingredients/products; int8 `-128..127`.      |
| `quality_min`         | `qualityMin`        | Item ingredients/products; canonical quality key. |
| `quality_max`         | `qualityMax`        | Item ingredients/products; canonical quality key. |

`affectedByQuality: false` must not be interpreted as "always normal quality".
Recipe quality still matters. Missing bounds are not filled, and explicit shifts
are not rewritten based on equal bounds. Fields are validated by role, type and
shape even without quality coverage; references are checked when coverage exists.

`prototypes.quality[name].next` is a canonical quality key, `null` for a known end,
or omitted for unknown linkage. The raw converter emits an explicit end when
`next` is omitted. Known cycles and, with coverage, dangling links are rejected.
When both recipe bounds exist, `qualityMax` must be reachable from `qualityMin`
through `next`. A known end before the maximum is an error; an unknown link leaves
the relationship unverified. Numeric `level` does not invent chain links/order.

## Entity structure and coverage

Entity footprint fields `tileWidth`/`tileHeight` are optional as a pair. Raw
projection uses explicit `tile_width`/`tile_height` per axis and then the pinned
API's collision-box fallback. It never substitutes a selection box. A recognized
Entity without enough dimension data stays in the database with no footprint.

Raw `blueprintEligible` is true only for `player-creation` without
`not-blueprintable`. Absent raw flags have an empty-set default and produce
false. A normalized record omitting the derived fact remains unknown; only
explicit true authorizes the host's conservative construction fallback.

Circuit geometry does not supply the nine normalized behavior flags:
`read`, `enableDisable`, `readContents`, `setFilters`, `setRequests`, `setRecipe`,
`readRecipe`, `readFinishedCraft` and `outputSignals`.

- Omitted `entity.circuit` means unknown, not all false.
- An explicit record must contain all nine booleans, including false values.
- `capabilities.entityCircuitCapabilities: true` promises complete coverage:
  every Entity has a record, and Entity coverage is also true.
- With partial coverage, a helper can return an individual known record;
  missing facts and an unknown Entity remain different errors.

`isBasicCraftingCompatible` is only a category/fluid prefilter. It does not prove
temperature, fluidbox, ingredient-limit, surface, quality or machine-state rules.
See [supplements and evidence](prototype-truth-sources.md) for explicitly supplied
facts; neither circuit flags nor extraction geometry create an Entity computation
profile automatically.
