import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import { elaborateDirectPlan } from '@comblang/runtime';

/** Converts a compiler-owned direct plan into readable, uncompressed Factorio blueprint JSON. */
export function blueprintJsonForPlan(plan: DirectElaborationPlan) {
  return generateBlueprintJson(elaborateDirectPlan(plan).circuit.ir);
}
