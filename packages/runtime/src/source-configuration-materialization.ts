import type { EntityPlanConfiguration } from '@comblang/compiler/entity';
import type {
  DirectElaborationPlan,
  DirectPlanArithmetic,
  DirectPlanDecider,
  DirectPlanProducer,
  PlanArithmeticOperand,
  PlanDeciderCondition,
} from '@comblang/compiler/direct-plan-schema';
import type {
  ArithmeticProducerConfig,
  DeciderProducerConfig,
  LogicalArithmeticOperand,
  LogicalDeciderCondition,
  LogicalDeciderOutput,
  NativeCircuitIr,
} from '@comblang/compiler/ir';

import type { BoundBlueprintConfiguration } from '../../compiler/src/blueprint-configuration-set.js';
import { canonicalDirectPlan } from './canonical-circuit.js';
import type { CapturedPlanConfigurationRelation } from './executed-blueprint-configuration-binding.js';

function pairMaterializationFailure(): never {
  throw new TypeError('Captured configuration no longer matches its Direct Plan producer.');
}

function materializeArithmeticOperand(
  planned: PlanArithmeticOperand,
  concrete: LogicalArithmeticOperand,
): PlanArithmeticOperand {
  if (planned.kind !== concrete.kind) return pairMaterializationFailure();
  if (planned.kind === 'constant' && concrete.kind === 'constant') {
    return { ...planned, value: concrete.value };
  }
  if (planned.kind === 'signal' && concrete.kind === 'signal') {
    if (planned.refKind !== concrete.refKind) return pairMaterializationFailure();
    return { ...planned, signal: concrete.signal };
  }
  if (planned.kind === 'each' && concrete.kind === 'each') {
    if (planned.refKind !== concrete.refKind) return pairMaterializationFailure();
    return planned;
  }
  return pairMaterializationFailure();
}

function materializeArithmeticProducer(
  planned: DirectPlanArithmetic,
  concrete: ArithmeticProducerConfig,
): DirectPlanArithmetic {
  if (planned.operation !== concrete.operation) return pairMaterializationFailure();
  let output: DirectPlanArithmetic['output'];
  if (planned.output.kind === 'signal' && concrete.output.kind === 'signal') {
    output = { ...planned.output, signal: concrete.output.signal };
  } else if (planned.output.kind === 'each' && concrete.output.kind === 'each') {
    output = planned.output;
  } else {
    return pairMaterializationFailure();
  }
  return {
    ...planned,
    left: materializeArithmeticOperand(planned.left, concrete.left),
    right: materializeArithmeticOperand(planned.right, concrete.right),
    output,
  };
}

function materializeDeciderCondition(
  planned: PlanDeciderCondition,
  concrete: LogicalDeciderCondition,
): PlanDeciderCondition {
  if (planned.kind === 'and' || planned.kind === 'or') {
    if (
      concrete.kind !== planned.kind ||
      planned.conditions.length !== concrete.conditions.length
    ) {
      return pairMaterializationFailure();
    }
    return {
      ...planned,
      conditions: planned.conditions.map((condition, index) =>
        materializeDeciderCondition(condition, concrete.conditions[index]!),
      ),
    };
  }
  if (concrete.kind !== 'compare' || planned.comparator !== concrete.comparator) {
    return pairMaterializationFailure();
  }
  if (planned.kind === 'compare-each') {
    if (
      concrete.left.kind !== 'wildcard' ||
      concrete.left.value !== 'each' ||
      concrete.right.kind !== 'constant'
    ) {
      return pairMaterializationFailure();
    }
    return { ...planned, constant: concrete.right.value };
  }
  if (planned.kind === 'compare-signal') {
    if (concrete.left.kind !== 'signal' || concrete.right.kind !== 'constant') {
      return pairMaterializationFailure();
    }
    return {
      ...planned,
      signal: concrete.left.signal,
      constant: concrete.right.value,
    };
  }
  if (planned.kind === 'compare-wildcard') {
    if (
      concrete.left.kind !== 'wildcard' ||
      concrete.left.value !== planned.wildcard ||
      concrete.right.kind !== 'constant'
    ) {
      return pairMaterializationFailure();
    }
    return { ...planned, constant: concrete.right.value };
  }
  if (planned.kind === 'compare-signals') {
    if (concrete.left.kind !== 'signal' || concrete.right.kind !== 'signal') {
      return pairMaterializationFailure();
    }
    return {
      ...planned,
      left: { ...planned.left, signal: concrete.left.signal },
      right: { ...planned.right, signal: concrete.right.signal },
    };
  }
  if (
    concrete.left.kind !== 'wildcard' ||
    concrete.left.value !== planned.left.wildcard ||
    concrete.right.kind !== 'signal'
  ) {
    return pairMaterializationFailure();
  }
  return {
    ...planned,
    right: { ...planned.right, signal: concrete.right.signal },
  };
}

