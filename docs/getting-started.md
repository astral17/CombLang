# Getting started

CombLang currently implements the Phase 3 source compiler and the first Phase 4 ownership slice of a TypeScript-shaped structural HDL for Factorio 2.1 circuit networks. The browser workbench can parse, lower, color, simulate, and generate an early uncompressed blueprint JSON preview for the supported source subset locally. Exchange-string encoding and the verified Phase 8 blueprint codec are not implemented yet.

The executable examples include [`examples/scale/main.factorio.ts`](../examples/scale/main.factorio.ts) for ordinary composition, [`examples/take/main.factorio.ts`](../examples/take/main.factorio.ts) for zero-tick network union, [`examples/borrow/main.factorio.ts`](../examples/borrow/main.factorio.ts) for non-owning function capabilities, and [`examples/move/main.factorio.ts`](../examples/move/main.factorio.ts) for explicit ownership transfer across a call.

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

The CLI `check` command validates TypeScript syntax, runs the non-executing DSL semantic pass, executes compile-time elaboration, and validates the resulting circuit topology and color constraints. Use `--json` for structured diagnostics and the generated producer count. The browser workbench adds the live simulation proof and blueprint preview; it is not required for compiler/runtime validation.

Continue with the [current language reference](language-reference.md) for the exact supported subset.
