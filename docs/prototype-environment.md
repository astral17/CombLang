# Prototype environment

Typed objects and high-level generators must not treat one bundled vanilla
prototype list as compiler truth. A CombLang compilation environment identifies
the Factorio version, enabled expansions, exact mod set, startup settings, and a
normalized snapshot of the resulting prototypes. Mods may add prototypes and
also modify vanilla ones, so reading only the upstream `factorio-data` Lua files
cannot describe an arbitrary user's game.

This is a compilation-time environment input. It does not belong in the circuit
simulator and must not be a process-global mutable singleton.

## Package boundary

Phase 5.5 provides `packages/prototypes` with these responsibilities:

- versioned normalized schema and structural validation;
- environment metadata and a deterministic content identity;
- immutable LuaPrototypes-shaped tables, derived indexes, and query helpers;
- JSON loading for Node and browser consumers;
- tiny synthetic fixtures and a generated first-run vanilla/Space Age profile.

The implemented foundation now also includes an offline native-dump normalizer
and explicit CLI database selection with optional identity pins. Versioned CLI
project profiles, browser-local file selection and identity-keyed IndexedDB
persistence are implemented. Conformance completion and the generated first-run
database remain subsequent Phase 5.5 slices.

The compiler, language service, typed-object schemas, layout, and blueprint
backend receive a provider through an explicit compilation environment. They do
not reach into a giant JSON object or a global registry. The simulator continues
to consume already-lowered circuit devices and buses rather than prototype data.

Schema version 1 includes only facts required by the next acceptance programs:

- environment: schema/generator version, Factorio version, expansions, ordered
  mod names and versions, and startup-settings identity;
- items and fluids: canonical key and item stack size;
- recipes: key, one or more categories, ingredients, products, energy, exact
  fluid temperature, the 2.x integer-plus-fraction result count form, independent
  and shared product probability metadata, and statistics/productivity exclusions;
- entities: key, type, footprint, crafting categories, and capability-oriented
  circuit flags;
- qualities: canonical key and stable ordering information;
- recipe categories and virtual signals: canonical key and name;
- indexes such as every recipe producing a product.

Every prototype carries a canonical namespaced key such as
`item:iron-plate`, `fluid:water`, or `entity:assembling-machine-3`. Normalized
prototype arrays, expansions, mods, categories, qualities, and generated
indexes have deterministic ordering. Recipe ingredient/product order remains
part of the normalized content; repeated products do not duplicate a recipe in
the `recipesByProduct` index.

`validatePrototypeDatabase()` accepts untrusted JSON-shaped values, ignores
unknown extension fields, copies and freezes accepted data, and rejects:

- unsupported schema versions and malformed required fields;
- noncanonical or duplicate keys;
- invalid numeric ranges and non-fluid temperature constraints;
- missing ingredient/product references;
- a `mainProduct` outside the product list;
- a supplied index that disagrees with normalized recipe products.

Validation errors carry stable `PT1000`–`PT1006` codes and a structural path.
`loadPrototypeDatabase()` and `loadPrototypeDatabaseJson()` return the frozen
database together with an immutable `prototypes` provider.

Recipe products are one-to-many, and ingredients/products may be items or
fluids. Entity data should expose capabilities needed by CombLang instead of
copying unstable raw prototype table layouts. Icons and localization are
separate optional assets, not part of the core identity.

## Factorio-side export

The preferred first extraction path is Factorio's own command-line
`factorio.exe --dump-data`. It loads the selected game/mod/startup-settings data
stage and writes the resolved raw prototype dump under `script-output`. A
separate offline CombLang converter can then select and normalize the small v1
schema instead of requiring an exporter mod or loading raw prototype JSON in
the compiler.

The command is:

```text
factorio-dsl prototypes normalize data-raw-dump.json metadata.json prototypes.json
```

`metadata.json` is required because `data-raw-dump.json` does not identify the
Factorio version, active mod versions, expansions, or startup-settings state:

```json
{
  "factorioVersion": "2.1.16",
  "expansions": ["space-age"],
  "mods": [
    { "name": "base", "version": "2.1.16" },
    { "name": "space-age", "version": "2.1.16" }
  ],
  "startupSettingsIdentity": "project-specific-hash-or-label"
}
```

The converter reads every item subtype carrying the resolved `stack_size`, not
only the literal `item` table. It applies the raw RecipePrototype defaults
(`categories = ["crafting"]`, `energy_required = 0.5`, and enabled by default),
preserves multiple categories, exact fluid temperature, and
`amount + extra_count_fraction`, and derives entity tile dimensions from the
resolved bounding boxes. Empty engine sentinel/parameter recipes are skipped
with `PD2001` warnings.

