import type {
  DirectElaborationPlan,
  DirectPlanCapabilityUse,
  DirectPlanDebugInstance,
  DirectPlanDebugValue,
  DirectPlanNetwork,
  DirectPlanNetworkAlias,
  DirectPlanProducer,
  PlanArithmeticOperand,
  PlanAttachment,
  PlanDeciderCondition,
  PlanNetworkRef,
} from '@comblang/compiler/direct-plan-schema';
import type { ArithmeticOperation, LogicalArithmeticOutput } from '@comblang/compiler';
import type { SignalId, SignalType } from '@comblang/factorio';
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
    diagnostics: [{ code, severity: 'error', message, ...(span === undefined ? {} : { span }) }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function descriptorSpan(value: unknown, key: 'source' | 'provenance'): SourceSpan | undefined {
  if (!isRecord(value)) return undefined;
  const valueSpan = value[key];
  if (!isRecord(valueSpan)) return undefined;
  return typeof valueSpan.fileId === 'string' &&
    valueSpan.fileId.length > 0 &&
    Number.isSafeInteger(valueSpan.start) &&
    Number.isSafeInteger(valueSpan.end) &&
    Number(valueSpan.start) >= 0 &&
    Number(valueSpan.end) >= Number(valueSpan.start)
    ? (valueSpan as unknown as SourceSpan)
    : undefined;
}

function isInstancePath(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((segment) => typeof segment === 'string' && segment.length > 0)
  );
}

function payloadFailure(path: string, message: string, span?: SourceSpan) {
  return failure('RT1001', `${path}: ${message}`, span);
}

function exceedsLimit(value: readonly unknown[]): boolean {
  return value.length > 100_000;
}

const signalTypes = new Set([
  'item',
  'fluid',
  'virtual',
  'entity',
  'recipe',
  'space-location',
  'asteroid-chunk',
  'quality',
]);

const arithmeticOperations = new Set([
  'add',
  'subtract',
  'multiply',
  'divide',
  'modulo',
  'power',
  'left-shift',
  'right-shift',
  'bit-and',
  'bit-or',
  'bit-xor',
]);

const comparators = new Set(['>', '<', '=', '>=', '<=', '!=']);
const maximumNestedConditionDepth = 128;
const maximumNestedDebugDepth = 128;

function isCircuitValue(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) >= -2_147_483_648 && Number(value) <= 2_147_483_647
  );
}

function isSignalId(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    signalTypes.has(value.type) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    (value.quality === undefined || (typeof value.quality === 'string' && value.quality.length > 0))
  );
}

function validateNetworkRef(
  value: Record<string, unknown>,
  path: string,
  declarations: ReadonlyMap<string, DirectPlanNetwork>,
  span: SourceSpan,
): DirectPlanEnvelopeValidationResult | undefined {
  if (value.refKind === 'single') {
    if (typeof value.network === 'string' && declarations.has(value.network)) return undefined;
    return failure('RT1003', `${path}: invalid or unknown input Network.`, span);
  }
  if (value.refKind === 'pair') {
    const networks = value.networks;
    if (
      Array.isArray(networks) &&
      networks.length === 2 &&
      networks[0] !== networks[1] &&
      networks.every((network) => typeof network === 'string' && declarations.has(network))
    )
      return undefined;
    return failure('RT1003', `${path}: invalid or unknown input Network pair.`, span);
  }
  return payloadFailure(`${path}.refKind`, 'unknown Network reference tag.', span);
}

function validateArithmeticOperand(
  value: unknown,
  path: string,
  declarations: ReadonlyMap<string, DirectPlanNetwork>,
  span: SourceSpan,
): DirectPlanEnvelopeValidationResult | undefined {
  if (!isRecord(value)) return payloadFailure(path, 'expected an arithmetic operand.', span);
  if (value.kind === 'constant')
    return isCircuitValue(value.value)
      ? undefined
      : payloadFailure(`${path}.value`, 'expected a signed int32 circuit value.', span);
  if (value.kind === 'signal' && !isSignalId(value.signal))
    return payloadFailure(`${path}.signal`, 'expected a valid SignalID.', span);
  if (value.kind !== 'signal' && value.kind !== 'each')
    return payloadFailure(`${path}.kind`, 'unknown arithmetic operand tag.', span);
  return validateNetworkRef(value, path, declarations, span);
}