function materializeDeciderOutput(
  planned: DirectPlanDecider['output'],
  concrete: LogicalDeciderOutput,
): DirectPlanDecider['output'] {
  if (planned.kind === 'each-constant') {
    if (
      concrete.mode !== 'constant' ||
      concrete.signal.kind !== 'wildcard' ||
      concrete.signal.value !== 'each'
    ) {
      return pairMaterializationFailure();
    }
    return { ...planned, value: concrete.value };
  }
  if (planned.kind === 'signal-constant') {
    if (concrete.mode !== 'constant' || concrete.signal.kind !== 'signal') {
      return pairMaterializationFailure();
    }
    return { ...planned, signal: concrete.signal.signal, value: concrete.value };
  }
  if (concrete.mode !== 'copy') return pairMaterializationFailure();
  if (planned.kind === 'each') {
    if (concrete.signal.kind !== 'wildcard' || concrete.signal.value !== 'each') {
      return pairMaterializationFailure();
    }
    return planned;
  }
  if (planned.kind === 'signal') {
    if (concrete.signal.kind !== 'signal') return pairMaterializationFailure();
    return { ...planned, signal: concrete.signal.signal };
  }
  if (concrete.signal.kind !== 'wildcard' || concrete.signal.value !== planned.wildcard) {
    return pairMaterializationFailure();
  }
  return planned;
}

function materializeDeciderProducer(
  planned: DirectPlanDecider,
  concrete: DeciderProducerConfig,
): DirectPlanDecider {
  const plannedOutputs = planned.outputs ?? [planned.output];
  if (plannedOutputs.length !== concrete.outputs.length || concrete.outputs.length === 0) {
    return pairMaterializationFailure();
  }
  const outputs = plannedOutputs.map((output, index) =>
    materializeDeciderOutput(output, concrete.outputs[index]!),
  );
  let elseOutputs: readonly DirectPlanDecider['output'][] | undefined;
  if (planned.elseOutputs !== undefined || concrete.elseOutputs !== undefined) {
    if (
      planned.elseOutputs === undefined ||
      concrete.elseOutputs === undefined ||
      planned.elseOutputs.length !== concrete.elseOutputs.length
    ) {
      return pairMaterializationFailure();
    }
    elseOutputs = planned.elseOutputs.map((output, index) =>
      materializeDeciderOutput(output, concrete.elseOutputs![index]!),
    );
  }
  return {
    ...planned,
    condition: materializeDeciderCondition(planned.condition, concrete.condition),
    output: outputs[0]!,
    ...(planned.outputs === undefined ? {} : { outputs }),
    ...(elseOutputs === undefined ? {} : { elseOutputs }),
  };
}

