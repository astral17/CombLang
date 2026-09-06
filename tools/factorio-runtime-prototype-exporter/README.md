# Runtime prototype exporter

This is a separate read-only Factorio 2.1 development tool for capturing
runtime-resolved structural prototype facts. It does not share code or output
with the selected-entity circuit observation probe, infer circuit capabilities,
or modify the game. Native execution is still pending.

## Capture

1. Copy this directory to the Factorio user-data `mods` directory as
   `comblang-runtime-prototype-exporter_0.1.0` and enable it in the disposable
   environment being captured.
2. Start or load a disposable save with the exact intended mods and startup
   settings.
3. Run `/comblang-export-prototypes` once from the console.
4. Retain `script-output/comblang/runtime-prototypes.json` together with the
   matching raw `factorio.exe --dump-data` output when one is needed.

Validate and inspect the artifact without converting it:

```powershell
npm run cli -- prototypes runtime-capture script-output/comblang/runtime-prototypes.json
npm run cli -- prototypes runtime-capture --json script-output/comblang/runtime-prototypes.json
```

The command overwrites only its own output artifact so an interrupted old run
cannot be mistaken for a new append. The snapshot contains the exact base/game
version, full active mod set, explicit startup-setting outcomes, collector
version, and hashes of the pinned API schemas used to develop it.

Collections cover items, fluids, recipes, entities, qualities, and recipe
categories. Recipe ingredients/products keep their runtime `item`/`fluid` role,
and `mainProduct` is captured as the resolved Product record. Entity tile width
and height are independent facts from selection/collision geometry. Available
global and per-entity limits are captured explicitly.

Every captured fact is an outcome:

- `value` preserves false, zero, empty arrays, and concrete data;
- `absent` means the runtime getter successfully returned nil;
- `unknown` means the collector deliberately cannot answer without additional
  parameters or context;
- `error` retains a failed getter/normalizer message.

None of these records is automatically a normalized Prototype DB or proof of
native circuit behavior. Inspect and validate a capture before promoting facts.
Until the tool has run in Factorio and a small base snapshot has been reviewed,
its status is **implemented-unverified**.