function validateArithmeticProducer(
  producer: Record<string, unknown>,
  path: string,
  declarations: ReadonlyMap<string, DirectPlanNetwork>,
  span: SourceSpan,
): DirectPlanEnvelopeValidationResult | undefined {
  const left = validateArithmeticOperand(producer.left, `${path}.left`, declarations, span);
  if (left !== undefined) return left;
  if (typeof producer.operation !== 'string' || !arithmeticOperations.has(producer.operation))
    return payloadFailure(`${path}.operation`, 'unknown arithmetic operation.', span);
  const right = validateArithmeticOperand(producer.right, `${path}.right`, declarations, span);
  if (right !== undefined) return right;
  if (!isRecord(producer.output))
    return payloadFailure(`${path}.output`, 'expected an arithmetic output.', span);
  if (producer.output.kind === 'each') return undefined;
  if (producer.output.kind === 'signal' && isSignalId(producer.output.signal)) return undefined;
  return payloadFailure(`${path}.output`, 'invalid arithmetic output.', span);
}

function validateDeciderCondition(
  value: unknown,
  path: string,
  declarations: ReadonlyMap<string, DirectPlanNetwork>,
  span: SourceSpan,
  depth = 0,
  budget = { remaining: 100_000 },
): DirectPlanEnvelopeValidationResult | undefined {
  if (depth > maximumNestedConditionDepth)
    return payloadFailure(
      path,
      `condition nesting exceeds the ${maximumNestedConditionDepth} level limit.`,
      span,
    );
  budget.remaining -= 1;
  if (budget.remaining < 0)
    return payloadFailure(path, 'condition tree exceeds the 100000 node limit.', span);
  if (!isRecord(value)) return payloadFailure(path, 'expected a Decider condition.', span);
  if (value.kind === 'and' || value.kind === 'or') {
    if (!Array.isArray(value.conditions))
      return payloadFailure(`${path}.conditions`, 'expected a condition array.', span);
    if (exceedsLimit(value.conditions))
      return payloadFailure(`${path}.conditions`, 'condition array exceeds the item limit.', span);
    for (const [index, child] of value.conditions.entries()) {
      const invalid = validateDeciderCondition(
        child,
        `${path}.conditions[${index}]`,
        declarations,
        span,
        depth + 1,
        budget,
      );
      if (invalid !== undefined) return invalid;
    }
    return undefined;
  }
  if (typeof value.comparator !== 'string' || !comparators.has(value.comparator))
    return payloadFailure(`${path}.comparator`, 'unknown Decider comparator.', span);
  if (value.kind === 'compare-signals') {
    for (const side of ['left', 'right'] as const) {
      const operand = value[side];
      const operandPath = `${path}.${side}`;
      if (!isRecord(operand))
        return payloadFailure(operandPath, 'expected a signal operand.', span);
      if (!isSignalId(operand.signal))
        return payloadFailure(`${operandPath}.signal`, 'expected a valid SignalID.', span);
      const invalid = validateNetworkRef(operand, operandPath, declarations, span);
      if (invalid !== undefined) return invalid;
    }
    return undefined;
  }
  if (
    value.kind !== 'compare-each' &&
    value.kind !== 'compare-signal' &&
    value.kind !== 'compare-wildcard'
  )
    return payloadFailure(`${path}.kind`, 'unknown Decider condition tag.', span);
  if (!isCircuitValue(value.constant))
    return payloadFailure(`${path}.constant`, 'expected a signed int32 circuit value.', span);
  if (value.kind === 'compare-signal' && !isSignalId(value.signal))
    return payloadFailure(`${path}.signal`, 'expected a valid SignalID.', span);
  if (
    value.kind === 'compare-wildcard' &&
    value.wildcard !== 'anything' &&
    value.wildcard !== 'everything'
  )
    return payloadFailure(`${path}.wildcard`, 'unknown Decider wildcard.', span);
  return validateNetworkRef(value, path, declarations, span);
}

function validateDeciderOutput(
  value: unknown,
  path: string,
  declarations: ReadonlyMap<string, DirectPlanNetwork>,
  span: SourceSpan,
): DirectPlanEnvelopeValidationResult | undefined {
  if (!isRecord(value)) return payloadFailure(path, 'expected a Decider output.', span);
  if (value.kind === 'each-constant')
    return isCircuitValue(value.value)
      ? undefined
      : payloadFailure(`${path}.value`, 'expected a signed int32 circuit value.', span);
  if (value.kind === 'signal-constant') {
    if (!isSignalId(value.signal))
      return payloadFailure(`${path}.signal`, 'expected a valid SignalID.', span);
    return isCircuitValue(value.value)
      ? undefined
      : payloadFailure(`${path}.value`, 'expected a signed int32 circuit value.', span);
  }
  if (value.kind === 'signal' && !isSignalId(value.signal))
    return payloadFailure(`${path}.signal`, 'expected a valid SignalID.', span);
  if (value.kind === 'wildcard' && value.wildcard !== 'anything' && value.wildcard !== 'everything')
    return payloadFailure(`${path}.wildcard`, 'unknown Decider wildcard.', span);
  if (value.kind !== 'each' && value.kind !== 'signal' && value.kind !== 'wildcard')
    return payloadFailure(`${path}.kind`, 'unknown Decider output tag.', span);
  return validateNetworkRef(value, path, declarations, span);
}