The original supplied-dump smoke test produced a valid 669 KB normalized database
with 342 items, 651 non-sentinel recipes, and 744 entity prototypes. The generator
`comblang-factorio-data-dump-v1.1` additionally retains 100 independent probabilities,
23 shared ranges, 268 statistics exclusions and 7 productivity exclusions in that
dump. The smoke run used explicitly unverified environment metadata: it proves
data ingestion, not the dump's game/mod version or native crafting behavior.

Generator `comblang-factorio-data-dump-v1.2` additionally preserves the dump's one
explicit spoil percentage, five reset-freshness flags, three fluidbox indexes and
nine fluidbox multipliers. That dump has no explicit spoil weights, always-fresh
flags or optional fluidbox index lists; synthetic tests cover those fields instead.
The converter still reports tracked unsupported recipe quality fields
(`affected_by_quality`, `quality_change`, `quality_min`, `quality_max`). This is not
an exhaustive native RecipePrototype implementation, and lack of loss warnings
does not establish complete recipe behavior coverage.

### Product probability and excluded amounts

The local Factorio prototype API snapshot 2.1.16 describes `ProductPrototypeBase`,
`SharedProbabilityDefinition`, and the item/fluid ingredient/product definitions.
The normalized mapping is:

| Dump field                | Normalized field                  | Meaning                                                                      |
| ------------------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| `independent_probability` | `independentProbability`          | Per-product independent roll threshold in `[0, 1]`                           |
| `shared_probability`      | `sharedProbability: { min, max }` | Interval for the single roll shared by a product set; `0 <= min <= max <= 1` |
| `ignored_by_stats`        | `ignoredByStats`                  | Ingredient/product amount excluded from consumption/production statistics    |
| `ignored_by_productivity` | `ignoredByProductivity`           | Product amount excluded from productivity bonus crafts                       |

Both independent and shared probability tests must pass. Shared intervals are not
flattened into an expected count or one independent probability: overlapping and
disjoint intervals encode correlated/exclusive outcomes between products. The
empty interval `min === max` is legal. These are immutable compilation-time facts;
the circuit simulator does not implement crafting RNG or productivity simulation.

Explicit zero and omitted fields remain distinct. In particular the native
`ignored_by_productivity` default refers to `ignored_by_stats`; absent metadata is
not replaced with zero by the loader. Excluded counts may exceed the crafted amount.
Item exclusions use non-negative uint16 counts; fluid exclusions allow non-negative
finite amounts. Independent/shared probabilities and productivity exclusions are
product-only; statistics exclusions also belong on ingredients.

Legacy normalized `probability` remains supported, but mixing it with the new
independent/shared probability representation is rejected as an ambiguous normalized
schema input. Older v1 data without the new optional fields remains loadable.
The fields participate in the database identity, including explicit default-valued
fields. Regenerating a database with the new generator may therefore require an
explicit project pin update. Older loaders that do not know these fields are not
equivalent readers for new datasets.

### Spoilage and fluidbox metadata

The same local 2.1.16 API snapshot defines these optional ingredient/product fields:

| Dump field                  | Normalized field          | Valid domain                                             |
| --------------------------- | ------------------------- | -------------------------------------------------------- |
| `percent_spoiled`           | `percentSpoiled`          | Item product fraction, `0 <= value < 1`                  |
| `always_fresh`              | `alwaysFresh`             | Item product boolean                                     |
| `reset_freshness_on_craft`  | `resetFreshnessOnCraft`   | Item product boolean                                     |
| `spoil_weight`              | `spoilWeight`             | Item ingredient weight, `0 <= value <= 1`                |
| `fluidbox_index`            | `fluidboxIndex`           | Fluid ingredient/product uint32 index                    |
| `fluidbox_multiplier`       | `fluidboxMultiplier`      | Fluid ingredient/product integer, `1..255`               |
| `optional_fluidbox_indexes` | `optionalFluidboxIndexes` | Fluid ingredient/product ordered array of uint32 indexes |

`alwaysFresh` produces fresh output using `percentSpoiled` even with spoiled
ingredients. `resetFreshnessOnCraft` produces fresh output when crafting succeeds
without spoiling. `spoilWeight` controls an ingredient's influence on the product's
spoil fraction. Their native defaults are respectively false, false, and 1;
`percentSpoiled` defaults to 0. These defaults are documented, not inserted into
the database. This metadata does not add spoilage or crafting simulation.

Fluidbox indexes address input and output boxes separately and are 1-based, with
the native default value 0 also accepted. The multiplier controls crafting-machine
fluidbox volumes; its native default is 3. Optional indexes describe additional
boxes: missing boxes do not make the recipe uncraftable. The native API loads this
list only when `fluidbox_index` is defined. The normalized database preserves an
explicit list even if the base index is absent, as inactive declarative metadata;
consumers must not apply it without `fluidboxIndex`. It never invents the base index.
Index lists retain order and duplicates, are copied/frozen on load, and participate
in the identity. An empty raw Lua-table sentinel `{}` becomes `[]` at conversion;
normalized JSON itself requires an array.

