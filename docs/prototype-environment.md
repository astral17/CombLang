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

Phase 5.5 will introduce `packages/prototypes` with these responsibilities:

- versioned normalized schema and structural validation;
- environment metadata and a deterministic content identity;
- immutable indexes and a `PrototypeProvider` query interface;
- JSON loading for Node and browser consumers;
- tiny synthetic fixtures and a generated first-run vanilla/Space Age profile.

The compiler, language service, typed-object schemas, layout, and blueprint
backend receive a provider through an explicit compilation environment. They do
not reach into a giant JSON object or a global registry. The simulator continues
to consume already-lowered circuit devices and buses rather than prototype data.

The first schema should include only facts required by the next acceptance
programs:

- environment: schema/generator version, Factorio version, expansions, ordered
  mod names and versions, and startup-settings identity;
- items and fluids: canonical key and item stack size;
- recipes: key, category, ingredients, products, and energy;
- entities: key, type, footprint, crafting categories, and capability-oriented
  circuit flags;
- qualities: canonical key and stable ordering information;
- indexes such as every recipe producing a product.

Recipe products are one-to-many, and ingredients/products may be items or
fluids. Entity data should expose capabilities needed by CombLang instead of
copying unstable raw prototype table layouts. Icons and localization are
separate optional assets, not part of the core identity.

## Factorio-side export

The bundled local Factorio 2.1.16 runtime API confirms a practical control-stage
export path. The global read-only `prototypes: LuaPrototypes` object exposes
dictionaries for items, fluids, recipes, entities, qualities, virtual signals,
and other resolved prototypes. `script.active_mods` identifies active mod
versions, while startup settings are available to the mod. `helpers.table_to_json`
serializes a normalized Lua table and `helpers.write_file` writes it under the
user-data `script-output` directory.

Therefore the first exporter should be a small Factorio mod that reads the
resolved runtime prototype views and writes CombLang's normalized schema. It
must not serialize `data.raw` as the public compiler contract. A larger raw
archive may be useful for diagnostics, but it is a separate artifact.

Extraction details still need conformance fixtures against base, Space Age, and
at least one mod that modifies a vanilla recipe or entity. The architecture does
not depend on one extraction implementation: a future Factorio API change may
replace the exporter without changing `PrototypeProvider` consumers.

## Loading and identity

CLI and browser loading should validate before constructing a provider. The CLI
will accept an explicit prototype database path and later a project profile. The
browser will accept a local file, cache validated databases in IndexedDB, and
show the active environment. A project pinned to one environment identity must
not silently compile against the built-in fallback when that database is
missing.

The exact content-hash algorithm is intentionally not selected yet. Until the
optional reproducible-build policy is designed, deterministic canonical content
identity is required, while timestamps and other provenance metadata must remain
outside that identity.

## Phase boundary

Phase 5 testbench work does not depend on prototype data and should finish
without this package. Phase 5.5 establishes the provider, validator, fixtures,
loader injection, and exporter prototype before Phase 6 typed objects introduce
entity- and recipe-specific configuration. Phase 8 then extends concrete
configuration values with blueprint parameters without changing the provider
boundary.