function validateDeciderProducer(
  producer: Record<string, unknown>,
  path: string,
  declarations: ReadonlyMap<string, DirectPlanNetwork>,
  span: SourceSpan,
): DirectPlanEnvelopeValidationResult | undefined {
  const condition = validateDeciderCondition(
    producer.condition,
    `${path}.condition`,
    declarations,
    span,
  );
  if (condition !== undefined) return condition;
  const compatibilityOutput = validateDeciderOutput(
    producer.output,
    `${path}.output`,
    declarations,
    span,
  );
  if (compatibilityOutput !== undefined) return compatibilityOutput;
  for (const key of ['outputs', 'elseOutputs'] as const) {
    const outputs = producer[key];
    if (outputs === undefined) continue;
    if (!Array.isArray(outputs) || exceedsLimit(outputs))
      return payloadFailure(`${path}.${key}`, 'expected a bounded output array.', span);
    for (const [index, output] of outputs.entries()) {
      const invalid = validateDeciderOutput(output, `${path}.${key}[${index}]`, declarations, span);
      if (invalid !== undefined) return invalid;
    }
  }
  return undefined;
}

function validateConstantProducer(
  producer: Record<string, unknown>,
  path: string,
  span: SourceSpan,
): DirectPlanEnvelopeValidationResult | undefined {
  if (!Array.isArray(producer.outputs) || exceedsLimit(producer.outputs))
    return payloadFailure(`${path}.outputs`, 'expected a bounded constant output array.', span);
  for (const [index, output] of producer.outputs.entries()) {
    const outputPath = `${path}.outputs[${index}]`;
    if (!isRecord(output)) return payloadFailure(outputPath, 'expected a constant output.', span);
    if (!isSignalId(output.signal))
      return payloadFailure(`${outputPath}.signal`, 'expected a valid SignalID.', span);
    if (!isCircuitValue(output.value))
      return payloadFailure(`${outputPath}.value`, 'expected a signed int32 circuit value.', span);
  }
  return undefined;
}

function validateProducerMetadata(
  producer: Record<string, unknown>,
  path: string,
  span: SourceSpan,
  captureIds: Set<string>,
): DirectPlanEnvelopeValidationResult | undefined {
  if (
    producer.bindingName !== undefined &&
    (typeof producer.bindingName !== 'string' || producer.bindingName.length === 0)
  )
    return payloadFailure(`${path}.bindingName`, 'expected a non-empty string.', span);
  if (producer.debugCaptureIds !== undefined) {
    if (!Array.isArray(producer.debugCaptureIds) || exceedsLimit(producer.debugCaptureIds))
      return payloadFailure(`${path}.debugCaptureIds`, 'expected a bounded string array.', span);
    for (const [index, captureId] of producer.debugCaptureIds.entries()) {
      if (typeof captureId !== 'string' || captureId.length === 0)
        return payloadFailure(
          `${path}.debugCaptureIds[${index}]`,
          'expected a non-empty string.',
          span,
        );
      if (captureIds.has(captureId))
        return payloadFailure(
          `${path}.debugCaptureIds[${index}]`,
          'duplicate Producer debug capture.',
          span,
        );
      captureIds.add(captureId);
    }
  }
  if (producer.placement !== undefined) {
    const placement = producer.placement;
    if (
      !isRecord(placement) ||
      typeof placement.x !== 'number' ||
      !Number.isFinite(placement.x) ||
      typeof placement.y !== 'number' ||
      !Number.isFinite(placement.y) ||
      (placement.direction !== undefined &&
        (!Number.isInteger(placement.direction) ||
          Number(placement.direction) < 0 ||
          Number(placement.direction) > 15))
    )
      return payloadFailure(`${path}.placement`, 'invalid entity placement.', span);
  }
  return undefined;
}

