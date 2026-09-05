import {
  CircuitColorConstraints,
  type ColorConstraint,
  type FixedColorConstraint,
} from './circuit-color-constraints.js';
import type { CircuitColor } from './ir.js';

export {
  ColorConstraintError,
  type ColorConstraint,
  type FixedColorConstraint,
} from './circuit-color-constraints.js';

/**
 * Solves equality and inequality constraints over the two Factorio wire colors.
 * Parity 0 means equal to a DSU parent, parity 1 means opposite.
 */
export function solveCircuitColors<Id>(
  ids: readonly Id[],
  constraints: readonly ColorConstraint<Id>[],
  fixed: readonly FixedColorConstraint<Id>[] = [],
): Map<Id, CircuitColor> {
  const engine = new CircuitColorConstraints<Id>();
  for (const id of ids) engine.add(id);
  for (const constraint of constraints) {
    if (constraint.relation === 'same') {
      engine.same(constraint.left, constraint.right, constraint);
    } else {
      engine.different(constraint.left, constraint.right, constraint);
    }
  }
  for (const constraint of fixed) {
    engine.fix(constraint.id, constraint.color, constraint);
  }
  return engine.resolve();
}
