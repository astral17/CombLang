# Factorio conformance fixtures

This directory documents the boundary for externally sourced static prototype
fixtures. It is not a runtime integration, game runner, or user workflow.

The shipped browser product consumes reviewed, versioned static assets generated
from finalized Factorio data-stage output and pinned local API metadata. The
checked-in Space Age database and its integrity manifest are the first-run source.
For a custom modpack, the user may run the official `factorio.exe --dump-data` with
the desired mods and startup settings, then select the raw dump plus explicit
metadata in the browser or normalize them first with the existing CLI. Custom
profiles need not already be normalized; environment metadata is explicit and
participates in the database identity.

The prototype package and its tests validate normalization, canonical ordering,
schema constraints, identity binding, evidence-manifest references, and byte-level
asset integrity. They do not connect to Factorio and do not turn runtime-only
behavior into a capability claim.

Runtime-only fields, including behavior-level Entity capabilities that are absent
from the static source, remain unknown. Later Phase 6/7 feature slices may add
reviewed static or externally supplied evidence with an explicit identity and
schema; that work must not add a project-owned runtime dependency to the browser.

Simulator tests remain deterministic executable specifications for the implemented
kernel. They are useful for regression coverage, but are not evidence that an
unimplemented Factorio behavior is supported.
