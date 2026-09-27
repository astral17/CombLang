import type {
  BlueprintNumericExpression,
  BlueprintNumericExpressionInspection,
} from './blueprint-numeric-expression.js';
import type { BlueprintParameterBinding } from './blueprint-parameter-validation.js';
import type { BlueprintParameterSession } from './blueprint-parameters.js';

export interface BlueprintNumericExpressionAdapter {
  readonly isRegistered: (value: unknown) => value is BlueprintNumericExpression;
  readonly inspect: (
    session: BlueprintParameterSession,
    expression: unknown,
    path: string,
  ) => BlueprintNumericExpressionInspection;
  readonly evaluate: (
    session: BlueprintParameterSession,
    expression: BlueprintNumericExpression,
    bindings: readonly BlueprintParameterBinding[],
  ) => number;
}

let adapter: BlueprintNumericExpressionAdapter | undefined;

function requireAdapter(): BlueprintNumericExpressionAdapter {
  if (adapter === undefined) throw new Error('numeric expression adapter is not registered.');
  return adapter;
}

/** Installs the host-only expression implementation without importing it into template consumers. */
export function registerBlueprintNumericExpressionAdapter(
  candidate: BlueprintNumericExpressionAdapter,
): void {
  if (adapter === undefined) {
    adapter = Object.freeze({ ...candidate });
    return;
  }
  if (
    adapter.isRegistered === candidate.isRegistered &&
    adapter.inspect === candidate.inspect &&
    adapter.evaluate === candidate.evaluate
  ) {
    return;
  }
  throw new Error('a conflicting blueprint numeric expression adapter is already registered.');
}

export function isRegisteredBlueprintNumericExpression(
  value: unknown,
): value is BlueprintNumericExpression {
  return adapter?.isRegistered(value) ?? false;
}

export function inspectRegisteredBlueprintNumericExpression(
  session: BlueprintParameterSession,
  expression: unknown,
  path: string,
): BlueprintNumericExpressionInspection {
  return requireAdapter().inspect(session, expression, path);
}

export function evaluateRegisteredBlueprintNumericExpression(
  session: BlueprintParameterSession,
  expression: BlueprintNumericExpression,
  bindings: readonly BlueprintParameterBinding[],
): number {
  return requireAdapter().evaluate(session, expression, bindings);
}
