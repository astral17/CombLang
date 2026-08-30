# Diagnostics

CombLang diagnostics are structured values with a stable code, severity, message, and optional half-open source span. Runtime color conflicts may also include related Network declarations.

## Code families

| Range    | Layer                    | Meaning                                                   |
| -------- | ------------------------ | --------------------------------------------------------- |
| `CL0xxx` | parser                   | source-file and TypeScript syntax diagnostics             |
| `CL1xxx` | source compiler          | unsupported or invalid circuit-language constructs        |
| `CL2xxx` | source compiler warnings | valid lowering that is suspicious but remains checkable   |
| `EX1xxx` | elaboration execution    | transformed JavaScript failure or execution limit         |
| `RT1xxx` | direct-plan boundary     | malformed descriptors or unresolved serialized references |
| `RT2xxx` | elaboration/runtime      | ownership, topology, native-mode, and wire-color failures |

An error prevents a valid direct plan or elaborated circuit. A warning does not; its topology is still checked.

The production CLI and browser first emit definite `CL` diagnostics from the conservative semantic pass, then execute transformed values, and finally report structured `RT` topology diagnostics. General JavaScript failures discovered during execution use `EX1001`; ownership failures retain their `RT2xxx` code, primary span, and related declaration/move spans across both frontends. The bootstrap `compileDirectPlan()` regression oracle has several more specific `CL` codes listed below; those codes describe the failure accurately but are not all guaranteed to appear from the executed CLI path until diagnostic unification is complete.

## Common compiler diagnostics

| Code     | Meaning                                                                   | Typical correction                                                         |
| -------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `CL1001` | unsupported function call shape in the bootstrap compiler                 | use the executed path for ordinary functions or a supported bootstrap form |
| `CL1008` | circuit constant is outside signed int32                                  | keep the literal in `-2147483648..2147483647`                              |
| `CL1010` | circular local binding                                                    | remove the cycle between local `const` bindings                            |
| `CL1014` | unsupported compact `IF` condition or output                              | use a documented Network/signal/wildcard form                              |
| `CL1016` | unknown attachment Network                                                | declare the destination before `+=`                                        |
| `CL1017` | bootstrap path inferred an implicit Network merge/owned copy              | use an alias, a producer, or explicit `destination.take(source)` transfer  |
| `CL1019` | invalid Signal declaration or Network signal selection                    | use `Signal(name)` or `Signal(type, name, quality?)`                       |
| `CL1021` | invalid producer destination set                                          | attach to one or two distinct declared Networks                            |
| `CL1024` | malformed constant-combinator entry                                       | write `CC(int32 * SIGNAL, ...)`                                            |
| `CL1025` | duplicate Signal in one `CC`                                              | combine the value before constructing `CC`                                 |
| `CL1026` | attempted destination-signal rebinding of `CC`                            | let each `CC` entry retain its declared Signal                             |
| `CL1027` | invalid constant-count `EACH` output                                      | use a signed int32 literal multiplied by `EACH`                            |
| `CL1028` | invalid explicit `Each(...)` selection                                    | pass exactly one Network                                                   |
| `CL1029` | `EACH` output used without an Each condition                              | emit a specific Signal for `Any`/`All` conditions                          |
| `CL1030` | invalid wildcard output mode or destination-signal rebinding              | respect native `Everything`/Each restrictions                              |
| `CL1031` | malformed explicit producer output binding                                | write `.as(DECLARED_SIGNAL)`                                               |
| `CL1032` | producer and destination output signals conflict                          | use the same Signal in `.as(...)` and `out[...]`                           |
| `CL1033` | unsupported body in the bootstrap direct-plan compiler                    | use the executed compiler path used by the CLI and web app                 |
| `CL1034` | definite non-producer used on the right side of `Network +=`              | attach `CC`, arithmetic, `IF`, or `when(...).then(...)`                    |
| `CL1035` | malformed `Network` construction or producer placement                    | use `new Network()` or `.at(x, y, direction?)`                             |
| `CL1036` | source is outside the Phase 3 single-file module boundary                 | remove imports, exports, dynamic import, or top-level await                |
| `CL1037` | definite malformed consuming Network transfer                             | write `destination.take(source)`                                           |
| `CL1038` | definite producer attachment through `Readonly<Network>`                  | use an owned Network or a `Ref<Network>` parameter                         |
| `CL1039` | definite attempt to consume a borrowed Network                            | pass owned destination and source values to `.take(...)`                   |
| `CL1040` | definite function escape of a borrowed Network                            | return a producer or an independently owned Network                        |
| `CL1041` | bare `Network` function parameter has ambiguous ownership                 | choose `Readonly<Network>`, `Ref<Network>`, or `Move<Network>`             |
| `CL1042` | definite misuse of immutable `pair(a, b)` input view                      | use pair only for reads; use `to`/`.to` for output fan-out                 |
| `CL1043` | `.as(...)` crosses a function's `Network` return boundary                 | bind the producer output Signal inside the function                        |
| `CL1044` | combinator-handle declaration, assignment, argument, or return mismatches | use a compatible unmaterialized producer of the annotated physical kind    |
| `CL2001` | producer has no user destination                                          | attach it, or keep the warning if intentional                              |
| `EX1001` | transformed elaboration program threw                                     | inspect the execution message and supported executed subset                |
| `EX1002` | compile-time execution exceeded the worker time budget                    | fix an infinite/expensive loop or reduce generated work                    |
| `EX1003` | compile-time generator exceeded its circuit-recording DSL-call limit      | reduce generated circuit work or raise the configured limit                |

## Common runtime diagnostics

| Code     | Meaning                                                           |
| -------- | ----------------------------------------------------------------- |
| `RT1001` | unsupported direct-plan format or version                         |
| `RT1002` | duplicate Network descriptor                                      |
| `RT1003` | producer references an unknown input Network                      |
| `RT1004` | attachment references an unknown destination Network              |
| `RT1005` | a requested named Network does not exist                          |
| `RT1099` | unexpected lower-level failure contained at the result API        |
| `RT2001` | foreign or invalid runtime Network handle                         |
| `RT2002` | unknown or foreign runtime producer handle                        |
| `RT2003` | attachment has no destination                                     |
| `RT2004` | attachment repeats a destination Network                          |
| `RT2005` | output connector has more than two destinations                   |
| `RT2006` | one physical Producer identity was attached through another alias |
| `RT2007` | producer has no destination during elaboration                    |
| `RT2008` | invalid empty native condition group                              |
| `RT2009` | a physical connector needs more than two logical Networks         |
| `RT2010` | red/green color constraints are mutually inconsistent             |
| `RT2011` | transfer references an unknown Network                            |
| `RT2012` | moved Network is used or consumed again                           |
| `RT2013` | Network takes itself or an already unified alias                  |
| `RT2014` | transfer unifies contradictory fixed color requirements           |
| `RT2015` | executed operation exceeds a Network capability                   |
| `RT2016` | mutable/shared borrow overlap or alias access conflicts           |
| `RT2017` | an escaped function borrow is used after its lifetime             |
| `RT2018` | color-qualified borrow conflicts with an existing color           |
| `RT2019` | ownership was dropped or returned without a valid transfer        |
| `RT2020` | pair input is repeated, malformed, or used as ownership/output    |
| `RT2021` | `.as(...)` target crossed a function or materialization boundary  |
| `RT2022` | an executed Producer boundary received a wrong value or kind      |
| `RT2023` | destination Signal conflicts with the physical producer output    |

`tryElaborateDirectPlan()` returns these runtime diagnostics without throwing. `elaborateDirectPlan()` throws `RuntimeDiagnosticError` carrying the same structured value.