All seven fields remain optional in schema v1. Explicit zero, false and empty lists
remain distinguishable from omission through JSON serialization, provider access
and identity calculation. New generators may require an explicit identity-pin
update; existing data without these fields still loads unchanged. Item-only fields
on fluids, fluid-only fields on items and incorrect ingredient/product roles are
validation errors, not silently discarded facts.

### Remaining conformance boundary

The raw entity records expose connector geometry and wire distance, but not the
normalized behavior-level flags in `EntityCircuitCapabilities`. The converter
therefore emits entities and crafting data while setting
`entityCircuitCapabilities: false`; a later Lua probe or verified per-type rule
table must supply those facts. It never infers them merely from the presence of
a connector.

This path still requires conformance verification. In particular, fixtures
must establish whether the dump contains every capability-oriented circuit and
crafting fact CombLang needs, and whether modded overrides agree with the
control-stage read-only `prototypes: LuaPrototypes` views. The bundled local
Factorio 2.1.16 runtime API confirms that `LuaPrototypes` exposes dictionaries
for items, fluids, recipes, entities, qualities, virtual signals, and other
resolved prototypes. If `--dump-data` omits a required derived fact, a small
Factorio-side Lua probe may supplement it; it should not become the public
compiler contract or duplicate fields already available in the native dump.

Extraction details still need conformance fixtures against base, Space Age, and
at least one mod that modifies a vanilla recipe or entity. The architecture does
not depend on one extraction implementation: a future Factorio dump/API change
may replace the converter or supplemental probe without changing
`PrototypeProvider` consumers.

## Loading and identity

The CLI validates normalized JSON before constructing a provider. Both commands
accept an explicit database path, resolved relative to the working directory:

```sh
npm run cli -- check --prototypes prototypes.json --json main.factorio.ts
npm run cli -- test --prototypes prototypes.json --json main.factorio.ts circuit.test.js
```

The normalizer's output can be used directly. JSON results include
`prototypeEnvironment` with the selected `identity`, Factorio/mod metadata and
capability coverage. Human-readable output prints the identity and Factorio version.
Read the reported identity first, then optionally require it on subsequent runs:

```sh
npm run cli -- check --prototypes prototypes.json --prototype-identity "<reported identity>" main.factorio.ts
```

`<reported identity>` is a placeholder for the full `comblang-prototypes-v1-sha256:…`
value, not a profile name. A missing database, validation failure or identity
mismatch stops before source execution with exit code `2`; no fallback is selected,
even if the source does not use `prototypes`. With `--json`, loading/usage errors
are emitted as one JSON document containing `diagnostics`. Database validation
retains its `PT1000`–`PT1006` code, structural `path`, and supplied `file` path.
Source/test failures still use exit code `1`.

Flags can precede or follow filenames. Duplicate value options and unknown flags
are rejected; `--` ends option parsing for literal filenames. Quote paths containing
spaces. One selected provider is used for all source files in that invocation, not
saved globally. The programmatic `run(args, { prototypes })` seam remains supported,
including an identity pin; combining an injected provider and `--prototypes` is an
error rather than an implicit precedence rule.

Without either source of prototype data, ordinary circuits still compile and
accessing `prototypes` produces `EX1004`. No built-in database is installed yet.
In the browser, use **Load normalized
JSON** above the source editor. It does not modify source or test drafts. After
validation, the database is saved in IndexedDB under its identity and the active
identity is saved in tab-local session storage. Reloading the tab restores the
database and checks that pin again before source execution. Separate tabs may
select different environments without overwriting each other's selection.

**Disable** clears the current tab's selection; it does not delete a database that
another tab may be using. Cached databases can also be removed through browser site
storage controls. Storage/quota failure is reported as **not saved**; compilation
can still use the selected in-memory profile. A selected database missing from
IndexedDB blocks compilation until the user loads a file or explicitly disables
the selection. It never silently substitutes a built-in fallback.

The browser compiler Worker protocol accepts either normalized JSON plus an
optional expected identity, or an identity already confirmed by that Worker.
Parsing, validation, hashing and provider construction happen inside the Worker;
only cloneable JSON enters it and only cloneable environment metadata, diagnostics,
and the direct plan leave it. Provider methods are never structured-cloned.

Successfully loaded environments are cached by identity for that Worker lifetime,
so ordinary recompilation does not repeatedly parse and hash the database. Selection
is still explicit on every compile request: omitting the profile compiles without
one, while an unknown cached identity returns `WP1002` and asks the caller to send
the JSON again. Thus a Worker restart cannot silently lose a pin or substitute a
profile. The UI retains the JSON in memory after loading and resends it with the
previous identity pin after a Worker restart. Initial JSON loading and compilation
share a 5000 ms Worker timeout; identity-only recompilation keeps the 1000 ms budget.

