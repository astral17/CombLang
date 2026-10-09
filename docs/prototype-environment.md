# Prototype environment

[Documentation](README.md) · [prototypes API](api/prototypes.md) · [Data format](prototype-normalization.md)

A prototype environment is an immutable snapshot of a selected Factorio version,
mod set and startup settings. It supplies names, stack sizes, recipes, qualities
and structural Entity facts to compilation. It is not a connection to a running
game, and importing a prototype does not grant Entity circuit behavior.

For ordinary circuit authoring, start with the [prototypes API](api/prototypes.md).
This page explains how to select and load the data behind that API.

## Choose an environment

| Situation                        | What to load                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| Bundled Base + Space Age         | The workbench's first-run profile; no extraction needed.                                     |
| Custom modpack in the workbench  | One normalized prototype JSON, or a raw dump plus its metadata JSON.                         |
| Custom modpack in the CLI        | Normalize the dump first, then select the resulting JSON with `--prototypes` or `--project`. |
| No prototype queries or Entities | An ordinary circuit can compile without a provider.                                          |

The bundled profile describes Factorio 2.1.17 with `base`, `elevated-rails`,
`quality` and `space-age`. Other installations need their own data; a familiar
prototype name does not establish that its configuration is unchanged.

## Static asset generation

For a custom environment, run Factorio with the intended mods and startup
settings using its official command:

```text
factorio.exe --dump-data
```

Take the raw dump from Factorio's `script-output` directory and keep it with
metadata for that same environment. No CombLang mod, scenario, runtime collector
or live game connection is required.

The dump does not identify its game version, mod versions, expansions or startup
settings. Record these separately. For the bundled Base + Space Age installation,
the metadata is:

```json
{
  "factorioVersion": "2.1.17",
  "expansions": ["space-age"],
  "mods": [
    { "name": "base", "version": "2.1.17" },
    { "name": "elevated-rails", "version": "2.1.17" },
    { "name": "quality", "version": "2.1.17" },
    { "name": "space-age", "version": "2.1.17" }
  ],
  "startupSettings": []
}
```

Adapt the version, expansions and **complete enabled mod list**, including
dependencies, to your own installation. Do not reuse this metadata for an
unverified dump. The importer validates the metadata's shape, not its truth.

`factorioVersion`, `expansions` and `mods` are required. `startupSettings`
is an optional array of `{ name, value }` entries. Omission means unknown;
`[]` means there are no startup settings, not "all settings use defaults".
Supported values include booleans, finite numbers, strings and color objects or
three/four-channel color arrays. An optional `startupSettingsIdentity` is a
caller-supplied label/hash; it is not automatically verified against the values.

### Import into the workbench

Use **Load prototype JSON** above the source editor:

1. Select one normalized JSON file; or select exactly two files, the raw dump
   and its companion metadata JSON.
2. For a two-file import, name the companion `metadata.json`,
   `environment.json` or `profile.json`. A filename containing one of those
   words separated by dots, underscores or hyphens also works. Exactly one
   selected file must match this naming rule.
3. Wait for Worker validation and inspect the selected profile/diagnostics.
   Source and test drafts are not overwritten.

A raw dump without companion metadata is rejected. Importing malformed
normalized JSON does not cause the loader to reinterpret it as a raw dump.

Custom profiles are saved in IndexedDB by content identity. The active choice
is tab-local, so different tabs can select different profiles. Reloading checks
the saved database against its identity before compiling. A storage/quota failure
reports **not saved**; the current in-memory profile can still be used.

**Disable** records an explicit empty selection for the current tab. It does not
delete a cached database that another tab may use. If a selected custom database
is missing from storage, reload it or explicitly disable it; the workbench does
not silently substitute the bundled profile. Browser site-storage controls can
remove cached databases.

### Normalize for CLI use

From the repository root, run:

```powershell
npm run cli -- prototypes normalize data-raw-dump.json metadata.json prototypes.json
```

The installed executable spelling is
`factorio-dsl prototypes normalize data-raw-dump.json metadata.json prototypes.json`.
This command expects the dump's raw prototype tables. The browser/host input
loader also recognizes a `data.raw` wrapper.

The normalizer validates and writes a normalized database, then reports omission
warnings. Choose a new output path: this normalization command can overwrite an
existing file. Unknown circuit capabilities stay unknown; warnings are not
permission to fill them with invented values. See the
[normalization reference](prototype-normalization.md) for retained fields,
defaults and diagnostics.

## Loading and identity

The CLI loads normalized JSON explicitly:

```powershell
npm run cli -- check --prototypes prototypes.json --json main.factorio.ts
npm run cli -- test --prototypes prototypes.json --json main.factorio.ts circuit.test.js
npm run cli -- blueprint export --prototypes prototypes.json main.factorio.ts
```

Paths supplied on the command line are relative to the working directory.
JSON reports include `prototypeEnvironment` with the selected identity,
environment metadata and capability coverage. Read that identity, then optionally
require it on subsequent runs:

```powershell
npm run cli -- check --prototypes prototypes.json --prototype-identity "<reported identity>" main.factorio.ts
```

Use the full reported value, not a profile name. A missing database, invalid
normalized data or identity mismatch stops before source execution with exit
code `2`; there is no fallback even when the source does not use prototypes.
Source/test failures use exit code `1`. JSON input errors contain diagnostics;
database validation preserves its `PT1000`–`PT1006` code, structural path and
supplied filename.

