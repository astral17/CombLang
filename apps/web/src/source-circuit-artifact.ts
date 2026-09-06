import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import { elaborateDirectPlan, type ExecutedDirectPlan } from '@comblang/runtime';

/**
 * Main-thread representation of one successfully compiled source circuit.
 *
 * An execution contains runtime handles and therefore cannot cross the compiler
 * Worker boundary. Once the accepted plan reaches the UI, however, every
 * preview can share this single elaboration.
 */
export interface SourceCircuitArtifact {
  readonly plan: DirectElaborationPlan;
  readonly execution: ExecutedDirectPlan;
  readonly blueprint: ReturnType<typeof generateBlueprintJson>;
}

export function createSourceCircuitArtifact(plan: DirectElaborationPlan): SourceCircuitArtifact {
  const execution = elaborateDirectPlan(plan);
  return Object.freeze({
    plan,
    execution,
    blueprint: generateBlueprintJson(execution.circuit.ir),
  });
}