The v1 environment identity is SHA-256 over canonical normalized JSON and is
prefixed `comblang-prototypes-v1-sha256:`. It includes schema and generator
versions, Factorio version, sorted expansions/mods, startup-settings identity,
capability coverage, normalized prototypes, and indexes. Informational
`generatedAt` provenance is deliberately excluded. This is a cache/project
identity boundary, not yet the optional reproducible-build policy from Phase
11; a future schema version may select a different explicitly tagged algorithm.

After asynchronous loading, the primary synchronous surface deliberately feels
like Factorio's Lua API. Singular snake_case tables are indexed by prototype
name:

```ts
const { prototypes } = await loadPrototypeDatabaseJson(source);

prototypes.item['iron-plate'];
prototypes.fluid.water;
prototypes.recipe['iron-gear-wheel'];
prototypes.recipe_category.crafting;
prototypes.entity['assembling-machine-3'];
prototypes.quality.normal;
prototypes.virtual_signal['signal-A'];
```

These frozen null-prototype objects model read-only `LuaCustomTable` access;
an unknown name evaluates to `undefined`. The tables contain names only, while
canonical-key access and cross-kind lookup live in query helpers and
`prototypes.collections`:

```ts
prototypes.getItem('item:iron-plate');
prototypes.collections.all['entity:chemical-plant'];
prototypes.collections.recipesByProduct['item:iron-gear-wheel'];
prototypes.collections.entitiesByType['assembling-machine'];
prototypes.collections.craftingMachinesByCategory.crafting;
```

The other helpers answer stack-size, entity circuit-capability, recipe-product,
and basic crafting-category/fluid-compatibility questions. If a database lacks
complete coverage for one prototype kind, its direct table is empty and a
helper requiring that coverage reports the missing capability separately from
an unknown key. No provider singleton exists, and the simulator has no
dependency on this package.

Source code receives the same provider through an explicit compilation
environment and may inspect it using the reserved `prototypes` value. The
transform routes that identifier through its hygienic runtime bridge, so it is
not a mutable process global:

```ts
const PLATE = Signal(prototypes.item['iron-plate'].name);
const fullStack = CC(prototypes.item['iron-plate'].stackSize * PLATE);
```

Using `prototypes` without an injected environment reports source-linked
`EX1004`. The runtime executor, browser-local `compileSource` boundary, and CLI
`run` boundary accept the provider explicitly. CLI flags construct it inside the
Node process, while the browser compiler Worker constructs and caches its own
provider from JSON. CLI project files persist the paths and optional identity pin;
providers with methods are never posted across a Worker boundary.

## CLI project files

Use `--project <file>` to select a versioned, data-only project configuration:

```json
{
  "schemaVersion": 1,
  "source": "main.factorio.ts",
  "tests": "circuit.test.js",
  "prototypes": {
    "path": "data/prototypes.json",
    "identity": "<reported identity>"
  }
}
```

Replace `<reported identity>` with the full identity emitted by a successful
`check --prototypes ... --json` run, or omit `identity` to accept the database's
current contents. `schemaVersion`, `source` and `prototypes.path` are required;
`tests` and `prototypes.identity` are optional. Unknown fields, empty strings and
unsupported versions are errors. This v1 configuration supplies one default source
and one optional test file; it is not yet a multi-module build manifest.

```sh
npm run cli -- check --project comblang.json
npm run cli -- test --project comblang.json --json
```

All configured paths are resolved relative to the configuration file, never to
the shell's working directory. Explicit positional filenames replace the configured
source/test filenames and retain their usual working-directory-relative meaning.
This lets the same profile check several independent files. `test` still requires
exactly two resolved filenames; without explicit filenames it requires `tests`.

There is no automatic parent-directory search, executable config, or import/eval
step. A project cannot be combined with `--prototypes` or an injected provider.
`--prototype-identity` may pin an otherwise unpinned project or repeat the existing
pin, but a conflicting pin fails with `CLI1003`. Changing a pinned environment
requires explicitly editing the project file. Invalid or unreadable project files
report `CLI1005`; all loading/selection errors stop before source/test execution.

The checked-in [prototype-stack project](../examples/prototype-stack/comblang.json)
provides a fully pinned synthetic example without downloads.

## Phase boundary

Phase 5 testbench work does not depend on prototype data. The schema, provider,
identity, validator, JSON boundary, and synthetic fixtures now establish the
core Phase 5.5 seam. The explicit runtime, browser-library, and CLI-library
injection seam and persisted CLI/browser profile loading are now established.
Dump/conformance fixtures and the built-in vanilla/Space Age snapshot remain before Phase 6
typed objects introduce entity- and recipe-specific configuration. Phase 8 then
extends concrete configuration values with blueprint parameters without
changing the provider boundary.
