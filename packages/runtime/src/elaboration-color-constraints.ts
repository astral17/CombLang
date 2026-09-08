import {
  CircuitColorConstraints,
  ColorConstraintError,
} from '@comblang/compiler/circuit-color-constraints';
import type {
  DirectPlanProducer,
  PlanArithmeticOperand,
  PlanDeciderCondition,
} from '@comblang/compiler/direct-plan-schema';
import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type { CombinatorDescriptor, NetworkOwnershipState } from './elaboration-values.js';

function networkNames(
  value:
    | { readonly refKind: 'single'; readonly network: string }
    | { readonly refKind: 'pair'; readonly networks: readonly [string, string] },
): readonly string[] {
  return value.refKind === 'single' ? [value.network] : value.networks;
}

function combinatorInputNames(combinator: CombinatorDescriptor): readonly string[] {
  const names: string[] = [];
  const addRef = (value: Parameters<typeof networkNames>[0]) => names.push(...networkNames(value));
  const addOperand = (value: PlanArithmeticOperand) => {
    if (value.kind !== 'constant') addRef(value);
  };
  const addCondition = (condition: PlanDeciderCondition): void => {
    if (condition.kind === 'and' || condition.kind === 'or') {
      for (const child of condition.conditions) addCondition(child);
    } else if (condition.kind === 'compare-signals') {
      addRef(condition.left);
      addRef(condition.right);
    } else {
      addRef(condition);
    }
  };
  const addOutput = (output: Extract<DirectPlanProducer, { kind: 'decider' }>['output']) => {
    if ('refKind' in output) addRef(output);
  };

  if (combinator.kind === 'arithmetic') {
    addOperand(combinator.left);
    addOperand(combinator.right);
  } else if (combinator.kind === 'decider') {
    addCondition(combinator.condition);
    for (const output of combinator.outputs ??
      (combinator.output === undefined ? [] : [combinator.output])) {
      addOutput(output);
    }
    for (const output of combinator.elseOutputs ?? []) addOutput(output);
  }
  return Object.freeze(names);
}

/** Online color validation owned by one executed-source recorder session. */
export class ElaborationColorConstraints {
  #constraints = new CircuitColorConstraints<NetworkOwnershipState>();
  readonly #identities = new Map<string, NetworkOwnershipState>();
  readonly #declarations = new Map<NetworkOwnershipState, { name: string; source: SourceSpan }>();
  readonly #combinatorInputs = new WeakMap<object, Set<NetworkOwnershipState>>();
  #logicalParents = new WeakMap<NetworkOwnershipState, NetworkOwnershipState>();
  readonly #registeredNetworks = new Set<NetworkOwnershipState>();

