# Prototype-driven stack example

`prototypes.synthetic.json` deliberately contains only one synthetic item. It is
an offline loader/test fixture, not a complete or game-verified Factorio database.

From the repository root:

```sh
npm run cli -- test --prototypes examples/prototype-stack/prototypes.synthetic.json examples/prototype-stack/main.factorio.ts examples/prototype-stack/circuit.test.js
```

Or use the checked-in project file, which contains these relative paths and pins
the synthetic database's content identity:

```sh
npm run cli -- test --project examples/prototype-stack/comblang.json
```

In the browser, choose this JSON with **Load normalized JSON**, then copy the source
and test into their editors. The constant combinator emits `iron-plate: 100` after
one tick. Reloading the page restores the validated profile without changing either
editor. **Disable** removes this tab's selection; source using `prototypes` then
reports `EX1004` until a profile is loaded again.
