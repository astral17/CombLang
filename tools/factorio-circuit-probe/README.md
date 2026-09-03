# Circuit observation probe

Development collector for Factorio 2.1.16 or newer 2.1 builds. Its API calls have
been checked against the local 2.1.16 documentation. **It has not yet been run in
Factorio.** Automated repository checks cover the JSONL reader, CLI, and static
package guards, not native Lua execution or game behavior.

## Install and capture

1. Copy this directory into the Factorio user-data `mods` directory, naming the
   copied directory `comblang-circuit-probe_0.1.0`. It must contain `info.json` and
   `control.lua` directly, not an extra nested folder. Enable the mod in Factorio.
2. Use a disposable test save or a copy of a save. Keep the intended base / Space
   Age / modded configuration and startup settings. Loading with an additional mod
   can affect other mods even though this collector has no data-stage scripts.
3. Place/configure the entity you want to investigate. Hover it so that it is
   selected, open the console and run `/comblang-probe assembler-set-recipe-off`.
   The optional text after the command is a case label, not a file path.
4. If investigating a configuration difference, change it explicitly in the game
   UI, select the entity again, and capture another label, for example
   `/comblang-probe assembler-set-recipe-on`. Keep both observations.
5. Collect `script-output/comblang/circuit-observations.jsonl` from that player's
   Factorio user-data directory. Every command appends one JSON object on one line.
   Repeating a command on the same tick does not overwrite the previous sample.

The command only reads the **selected existing entity**. It does not scan the map,
create entities, create a missing control behavior, modify configuration, advance
ticks, or install tick handlers. A missing selection produces a message, not a
sample. Server-console/RCON capture is not supported; a player is required. The
file is written only for the invoking player in multiplayer.

## Inspect offline

From the CombLang repository:

```powershell
npm run cli -- prototypes observations path/to/circuit-observations.jsonl
npm run cli -- prototypes observations --json path/to/circuit-observations.jsonl
```

The text view reports sample labels and read outcomes. JSON returns complete
validated observations, not a normalized Prototype DB or circuit supplement.
Malformed/truncated samples fail with `PO1001`, their JSONL line, and field path;
the reader does not silently skip them. Blank lines and CRLF are accepted.

To compare captured provenance with a selected normalized database:

```powershell
npm run cli -- prototypes compare-observations --json prototypes.json path/to/circuit-observations.jsonl
```

This checks game version, the entire mod set (including the collector), startup
setting values and entity key/type. The database must have explicit
`environment.startupSettings` values and entity coverage for a match; missing
values yield `unverified`, not a match. An identity label alone is insufficient.
The CLI returns 0 for match, 1 for mismatch/unverified, and 2 for malformed input.
It reports original JSONL lines and never modifies the capture or database.
Matching declared provenance does not certify native circuit behavior.

Captures include:

- exact active mod names/versions, including this collector;
- the base mod version as `factorioVersion` and the collector version;
- all startup setting values, including color settings;
- case label, tick, player, entity key/type, optional unit number, surface and position;
- presence/error of `get_control_behavior()` and observations of an explicit
  allowlist of fields, including concrete class name and control-behavior type.

Review settings and labels before sharing the file. The collector does not omit
itself from the mod list or claim compatibility with a previously generated dump.
For conformance work, retain a dump and metadata from the same enabled mod/settings
environment. The JSONL reader preserves separate records from different sessions
or environments; it does not merge them or compare them to a database identity.

## What a snapshot does not prove

`status: "value", value: false` means a field currently reads false, not that the
feature is unsupported. `absent` means nil, and `error` means the getter failed.
Unexpected non-scalar values are recorded as `unexpected-type`. Missing behaviors
remain `absent`: the collector deliberately does not call
`get_or_create_control_behavior()` to materialize one.

The field list is not an exhaustive model of every control-behavior class. An
unobserved field is unknown. Successful reads do not prove setter acceptance,
actual wire input/output, timing, or mode interactions. No capability booleans are
inferred, and these observations cannot be passed to `prototypes supplement`.

Next conformance work must pair relevant snapshots with actual native behavior
tests, blueprint/configuration exports and expected signals/ticks. Only reviewed
results should become explicit identity-bound circuit supplements. Probe runs
that fail to create/find/configure a test case must not become all-false records.