  registerNetwork(
    identity: NetworkOwnershipState,
    name: string,
    source: SourceSpan,
    fixedColor?: 'red' | 'green',
  ): void {
    this.#registeredNetworks.add(identity);
    this.#constraints.add(identity);
    this.#logicalParents.set(identity, identity);
    this.renameNetwork(identity, name, source);
    if (fixedColor !== undefined) {
      this.#constraints.fix(identity, fixedColor, {
        reason: `Network ${name} has a fixed color`,
        provenance: source,
      });
    }
  }

  /** Returns an isolated copy for topology preflight and rollback snapshots. */
  clone(): ElaborationColorConstraints {
    const copy = new ElaborationColorConstraints();
    copy.#constraints = this.#constraints.clone();
    copy.#identities.clear();
    for (const [name, identity] of this.#identities) copy.#identities.set(name, identity);
    copy.#declarations.clear();
    for (const [identity, declaration] of this.#declarations) {
      copy.#declarations.set(identity, declaration);
    }
    for (const identity of this.#registeredNetworks) {
      copy.#registeredNetworks.add(identity);
      copy.#logicalParents.set(identity, this.#logicalNetworkRoot(identity));
    }
    return copy;
  }

  /** Restores a preflight snapshot without replacing the recorder-owned object. */
  restore(snapshot: ElaborationColorConstraints): void {
    this.#constraints = snapshot.#constraints.clone();
    this.#identities.clear();
    for (const [name, identity] of snapshot.#identities) this.#identities.set(name, identity);
    this.#declarations.clear();
    for (const [identity, declaration] of snapshot.#declarations) {
      this.#declarations.set(identity, declaration);
    }
    this.#registeredNetworks.clear();
    this.#logicalParents = new WeakMap();
    for (const identity of snapshot.#registeredNetworks) {
      this.#registeredNetworks.add(identity);
      this.#logicalParents.set(identity, snapshot.#logicalNetworkRoot(identity));
    }
  }

  renameNetwork(identity: NetworkOwnershipState, name: string, source: SourceSpan): void {
    this.#identities.set(name, identity);
    this.#declarations.set(identity, { name, source });
  }

  requireColor(
    identity: NetworkOwnershipState,
    name: string,
    color: 'red' | 'green',
    source: SourceSpan,
  ): void {
    try {
      this.#constraints.fix(identity, color, {
        reason: `Network ${name} requires ${color}`,
        provenance: source,
      });
    } catch (error) {
      this.#fail(error, source);
    }
  }

  same(
    left: NetworkOwnershipState,
    right: NetworkOwnershipState,
    source: SourceSpan,
    reason: string,
    code?: string,
    message?: string,
  ): void {
    try {
      this.#constraints.same(left, right, { reason, provenance: source });
      this.#unifyLogicalNetworks(left, right);
    } catch (error) {
      this.#fail(error, source, code, message);
    }
  }

  different(
    left: NetworkOwnershipState,
    right: NetworkOwnershipState,
    source: SourceSpan,
    reason: string,
  ): void {
    try {
      this.#constraints.different(left, right, { reason, provenance: source });
    } catch (error) {
      this.#fail(error, source);
    }
  }

  constrainConnector(
    identities: readonly NetworkOwnershipState[],
    source: SourceSpan,
    label: string,
  ): void {
    const distinct: NetworkOwnershipState[] = [];
    for (const identity of identities) {
      if (
        !distinct.some(
          (candidate) => this.#logicalNetworkRoot(candidate) === this.#logicalNetworkRoot(identity),
        )
      ) {
        distinct.push(identity);
      }
    }
    if (distinct.length > 2) {
      throw new ElaborationExecutionError(
        `${label} needs ${distinct.length} logical networks on two wires.`,
        source,
        'RT2009',
      );
    }
    if (distinct.length === 2) {
      this.different(distinct[0]!, distinct[1]!, source, `${label} uses both wire colors`);
    }
  }

  registerCombinatorInputs(
    identity: object,
    descriptor: CombinatorDescriptor,
    source: SourceSpan = descriptor.source,
  ): void {
    const identities = combinatorInputNames(descriptor).map((name) => {
      const identity = this.#identities.get(name);
      if (identity === undefined) {
        throw new ElaborationExecutionError(
          `Combinator input references an unknown Network: ${name}.`,
          source,
          'RT2001',
        );
      }
      return identity;
    });
    const registered = this.#combinatorInputs.get(identity) ?? new Set<NetworkOwnershipState>();
    const combined = [...new Set([...registered, ...identities])];
    this.constrainConnector(combined, source, 'Combinator input connector');
    for (const network of identities) registered.add(network);
    this.#combinatorInputs.set(identity, registered);
  }

  #fail(error: unknown, source: SourceSpan, code = 'RT2010', message?: string): never {
    if (!(error instanceof ColorConstraintError)) throw error;
    const constraint = error.constraint;
    const ids = 'id' in constraint ? [constraint.id] : [constraint.left, constraint.right];
    const related = [...new Set(ids)].flatMap((id) => {
      const declaration = this.#declarations.get(id);
      return declaration === undefined
        ? []
        : [
            {
              message: `Conflicting Network ${declaration.name} is declared here.`,
              span: declaration.source,
            },
          ];
    });
    throw new ElaborationExecutionError(message ?? error.message, source, code, related, {
      cause: error,
    });
  }

  #logicalNetworkRoot(identity: NetworkOwnershipState): NetworkOwnershipState {
    const parent = this.#logicalParents.get(identity);
    if (parent === undefined || parent === identity) return identity;
    const root = this.#logicalNetworkRoot(parent);
    this.#logicalParents.set(identity, root);
    return root;
  }

  #unifyLogicalNetworks(left: NetworkOwnershipState, right: NetworkOwnershipState): void {
    const leftRoot = this.#logicalNetworkRoot(left);
    const rightRoot = this.#logicalNetworkRoot(right);
    if (leftRoot !== rightRoot) this.#logicalParents.set(rightRoot, leftRoot);
  }
}
