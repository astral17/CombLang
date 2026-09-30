import { cloneAndDeepFreeze } from '@comblang/compiler/immutable';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import {
  parseResolvedCircuit,
  resolvedCircuitPlanFingerprint,
} from '@comblang/compiler/resolved-circuit';

type DataRecord = Record<string, any>;

function dataRecord(value: unknown): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Canonical circuit artifacts require data records.');
  return value as DataRecord;
}

export function canonicalPlanFingerprint(value: unknown): string {
  return resolvedCircuitPlanFingerprint(value as DirectElaborationPlan);
}

export function canonicalDirectPlan(value: unknown): DirectElaborationPlan {
  return cloneAndDeepFreeze(value) as DirectElaborationPlan;
}

export function canonicalCircuitGraph(value: unknown): unknown {
  return cloneAndDeepFreeze(value);
}

export function canonicalNativeCircuitIr(value: unknown): unknown {
  return cloneAndDeepFreeze(value);
}

export function canonicalResolvedCircuit(value: unknown, plan: unknown, ir?: unknown): unknown {
  const source = value === undefined ? undefined : dataRecord(value);
  const physicalIr = ir === undefined ? source?.ir : ir;
  const candidate = {
    format: 'comblang-resolved-circuit',
    planFingerprint: canonicalPlanFingerprint(plan),
    ir: canonicalNativeCircuitIr(physicalIr ?? { format: 'comblang-ncir', entities: [] }),
  };
  return physicalIr === undefined ? cloneAndDeepFreeze(candidate) : parseResolvedCircuit(candidate);
}

export function canonicalizeCompilationArtifacts<T extends DataRecord>(value: T): T {
  const plan = value.plan === undefined ? undefined : canonicalDirectPlan(value.plan);
  const execution = value.execution;
  const executionRecord = execution === undefined ? undefined : dataRecord(execution);
  const executionCircuit = executionRecord?.circuit;
  const canonicalExecution =
    executionRecord === undefined
      ? undefined
      : {
          ...executionRecord,
          circuit:
            executionCircuit === undefined
              ? undefined
              : {
                  ...dataRecord(executionCircuit),
                  graph: canonicalCircuitGraph(dataRecord(executionCircuit).graph),
                  ir: canonicalNativeCircuitIr(dataRecord(executionCircuit).ir),
                },
        };
  const resolved =
    plan === undefined && value.resolvedCircuit === undefined && executionCircuit === undefined
      ? undefined
      : canonicalResolvedCircuit(
          value.resolvedCircuit,
          plan,
          executionCircuit === undefined ? undefined : dataRecord(executionCircuit).ir,
        );
  return {
    ...value,
    ...(plan === undefined ? {} : { plan }),
    ...(canonicalExecution === undefined ? {} : { execution: canonicalExecution }),
    ...(resolved === undefined ? {} : { resolvedCircuit: resolved }),
  } as T;
}
