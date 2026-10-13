# Import a blueprint as editable source

Blueprint source import turns one supported native blueprint JSON document—or
its Factorio exchange string—into literal CombLang source. The result is
verified by ordinary source compilation and a structural native-JSON round trip
before it can replace the source editor. Import is intentionally narrower than
the full blueprint format: unsupported or unknown fields are refusals, not data
that the importer silently strips.

## Web workbench

1. Under **Prototype environment**, wait for the selected environment to be
   validated. The workbench selects the bundled environment by default; use
   **Load prototype JSON** for a different modpack. The importer needs a trusted
   exact profile for each canonical device family in the blueprint.
2. Paste one blueprint JSON document or one unwrapped Factorio exchange string
   into **Paste blueprint JSON or a Factorio exchange string**. Do not add a
   code fence or alter the exchange marker and payload.
3. Choose **Convert to source**. The panel displays only a verified generated
   TypeScript preview. Refusals show the native JSON field path and, where
   available, a separate generated-source location; blocked imports have no
   partial source to apply.
4. Review the preview, then choose **Replace source…** and accept the separate
   confirmation. Only then does the workbench replace the current source editor
   contents. It compiles that source through the normal workbench path; the
   circuit test draft is left unchanged.

Source and test drafts are stored independently per browser tab and survive a
reload when tab storage is available. The pasted import input and its one-use
verified preview are not saved as either draft. Editing the input or source,
changing the selected prototype profile, or losing/restarting the compiler
Worker invalidates the preview; convert again before replacing the source.

Conversion verification, applying the preview, and Factorio compatibility are
different things. Verification means that the generated source compiles in the
selected environment and agrees with the imported JSON for the supported
structural subset. Applying is a separate, confirmed editor replacement.
Neither operation runs Factorio or proves native game acceptance, electrical
behavior, or exact physical wire-edge fidelity.

## CLI import

The CLI accepts exactly one UTF-8 file containing a blueprint JSON document or
a Factorio exchange string:

```sh
node apps/cli/dist/main.js blueprint import [--json] [--output <source.factorio.ts>] [--prototypes <database.json>] [--prototype-identity <id>] <blueprint-file>
```

For example, import an existing JSON file or a file containing the exchange
string into a new source file, then check that file in the same prototype
environment:

```sh
node apps/cli/dist/main.js blueprint import --prototypes database.json --output imported.factorio.ts blueprint.json
node apps/cli/dist/main.js check --prototypes database.json imported.factorio.ts
node apps/cli/dist/main.js blueprint import --prototypes database.json --output imported-exchange.factorio.ts blueprint.exchange
node apps/cli/dist/main.js check --prototypes database.json imported-exchange.factorio.ts
```

Add the same `--prototype-identity <id>` to both commands when pinning an
identity. The selected trusted Entity replay context must contain exactly one
profile for the exact base key of each imported family. A modded same-type name,
missing profile, or ambiguous profile is not a substitute.

Without `--output`, plain mode writes only generated source to stdout and does
not create a file. Its reported source path is virtual; it is based on the
resolved input path with `.factorio.ts` appended. With `--output`, the CLI
resolves that destination path and creates it exclusively, so an existing file
is never replaced. On success, `--json` writes one report envelope containing
`ok`, the source snapshot, correspondence, verification counts, diagnostics,
and (when `--output` was used) the output path. On failure it reports the error
and diagnostics without a source snapshot. The envelope is a report, not a
source file; do not pass it to `check`.

Native JSON diagnostics keep paths such as
`$.blueprint.entities[0].control_behavior.operation`. A related generated-source
location is reported separately when one exists; a virtual source path does not
mean that a file was written. A refused or failed import never publishes
partial generated source. When importing a Factorio exchange file, the CLI
removes at most one final LF or CRLF before strict exchange decoding. It
otherwise examines the untouched first character: only a leading `0` selects
exchange mode. JSON text is passed unchanged. In the web workbench the pasted
text is passed unchanged, including any terminal newline, so paste an exchange
string verbatim without wrapping or adding a newline. A malformed exchange
string is not retried as JSON.

## Supported source subset

The importer supports these four exact canonical device names and reconstructs
only fields represented by the current CombLang source constructors. The links
describe the source APIs; they do not imply that every field of the native
blueprint format can be reconstructed.