function validateDebugValue(
  value: unknown,
  path: string,
  declarations: ReadonlyMap<string, DirectPlanNetwork>,
  captureIds: ReadonlySet<string>,
  span: SourceSpan,
  depth = 0,
  budget = { remaining: 100_000 },
): DirectPlanEnvelopeValidationResult | undefined {
  if (depth > maximumNestedDebugDepth)
    return payloadFailure(
      path,
      `debug value nesting exceeds the ${maximumNestedDebugDepth} level limit.`,
      span,
    );
  budget.remaining -= 1;
  if (budget.remaining < 0)
    return payloadFailure(path, 'debug value exceeds the 100000 node limit.', span);
  if (!isRecord(value)) return payloadFailure(path, 'expected a debug value.', span);
  if (value.kind === 'network')
    return typeof value.network === 'string' && declarations.has(value.network)
      ? undefined
      : failure('RT1003', `${path}.network: unknown debug Network.`, span);
  if (value.kind === 'producer')
    return typeof value.captureId === 'string' && captureIds.has(value.captureId)
      ? undefined
      : payloadFailure(`${path}.captureId`, 'unknown Producer debug capture.', span);
  if (value.kind === 'undefined') return undefined;
  if (value.kind === 'literal') {
    const literal = value.value;
    return literal === null ||
      typeof literal === 'string' ||
      typeof literal === 'boolean' ||
      (typeof literal === 'number' && Number.isFinite(literal))
      ? undefined
      : payloadFailure(`${path}.value`, 'invalid debug literal.', span);
  }
  if (value.kind === 'array') {
    if (!Array.isArray(value.values) || exceedsLimit(value.values))
      return payloadFailure(`${path}.values`, 'expected a bounded debug value array.', span);
    for (const [index, item] of value.values.entries()) {
      const invalid = validateDebugValue(
        item,
        `${path}.values[${index}]`,
        declarations,
        captureIds,
        span,
        depth + 1,
        budget,
      );
      if (invalid !== undefined) return invalid;
    }
    return undefined;
  }
  if (value.kind === 'object') {
    if (!Array.isArray(value.entries) || exceedsLimit(value.entries))
      return payloadFailure(`${path}.entries`, 'expected a bounded debug entry array.', span);
    const keys = new Set<string>();
    for (const [index, entry] of value.entries.entries()) {
      const entryPath = `${path}.entries[${index}]`;
      if (!isRecord(entry) || typeof entry.key !== 'string')
        return payloadFailure(entryPath, 'expected a named debug entry.', span);
      if (keys.has(entry.key))
        return payloadFailure(`${entryPath}.key`, 'duplicate debug object key.', span);
      keys.add(entry.key);
      const invalid = validateDebugValue(
        entry.value,
        `${entryPath}.value`,
        declarations,
        captureIds,
        span,
        depth + 1,
        budget,
      );
      if (invalid !== undefined) return invalid;
    }
    return undefined;
  }
  return payloadFailure(`${path}.kind`, 'unknown debug value tag.', span);
}

function validateDiagnostic(
  value: unknown,
  path: string,
): DirectPlanEnvelopeValidationResult | undefined {
  if (
    !isRecord(value) ||
    typeof value.code !== 'string' ||
    value.code.length === 0 ||
    (value.severity !== 'error' && value.severity !== 'warning' && value.severity !== 'info') ||
    typeof value.message !== 'string'
  )
    return payloadFailure(path, 'invalid diagnostic.');
  if (value.span !== undefined && descriptorSpan({ source: value.span }, 'source') === undefined)
    return payloadFailure(`${path}.span`, 'invalid source span.');
  if (value.related !== undefined) {
    if (!Array.isArray(value.related) || exceedsLimit(value.related))
      return payloadFailure(`${path}.related`, 'expected a bounded related-information array.');
    for (const [index, related] of value.related.entries()) {
      const relatedPath = `${path}.related[${index}]`;
      if (
        !isRecord(related) ||
        typeof related.message !== 'string' ||
        descriptorSpan({ source: related.span }, 'source') === undefined
      )
        return payloadFailure(relatedPath, 'invalid related diagnostic information.');
    }
  }
  return undefined;
}

function canonicalSpan(value: unknown): SourceSpan {
  const span = value as Record<string, unknown>;
  return Object.freeze({
    fileId: span.fileId as SourceSpan['fileId'],
    start: span.start as number,
    end: span.end as number,
  });
}

function canonicalPath(value: unknown): readonly string[] {
  return Object.freeze([...(value as string[])]);
}

function canonicalSignal(value: unknown): SignalId {
  const signal = value as Record<string, unknown>;
  return Object.freeze({
    type: signal.type as SignalType,
    name: signal.name as string,
    ...(signal.quality === undefined ? {} : { quality: signal.quality as string }),
  });
}

