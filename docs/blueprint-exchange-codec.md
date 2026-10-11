# Blueprint exchange codec

`@comblang/blueprint` separates exchange framing, lossless JSON storage, and a
small root/header projection. It does not reconstruct CombLang source or claim
that a decoded document is accepted or interpreted identically by Factorio.

## Exchange format and browser requirements

An exchange string is the marker `0`, followed by canonical padded standard
Base64 containing a zlib-wrapped `deflate` stream and UTF-8 JSON. Base64url,
whitespace, non-canonical trailing Base64 bits, invalid UTF-8, and trailing
compressed-stream bytes are rejected. The default adapter uses the standard Web
`CompressionStream` and `DecompressionStream` with the `deflate` format. Hosts
without both capabilities receive `BEX1004`; callers can inject a compatible
streaming adapter. Codec modules do not read browser globals during import.

The implementation uses `TextEncoder`, fatal `TextDecoder`, `AbortSignal`, and
ordinary `Uint8Array` streams. Browser/Worker callers can structured-clone the
detached semantic header; the lossless class instances themselves are not a
structured-clone transport format. The checked-in tests exercise Web streams,
`structuredClone`, and `MessageChannel` under Node's browser-compatible globals;
they are not a substitute for a native Factorio export.

## Budgets

Defaults are immutable. Callers may provide positive safe-integer overrides.

| Limit                  |    Default | Applied to                                       |
| ---------------------- | ---------: | ------------------------------------------------ |
| `maxEncodedCharacters` |  8,388,608 | Complete exchange string, including marker       |
| `maxCompressedBytes`   |  6,291,456 | Base64-decoded input or compressed output        |
| `maxDecompressedBytes` | 25,165,824 | UTF-8 JSON input/output of the compression layer |
| `maxJsonDepth`         |        128 | Nested arrays/objects                            |
| `maxJsonNodes`         |  1,000,000 | JSON values; object member names are not nodes   |
| `maxStringBytes`       |  4,194,304 | Aggregate UTF-8 bytes in values and member names |
| `maxEmittedBytes`      | 25,165,824 | Lossless JSON writer output                      |

Input, compressed, decompressed, and emitted sizes are checked before their
corresponding final allocations; streamed chunks are counted before copying.
The CLI applies these same defaults and reads input files with a bounded reader.

## Lossless document model

`parseLosslessJson` returns only JSON data nodes. Objects are immutable ordered
member pairs, not JavaScript property bags; arrays are immutable; caller-provided
accessors, prototypes, sparse arrays, and duplicate keys are rejected. The writer
may normalize whitespace and string escaping but preserves member order, array
order, and each numeric lexeme.

Numbers are represented by the nominal `LosslessJsonNumber` class. Its `lexeme`
remains authoritative; `toNumberIfExact()` returns a JavaScript number only when
its binary floating-point value is mathematically exact for that decimal. It may
return `undefined` when a bounded exactness check cannot establish that property.
Blueprint `version` projection is stricter: it must be an exact safe integer.

## Root classification

Exactly one top-level root is accepted:

| Root                     | Result                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `blueprint`              | Full lossless document plus bounded `item`, `label`, `version`, `entities`-present, and `wires`-present header view |
| `blueprint_book`         | Opaque, codec-round-trippable; no blueprint semantic projection                                                     |
| `upgrade_planner`        | Opaque, codec-round-trippable; no blueprint semantic projection                                                     |
| `deconstruction_planner` | Opaque, codec-round-trippable; no blueprint semantic projection                                                     |

The header projection does not validate Entity or wire payloads. Unknown or
multiple roots and incorrect root/header shapes fail with typed errors and paths.

## CLI

```text
factorio-dsl blueprint decode [--json] [--input-file <exchange.txt> | <exchange-string>] [--output <document.json>]
factorio-dsl blueprint encode [--json] [--output <exchange.txt>] <document.json>
factorio-dsl blueprint import [--json] [--output <source.factorio.ts>] [--prototypes <database.json>] [--prototype-identity <id>] <blueprint-file>
```

