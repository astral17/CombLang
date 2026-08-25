# Factorio conformance fixtures

This directory separates verified Factorio behavior from provisional simulator choices.

Current authoritative inputs:

- Factorio Runtime API 2.1.16 / API version 6 as the recorded API baseline;
- official Factorio Wiki descriptions for arithmetic, decider, and wildcard behavior;
- structural invariants in the project architecture documents.

The runtime API fixes the exact configuration shapes and defaults, but does not define every numerical edge case. Before Phase 1 is called conformance-complete, generated in-game snapshots must cover at least:

- division and modulo by zero;
- negative exponent behavior and large exponent overflow;
- shift counts outside `0..31`;
- exact Factoriopedia precedence for `Anything` output;
- mixed AND/OR native condition-list precedence;
- `Each` candidate sets across independently selected red/green masks;
- `Each`, `Anything`, and `Everything` output copy/constant modes;
- normal and else outputs in the same decider;
- quality-sensitive signal identity.

Tests in `packages/simulator` are deterministic executable specifications. Cases listed above remain provisional until paired with captured Factorio 2.1 fixtures.