function canonicalNetworkRef(value: Record<string, unknown>): PlanNetworkRef {
  return value.refKind === 'single'
    ? Object.freeze({ refKind: 'single', network: value.network as string })
    : Object.freeze({
        refKind: 'pair',
        networks: Object.freeze([...(value.networks as [string, string])]) as readonly [
          string,
          string,
        ],
      });
}

function canonicalArithmeticOperand(value: unknown): PlanArithmeticOperand {
  const operand = value as Record<string, unknown>;
  if (operand.kind === 'constant')
    return Object.freeze({ kind: 'constant', value: operand.value as number });
  return Object.freeze({
    kind: operand.kind as 'signal' | 'each',
    ...(operand.kind === 'signal' ? { signal: canonicalSignal(operand.signal) } : {}),
    ...canonicalNetworkRef(operand),
  }) as PlanArithmeticOperand;
}

function canonicalArithmeticOutput(value: unknown): LogicalArithmeticOutput {
  const output = value as Record<string, unknown>;
  return output.kind === 'each'
    ? Object.freeze({ kind: 'each' })
    : Object.freeze({ kind: 'signal', signal: canonicalSignal(output.signal) });
}

function canonicalCondition(value: unknown): PlanDeciderCondition {
  const condition = value as Record<string, unknown>;
  if (condition.kind === 'and' || condition.kind === 'or')
    return Object.freeze({
      kind: condition.kind,
      conditions: Object.freeze(
        (condition.conditions as unknown[]).map((child) => canonicalCondition(child)),
      ),
    });
  if (condition.kind === 'compare-signals') {
    const side = (operand: unknown) => {
      const record = operand as Record<string, unknown>;
      return Object.freeze({
        signal: canonicalSignal(record.signal),
        ...canonicalNetworkRef(record),
      });
    };
    return Object.freeze({
      kind: 'compare-signals',
      left: side(condition.left),
      comparator: condition.comparator as '>' | '<' | '=' | '>=' | '<=' | '!=',
      right: side(condition.right),
    });
  }
  return Object.freeze({
    kind: condition.kind as 'compare-each' | 'compare-signal' | 'compare-wildcard',
    ...(condition.kind === 'compare-signal'
      ? { signal: canonicalSignal(condition.signal) }
      : condition.kind === 'compare-wildcard'
        ? { wildcard: condition.wildcard as 'anything' | 'everything' }
        : {}),
    comparator: condition.comparator as '>' | '<' | '=' | '>=' | '<=' | '!=',
    constant: condition.constant as number,
    ...canonicalNetworkRef(condition),
  }) as PlanDeciderCondition;
}

type PlanDeciderOutput = Extract<DirectPlanProducer, { kind: 'decider' }>['output'];

function canonicalDeciderOutput(value: unknown): PlanDeciderOutput {
  const output = value as Record<string, unknown>;
  if (output.kind === 'each-constant')
    return Object.freeze({ kind: 'each-constant', value: output.value as number });
  if (output.kind === 'signal-constant')
    return Object.freeze({
      kind: 'signal-constant',
      signal: canonicalSignal(output.signal),
      value: output.value as number,
    });
  return Object.freeze({
    kind: output.kind as 'each' | 'signal' | 'wildcard',
    ...(output.kind === 'signal'
      ? { signal: canonicalSignal(output.signal) }
      : output.kind === 'wildcard'
        ? { wildcard: output.wildcard as 'anything' | 'everything' }
        : {}),
    ...canonicalNetworkRef(output),
  }) as PlanDeciderOutput;
}

function canonicalAttachment(value: unknown): PlanAttachment {
  const attachment = value as Record<string, unknown>;
  return Object.freeze({
    network: attachment.network as string,
    source: canonicalSpan(attachment.source),
    instancePath: canonicalPath(attachment.instancePath),
  });
}

