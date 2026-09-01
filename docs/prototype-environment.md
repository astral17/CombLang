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

The implemented foundation currently covers the first four responsibilities
and synthetic fixtures. CLI/browser profile loading, the Factorio exporter, and
the generated first-run database remain subsequent Phase 5.5 slices.

The compiler, language service, typed-object schemas, layout, and blueprint
backend receive a provider through an explicit compilation environment. They do
not reach into a giant JSON object or a global registry. The simulator continues
to consume already-lowered circuit devices and buses rather than prototype data.

Schema version 1 includes only facts required by the next acceptance programs:

- environment: schema/generator version, Factorio version, expansions, ordered
  mod names and versions, and startup-settings identity;
- items and fluids: canonical key and item stack size;
- recipes: key, category, ingredients, products, and energy;
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
- invalid numeric ranges and item temperature constraints;
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

CLI and browser loading should validate before constructing a provider. The CLI
will accept an explicit prototype database path and later a project profile. The
browser will accept a local file, cache validated databases in IndexedDB, and
show the active environment. A project pinned to one environment identity must
not silently compile against the built-in fallback when that database is
missing.

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
`run` boundary accept the provider explicitly. The CLI flag/project profile and
browser Worker-side database construction belong to the next loading slice;
providers with methods are never posted across a Worker boundary.

## Phase boundary

Phase 5 testbench work does not depend on prototype data. The schema, provider,
identity, validator, JSON boundary, and synthetic fixtures now establish the
core Phase 5.5 seam. The explicit runtime, browser-library, and CLI-library
injection seam is now established. Persisted profile loading, dump/conformance
fixtures, and the built-in vanilla/Space Age snapshot remain before Phase 6
typed objects introduce entity- and recipe-specific configuration. Phase 8 then
extends concrete configuration values with blueprint parameters without
changing the provider boundary.
