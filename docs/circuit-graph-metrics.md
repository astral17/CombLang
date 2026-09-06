# Circuit graph metrics

`analyzeCircuitGraph` computes structural timing facts from resolved NCIR. It does
not inspect source declaration order and does not predict when an arbitrary
feedback circuit settles.

## Dependency graph

A directed Producer edge exists when a Network written by the first Producer is
a semantic input of the second. Inputs come from the shared
`producerInputNetworkIds` traversal, including both members of a pair, nested
Decider conditions, copied output inputs, and else-output inputs. Every driver of
a Network contributes an edge. Zero-tick source aliases have already become one
physical Network ID in NCIR.

The analyzer finds strongly connected components iteratively, so large generated
circuits do not depend on JavaScript recursion depth. A component containing more
than one Producer, or a singleton with a self-edge, is reported as feedback.

## Depth and latency

For an acyclic circuit, `depth` is the maximum predecessor arrival plus each
device's declared latency. It is independent of Producer serialization order and
includes the longest branch anywhere in the circuit.

For a circuit with feedback, SCCs are condensed into a DAG. A feedback component
contributes the maximum declared latency of one member once. The resulting depth
is useful as a structural component-depth indicator, but it is explicitly not a
settle time or a bound on repeated circulation through the loop. Feedback SCCs
are always reported separately.

Arithmetic, Decider, and Constant combinators currently have a declared latency
of one committed simulator tick. The default resolver enumerates those supported
kinds rather than assigning one tick to every future entity. A caller may supply
a different resolver; `undefined` marks an unmodelled latency and propagates to
the global depth while remaining distinct from feedback. Invalid negative or
non-integer latencies are rejected.

The browser proof displays graph depth, feedback SCC count, and whether all device
latencies are known as separate values. Its default short preview may use depth
as a tick horizon, but does not label that horizon as convergence.
