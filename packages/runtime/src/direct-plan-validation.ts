import type {
  DirectElaborationPlan,
  DirectPlanCapabilityUse,
  DirectPlanNetwork,
  DirectPlanNetworkAlias,
} from '@comblang/compiler/direct-plan-schema';
import type { Diagnostic, SourceSpan } from '@comblang/shared';

export interface ValidatedDirectPlanEnvelope {
  readonly plan: DirectElaborationPlan;
  readonly declarations: ReadonlyMap<string, DirectPlanNetwork>;
  readonly aliases: readonly DirectPlanNetworkAlias[];
  readonly capabilityUses: readonly DirectPlanCapabilityUse[];
}

export interface DirectPlanEnvelopeValidationResult {
  readonly value?: ValidatedDirectPlanEnvelope;
  readonly diagnostics: readonly Diagnostic[];
}

function failure(
  code: string,
  message: string,
  span?: SourceSpan,
): DirectPlanEnvelopeValidationResult {
  return {
    diagnostics: [
      {
        code,
        severity: 'error',
        message,
        ...(span === undefined ? {} : { span }),
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function descriptorSpan(value: unknown, key: 'source' | 'provenance'): SourceSpan | undefined {
  if (!isRecord(value)) return undefined;
  const span = value[key];
  if (!isRecord(span)) return undefined;
  return typeof span.fileId === 'string' &&
    span.fileId.length > 0 &&
    Number.isSafeInteger(span.start) &&
    Number.isSafeInteger(span.end) &&
    Number(span.start) >= 0 &&
    Number(span.end) >= Number(span.start)
    ? (span as unknown as SourceSpan)
    : undefined;
}

function isInstancePath(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((segment) => typeof segment === 'string' && segment.length > 0)
  );
}

/**
 * Validates the versioned transport envelope before any runtime graph is allocated.
 * Topology and circuit-configuration validation remain part of direct-plan elaboration.
 */
export function validateDirectPlanEnvelope(plan: unknown): DirectPlanEnvelopeValidationResult {
  if (!isRecord(plan) || plan.format !== 'comblang-direct-plan' || plan.version !== 2) {
    return failure('RT1001', 'Unsupported direct elaboration plan format.');
  }
  if (!Array.isArray(plan.networks) || !Array.isArray(plan.producers)) {
    return failure('RT1001', 'Invalid direct elaboration plan envelope.');
  }

  const declarations = new Map<string, DirectPlanNetwork>();
  for (const candidate of plan.networks) {
    if (
      !isRecord(candidate) ||
      typeof candidate.name !== 'string' ||
      candidate.name.length === 0 ||
      (candidate.fixedColor !== undefined &&
        candidate.fixedColor !== 'red' &&
        candidate.fixedColor !== 'green') ||
      descriptorSpan(candidate, 'source') === undefined ||
      !isInstancePath(candidate.instancePath)
    ) {
      return failure(
        'RT1001',
        'Invalid Network descriptor in direct plan.',
        descriptorSpan(candidate, 'source'),
      );
    }
    if (declarations.has(candidate.name)) {
      return failure(
        'RT1002',
        `Duplicate Network in direct plan: ${candidate.name}.`,
        candidate.source as SourceSpan,
      );
    }
    declarations.set(candidate.name, candidate as unknown as DirectPlanNetwork);
  }

  const optionalDescriptorArrays = [
    'networkAliases',
    'networkTransfers',
    'networkPairs',
    'capabilityUses',
    'debugInstances',
    'diagnostics',
  ] as const;
  for (const key of optionalDescriptorArrays) {
    if (plan[key] !== undefined && !Array.isArray(plan[key])) {
      return failure('RT1001', `Invalid ${key} collection in direct plan.`);
    }
  }

  const aliases = (plan.networkAliases ?? []) as unknown[];
  for (const alias of aliases) {
    if (
      !isRecord(alias) ||
      typeof alias.name !== 'string' ||
      alias.name.length === 0 ||
      typeof alias.network !== 'string' ||
      !declarations.has(alias.network) ||
      descriptorSpan(alias, 'source') === undefined ||
      !isInstancePath(alias.instancePath) ||
      typeof alias.moved !== 'boolean'
    ) {
      return failure(
        'RT1001',
        'Invalid Network alias descriptor in direct plan.',
        descriptorSpan(alias, 'source'),
      );
    }
  }

  const capabilityUses = (plan.capabilityUses ?? []) as unknown[];
  for (const use of capabilityUses) {
    if (
      !isRecord(use) ||
      typeof use.network !== 'string' ||
      !declarations.has(use.network) ||
      !['readonly', 'ref', 'move'].includes(String(use.capability)) ||
      typeof use.parameter !== 'string' ||
      use.parameter.length === 0 ||
      (use.fixedColor !== undefined && use.fixedColor !== 'red' && use.fixedColor !== 'green') ||
      descriptorSpan(use, 'provenance') === undefined ||
      !isInstancePath(use.instancePath)
    ) {
      return failure(
        'RT1001',
        'Invalid capability descriptor in direct plan.',
        descriptorSpan(use, 'provenance'),
      );
    }
  }

  return {
    value: {
      plan: plan as unknown as DirectElaborationPlan,
      declarations,
      aliases: Object.freeze([...(aliases as unknown as DirectPlanNetworkAlias[])]),
      capabilityUses: Object.freeze([...(capabilityUses as unknown as DirectPlanCapabilityUse[])]),
    },
    diagnostics: [],
  };
}
