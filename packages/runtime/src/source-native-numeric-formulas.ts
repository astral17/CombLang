import { constantConfigurationLimits } from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';
import type {
  BlueprintNumericExpression,
  BlueprintNumericParameterExpression,
} from '../../compiler/src/blueprint-numeric-expression.js';
import {
  evaluateRegisteredBlueprintNumericExpression,
  inspectRegisteredBlueprintNumericExpression,
} from '../../compiler/src/blueprint-numeric-expression-bridge.js';
import {
  BlueprintParameterError,
  type BlueprintNumberParameterHandle,
  type BlueprintParameterSession,
} from '../../compiler/src/blueprint-parameters.js';

export interface MeasuredNativeNumericFormula {
  readonly expression: BlueprintNumericExpression;
  readonly dependencies: readonly BlueprintNumberParameterHandle[];
  readonly defaultValue: number;
  readonly key: string;
  readonly renderedBytes: number;
  readonly path: string;
  readonly source?: SourceSpan;
}

export interface NativeNumericFormulaRenderer {
  measure(expression: unknown, path: string): MeasuredNativeNumericFormula;
  renderUnique(formulas: readonly MeasuredNativeNumericFormula[]): ReadonlyMap<string, string>;
}

interface NodeMeasure {
  readonly key: number;
  readonly renderedBytes: number;
}

const int32Min = -2147483648;
const int32Max = 2147483647;
const textEncoder = new TextEncoder();

function fail(path: string, message: string, source?: SourceSpan): never {
  throw new BlueprintParameterError('CP1002', path, message, source);
}

function saturatingAdd(left: number, right: number): number {
  const limit = constantConfigurationLimits.maxBytes;
  return right > limit - left ? limit + 1 : left + right;
}

function int32(value: number): boolean {
  return Number.isInteger(value) && value >= int32Min && value <= int32Max;
}