Flags may precede or follow filenames; `--` ends option parsing for literal
filenames. Duplicate value options and unknown flags are rejected. Quote paths
containing spaces.

Content identity is SHA-256 over canonical normalized data, including schema and
generator identifiers, environment metadata, coverage, prototypes and indexes.
Informational `generatedAt` is excluded. Ordering is locale-free UTF-16
code-unit order; recipe component order remains significant. Treat the full
identity as opaque. Changed content or generator metadata can require an
explicit pin update; see [identity migration](prototype-truth-sources.md#identity-migration).
An identity proves which normalized data was selected, not native game behavior
or a fully reproducible build.

## CLI project files

A data-only project file supplies one default source, an optional test file and
a prototype selection:

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

Replace `<reported identity>` with the identity reported for the selected
database, or omit `identity` to accept its current contents. `schemaVersion`,
`source` and `prototypes.path` are required; `tests`, the identity pin and
an optional [diagnostic policy](diagnostics.md) are not.

```powershell
npm run cli -- check --project comblang.json
npm run cli -- test --project comblang.json --json
npm run cli -- blueprint export --project comblang.json
npm run cli -- parameters list --project comblang.json --json
```

Configured paths resolve relative to the project file. Explicit positional
filenames replace the configured source/test filenames and resolve from the
working directory, as do explicit output/override paths. `test` accepts either
the configured pair or an explicit source/test pair, not one explicit filename.
Export and parameter listing accept zero or one explicit source and do not read
the configured test file. See [Param](api/parameters.md) for concrete overrides.

There is no automatic parent-directory search, executable configuration, import
or module linking. Multiple `check` filenames are independent compilations
sharing the selected provider, not a linked project.

Do not combine `--project` with `--prototypes` or an injected provider.
`--prototype-identity` may pin an unpinned project or repeat its existing pin;
a conflicting pin reports `CLI1003`. Unknown fields, unsupported schema values,
invalid paths or unreadable project files report `CLI1005`. Selection errors
stop before source or test execution.

The checked-in [prototype-stack project](../examples/prototype-stack/comblang.json)
is a pinned synthetic example that needs no downloads.

## Embedding hosts and Worker loading

These are host APIs, not globals to paste into circuit source:

| API                                              | Accepted input and result                                                                                                                                         |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadPrototypeDatabaseJson(normalizedJson)`      | Strict normalized JSON → frozen database and provider.                                                                                                            |
| `loadPrototypeInputJson(json, options?)`         | Normalized JSON or recognized raw dump → frozen database/provider, detected format and normalization warnings. Raw input requires `options.factorioDumpMetadata`. |
| `loadPrototypeAsset(databaseJson, manifestJson)` | Generated database/manifest pair with integrity checks. Original input bytes may also be supplied for input digest checks.                                        |

Each provider is explicitly injected into its compilation environment. The
reserved source value `prototypes` exposes frozen name tables and query helpers;
there is no mutable process-global provider. Without an injected environment,
reading `prototypes` reports source-linked `EX1004`.

The compiler Worker receives cloneable JSON and metadata, never provider methods.
It constructs and caches providers by identity for its own lifetime. An unknown
cached identity reports `WP1002` rather than selecting another profile. After a
restart, the UI resends its retained JSON with the identity pin. Cold loading and
compilation use a 15000 ms timeout; warm identity-only recompilation uses 1000 ms.

The bundled database/manifest pair is loaded as separate Vite assets, not embedded
in the JavaScript payload or persisted to IndexedDB. A missing/corrupt bundled
pair leaves ordinary circuits available with a profile notice. A missing selected
custom profile blocks compilation until the selection is explicitly repaired.

Structural data can authorize conservative construction only for Entities whose
`blueprintEligible` fact is explicitly `true`. The host fallback has no
inferred connectors or computation. Callable projections, circuit connections,
configuration authority and simulator behavior need their own reviewed profiles;
see [Entity](api/entity.md) and [evidence boundaries](prototype-truth-sources.md).
The simulator consumes lowered devices and buses, not prototype data.

## Reproducible generated asset

For maintainers, the asset generator writes a database and its sibling
`<output>.manifest.json`. The manifest records source-dump and metadata SHA-256
digests, schema/generator identifiers, the normalized identity and exact output
digest, without input paths or generated timestamps.

```powershell
npm run prototype:asset -- data-raw-dump.json metadata.json prototypes.json
npm run prototype:asset:check -- data-raw-dump.json metadata.json prototypes.json
npm run prototype:asset:verify
```

The first two commands generate or regenerate/check the pair from its original
inputs. The last checks the shipped bundled pair without requiring those inputs.
The installed command equivalents are `prototypes asset generate [--check]`
and `prototypes asset verify <database.json> <manifest.json>`.

Generation validates before writing. Check mode regenerates in memory and rejects
missing, stale or digest-mismatched outputs. Integrity loading does not treat
structural facts as native behavior evidence.

The shipped files under `packages/prototypes/generated/` are
`space-age-2.1.17.metadata.json`, `space-age-2.1.17.json` and
`space-age-2.1.17.json.manifest.json`. Consult their current content rather
than an old extraction report. The bundled database has
`entityCircuitCapabilities: false`; importing it does not claim native behavior.

See [normalization](prototype-normalization.md) for the data contract and
[evidence boundaries](prototype-truth-sources.md) for supplements and claims.
