# Source-linked schematic editing

Status: future design requirements, not implemented UI or language syntax.
Comment export belongs to the metadata/blueprint work in Phase 8; schematic
navigation and source edits belong to Phase 9, with physical placement constraints
in Phase 10. The current debug index already connects physical producers to source
spans, instance paths, and resolved placement, but is not yet a source-edit plan.

## Shared provenance

One physical combinator must keep its creation origin through instrumentation,
runtime materialization, EG/NCIR, rendering, and blueprint export. Retain file and
source revision, creation expression span, enclosing declaration/attachment,
dynamic call/loop instance path, and the origin of each explicit placement call.
Placement needs its own AST/call/argument spans in addition to evaluated numbers.
These spans must refer to the original TS, not generated JS.

A source line is not an entity ID. One expression may create intermediate
combinators, loop iterations, or repeated function instances. Aliases may instead
refer to the same physical entity. Runtime IDs identify instances within an
execution; do not persist them as stable source-edit keys across compilations.
Cross-revision edits need re-resolved anchors and explicit ambiguity checks.

## Line comments as descriptions

Support automatically carrying associated `//` comments into combinator
descriptions, without treating comment text as executable instructions. Collect
comments from the original source before TS erasure. Define and test attachment
rules for preceding comment blocks and same-line trailing comments; do not simply
copy the nearest comment to every entity on a line.

For a unique producer site, its associated comment can describe every generated
instance, including instances from a loop. Shared text does not make those
instances identical. Several producers on one statement, intermediate arithmetic
nodes, function header comments, and mixed declaration lists need an explicit
association policy before automatic export. Unassociated comments must not be
silently reassigned. Preserve multiline order and readable text; an eventual
explicit description takes precedence over inferred comments.

Descriptions are entity metadata, not circuit signals or executable configuration.
They must not change topology, ticks, or ownership. Show the resulting description
in inspection and verify the appropriate native entity description field through
blueprint round trips before claiming Factorio export compatibility. Treat text as
plain text in the UI. Automatic export also needs a visible opt-out so private
source comments are not unknowingly included in shared blueprints.

## Navigate from a combinator to code

Selecting a rendered combinator should offer navigation to its creation span in
the correct source tab/file. Highlight the exact expression, not just a line
number. Include instance context (function calls and loop iterations); offer the
placement site separately when different. Generated/intermediate combinators
must navigate to their closest actual source origin with a generated-origin label,
not an invented location. Existing debug-index source buttons can provide the
navigation foundation for the future rendered schematic.

If the editor has changed since compilation, recompile or resolve the source
anchor before navigation/editing; never apply stale offsets to another revision
or another tab. Multiple diagram entities may legitimately highlight the same
source expression while remaining separately selectable.

## Dragging and `.at` write-back

Distinguish schematic-only arrangement from physical Factorio coordinates. A
diagram-layout drag must not silently become `.at` or change blueprint positions.
Physical placement mode may offer a source edit on drop, after coordinate-system,
grid, footprint, and direction validation.

Start with the safe subset:

- One editable producer site generates exactly one physical entity, and there
  is a unique placement call with literal coordinates: replace only the coordinate
  AST ranges, retaining direction, comments, and surrounding formatting.
- No placement call: offer inserting `.at(x, y, direction?)` only where the
  receiver is demonstrably the producer/Entity handle. An inferred Network
  variable is not a safe target for appending a producer placement method.
- Variables, arithmetic expressions, spread arguments, shared helpers, several
  `.at` calls, loop/repeated-call sites, multiple physical outputs from one source
  expression, or unresolved provenance: disable automatic write-back and explain
  why. Do not replace a variable reference with a literal or edit its declaration
  because a single instance was dragged.

For ambiguous cases the user may later choose to edit the generator (affecting
all instances) or create an explicit per-instance override. Neither override
syntax nor its stable identity scheme is decided; do not synthesize conditional
code, clone loop bodies, or add hidden layout overrides automatically.

Apply an accepted edit as one revision-checked, undoable editor transaction.
Preview the textual change and its instance impact. Recompile through the normal
pipeline and reconcile the new diagram; compilation failure must remain visible
and the edit reversible. Pointer movement should only preview placement, not
repeatedly rewrite/re-execute source. A rejected/stale edit leaves the source
unchanged. Undo/redo must restore both source and derived diagram, and touch input
must support the same selection/navigation without requiring hover.

## Acceptance cases

- Unique literal `.at`, absent `.at`, explicit direction enum, and negative coordinates.
- Computed positions, mutable coordinate variables, helper-owned placement,
  chained placement, and two entities on one line.
- Loops, repeated function calls, nested expressions, aliases, and moved Networks.
- Preceding/trailing comment blocks, unattached comments, multiple producers,
  explicit-description precedence, and comment export disabled.
- Changed source during drag, changed active tab, failed recompile, undo/redo,
  and touch navigation; none may silently edit the wrong source or instance.

Each case must check physical identity and circuit topology as well as source
text. A visually successful drag alone does not prove safe reverse editing.
