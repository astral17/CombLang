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
```

Decode output is lossless JSON. Under `--json`, stdout is one JSON object with
the raw document embedded as a JSON value, so unsafe number lexemes are retained.
Encode `--json` wraps the exchange string in a JSON object. File outputs are
created exclusively; existing files are never overwritten. A decode input file
may have one terminal LF or CRLF, which is removed before strict framing checks.

Exchange errors use `BEX1001`–`BEX1007` (marker, Base64, budget, capability,
deflate, UTF-8, cancellation). Document errors use `BPD1001`–`BPD1008` (JSON
syntax, duplicate key, Unicode, budget, unsafe node, number lexeme, root shape,
header shape). CLI file/argument errors use `CLIBP1000`–`CLIBP1005`.

## Evidence provenance

`fixtures/blueprint-exchange/manifest.json` distinguishes `self-generated` test
data from `factorio-export` evidence and records logical exchange/document SHA-256
digests, environment/version metadata, and review status. The generated fixture
is internal test material only. A user-supplied export reported as Factorio 2.1.10
pins exchange framing and a lossless document round trip. Its installed mods have
not been independently verified. This does not prove game acceptance of the
re-encoded string or native combinator behavior. Parameter and formula fields
need separate exports from a version that supports them.
