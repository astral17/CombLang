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
import type { NetworkOwnershipState, ProducerValue } from './elaboration-values.js';

function networkNames(
  value:
    | { readonly refKind: 'single'; readonly network: string }
    | { readonly refKind: 'pair'; readonly networks: readonly [string, string] },
): readonly string[] {
  return value.refKind === 'single' ? [value.network] : value.networks;
}

function producerInputNames(producer: ProducerValue['producer']): readonly string[] {
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

  if (producer.kind === 'arithmetic') {
    addOperand(producer.left);
    addOperand(producer.right);
  } else if (producer.kind === 'decider') {
    addCondition(producer.condition);
    for (const output of producer.outputs ?? [producer.output]) addOutput(output);
    for (const output of producer.elseOutputs ?? []) addOutput(output);
  }
  return Object.freeze(names);
}

/** Online color validation owned by one executed-source recorder session. */
export class ElaborationColorConstraints {
  readonly #constraints = new CircuitColorConstraints<NetworkOwnershipState>();
  readonly #identities = new Map<string, NetworkOwnershipState>();
  readonly #declarations = new Map<NetworkOwnershipState, { name: string; source: SourceSpan }>();
  readonly #registeredProducers = new WeakSet<object>();

  registerNetwork(
    identity: NetworkOwnershipState,
    name: string,
    source: SourceSpan,
    fixedColor?: 'red' | 'green',
  ): void {
    this.#constraints.add(identity);
    this.renameNetwork(identity, name, source);
    if (fixedColor !== undefined) {
      this.#constraints.fix(identity, fixedColor, {
        reason: `Network ${name} has a fixed color`,
        provenance: source,
      });
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
    const distinct = [...new Set(identities)];
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

  registerProducerInputs(value: ProducerValue): void {
    if (this.#registeredProducers.has(value.identity)) return;
    const identities = producerInputNames(value.producer).map((name) => {
      const identity = this.#identities.get(name);
      if (identity === undefined) {
        throw new ElaborationExecutionError(
          `Producer input references an unknown Network: ${name}.`,
          value.producer.source,
          'RT2001',
        );
      }
      return identity;
    });
    this.constrainConnector(identities, value.producer.source, 'Producer input connector');
    this.#registeredProducers.add(value.identity);
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
}
