# Runtime prototype capture fixtures

`synthetic.json` exercises the transport and parser only. It deliberately
contains explicit false, an empty recipe output, absent, unknown, and error
outcomes, plus an entity whose runtime tile size is 2×3 while its selection box
is 10×10. It was not produced by Factorio and is not native evidence.

Reviewed native captures will live in environment-specific subdirectories with
their exact game/mod/startup-setting provenance and matching raw dump metadata.
Do not replace this fixture with an unreviewed game output or infer circuit
capabilities from a successful structural read.