| Family                          | Imported form and important limits                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Constant](api/constant.md)     | Native `constant-combinator` / trusted key `entity:constant-combinator`. Explicit `is_on` and ordered `sections.sections`; section and filter indices must be contiguous and 1-based. Section active/group/multiplier and ordered filters are retained. Each filter needs a concrete Signal quality; an omitted Signal `type` is accepted as `item`.                                                                         |
| [Arithmetic](api/arithmetic.md) | Native `arithmetic-combinator` / trusted key `entity:arithmetic-combinator`. Explicit `arithmetic_conditions`, a supported operation/operand pair/output, and explicit red/green masks for Signal operands. Constant operands have no mask; unknown fields and unrepresented configuration are refused.                                                                                                                      |
| [Decider](api/decider.md)       | Native `decider-combinator` / trusted key `entity:decider-combinator`. Explicit ordered condition groups, true-output rows, and supported else-output rows. Signal input masks and copied-count output masks must be explicit; constant operands/outputs cannot carry masks. An empty explicit else branch or a configuration with no output rows is refused. A constant-count wildcard output is supported only for `Each`. |
| [Selector](api/selector.md)     | Native `selector-combinator` / trusted key `entity:selector-combinator`. Only explicit `operation: "select"` and `operation: "count"`. Select requires explicit `select_max` and exactly one of `index_constant` or `index_signal`; Count requires `count_signal`. Newer operations and unknown/cross-operation fields are refused.                                                                                          |

Arithmetic recognizes only the explicit native operators `+`, `-`, `*`, `/`,
`%`, `^`, `<<`, `>>`, `AND`, `OR`, and `XOR`.

Every entity needs an explicit exactly representable x/y position and direction
integer from 0 through 15. Placement objects with extra coordinates are outside
the subset. Wires must use the supported top-level four-value tuples
`[entity_number, connector, entity_number, connector]`, with endpoints that the
selected canonical profile can resolve. Legacy per-entity connections,
object-shaped wire data, unknown outer fields, partial entity inventories, and
unrepresentable edges are not silently discarded. Import does not promise to
preserve every original wire edge or document metadata; retained-only metadata
notices do not mean that metadata appears in source.

Signal `type` can be omitted for item Signals and defaults to `item`; this is
not, by itself, an import error. Explicit concrete qualities are retained where
the family accepts them. Constant filters require an explicit quality.
Wildcards, family-specific masks, and defaults remain subject to the exact
decoder rules above: do not infer support from a field merely being present in a
Factorio schema. Some negative-zero values cannot round-trip through native JSON
serialization—for example Constant multipliers, Decider constants, and numeric
Selector indices—and are refused rather than normalized to zero.

Books, upgrade planners, and deconstruction planners may be handled as opaque
documents by the exchange codec, but they are not source-import roots. The
structural `Entity` API, a modded prototype with a familiar device type, and a
new Selector operation do not become source-importable just because a schema or
prototype entry exists. Selector input red and green lanes are represented
separately even when one or both are unwired; configured isolated devices are
also allowed and can produce an unused-output warning. Only represented wire
tuples attach outputs in the reconstructed source. These are structural
reconstruction rules, not claims about native electrical behavior.

## Minimal supported document

This complete, uncompressed blueprint JSON document contains one configured
but unwired Constant. An empty wire list is valid here: configuration and
placement can be reconstructed without inventing a connection. The source
compiler may warn that the Constant output is unused; that warning does not
remove the device.

```json
{
  "blueprint": {
    "entities": [
      {
        "entity_number": 1,
        "name": "constant-combinator",
        "position": { "x": 0, "y": 0 },
        "direction": 0,
        "control_behavior": {
          "is_on": true,
          "sections": {
            "sections": [
              {
                "index": 1,
                "active": true,
                "multiplier": 1,
                "filters": [
                  {
                    "index": 1,
                    "name": "signal-A",
                    "type": "virtual",
                    "quality": "normal",
                    "comparator": "=",
                    "count": 5
                  }
                ]
              }
            ]
          }
        }
      }
    ],
    "wires": []
  }
}
```

### Generated source

This is the exact generated CombLang source for the JSON above, not native
Factorio JSON:

<!-- prettier-ignore -->
```ts
const import_network_1 = new Network<R>();
const import_network_2 = new Network<G>();
const import_entity_1 = Constant({isOn:true,sections:[{active:true,multiplier:1,filters:[{signal:Signal("virtual","signal-A","normal"),value:5}]}]});
import_entity_1.at(0,0,0);
```

The example is structurally checked by the runtime's ordinary import pipeline
using a synthetic trusted Constant profile. It demonstrates the documented
source reconstruction path only; it is not a native Factorio compatibility
test.

## When a supported root is refused

A `blueprint` root is not enough: the current import subset must represent every
field that affects the reconstructed device. For example,
`$.blueprint.entities[0].control_behavior.select_highest_quality` is outside the
supported Selector Select/Count fields. Read the reported native path and the
family limits above, keep the original blueprint intact, and choose a source
representation only if it preserves the intended behavior. Do not make the
import pass by silently deleting an unknown or unsupported semantic field.

For exchange framing, lossless JSON rules, and codec error codes, see the
[blueprint exchange codec](blueprint-exchange-codec.md). For authoring the
constructors, see the linked [Constant](api/constant.md),
[Arithmetic](api/arithmetic.md), [Decider](api/decider.md), and
[Selector](api/selector.md) references.