function materializeCapturedProducer(
  planned: DirectPlanProducer,
  concrete: BoundBlueprintConfiguration,
): DirectPlanProducer {
  if (planned.kind !== concrete.kind) return pairMaterializationFailure();
  switch (concrete.kind) {
    case 'arithmetic':
      if (planned.kind !== 'arithmetic') return pairMaterializationFailure();
      return materializeArithmeticProducer(planned, concrete.config);
    case 'constant':
      if (planned.kind !== 'constant' || planned.configuration === undefined) {
        return pairMaterializationFailure();
      }
      return { ...planned, configuration: concrete.config };
    case 'decider':
      if (planned.kind !== 'decider') return pairMaterializationFailure();
      return materializeDeciderProducer(planned, concrete.config);
    case 'selector':
      if (planned.kind !== 'selector' || planned.operation !== concrete.config.operation) {
        return pairMaterializationFailure();
      }
      if (planned.operation === 'select' && concrete.config.operation === 'select') {
        return { ...planned, index: concrete.config.index };
      }
      if (planned.operation === 'count' && concrete.config.operation === 'count') {
        return { ...planned, output: concrete.config.output };
      }
      return pairMaterializationFailure();
  }
}

function entityPlanConfiguration(producer: DirectPlanProducer): EntityPlanConfiguration {
  switch (producer.kind) {
    case 'constant':
      if (producer.configuration === undefined) return pairMaterializationFailure();
      return { mode: 'constant', value: producer.configuration };
    case 'arithmetic':
      return {
        mode: 'arithmetic',
        left: producer.left,
        operation: producer.operation,
        right: producer.right,
        output: producer.output,
      };
    case 'decider':
      return {
        mode: 'decider',
        condition: producer.condition,
        outputs: producer.outputs ?? [producer.output],
        ...(producer.elseOutputs === undefined ? {} : { elseOutputs: producer.elseOutputs }),
      };
    case 'selector':
      return producer.operation === 'select'
        ? {
            mode: 'selector',
            operation: 'select',
            input: producer.input,
            selectMax: producer.selectMax,
            index: producer.index,
          }
        : {
            mode: 'selector',
            operation: 'count',
            input: producer.input,
            output: producer.output,
          };
  }
}

/** Materializes captured settings into their matching Plan producers and Entities. */
export function materializeCapturedPlan(
  plan: DirectElaborationPlan,
  configurations: readonly CapturedPlanConfigurationRelation[],
  circuit: NativeCircuitIr,
): DirectElaborationPlan {
  const replacements = new Map<number, DirectPlanProducer>();
  for (const relation of configurations) {
    if (
      relation.configuration.key !== relation.captureId ||
      relation.configuration.kind !== relation.kind
    ) {
      return pairMaterializationFailure();
    }
    const producer = plan.producers[relation.planIndex];
    if (
      producer === undefined ||
      producer.kind !== relation.kind ||
      !producer.debugCaptureIds?.includes(relation.captureId)
    ) {
      return pairMaterializationFailure();
    }
    const physicalProducer = circuit.producers[relation.producerIndex];
    if (
      physicalProducer === undefined ||
      physicalProducer.id !== relation.producerId ||
      physicalProducer.kind !== relation.kind
    ) {
      return pairMaterializationFailure();
    }
    if (replacements.has(relation.planIndex)) return pairMaterializationFailure();
    replacements.set(
      relation.planIndex,
      materializeCapturedProducer(producer, relation.configuration),
    );
  }
  const producers = plan.producers.map((producer, index) => replacements.get(index) ?? producer);
  const producersByEntityId = new Map<
    DirectPlanProducer['entityId'] & string,
    DirectPlanProducer
  >();
  for (const producer of replacements.values()) {
    if (producer.entityId === undefined) continue;
    if (producersByEntityId.has(producer.entityId)) return pairMaterializationFailure();
    producersByEntityId.set(producer.entityId, producer);
  }
  const entities = plan.entities.map((entity) => {
    const producer = producersByEntityId.get(entity.id);
    return producer === undefined
      ? entity
      : { ...entity, configuration: entityPlanConfiguration(producer) };
  });
  return canonicalDirectPlan({ ...plan, producers, entities });
}
