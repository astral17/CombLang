import { cloneAndDeepFreeze } from '@comblang/compiler/immutable';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import { parseResolvedCircuit } from '@comblang/compiler/resolved-circuit';

type DataRecord = Record<string, any>;

function dataRecord(value: unknown): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Canonical circuit artifacts require data records.');
  return value as DataRecord;
}

function stableJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) throw new TypeError('Cyclic canonical circuit data.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry, seen)).join(',')}]`;
    const record = value as DataRecord;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key], seen)}`)
      .join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function fingerprint(value: unknown): string {
  let hash = 0xcbf29ce484222325n;
  const serialized = stableJson(value);
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `plan-fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

export function canonicalPlanFingerprint(value: unknown): string {
  return fingerprint(value);
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
    planFingerprint: fingerprint(plan),
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
