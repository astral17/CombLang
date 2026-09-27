import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';

interface PlanPairing {
  readonly plan: DirectElaborationPlan;
  readonly snapshot: string;
}

const pairingsByExecution = new WeakMap<object, PlanPairing>();

function stablePlanData(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';
  if (typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Plan pairing requires JSON-compatible data.');
    return encoded;
  }
  if (seen.has(value)) throw new TypeError('Plan pairing does not accept cyclic data.');
  seen.add(value);
  try {
    if (Array.isArray(value))
      return `[${value.map((entry) => stablePlanData(entry, seen)).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stablePlanData(record[key], seen)}`)
      .join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

export function registerExecutedDirectPlanPairing(
  execution: object,
  plan: DirectElaborationPlan,
): void {
  pairingsByExecution.set(execution, { plan, snapshot: stablePlanData(plan) });
}

export function executedDirectPlanMatchesPlan(
  execution: object,
  plan: DirectElaborationPlan,
): boolean {
  const pairing = pairingsByExecution.get(execution);
  return (
    pairing !== undefined && pairing.plan === plan && pairing.snapshot === stablePlanData(plan)
  );
}
