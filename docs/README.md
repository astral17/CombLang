# Documentation

CombLang turns TypeScript-shaped source into Factorio circuit hardware. Start
with the user guides below; you do not need to understand the compiler IR or
replay protocol to write a circuit.

## Start here

1. [Getting started](getting-started.md): run the workbench, compile a complete
   example, inspect its output and run your first test.
2. [Circuit basics](circuit-basics.md): Signals, Networks, combinators, output
   connections, tick delays, functions and loops.
3. [Language reference](language-reference.md): exact syntax and restrictions.
   Examples in the reference may be fragments; the basics guide uses complete
   standalone programs.

## Find a task

For a failing example, start with [Troubleshooting](troubleshooting.md).
It distinguishes intent-preserving corrections, hardware alternatives and
current implementation restrictions.

| I want to…                                | Read                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Select a signal, quality or wire color    | [Signals](language-reference.md#signals), [Networks and colors](language-reference.md#networks-and-colors), [Network selections](language-reference.md#network-selections) |
| Add arithmetic or conditions              | [Arithmetic](api/arithmetic.md), [Decider](api/decider.md)                                                                                                                 |
| Configure Constant sections               | [Constant and Section](api/constant.md)                                                                                                                                    |
| Select or count input Signals             | [Selector](api/selector.md)                                                                                                                                                |
| Connect both output wire colors           | [Output connections](language-reference.md#combinators-and-output-connections)                                                                                             |
| Reuse a circuit-building function         | [Functions](language-reference.md#functions), [ownership and multi-network](ownership-and-multi-network.md)                                                                |
| Create or configure a game entity         | [Entity source API](language-reference.md#provider--and-host-bound-entities), [Blueprint schema catalog](blueprint-schema-catalog.md)                                      |
| Use a custom modpack's prototypes         | [Prototype environment](prototype-environment.md)                                                                                                                          |
| Test signal values and delays             | [Testbench](testbench.md#executable-files), [complete test examples](testbench-acceptance.md)                                                                              |
| Understand an error or warning            | [Diagnostics](diagnostics.md)                                                                                                                                              |
| Export JSON or process an exchange string | [Blueprint JSON](blueprint-json.md), [exchange codec](blueprint-exchange-codec.md)                                                                                         |
| Understand current parameter support      | [Blueprint parameters](native-objects-deciders-and-parameters.md#blueprint-parameter-values)                                                                               |

## API reference

The entity-oriented reference starts with [Signal](api/signal.md),
[Network](api/network.md), [Combinator](api/combinator.md),
[Arithmetic](api/arithmetic.md), [Decider](api/decider.md),
[Constant and Section](api/constant.md), and [Selector](api/selector.md): construction,
operators, methods, return values, capabilities and complete examples.
Other API entries currently remain in the [language reference](language-reference.md);
they have not all been converted to this format yet. Guides teach circuit
building; API pages answer what an operation accepts, returns and changes.

## What the documentation promises

Source-language examples use globals such as `Signal`, `Network`, `CC` and
`when`; do not import packages into a circuit source file. Current source
compilation accepts one synchronous file; local library imports and project
module linking are not implemented yet.

A normal source program, a JavaScript test file and an embedding-host API example
are different contexts. Test files are not operator-transformed: they use
`[[A, 5]]`, not `5 * A`, and `expectSignal`, not circuit indexing. Examples with
`@comblang/...` imports describe application/embedding code, not source to paste
into the editor. Some parameter APIs are host-only and do not yet change the
web's copied blueprint.

Schema-checked Entity configuration does not imply that the Entity is callable
or simulated. A generated blueprint and passing simulator test demonstrate the
implemented model, not verification of every behavior in Factorio. Unsupported
capabilities should remain explicit rather than being inferred from a prototype's
presence in the database.

Track planned features in the repository [roadmap](../README.md#roadmap), not in
the runnable guides.

## Compiler and embedding documentation

These pages explain implementation contracts. They are not prerequisites for
ordinary circuit authoring.

- [Architecture](architecture.md), [compile-time JavaScript](compile-time-javascript.md)
  and [security model](security-model.md).
- [Elaboration transform](elaboration-transform.md), [Direct Plan schema](direct-plan-schema.md)
  and [Entity pipeline](entity-pipeline.md).
- [Combinator value policy](producer-materialization-policy.md), [returned ownership](return-ownership.md)
  and [debug index](debug-index.md).
- [Object test adapters](object-test-adapters.md), [graph metrics](circuit-graph-metrics.md)
  and [source-linked schematic editing](source-linked-schematic.md).
- [Prototype evidence boundaries](prototype-truth-sources.md) and
  [pinned Factorio API inputs](../tools/factorio-api/README.md).

Return to [getting started](getting-started.md) when you just want to build a circuit.
