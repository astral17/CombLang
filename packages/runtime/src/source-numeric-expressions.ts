import type { SourceSpan } from '@comblang/shared';

import type { BlueprintNumericExpression } from '../../compiler/src/blueprint-numeric-expression.js';
import type { BlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';
import { BlueprintParameterError } from '../../compiler/src/blueprint-parameters.js';

export interface RegisteredSourceNumericExpressionView {
  readonly session: BlueprintParameterSession;
  readonly expression: BlueprintNumericExpression;
  readonly source: SourceSpan;
}

const sourceNumericExpressionViews = new WeakMap<object, RegisteredSourceNumericExpressionView>();

/** Creates a source-only opaque view; the registered host DAG never enters source artifacts. */
export function createSourceNumericExpressionView(
  session: BlueprintParameterSession,
  expression: BlueprintNumericExpression,
  source: SourceSpan,
): object {
  const rejectAccess = (): never => {
    throw new BlueprintParameterError(
      'CP1001',
      '$.expression',
      'Source numeric expression views are opaque and cannot be inspected or coerced.',
      source,
    );
  };
  const rejectCoercion = (): never => {
    throw new BlueprintParameterError(
      'CP1001',
      '$.expression',
      'Source numeric expressions are symbolic configuration values and cannot be coerced to JavaScript primitives.',
      source,
    );
  };
  const target = Object.freeze(Object.create(null) as object);
  const view = new Proxy(target, {
    get: (_target, key) => (key === Symbol.toPrimitive ? rejectCoercion() : rejectAccess()),
    set: rejectAccess,
    has: rejectAccess,
    ownKeys: rejectAccess,
    getOwnPropertyDescriptor: rejectAccess,
    defineProperty: rejectAccess,
    deleteProperty: rejectAccess,
    getPrototypeOf: rejectAccess,
    setPrototypeOf: rejectAccess,
    isExtensible: rejectAccess,
    preventExtensions: rejectAccess,
  });
  sourceNumericExpressionViews.set(
    view,
    Object.freeze({ session, expression, source: Object.freeze({ ...source }) }),
  );
  return view;
}

/** Recognizes only opaque views created by this runtime module. */
export function findSourceNumericExpressionView(
  value: unknown,
): RegisteredSourceNumericExpressionView | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null)
    return undefined;
  return sourceNumericExpressionViews.get(value);
}
