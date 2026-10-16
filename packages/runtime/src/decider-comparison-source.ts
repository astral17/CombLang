import type { SignalId } from '@comblang/factorio';
import type { PlanNetworkRef } from '@comblang/compiler/direct-plan-schema';
import type { NetworkId } from '@comblang/shared';

import { bindDeciderConfigurationTemplate } from '../../compiler/src/decider-configuration-binding.js';
import { type BlueprintNumericExpression } from '../../compiler/src/blueprint-numeric-expression.js';
import {
  BlueprintParameterError,
  findBlueprintParameterHandle,
  type BlueprintNumberParameterHandle,
  type BlueprintParameterSession,
} from '../../compiler/src/blueprint-parameters.js';
import {
  createDeciderConfigurationTemplate,
  type DeciderConfigurationTemplate,
  type DeciderTemplateCondition,
} from '../../compiler/src/decider-configuration-template.js';
import {
  isBlueprintParameterShaped,
  lookupBlueprintParameterSlot,
  type BlueprintParameterBinding,
} from '../../compiler/src/blueprint-parameter-validation.js';

import type { DeciderConstantComparisonHead } from './elaboration-operators.js';
import { findSourceNumericExpressionView } from './source-numeric-expressions.js';

type NumericComparisonRoot = BlueprintNumberParameterHandle | BlueprintNumericExpression;

export interface DeciderComparisonSourceContext {
  snapshotSignal(signal: SignalId): SignalId;
}

export interface PreparedDeciderComparisonSource {
  readonly template: DeciderConfigurationTemplate;
  readonly root: NumericComparisonRoot;
}

export class DeciderComparisonSourceError extends TypeError {
  constructor(
    readonly path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${path}: ${message}`, options);
    this.name = 'DeciderComparisonSourceError';
  }
}

function fail(path: string, message: string, cause?: unknown): never {
  throw new DeciderComparisonSourceError(
    path,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function adaptError(error: unknown): never {
  if (error instanceof DeciderComparisonSourceError) throw error;
  if (error instanceof BlueprintParameterError) {
    const detail = error.message.startsWith(`${error.path}: `)
      ? error.message.slice(error.path.length + 2)
      : error.message;
    fail('$.condition.right', detail, error);
  }
  fail(
    '$.condition.right',
    error instanceof Error ? error.message : 'invalid source numeric comparison value.',
    error,
  );
}

function comparisonRoot(
  value: unknown,
  session: BlueprintParameterSession | undefined,
): NumericComparisonRoot {
  const expressionView = findSourceNumericExpressionView(value);
  if (expressionView !== undefined) {
    if (session === undefined) {
      fail('$.condition.right', 'source numeric expressions require an owning parameter session.');
    }
    if (expressionView.session !== session) {
      fail(
        '$.condition.right',
        'source numeric expression belongs to a different parameter session.',
      );
    }
    return expressionView.expression;
  }

  if (session === undefined) {
    try {
      if (findBlueprintParameterHandle(value) !== undefined || isBlueprintParameterShaped(value)) {
        fail('$.condition.right', 'source number parameters require an owning parameter session.');
      }
    } catch (error) {
      adaptError(error);
    }
    fail('$.condition.right', 'source number parameters require an owning parameter session.');
  }

  try {
    const slot = lookupBlueprintParameterSlot(value, 'number', session, '$.condition.right');
    if (slot === undefined) {
      fail('$.condition.right', 'expected an owning number parameter or numeric expression.');
    }
    return slot.handle as BlueprintNumberParameterHandle;
  } catch (error) {
    adaptError(error);
  }
}

function networkReference(reference: PlanNetworkRef) {
  return reference.refKind === 'single'
    ? { refKind: 'single' as const, network: reference.network as NetworkId }
    : {
        refKind: 'pair' as const,
        networks: [reference.networks[0] as NetworkId, reference.networks[1] as NetworkId] as const,
      };
}

function templateCondition(
  head: DeciderConstantComparisonHead,
  root: NumericComparisonRoot,
  context: DeciderComparisonSourceContext,
): DeciderTemplateCondition {
  const reference = networkReference(head);
  const left: Extract<DeciderTemplateCondition, { kind: 'compare' }>['left'] =
    head.kind === 'compare-signal'
      ? {
          kind: 'signal',
          signal: context.snapshotSignal(head.signal),
          ...reference,
        }
      : {
          kind: 'wildcard',
          value: head.kind === 'compare-each' ? 'each' : head.wildcard,
          ...reference,
        };
  return {
    kind: 'compare',
    left,
    comparator: head.comparator,
    right: { kind: 'constant', value: root },
  };
}

/** Prepares only the authentic symbolic condition envelope; it does not bind or allocate. */
export function prepareDeciderComparisonSource(
  head: DeciderConstantComparisonHead,
  value: unknown,
  session: BlueprintParameterSession | undefined,
  context: DeciderComparisonSourceContext,
): PreparedDeciderComparisonSource {
  const root = comparisonRoot(value, session);
  if (session === undefined) {
    fail('$.condition.right', 'symbolic Decider comparisons require an owning parameter session.');
  }
  try {
    const template = createDeciderConfigurationTemplate(session, {
      condition: templateCondition(head, root, context),
      outputs: [],
    });
    return Object.freeze({ template, root });
  } catch (error) {
    adaptError(error);
  }
}

/** Binds at the source compare() boundary and returns only its validated concrete RHS. */
export function bindPreparedDeciderComparisonSource(
  prepared: PreparedDeciderComparisonSource,
  bindings: readonly BlueprintParameterBinding[] = [],
): number {
  let configuration;
  try {
    configuration = bindDeciderConfigurationTemplate(prepared.template, bindings);
  } catch (error) {
    adaptError(error);
  }
  if (configuration.outputs.length !== 0) {
    fail('$.condition.right', 'condition-only Decider template unexpectedly contains outputs.');
  }
  const condition = configuration.condition;
  if (condition.kind !== 'compare' || condition.right.kind !== 'constant') {
    fail(
      '$.condition.right',
      'condition-only Decider template did not bind a constant comparison.',
    );
  }
  return condition.right.value;
}
