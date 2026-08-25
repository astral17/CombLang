import type { CircuitColor } from './ir.js';

export interface ColorConstraint<Id> {
  readonly left: Id;
  readonly right: Id;
  readonly relation: 'same' | 'different';
  readonly reason?: string;
}

export interface FixedColorConstraint<Id> {
  readonly id: Id;
  readonly color: CircuitColor;
  readonly reason?: string;
}

export class ColorConstraintError<Id> extends Error {
  readonly constraint: ColorConstraint<Id> | FixedColorConstraint<Id>;

  constructor(message: string, constraint: ColorConstraint<Id> | FixedColorConstraint<Id>) {
    super(message);
    this.name = 'ColorConstraintError';
    this.constraint = constraint;
  }
}

interface Root {
  readonly index: number;
  readonly parity: 0 | 1;
}

/**
 * Solves equality and inequality constraints over the two Factorio wire colors.
 * Parity 0 means equal to a DSU parent, parity 1 means opposite.
 */
export function solveCircuitColors<Id>(
  ids: readonly Id[],
  constraints: readonly ColorConstraint<Id>[],
  fixed: readonly FixedColorConstraint<Id>[] = [],
): Map<Id, CircuitColor> {
  const uniqueIds = [...new Set(ids)];
  const indexes = new Map(uniqueIds.map((id, index) => [id, index]));
  const anchor = uniqueIds.length;
  const parent = Array.from({ length: anchor + 1 }, (_, index) => index);
  const rank = Array.from({ length: anchor + 1 }, () => 0);
  const parity = Array.from({ length: anchor + 1 }, () => 0 as 0 | 1);

  const find = (index: number): Root => {
    const directParent = parent[index]!;
    if (directParent === index) return { index, parity: 0 };
    const root = find(directParent);
    parity[index] = (parity[index]! ^ root.parity) as 0 | 1;
    parent[index] = root.index;
    return { index: root.index, parity: parity[index]! };
  };

  const unite = (left: number, right: number, expectedParity: 0 | 1): boolean => {
    let leftRoot = find(left);
    let rightRoot = find(right);
    if (leftRoot.index === rightRoot.index) {
      return (leftRoot.parity ^ rightRoot.parity) === expectedParity;
    }
    if (rank[leftRoot.index]! < rank[rightRoot.index]!) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    parent[rightRoot.index] = leftRoot.index;
    parity[rightRoot.index] = (leftRoot.parity ^ rightRoot.parity ^ expectedParity) as 0 | 1;
    if (rank[leftRoot.index] === rank[rightRoot.index]) rank[leftRoot.index]! += 1;
    return true;
  };

  const indexOf = (id: Id): number => {
    const index = indexes.get(id);
    if (index === undefined) throw new Error('A color constraint references an unknown network.');
    return index;
  };

  for (const constraint of constraints) {
    const expected = constraint.relation === 'same' ? 0 : 1;
    if (!unite(indexOf(constraint.left), indexOf(constraint.right), expected)) {
      throw new ColorConstraintError(
        `Circuit color constraints conflict${constraint.reason ? `: ${constraint.reason}` : '.'}`,
        constraint,
      );
    }
  }
  for (const constraint of fixed) {
    const expected = constraint.color === 'red' ? 0 : 1;
    if (!unite(indexOf(constraint.id), anchor, expected)) {
      throw new ColorConstraintError(
        `Fixed circuit color conflicts${constraint.reason ? `: ${constraint.reason}` : '.'}`,
        constraint,
      );
    }
  }

  const anchorRoot = find(anchor);
  return new Map(
    uniqueIds.map((id) => {
      const root = find(indexOf(id));
      const value = root.index === anchorRoot.index ? root.parity ^ anchorRoot.parity : root.parity;
      return [id, value === 0 ? 'red' : 'green'] as const;
    }),
  );
}
