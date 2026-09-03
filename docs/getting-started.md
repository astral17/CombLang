# Getting started

CombLang currently implements the source compiler, ownership/multi-network runtime and Phase 5 MVP testbench of a TypeScript-shaped structural HDL for Factorio 2.1 circuit networks. Phase 5.5 adds explicit prototype environments. The browser workbench can parse, lower, color, simulate, and generate an early uncompressed blueprint JSON preview for the supported source subset locally. Exchange-string encoding and the verified Phase 8 blueprint codec are not implemented yet.

The executable examples include [`examples/scale/main.factorio.ts`](../examples/scale/main.factorio.ts) for ordinary composition, [`examples/take/main.factorio.ts`](../examples/take/main.factorio.ts) for zero-tick network union, [`examples/borrow/main.factorio.ts`](../examples/borrow/main.factorio.ts) for non-owning function capabilities, [`examples/move/main.factorio.ts`](../examples/move/main.factorio.ts) for explicit ownership transfer across a call, [`examples/move-slots/main.factorio.ts`](../examples/move-slots/main.factorio.ts) for replacing moved variable/array/object owners, and [`examples/pair/main.factorio.ts`](../examples/pair/main.factorio.ts) for reading both circuit-wire colors through one immutable input view.

## Requirements

- Node.js 22 or newer
- npm 11 or newer

The repository is an npm workspace. No backend or database is required.

## Install and verify

```text
npm install
npm run check
npm run build
```

`npm run check` runs formatting validation, TypeScript type checking, and the complete test suite. `npm run build` produces the CLI and static web application.

## Browser workbench

```text
npm run dev:web
```

Vite prints the local URL. On desktop, CodeMirror provides TypeScript highlighting, folding, search, DSL snippets, and inline parser/compiler diagnostics. Narrow coarse-pointer devices automatically use a native textarea because browser contenteditable editors remain unreliable with some mobile keyboards and IMEs. The Source header can switch modes manually.

Source stays in the browser. Every accepted source revision follows the same path: conservative semantic validation, DSL-sensitive transformation, execution in the persistent time-bounded compiler Worker, elaboration, color checking, simulation, and blueprint generation. The bootstrap static lowerer is only a test oracle and is not a browser fallback.

The current editor value is saved as a versioned tab-local draft on every change and restored after Vite HMR or a full reload. Each browser tab owns an independent draft, so editing one workbench cannot replace the source open in another. Closing a tab ends that tab's draft session. Compilation requests reuse one Worker; edits made while it is busy replace the queued revision rather than downloading and starting another compiler. The Worker is recreated only after a crash or the 1000 ms timeout.

To test from another device on the same local network:

```text
npm run dev:web
```

The production web build uses relative assets so it can later be published under a GitHub Pages project subpath. Its same-origin Service Worker atomically caches the HTML, CSS, main JavaScript, and compiler Worker. After one successful online production visit, the workbench can reload and compile without a server or network connection. Vite development mode deliberately does not register this production cache; an already open development page can still recompile offline because its compiler Worker is persistent.

## Minimal circuit

```ts
const A = Signal('virtual', 'signal-A');

const input = new Network<R>();
const scaled: Network = Each(input) * 2;
const output: Network = IF(scaled[A] > 0, scaled[A]);
```

Every circuit arithmetic operation becomes one physical combinator and one synchronous tick. Typed declarations contextually materialize the producer into the declared Network.

## Constant combinator

```ts
const IRON = Signal('iron-plate');
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');

const constants: Network = CC(50 * IRON, 5 * A, -2 * B);
```

`Signal(name)` uses Factorio's default item type, matching `network[name]`; explicit namespaces still use `Signal(type, name)`. `CC` is a source device with no input connector and repeats its configured values every tick.

## CLI status

```text
npm run cli -- check fixtures/language/scale.ts
```

The CLI `check` command validates TypeScript syntax, runs the non-executing DSL semantic pass, executes compile-time elaboration, and validates the resulting circuit topology and color constraints. Use `--json` for structured diagnostics, the generated producer count, and `capabilityUses`: the executed `Readonly`/`Ref`/`Move` function-boundary audit descriptors with their Network, parameter, optional color requirement, source span, and dynamic instance path. The browser result exposes the same descriptors on `result.plan.capabilityUses`; it also retains `networkPairs` and `networkTransfers`.

The temporary Phase 5 test syntax is also available without starting the web
workbench:

```sh
npm run cli -- test --json main.factorio.ts circuit.test.js
```

`test` first performs the same compiler/runtime validation, then runs every
`test(name, callback)` against a fresh elaboration and session. JSON contains
structured assertion, debug-query, and structural failure data plus each test's
renderer-independent `comblang-trace` document. A compilation error prevents
the test file from executing. Exit status is `1` when compilation or any test
fails, and `2` for usage or file-loading errors.

The browser workbench adds the live simulation proof and blueprint preview, but
is not required for compiler/runtime validation or test execution.

Runnable three-test examples are provided for a
[feedback MemoCell and a synthetic external object](phase-5-acceptance.md).
They need no downloaded prototype database or running Factorio instance.

To normalize Factorio's native prototype dump without starting the game again:

```sh
npm run cli -- prototypes normalize data-raw-dump.json metadata.json prototypes.json
```

The dump omits environment identity data, so the separate metadata file is
mandatory. Its exact format and the currently reported lossy 2.x fields are
documented in [Prototype environment](prototype-environment.md).

Use the resulting normalized database during CLI compilation or testing:

```sh
npm run cli -- check --prototypes prototypes.json --json main.factorio.ts
npm run cli -- test --prototypes prototypes.json --json main.factorio.ts circuit.test.js
```

JSON includes the selected `prototypeEnvironment.identity` and capability coverage.
Add `--prototype-identity "<reported identity>"` to reject a different database.
Missing, invalid or mismatched profiles stop with exit code `2` before source
execution; they never fall back to another profile. Browser file selection is
available in the **Prototype environment** bar above Source; the bundled first-run
profile remains pending. Select a normalized JSON file there; valid data
is cached in IndexedDB and restored on tab reload with its identity pin. **Disable**
clears only this tab's selection, without changing code or tests.

For an offline synthetic smoke test, use
[`examples/prototype-stack`](../examples/prototype-stack/README.md). Its tiny profile
is test data, not a vanilla/Space Age database or Factorio conformance evidence.

Continue with the [current language reference](language-reference.md) for the exact supported subset.
