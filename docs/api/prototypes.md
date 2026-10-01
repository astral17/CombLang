# prototypes

[Documentation](../README.md) · [Entity](entity.md) · [Signal](signal.md)

`prototypes` is a reserved injected source value for the selected immutable
prototype environment. Do not declare, import or construct it yourself. Ordinary
circuits need no provider, but reading `prototypes` without one reports `EX1004`.
The workbench selects its bundled or user-loaded environment; embedding hosts
load and inject one explicitly.

## Signatures

Source query signatures; the records/arrays returned are readonly:

```text
prototypes.getItem(nameOrKey: string) -> ItemPrototype | undefined
prototypes.getFluid(nameOrKey: string) -> FluidPrototype | undefined
prototypes.getRecipe(nameOrKey: string) -> RecipePrototype | undefined
prototypes.getRecipeCategory(nameOrKey: string) -> RecipeCategoryPrototype | undefined
prototypes.getEntity(nameOrKey: string) -> EntityPrototype | undefined
prototypes.getQuality(nameOrKey: string) -> QualityPrototype | undefined
prototypes.getVirtualSignal(nameOrKey: string) -> VirtualSignalPrototype | undefined
prototypes.stackSize(item: string) -> number
prototypes.recipesProducing(product: 'item:NAME' | 'fluid:NAME') -> readonly RecipePrototype[]
prototypes.entityCircuitCapabilities(entity: string) -> EntityCircuitCapabilities
prototypes.isBasicCraftingCompatible(entity: string, recipe: string) -> boolean
```

## Tables and names

Seven singular tables are indexed by **short prototype name**, not canonical key:

| Table             | Example canonical record key  |
| ----------------- | ----------------------------- |
| `item`            | `item:iron-plate`             |
| `fluid`           | `fluid:water`                 |
| `recipe`          | `recipe:iron-gear-wheel`      |
| `recipe_category` | `recipe-category:crafting`    |
| `entity`          | `entity:assembling-machine-3` |
| `quality`         | `quality:normal`              |
| `virtual_signal`  | `virtual:signal-A`            |

For example `prototypes.item['iron-plate']` and
`prototypes.getItem('item:iron-plate')` return the same record. An unknown table
entry returns `undefined`; test it before reading fields. A `get...` lookup also
returns `undefined` for an unknown name when the required kind has coverage,
but throws if that coverage is unavailable. Records, tables,
provider and result arrays are frozen. Unsupported collections may be empty;
helpers requiring unavailable data throw instead of guessing.

## Environment and collections

`identity`, `schemaVersion`, `environment` and `capabilities` describe the selected
snapshot. Environment includes Factorio version, expansions, mod versions and
startup-setting metadata, not the running game state. Capabilities record coverage:
`itemStackSizes`, `fluids`, `recipes`, `entities`, `entityCircuitCapabilities`,
`qualities`, `recipeCategories`, `virtualSignals`.

| Collection                               | Index and value                                      |
| ---------------------------------------- | ---------------------------------------------------- |
| `collections.all`                        | Canonical prototype key → record.                    |
| `collections.recipesByProduct`           | Canonical item/fluid key → readonly recipe array.    |
| `collections.entitiesByType`             | Entity type → readonly Entity prototype array.       |
| `collections.craftingMachinesByCategory` | Crafting category → readonly Entity prototype array. |

## Query limits

`stackSize` accepts an item name or key and requires item-stack coverage and an
existing item. `recipesProducing` requires recipe coverage; an unindexed product
returns an empty array. It does not promise deterministic product amounts or
that a machine can execute the recipe.

`entityCircuitCapabilities` requires an existing Entity and explicit circuit
facts for that record (`read`, `enableDisable`, `readContents`, `setFilters`,
`setRequests`, `setRecipe`, `readRecipe`, `readFinishedCraft`, `outputSignals`).
It can succeed for a known record even when overall
circuit coverage is incomplete. These structural flags do not declare callable
Entity endpoints, default read projections or simulator behavior.

`isBasicCraftingCompatible` accepts Entity/recipe names or keys and checks only
category overlap plus required fluid support. Missing Entity, recipe, coverage or
crafting facts throw. A true result is a prefilter, not native craftability proof:
quality, temperatures, fluidbox routing and other recipe/machine rules may matter.

## Stack count example

Complete source; requires a selected provider containing `iron-plate` and
item-stack-size coverage. The bundled Space Age 2.1.17 profile meets this requirement.

```ts
const plate = prototypes.item['iron-plate'];
if (plate === undefined) throw new Error('iron-plate is missing');
const size = prototypes.stackSize(plate.key);
if (size !== plate.stackSize) throw new Error('stack facts disagree');
const PLATE = Signal('item', plate.name);
const output = new Network();
output += CC(size * PLATE);
```

One Constant; the selected stack count appears on PLATE at T1. For the bundled
profile it is 100. No item crafting or Entity simulation occurs.

## Loading outside circuit source

Host-only sequence, **not** source to paste into the editor:

```text
host: await loadPrototypeDatabaseJson(normalizedJson) -> { database, prototypes }
host: compileSourceProgram(source, { prototypes, ...hostEntityEnvironment })
```

The actual imports, provider/Entity provisioning, CLI and workbench selection are
documented in [Prototype environment](../prototype-environment.md#loading-and-identity).
Use the bundled profile or import your own normalized JSON / user-supplied
Factorio dump-data with honest metadata. No CombLang mod, scenario or headless
runtime collector is required. See [static data import](../prototype-environment.md#static-asset-generation).

## Restrictions

Static prototype records are neither live `LuaPrototypes` nor behavior profiles.
Structural import does not grant Entity connectors, callability or native
conformance. Avoid assuming a familiar vanilla/modded name has a released
computation contract. Unknown/omitted facts stay unknown. Do not mutate records
or use canonical keys as singular-table names. See [Entity](entity.md) and the
[Blueprint schema catalog](../blueprint-schema-catalog.md) for configuration.
