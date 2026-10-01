# Getting started

[Documentation](README.md) · [Circuit basics](circuit-basics.md) · [Language reference](language-reference.md)

CombLang builds Factorio circuit hardware from TypeScript-shaped source. The
workbench compiles locally in your browser, lets you test signal values over
ticks, and produces blueprint JSON. No backend or project-owned Factorio mod
is required.

## Run the workbench

For a local checkout, install Node.js 22+ and npm 11+, then run from the
repository root:

```sh
npm install
npm run dev:web
```

Installation needs network access unless dependencies are already available;
you do not need to reinstall them on every run. Open the URL printed by Vite
(normally `http://localhost:5173/`). The development server listens on `0.0.0.0`
and uses a fixed port, so another device on your local network can use your
computer's LAN address with port 5173. Do not start another server when that
port is already in use.

## Compile your first circuit

Replace the Source editor contents with this complete program:

```ts
const A = Signal('virtual', 'signal-A');
const input = CC(5 * A);
const output = new Network();
output[A] += input[A] * 2 + 1;
```

You should get three combinators: one Constant and two arithmetic stages. Source
changes trigger compilation automatically. Diagnostics link back to the source;
the generated-JavaScript panel shows how the source is executed, and the
blueprint panel shows the exported document. **Copy blueprint** copies the
current readable JSON, not a compressed Factorio exchange string.

In the simulation controls, advance three ticks: A on `output` should be 11.
All Networks start empty at T0. The Constant emits 5 at T1, multiplication
emits 10 at T2 and addition emits 11 at T3. Source execution builds the circuit;
it does not run a simulation tick for each source statement.

## Run a first test

Keep that circuit in Source and put the following in the test editor:

```js
test('scales A after three ticks', ({ network, tick, expectSignal }) => {
  const A = Signal('virtual', 'signal-A');
  const output = network('output');
  expectSignal(output, A).toBe(0);
  tick(3);
  expectSignal(output, A).toBe(11);
});
```

Run the test with the workbench's test controls. Each test gets a fresh
circuit/session. The test file is ordinary synchronous JavaScript, not the
operator-transformed circuit DSL. Use the test API to read/write signals;
do not paste circuit expressions such as `5 * A` into test drives.
Continue with the [testbench reference](testbench.md#executable-files) for
external inputs, assertions, traces and failures.

## Save, reload and use a phone

Source and test drafts are independent per browser tab and survive reloads.
Closing the tab ends its draft session; keep important code in files as well.
On desktop the workbench uses CodeMirror. Narrow coarse-pointer devices use a
native textarea to avoid mobile keyboard/IME issues; the Source header can
switch editor mode manually.

A production web build caches the application for offline use after a
successful initial load. Development mode does not install that production
cache; an already open development page can recompile offline while its
compiler Worker remains alive. A page not loaded/cached before going offline
cannot fetch missing assets. A later deployment can use static hosting such
as GitHub Pages; no server-side compiler is needed.

## Check a circuit without the browser

Save the circuit as `main.factorio.ts` and the test as `circuit.test.js`:

```sh
npm run cli -- check main.factorio.ts
npm run cli -- test main.factorio.ts circuit.test.js
```

Add `--json` for machine-readable results. The browser is not required for
compiler or simulator validation. The current circuit source is one synchronous
file; imports and multi-file libraries are not supported yet.

## Prototypes and entities

The browser offers bundled Base + Space Age prototype data. Ordinary circuit
examples above do not require a custom database. For other modpacks you may
provide the output of Factorio's `--dump-data` together with matching environment
metadata. Read [Prototype environment](prototype-environment.md) for exact
import/normalization steps, CLI selection and metadata requirements.

Configuring an Entity does not automatically make it callable or simulated.
Read the [Entity API](language-reference.md#provider--and-host-bound-entities)
for capability limits. Passing simulator tests or producing JSON is not proof
that every native Factorio behavior has been verified.

## Next steps

- Learn the circuit-building model in [Circuit basics](circuit-basics.md).
- Look up exact syntax in [Language reference](language-reference.md).
- Browse [complete examples](../examples) or the [documentation index](README.md).
- For repository development, `npm run check` validates formatting, types,
  catalogs, prototype integrity and tests; `npm run build` builds CLI and static
  web assets. Neither command is required after every editor change.
