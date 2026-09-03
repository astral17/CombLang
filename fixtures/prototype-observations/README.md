# Synthetic observation format fixture

`synthetic.json` is hand-written test data for the circuit-observation JSONL reader
and CLI. It is **not a Factorio capture** and proves no native capability behavior.
Tests serialize it onto individual JSONL lines, including repeated/mixed-environment
records, and exercise immutable parsing, exact identifier strings, false/absent/error
distinctions, and line-specific failures.

Real captures and their case descriptions belong with the Factorio conformance
evidence once their provenance has been reviewed. Do not rename this synthetic
fixture into a verified game snapshot.
