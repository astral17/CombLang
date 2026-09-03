# Phase 5 acceptance

Phase 5's MVP testbench acceptance is complete, including caller-binding queries
for existing Networks returned by functions. The runnable examples and layered
checks below define this boundary; they do not claim native Factorio conformance.

## Run without a browser or downloads

From the repository root, with the existing dependencies installed:

```sh
npm run cli -- test examples/testbench-memo/main.factorio.ts examples/testbench-memo/circuit.test.js
npm run cli -- test examples/testbench-object/main.factorio.ts examples/testbench-object/circuit.test.js
```

Each example has three passing test bodies. Add `--json` immediately after
`test` to inspect structured results, per-test traces and debug documents.
To avoid rebuilding the CLI for every invocation, build it once with
`npm run build --workspace @comblang/cli`, then run
`node apps/cli/dist/main.js test ...` with the same arguments.

In the current browser workbench, copy an example's `main.factorio.ts` into
**Source** and its `circuit.test.js` into **Tests**. No example-loading UI or
automatic replacement of existing drafts is introduced. **View trace** shows
that result's history; source inspection uses the same execution's debug data.

## MemoCell

[Circuit](../examples/testbench-memo/main.factorio.ts) and
[tests](../examples/testbench-memo/circuit.test.js) use two independent calls of
the feedback function. Each call creates an arithmetic copy and a conditional
feedback combinator, sharing their two destination Networks.

The program verifies:

- all-zero `T0`, a one-boundary input pulse, and the extra combinator tick before
  the output changes;
- retained ordinary and rare-quality signal-A values without conflating them;
- a scheduled replacement followed by clearing external input and bounded settling;
- separate `function MemoCell` / `function MemoCell #2` debug scopes and memory;
- physical producer counts and one-tick structural input-to-memory latency;
- replay through the quiet tail after the last signal change.

The tests access the returned Networks through `network('output')` and
`network('secondOutput')`, and inspect each cell's `mem` through its exact callee
debug scope. Caller aliases and callee declarations share physical identity.

## Synthetic object and pipeline

[Circuit](../examples/testbench-object/main.factorio.ts) and
[tests](../examples/testbench-object/circuit.test.js) wire an external sensor to
two arithmetic stages and a separately gated Decider output. A test-only
`acceptance-probe` adapter maps a command input and sensor output; it is not an
implementation of a native Factorio entity.

The program verifies:

- strict unmodeled output becomes Unknown at `T1`, reaches the first arithmetic
  stage at `T2`, and the second at `T3`;
- a known-false Decider branch remains known despite an inactive Unknown input;
- mock replacement and external-drive aggregation, with isolated object-output
  traces distinct from the total Network value;
- clearing a mock/model restores strict Unknown, rather than silently emitting zero;
- a reactive accumulator reads snapshot `T` and publishes state/output together
  at `T+1`; downstream stages retain their own delays;
- both object input and isolated output observations appear in the shared trace.

## Automated coverage

| Layer                                                            | Evidence                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Clock, scheduling, pulses, settling and assertions               | `packages/simulator/src/test-session.test.ts`                                                   |
| Whole-bus lattice and synchronous value kernel                   | `packages/simulator/src/bus-value.test.ts`, `value-kernel.test.ts`, `combinator-device.test.ts` |
| Object defaults, providers, atomic state, identity and lifecycle | `packages/simulator/src/object-adapter.test.ts`                                                 |
| Sparse history, quality, Unknown and replay validation           | `packages/simulator/src/trace.test.ts`, `trace-reader.test.ts`                                  |
| Call/loop hierarchy, captures and structural queries             | `packages/runtime/src/debug-index.test.ts`, `debug-structure.test.ts`, `debug-document.test.ts` |
| Real example execution and identical Node/browser results        | `apps/web/src/testbench-acceptance.test.ts`                                                     |
| File loading, exit status and JSON transport                     | `apps/cli/src/main.test.ts`                                                                     |

The acceptance harness compiles the checked-in source files, runs the unchanged
test files through the runtime and browser adapters, and compares their portable
results. It checks that the plan and rebuilt graph remain unchanged. It also
replays histories through the browser table model and checks exact tick values,
quality columns and isolated object observations. These are headless browser-model
checks, not new interactive DOM or mobile checks.

Negative cases additionally verify an unmodeled-object assertion's test-file
line and full physical dependency chain, and non-converging feedback that exhausts
`settle({ maxTicks: 6 })` while retaining snapshots `T0` through `T6`.

```sh
npm test -- apps/web/src/testbench-acceptance.test.ts apps/cli/src/main.test.ts
npm run check
```

## Caller-binding regression

An ordinary passing acceptance test requires this to succeed:

```js
test('caller binding', ({ network, session }) => {
  session.trace(network('output'));
});
```

The direct plan retains serializable logical aliases without introducing another
physical Network or Producer. The acceptance test checks shared identity and an
unchanged graph. Runtime regressions additionally cover repeated calls, readonly
returns, caller/callee name collisions, reassignment from loops and closures,
ambiguous exact-scope queries, and moved-alias rejection. Trace labels prefer
non-moved root bindings, so the returned Network appears as `output`, not only `out`.

See [debug-index.md](debug-index.md) for the exact alias snapshot contract and
limits on reflecting arbitrary JavaScript containers or uninitialized variables.

## Later-phase work

The callback spelling remains provisional by design. Hardened sandboxing,
native Factorio conformance, richer object state, and the final schematic UI
are later-phase work, not implicit promises made by these examples.