function canonicalProducer(value: unknown): DirectPlanProducer {
  const producer = value as Record<string, unknown>;
  const common = {
    ...(producer.bindingName === undefined ? {} : { bindingName: producer.bindingName as string }),
    ...(producer.debugCaptureIds === undefined
      ? {}
      : { debugCaptureIds: canonicalPath(producer.debugCaptureIds) }),
    destinations: Object.freeze(
      (producer.destinations as unknown[]).map((destination) => canonicalAttachment(destination)),
    ),
    source: canonicalSpan(producer.source),
    instancePath: canonicalPath(producer.instancePath),
    ...(producer.placement === undefined
      ? {}
      : {
          placement: Object.freeze({
            x: (producer.placement as Record<string, unknown>).x as number,
            y: (producer.placement as Record<string, unknown>).y as number,
            ...((producer.placement as Record<string, unknown>).direction === undefined
              ? {}
              : {
                  direction: (producer.placement as Record<string, unknown>).direction as number,
                }),
          }),
        }),
  };
  if (producer.kind === 'arithmetic')
    return Object.freeze({
      kind: 'arithmetic',
      ...common,
      left: canonicalArithmeticOperand(producer.left),
      operation: producer.operation as ArithmeticOperation,
      right: canonicalArithmeticOperand(producer.right),
      output: canonicalArithmeticOutput(producer.output),
    });
  if (producer.kind === 'constant')
    return Object.freeze({
      kind: 'constant',
      ...common,
      outputs: Object.freeze(
        (producer.outputs as unknown[]).map((output) => {
          const record = output as Record<string, unknown>;
          return Object.freeze({
            signal: canonicalSignal(record.signal),
            value: record.value as number,
          });
        }),
      ),
    });
  const compatibilityOutput = canonicalDeciderOutput(producer.output);
  const outputs = Object.freeze(
    (producer.outputs === undefined ? [producer.output] : (producer.outputs as unknown[])).map(
      (output) => canonicalDeciderOutput(output),
    ),
  );
  return Object.freeze({
    kind: 'decider',
    ...common,
    condition: canonicalCondition(producer.condition),
    output: outputs[0] ?? compatibilityOutput,
    outputs,
    ...(producer.elseOutputs === undefined
      ? {}
      : {
          elseOutputs: Object.freeze(
            (producer.elseOutputs as unknown[]).map((output) => canonicalDeciderOutput(output)),
          ),
        }),
  });
}

function canonicalDebugValue(value: unknown): DirectPlanDebugValue {
  const debug = value as Record<string, unknown>;
  if (debug.kind === 'network')
    return Object.freeze({ kind: 'network', network: debug.network as string });
  if (debug.kind === 'producer')
    return Object.freeze({ kind: 'producer', captureId: debug.captureId as string });
  if (debug.kind === 'undefined') return Object.freeze({ kind: 'undefined' });
  if (debug.kind === 'literal')
    return Object.freeze({
      kind: 'literal',
      value: debug.value as string | number | boolean | null,
    });
  if (debug.kind === 'array')
    return Object.freeze({
      kind: 'array',
      values: Object.freeze((debug.values as unknown[]).map((item) => canonicalDebugValue(item))),
    });
  return Object.freeze({
    kind: 'object',
    entries: Object.freeze(
      (debug.entries as unknown[]).map((entry) => {
        const record = entry as Record<string, unknown>;
        return Object.freeze({
          key: record.key as string,
          value: canonicalDebugValue(record.value),
        });
      }),
    ),
  });
}

function canonicalDiagnostic(value: unknown): Diagnostic {
  const diagnostic = value as Record<string, unknown>;
  return Object.freeze({
    code: diagnostic.code as string,
    severity: diagnostic.severity as Diagnostic['severity'],
    message: diagnostic.message as string,
    ...(diagnostic.span === undefined ? {} : { span: canonicalSpan(diagnostic.span) }),
    ...(diagnostic.related === undefined
      ? {}
      : {
          related: Object.freeze(
            (diagnostic.related as unknown[]).map((item) => {
              const related = item as Record<string, unknown>;
              return Object.freeze({
                message: related.message as string,
                span: canonicalSpan(related.span),
              });
            }),
          ),
        }),
  });
}

