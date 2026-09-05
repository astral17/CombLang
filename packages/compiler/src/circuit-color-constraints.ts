import type { CircuitColor } from './ir.js';

export interface ColorConstraintDetails {
  readonly reason?: string;
  readonly provenance?: unknown;
}

export interface ColorConstraint<Id> extends ColorConstraintDetails {
  readonly left: Id;
  readonly right: Id;
  readonly relation: 'same' | 'different';
}

export interface FixedColorConstraint<Id> extends ColorConstraintDetails {
  readonly id: Id;
  readonly color: CircuitColor;
}

export class ColorConstraintError<Id> extends Error {
  readonly constraint: ColorConstraint<Id> | FixedColorConstraint<Id>;

  constructor(message: string, constraint: ColorConstraint<Id> | FixedColorConstraint<Id>) {
    super(message);
    this.name = 'ColorConstraintError';
    this.constraint = constraint;
  }
}

export class UnknownColorConstraintIdError<Id> extends Error {
  readonly id: Id;

  constructor(id: Id) {
    super('A color constraint references an unknown network.');
    this.name = 'UnknownColorConstraintIdError';
    this.id = id;
  }
}

interface Root {
  readonly index: number;
  readonly parity: 0 | 1;
}

/**
 * Incrementally maintains equality and inequality constraints over Factorio's
 * two circuit-wire colors. Parity 0 means equal to a DSU parent and parity 1
 * means opposite.
 */
export class CircuitColorConstraints<Id> {
  readonly #ids: Id[] = [];
  readonly #indexes = new Map<Id, number>();
  readonly #parent: number[] = [0];
  readonly #rank: number[] = [0];
  readonly #parity: (0 | 1)[] = [0];

  add(id: Id): this {
    if (this.#indexes.has(id)) return this;
    const index = this.#ids.length + 1;
    this.#ids.push(id);
    this.#indexes.set(id, index);
    this.#parent.push(index);
    this.#rank.push(0);
    this.#parity.push(0);
    return this;
  }

  same(left: Id, right: Id, details: ColorConstraintDetails = {}): this {
    return this.#constrain(Object.freeze({ ...details, left, right, relation: 'same' as const }));
  }

  different(left: Id, right: Id, details: ColorConstraintDetails = {}): this {
    return this.#constrain(
      Object.freeze({ ...details, left, right, relation: 'different' as const }),
    );
  }

  fix(id: Id, color: CircuitColor, details: ColorConstraintDetails = {}): this {
    const constraint: FixedColorConstraint<Id> = Object.freeze({ ...details, id, color });
    if (!this.#unite(this.#indexOf(id), 0, color === 'red' ? 0 : 1)) {
      throw new ColorConstraintError(
        `Fixed circuit color conflicts${constraint.reason ? `: ${constraint.reason}` : '.'}`,
        constraint,
      );
    }
    return this;
  }

  resolve(): Map<Id, CircuitColor> {
    const anchor = this.#find(0);
    const componentOrientations = new Map<number, 0 | 1>();

    for (let ordinal = 0; ordinal < this.#ids.length; ordinal += 1) {
      const root = this.#find(ordinal + 1);
      if (root.index !== anchor.index && !componentOrientations.has(root.index)) {
        // Iteration follows stable registration order, so the first member is
        // the canonical red member of every unanchored component.
        componentOrientations.set(root.index, root.parity);
      }
    }

    return new Map(
      this.#ids.map((id, ordinal) => {
        const root = this.#find(ordinal + 1);
        const orientation =
          root.index === anchor.index
            ? anchor.parity
            : (componentOrientations.get(root.index) ?? 0);
        return [id, (root.parity ^ orientation) === 0 ? 'red' : 'green'] as const;
      }),
    );
  }

  #constrain(constraint: ColorConstraint<Id>): this {
    const expected = constraint.relation === 'same' ? 0 : 1;
    if (!this.#unite(this.#indexOf(constraint.left), this.#indexOf(constraint.right), expected)) {
      throw new ColorConstraintError(
        `Circuit color constraints conflict${constraint.reason ? `: ${constraint.reason}` : '.'}`,
        constraint,
      );
    }
    return this;
  }

  #indexOf(id: Id): number {
    const index = this.#indexes.get(id);
    if (index === undefined) throw new UnknownColorConstraintIdError(id);
    return index;
  }

  #find(index: number): Root {
    const directParent = this.#parent[index]!;
    if (directParent === index) return { index, parity: 0 };
    const root = this.#find(directParent);
    this.#parity[index] = (this.#parity[index]! ^ root.parity) as 0 | 1;
    this.#parent[index] = root.index;
    return { index: root.index, parity: this.#parity[index]! };
  }

  #unite(left: number, right: number, expectedParity: 0 | 1): boolean {
    let leftRoot = this.#find(left);
    let rightRoot = this.#find(right);
    if (leftRoot.index === rightRoot.index) {
      return (leftRoot.parity ^ rightRoot.parity) === expectedParity;
    }
    if (this.#rank[leftRoot.index]! < this.#rank[rightRoot.index]!) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    this.#parent[rightRoot.index] = leftRoot.index;
    this.#parity[rightRoot.index] = (leftRoot.parity ^ rightRoot.parity ^ expectedParity) as 0 | 1;
    if (this.#rank[leftRoot.index] === this.#rank[rightRoot.index]) {
      this.#rank[leftRoot.index]! += 1;
    }
    return true;
  }
}