export function createNativeNumericFormulaRenderer(
  session: BlueprintParameterSession,
  variableFor: (parameter: BlueprintNumberParameterHandle) => string | undefined,
): NativeNumericFormulaRenderer {
  const canonicalNodes = new Map<string, number>();

  function intern(key: string): number {
    const existing = canonicalNodes.get(key);
    if (existing !== undefined) return existing;
    const next = canonicalNodes.size + 1;
    canonicalNodes.set(key, next);
    return next;
  }

  function resolveVariable(
    node: BlueprintNumericParameterExpression,
    path: string,
    source?: SourceSpan,
  ): string {
    const variable = variableFor(node.parameter);
    if (variable === undefined || !/^[A-Za-z][A-Za-z0-9_]*$/.test(variable)) {
      fail(path, 'native numeric formulas require an explicit valid variable name.', source);
    }
    return variable;
  }

  function render(
    expression: BlueprintNumericExpression,
    path: string,
    source?: SourceSpan,
  ): string {
    switch (expression.kind) {
      case 'literal':
        return String(Object.is(expression.value, -0) ? 0 : expression.value);
      case 'parameter':
        return resolveVariable(expression, path, source);
      case 'negate':
        return `(-${render(expression.operand, path, source)})`;
      case 'binary': {
        if (expression.operator === 'power') {
          return `((${render(expression.left, path, source)}) ^ (${render(expression.right, path, source)}))`;
        }
        const operator = {
          add: '+',
          subtract: '-',
          multiply: '*',
          divide: '/',
        }[expression.operator];
        return `(${render(expression.left, path, source)} ${operator} ${render(expression.right, path, source)})`;
      }
    }
  }

  return Object.freeze({
    measure(expressionValue: unknown, path: string): MeasuredNativeNumericFormula {
      let inspection;
      try {
        inspection = inspectRegisteredBlueprintNumericExpression(session, expressionValue, path);
      } catch (error) {
        if (error instanceof BlueprintParameterError) {
          fail(
            path,
            'native numeric formulas require a registered expression owned by this compilation.',
            error.span,
          );
        }
        throw error;
      }
      if (
        expressionValue === null ||
        typeof expressionValue !== 'object' ||
        !('kind' in expressionValue)
      ) {
        fail(
          path,
          'native numeric formula root is not a registered expression.',
          inspection.source,
        );
      }
      const expression = expressionValue as BlueprintNumericExpression;
      const measuredNodes = new WeakMap<object, NodeMeasure>();
      const measureNode = (node: BlueprintNumericExpression): NodeMeasure => {
        const cached = measuredNodes.get(node);
        if (cached !== undefined) return cached;
        let nodeMeasure: NodeMeasure;
        switch (node.kind) {
          case 'literal': {
            if (!int32(node.value)) {
              fail(
                path,
                'native numeric formula literals must be signed int32 integers.',
                inspection.source,
              );
            }
            const normalized = Object.is(node.value, -0) ? 0 : node.value;
            const text = String(normalized);
            nodeMeasure = {
              key: intern(JSON.stringify(['literal', normalized])),
              renderedBytes: text.length,
            };
            break;
          }
          case 'parameter': {
            const variable = resolveVariable(node, path, inspection.source);
            nodeMeasure = {
              key: intern(JSON.stringify(['parameter', variable])),
              renderedBytes: textEncoder.encode(variable).byteLength,
            };
            break;
          }
          case 'negate': {
            const operand = measureNode(node.operand);
            nodeMeasure = {
              key: intern(JSON.stringify(['negate', operand.key])),
              renderedBytes: saturatingAdd(operand.renderedBytes, 3),
            };
            break;
          }
          case 'binary': {
            const left = measureNode(node.left);
            const right = measureNode(node.right);
            const renderingOverhead = node.operator === 'power' ? 9 : 5;
            nodeMeasure = {
              key: intern(JSON.stringify(['binary', node.operator, left.key, right.key])),
              renderedBytes: saturatingAdd(
                saturatingAdd(left.renderedBytes, right.renderedBytes),
                renderingOverhead,
              ),
            };
            break;
          }
        }
        measuredNodes.set(node, nodeMeasure);
        return nodeMeasure;
      };
      const root = measureNode(expression);
      if (root.renderedBytes > constantConfigurationLimits.maxBytes) {
        fail(path, 'rendered native numeric formula exceeds the byte limit.', inspection.source);
      }
      let defaultValue: number;
      try {
        defaultValue = evaluateRegisteredBlueprintNumericExpression(session, expression, []);
      } catch (error) {
        if (error instanceof BlueprintParameterError) {
          fail(
            path,
            'native numeric formula default could not be evaluated from owned defaults.',
            error.span ?? inspection.source,
          );
        }
        throw error;
      }
      if (!int32(defaultValue)) {
        fail(
          path,
          'native numeric formula defaults must evaluate to signed int32 integers.',
          inspection.source,
        );
      }
      const normalizedDefault = Object.is(defaultValue, -0) ? 0 : defaultValue;
      return Object.freeze({
        expression,
        dependencies: inspection.dependencies,
        defaultValue: normalizedDefault,
        key: `${normalizedDefault}:${root.key}`,
        renderedBytes: root.renderedBytes,
        path,
        ...(inspection.source ? { source: inspection.source } : {}),
      });
    },
    renderUnique(formulas: readonly MeasuredNativeNumericFormula[]): ReadonlyMap<string, string> {
      const unique = new Map<string, MeasuredNativeNumericFormula>();
      let totalBytes = 0;
      for (const formula of formulas) {
        if (unique.has(formula.key)) continue;
        if (formula.renderedBytes > constantConfigurationLimits.maxBytes - totalBytes) {
          fail(
            formula.path,
            'generated native numeric formula texts exceed the aggregate byte limit.',
            formula.source,
          );
        }
        totalBytes += formula.renderedBytes;
        unique.set(formula.key, formula);
      }
      const rendered = new Map<string, string>();
      for (const [key, formula] of unique) {
        const text = render(formula.expression, formula.path, formula.source);
        if (text.length !== formula.renderedBytes) {
          fail(
            formula.path,
            'native numeric formula rendering length changed after preflight.',
            formula.source,
          );
        }
        rendered.set(key, text);
      }
      return rendered;
    },
  });
}