function canonicalPlanFromValidated(value: Record<string, unknown>): DirectElaborationPlan {
  const networks = Object.freeze(
    (value.networks as unknown[]).map((item) => {
      const network = item as Record<string, unknown>;
      return Object.freeze({
        name: network.name as string,
        ...(network.fixedColor === undefined
          ? {}
          : { fixedColor: network.fixedColor as 'red' | 'green' }),
        source: canonicalSpan(network.source),
        instancePath: canonicalPath(network.instancePath),
      });
    }),
  );
  return Object.freeze({
    format: 'comblang-direct-plan',
    version: 2,
    networks,
    ...(value.networkAliases === undefined
      ? {}
      : {
          networkAliases: Object.freeze(
            (value.networkAliases as unknown[]).map((item) => {
              const alias = item as Record<string, unknown>;
              return Object.freeze({
                name: alias.name as string,
                network: alias.network as string,
                source: canonicalSpan(alias.source),
                instancePath: canonicalPath(alias.instancePath),
                moved: alias.moved as boolean,
              });
            }),
          ),
        }),
    ...(value.networkTransfers === undefined
      ? {}
      : {
          networkTransfers: Object.freeze(
            (value.networkTransfers as unknown[]).map((item) => {
              const transfer = item as Record<string, unknown>;
              return Object.freeze({
                destination: transfer.destination as string,
                source: transfer.source as string,
                provenance: canonicalSpan(transfer.provenance),
                instancePath: canonicalPath(transfer.instancePath),
              });
            }),
          ),
        }),
    ...(value.networkPairs === undefined
      ? {}
      : {
          networkPairs: Object.freeze(
            (value.networkPairs as unknown[]).map((item) => {
              const pair = item as Record<string, unknown>;
              return Object.freeze({
                networks: Object.freeze([...(pair.networks as [string, string])]) as readonly [
                  string,
                  string,
                ],
                provenance: canonicalSpan(pair.provenance),
                instancePath: canonicalPath(pair.instancePath),
              });
            }),
          ),
        }),
    ...(value.capabilityUses === undefined
      ? {}
      : {
          capabilityUses: Object.freeze(
            (value.capabilityUses as unknown[]).map((item) => {
              const use = item as Record<string, unknown>;
              return Object.freeze({
                network: use.network as string,
                capability: use.capability as 'readonly' | 'ref' | 'move',
                parameter: use.parameter as string,
                ...(use.fixedColor === undefined
                  ? {}
                  : { fixedColor: use.fixedColor as 'red' | 'green' }),
                provenance: canonicalSpan(use.provenance),
                instancePath: canonicalPath(use.instancePath),
              });
            }),
          ),
        }),
    ...(value.debugInstances === undefined
      ? {}
      : {
          debugInstances: Object.freeze(
            (value.debugInstances as unknown[]).map((item): DirectPlanDebugInstance => {
              const instance = item as Record<string, unknown>;
              return Object.freeze({
                name: instance.name as string,
                path: canonicalPath(instance.path),
                source: canonicalSpan(instance.source),
                value: canonicalDebugValue(instance.value),
              });
            }),
          ),
        }),
    producers: Object.freeze(
      (value.producers as unknown[]).map((producer) => canonicalProducer(producer)),
    ),
    ...(value.diagnostics === undefined
      ? {}
      : {
          diagnostics: Object.freeze(
            (value.diagnostics as unknown[]).map((diagnostic) => canonicalDiagnostic(diagnostic)),
          ),
        }),
  });
}

