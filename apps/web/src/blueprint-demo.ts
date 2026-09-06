import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';

import {
  createSourceCircuitArtifact,
  type SourceCircuitArtifact,
} from './source-circuit-artifact.js';

export function blueprintJsonForArtifact(artifact: SourceCircuitArtifact) {
  return artifact.blueprint;
}

/** Converts a compiler-owned direct plan into readable, uncompressed Factorio blueprint JSON. */
export function blueprintJsonForPlan(plan: DirectElaborationPlan) {
  return blueprintJsonForArtifact(createSourceCircuitArtifact(plan));
}
