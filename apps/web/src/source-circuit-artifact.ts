import {
  generateBlueprintJson,
  generateEntityBlueprintJson,
} from '@comblang/compiler/blueprint-json';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { DirectElaborationPlanV3 } from '@comblang/compiler/entity';
import type { TrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import {
  elaborateDirectPlan,
  elaborateEntityDirectPlan,
  type ExecutedDirectPlan,
  type ExecutedEntityDirectPlan,
} from '@comblang/runtime';

export type SourcePlan = DirectElaborationPlan | DirectElaborationPlanV3;
export type SourceExecution = ExecutedDirectPlan | ExecutedEntityDirectPlan;

/**
 * Main-thread representation of one successfully compiled source circuit.
 *
 * An execution contains runtime handles and therefore cannot cross the compiler
 * Worker boundary. Once the accepted plan reaches the UI, however, every
 * preview can share this single elaboration.
 */
export interface LegacySourceCircuitArtifact {
  readonly plan: DirectElaborationPlan;
  readonly execution: ExecutedDirectPlan;
  readonly blueprint: ReturnType<typeof generateBlueprintJson>;
}

export interface EntitySourceCircuitArtifact {
  readonly plan: DirectElaborationPlanV3;
  readonly execution: ExecutedEntityDirectPlan;
  readonly blueprint: ReturnType<typeof generateEntityBlueprintJson>;
}

export type SourceCircuitArtifact = LegacySourceCircuitArtifact | EntitySourceCircuitArtifact;

export function createSourceCircuitArtifact(
  plan: DirectElaborationPlan,
): LegacySourceCircuitArtifact;
export function createSourceCircuitArtifact(
  plan: DirectElaborationPlanV3,
  trustedEntityReplayContext: TrustedEntityReplayContext,
): EntitySourceCircuitArtifact;
export function createSourceCircuitArtifact(
  plan: SourcePlan,
  trustedEntityReplayContext?: TrustedEntityReplayContext,
): SourceCircuitArtifact {
  if (plan.version === 3) {
    if (trustedEntityReplayContext === undefined) {
      throw new Error('Entity v3 preview requires the matching host-bound trusted context.');
    }
    const execution = elaborateEntityDirectPlan(plan, trustedEntityReplayContext);
    return Object.freeze({
      plan,
      execution,
      blueprint: generateEntityBlueprintJson(execution.circuit.ir),
    });
  }
  const execution = elaborateDirectPlan(plan);
  return Object.freeze({
    plan,
    execution,
    blueprint: generateBlueprintJson(execution.circuit.ir),
  });
}