For a source circuit, create native JSON with the separate
[source export command](blueprint-json.md#source-export-cli), then either import
the JSON file directly or encode it and import the resulting exchange file:

```sh
node apps/cli/dist/main.js blueprint export --output simple.json simple.factorio.ts
node apps/cli/dist/main.js blueprint export --prototypes database.json --parameters --output numeric.json numeric.factorio.ts
node apps/cli/dist/main.js blueprint import --prototypes database.json --output imported.factorio.ts simple.json
node apps/cli/dist/main.js blueprint encode --output simple.txt simple.json
node apps/cli/dist/main.js blueprint import --prototypes database.json --output imported-exchange.factorio.ts simple.txt
node apps/cli/dist/main.js blueprint encode --output numeric.txt numeric.json
```

### Import JSON or exchange files as CombLang source

Import accepts exactly one UTF-8 blueprint file. If its untouched first
character is the existing `0` exchange marker, the CLI decodes it with the
public lossless codec and sends the resulting lossless JSON to the same canonical
source importer. Otherwise, the original file text is passed as JSON without
normalization. Import does not accept books, projects, source files, stdin, or
parameter overrides. The separate `blueprint decode` command remains available
when a standalone JSON document is wanted.

For exchange files only, one terminal LF or CRLF is removed before strict codec
framing, matching `decode --input-file`. The CLI does not otherwise trim the
file, strip a BOM or leading whitespace, unwrap Base64, or remove multiple line
endings. A leading space before the marker therefore selects JSON, two final
newlines leave one newline for strict decoding and fail, and malformed exchange
data is never retried as JSON. JSON text, including valid surrounding
whitespace, is passed unchanged. The file reader remains bounded, and the codec
independently applies its encoded, compressed, decompressed, depth, node, and
string limits.

Import and check the generated source with the same prototype database:

```sh
node apps/cli/dist/main.js blueprint import --prototypes database.json --output imported.factorio.ts simple.json
node apps/cli/dist/main.js check --prototypes database.json imported.factorio.ts
```

`--prototype-identity <id>` can pin the selected database; use the same pin for
the subsequent `check`. The host must provide a trusted Entity replay context
with exactly one profile for each imported canonical Constant or Arithmetic
prototype. Import never selects profiles by type, position, or approximate name;
missing/ambiguous profiles, modded names, opaque roots, partial inventories,
unsupported fields, and unsupported placement are refusals. The supported source
subset requires explicit direction, exact x/y placement, and top-level four-value
wire tuples; legacy per-entity connections, object-shaped wires, and unknown
outer fields are not silently dropped. Root metadata may be reported as
retained-only, but it is not emitted into the generated source.

#### Browser workflow

The web workbench accepts pasted native JSON for one `blueprint` or one Factorio
exchange string that decodes to that same supported root. The same field chooses
exchange mode only when the untouched first character is the existing `0` marker;
otherwise it sends the text as JSON. Input is never trimmed or normalized. A
leading space before an exchange marker therefore selects JSON, and a malformed
exchange string is not retried as JSON. Empty input is also treated as JSON and
fails its ordinary document parse. Exchange framing is strict: paste the marker
and Base64 string verbatim without wrapping or adding/removing a terminal newline.
Exchange decoding uses the standard Web deflate streams and reports `BEX1004`
when they are unavailable. Editing the pasted text invalidates any pending or
verified preview. Select and wait for a validated prototype environment first;
conversion reuses that selected profile.
The current source importer supports its reviewed Constant and Arithmetic
subset, with explicit placements and supported top-level wire tuples.
Unsupported fields, incomplete coverage, missing or ambiguous canonical
profiles, and failed verification are shown as refusals with native JSON paths
and generated-source locations where available. A refusal never presents
partial generated source.

Only a verified preview enables **Replace source**. After a separate browser
confirmation, generated `main.factorio.ts` replaces the current source and is
compiled through the normal workbench path; the circuit test draft is left
unchanged. Editing the input or source, changing the profile, or losing the
compiler Worker makes the preview stale, so convert again before applying.
Warnings and metadata retained only in the original document are shown, but
that metadata is not reconstructed in source. Verification means structural
source compilation and native-JSON round-trip agreement for the supported
subset; it does not establish Factorio acceptance, electrical compatibility,
or lossless preservation of every document field.

Without `--output`, source text alone is printed and its reported source path is
virtual; no file is created. With `--output`, the path is resolved absolutely and
created exclusively, so an existing file is never replaced. `--json` emits one
response envelope containing the source snapshot, correspondence, verification
counts, diagnostics, and optional output path; that envelope is not the TS file.
Compiler warnings remain visible in diagnostics and on stderr in plain mode.
Import success means that ordinary compilation and the structural native JSON
re-import verifier agree; it does not claim native Factorio acceptance or
electrical compatibility. In particular, negative-zero Constant multipliers are
refused when native JSON serialization normalizes `-0` to `0`.

The source examples and provider requirements are in the linked guide. Default
source export is concrete; `--parameters` explicitly requests supported numeric
metadata, including opaque formula fields, without promising native validity.
Source export does not implement compression or alter encode/decode semantics.
Use a plain output file for encode, not a `--json` success envelope.

Decode output is lossless JSON. Under `--json`, stdout is one JSON object with
the raw document embedded as a JSON value, so unsafe number lexemes are retained.
Encode `--json` wraps the exchange string in a JSON object. File outputs are
created exclusively; existing files are never overwritten. A decode input file
may have one terminal LF or CRLF, which is removed before strict framing checks.

Exchange errors use `BEX1001`–`BEX1007` (marker, Base64, budget, capability,
deflate, UTF-8, cancellation). Document errors use `BPD1001`–`BPD1008` (JSON
syntax, duplicate key, Unicode, budget, unsafe node, number lexeme, root shape,
header shape). CLI file/argument errors use `CLIBP1000`–`CLIBP1006`.

## Evidence provenance

`fixtures/blueprint-exchange/manifest.json` distinguishes `self-generated` test
data from `factorio-export` evidence and records logical exchange/document SHA-256
digests, environment/version metadata, and review status. The generated fixture
is internal test material only. A user-supplied export reported as Factorio 2.1.10
pins exchange framing and a lossless document round trip. Its installed mods have
not been independently verified. This does not prove game acceptance of the
re-encoded string or native combinator behavior. Parameter and formula fields
need separate exports from a version that supports them.