/** Validates the versioned transport envelope before any runtime graph is allocated. */
export function validateDirectPlanEnvelope(plan: unknown): DirectPlanEnvelopeValidationResult {
  if (!isRecord(plan) || plan.format !== 'comblang-direct-plan' || plan.version !== 2)
    return failure('RT1001', 'Unsupported direct elaboration plan format.');
  if (!Array.isArray(plan.networks) || !Array.isArray(plan.producers))
    return failure('RT1001', 'Invalid direct elaboration plan envelope.');
  if (exceedsLimit(plan.networks) || exceedsLimit(plan.producers))
    return payloadFailure('$', 'top-level collection exceeds the 100000 item limit.');

  const declarations = new Map<string, DirectPlanNetwork>();
  for (const candidate of plan.networks) {
    if (
      !isRecord(candidate) ||
      typeof candidate.name !== 'string' ||
      candidate.name.length === 0 ||
      (candidate.fixedColor !== undefined &&
        candidate.fixedColor !== 'red' &&
        candidate.fixedColor !== 'green') ||
      'generation' in candidate ||
      'consumedAt' in candidate ||
      descriptorSpan(candidate, 'source') === undefined ||
      !isInstancePath(candidate.instancePath)
    )
      return failure(
        'RT1001',
        'Invalid Network descriptor in direct plan.',
        descriptorSpan(candidate, 'source'),
      );
    if (declarations.has(candidate.name))
      return failure(
        'RT1002',
        `Duplicate Network in direct plan: ${candidate.name}.`,
        candidate.source as SourceSpan,
      );
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
    if (plan[key] !== undefined && !Array.isArray(plan[key]))
      return failure('RT1001', `Invalid ${key} collection in direct plan.`);
    if (Array.isArray(plan[key]) && exceedsLimit(plan[key]))
      return failure('RT1001', `Oversized ${key} collection in direct plan.`);
  }

  for (const [index, transfer] of ((plan.networkTransfers ?? []) as unknown[]).entries()) {
    const path = `$.networkTransfers[${index}]`;
    if (!isRecord(transfer)) return payloadFailure(path, 'expected an object.');
    if (
      typeof transfer.destination !== 'string' ||
      !declarations.has(transfer.destination) ||
      typeof transfer.source !== 'string' ||
      !declarations.has(transfer.source) ||
      descriptorSpan(transfer, 'provenance') === undefined ||
      !isInstancePath(transfer.instancePath)
    )
      return payloadFailure(
        path,
        'invalid Network transfer.',
        descriptorSpan(transfer, 'provenance'),
      );
  }

  for (const [index, pair] of ((plan.networkPairs ?? []) as unknown[]).entries()) {
    const path = `$.networkPairs[${index}]`;
    if (!isRecord(pair)) return payloadFailure(path, 'expected an object.');
    const names = pair.networks;
    if (
      !Array.isArray(names) ||
      names.length !== 2 ||
      names[0] === names[1] ||
      names.some((name) => typeof name !== 'string' || !declarations.has(name)) ||
      descriptorSpan(pair, 'provenance') === undefined ||
      !isInstancePath(pair.instancePath)
    )
      return payloadFailure(path, 'invalid Network pair.', descriptorSpan(pair, 'provenance'));
  }

  const captureIds = new Set<string>();
  for (const [index, producer] of plan.producers.entries()) {
    const path = `$.producers[${index}]`;
    if (!isRecord(producer)) return payloadFailure(path, 'expected a Producer object.');
    if (
      producer.kind !== 'arithmetic' &&
      producer.kind !== 'decider' &&
      producer.kind !== 'constant'
    )
      return payloadFailure(
        `${path}.kind`,
        'unknown Producer tag.',
        descriptorSpan(producer, 'source'),
      );
    if (
      descriptorSpan(producer, 'source') === undefined ||
      !isInstancePath(producer.instancePath) ||
      !Array.isArray(producer.destinations)
    )
      return payloadFailure(
        path,
        'invalid Producer provenance or destinations.',
        descriptorSpan(producer, 'source'),
      );
    for (const [destinationIndex, destination] of producer.destinations.entries()) {
      const destinationPath = `${path}.destinations[${destinationIndex}]`;
      if (
        !isRecord(destination) ||
        typeof destination.network !== 'string' ||
        !declarations.has(destination.network) ||
        descriptorSpan(destination, 'source') === undefined ||
        !isInstancePath(destination.instancePath)
      )
        return failure(
          'RT1004',
          `${destinationPath}: invalid attachment destination.`,
          descriptorSpan(destination, 'source'),
        );
    }
    const producerSpan = producer.source as SourceSpan;
    const metadata = validateProducerMetadata(producer, path, producerSpan, captureIds);
    if (metadata !== undefined) return metadata;
    const invalid =
      producer.kind === 'arithmetic'
        ? validateArithmeticProducer(producer, path, declarations, producerSpan)
        : producer.kind === 'decider'
          ? validateDeciderProducer(producer, path, declarations, producerSpan)
          : validateConstantProducer(producer, path, producerSpan);
    if (invalid !== undefined) return invalid;
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
    )
      return failure(
        'RT1001',
        'Invalid Network alias descriptor in direct plan.',
        descriptorSpan(alias, 'source'),
      );
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
    )
      return failure(
        'RT1001',
        'Invalid capability descriptor in direct plan.',
        descriptorSpan(use, 'provenance'),
      );
  }

  for (const [index, instance] of ((plan.debugInstances ?? []) as unknown[]).entries()) {
    const path = `$.debugInstances[${index}]`;
    if (
      !isRecord(instance) ||
      typeof instance.name !== 'string' ||
      instance.name.length === 0 ||
      !isInstancePath(instance.path) ||
      descriptorSpan(instance, 'source') === undefined
    )
      return payloadFailure(path, 'invalid debug instance.', descriptorSpan(instance, 'source'));
    const invalid = validateDebugValue(
      instance.value,
      `${path}.value`,
      declarations,
      captureIds,
      instance.source as SourceSpan,
    );
    if (invalid !== undefined) return invalid;
  }

  for (const [index, diagnostic] of ((plan.diagnostics ?? []) as unknown[]).entries()) {
    const invalid = validateDiagnostic(diagnostic, `$.diagnostics[${index}]`);
    if (invalid !== undefined) return invalid;
  }

  const canonicalPlan = canonicalPlanFromValidated(plan);
  const canonicalDeclarations = new Map(
    canonicalPlan.networks.map((network) => [network.name, network]),
  );
  const canonicalAliases = canonicalPlan.networkAliases ?? Object.freeze([]);
  const canonicalCapabilityUses = canonicalPlan.capabilityUses ?? Object.freeze([]);
  return {
    value: {
      plan: canonicalPlan,
      declarations: canonicalDeclarations,
      aliases: canonicalAliases,
      capabilityUses: canonicalCapabilityUses,
    },
    diagnostics: [],
  };
}
