import ts from 'typescript';

import { Signal, signalTypes, type SignalId } from '@comblang/factorio';
import { spanForNode, type ParsedSourceFile } from '@comblang/language';
import type { Diagnostic, SourceSpan } from '@comblang/shared';

import type { ArithmeticOperation, CircuitColor, LogicalArithmeticOutput } from './ir.js';

export type PlanNetworkRef =
  | { readonly refKind: 'single'; readonly network: string }
  | { readonly refKind: 'pair'; readonly networks: readonly [string, string] };

export interface PlanAttachment {
  readonly network: string;
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
}

export interface PlanEntityPlacement {
  readonly x: number;
  readonly y: number;
  readonly direction?: number;
}

export type PlanArithmeticOperand =
  | { readonly kind: 'constant'; readonly value: number }
  | ({ readonly kind: 'signal'; readonly signal: SignalId } & PlanNetworkRef)
  | ({ readonly kind: 'each' } & PlanNetworkRef);

export type PlanComparator = '>' | '<' | '=' | '>=' | '<=' | '!=';

export type PlanDeciderCondition =
  | ({
      readonly kind: 'compare-each';
      readonly comparator: PlanComparator;
      readonly constant: number;
    } & PlanNetworkRef)
  | ({
      readonly kind: 'compare-signal';
      readonly signal: SignalId;
      readonly comparator: PlanComparator;
      readonly constant: number;
    } & PlanNetworkRef)
  | ({
      readonly kind: 'compare-wildcard';
      readonly wildcard: 'anything' | 'everything';
      readonly comparator: PlanComparator;
      readonly constant: number;
    } & PlanNetworkRef)
  | {
      readonly kind: 'compare-signals';
      readonly left: PlanNetworkRef & { readonly signal: SignalId };
      readonly comparator: PlanComparator;
      readonly right: PlanNetworkRef & { readonly signal: SignalId };
    }
  | {
      readonly kind: 'and';
      readonly conditions: readonly PlanDeciderCondition[];
    }
  | {
      readonly kind: 'or';
      readonly conditions: readonly PlanDeciderCondition[];
    };

export interface DirectPlanNetwork {
  readonly name: string;
  readonly fixedColor?: CircuitColor;
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
}

/** A zero-tick physical union. `source` is consumed and `destination` survives. */
export interface DirectPlanNetworkTransfer {
  readonly destination: string;
  readonly source: string;
  readonly provenance: SourceSpan;
  readonly instancePath: readonly string[];
}

/** A read-only input connector view whose members must use opposite wire colors. */
export interface DirectPlanNetworkPair {
  readonly networks: readonly [string, string];
  readonly provenance: SourceSpan;
  readonly instancePath: readonly string[];
}

/** An executed function-boundary capability use. This is audit metadata, not hardware. */
export interface DirectPlanCapabilityUse {
  readonly network: string;
  readonly capability: 'readonly' | 'ref' | 'move';
  readonly parameter: string;
  readonly fixedColor?: CircuitColor;
  readonly provenance: SourceSpan;
  readonly instancePath: readonly string[];
}

export interface DirectPlanArithmetic {
  readonly kind: 'arithmetic';
  readonly left: PlanArithmeticOperand;
  readonly operation: ArithmeticOperation;
  readonly right: PlanArithmeticOperand;
  readonly output: LogicalArithmeticOutput;
  readonly destinations: readonly PlanAttachment[];
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  readonly placement?: PlanEntityPlacement;
}

export interface DirectPlanDecider {
  readonly kind: 'decider';
  readonly condition: PlanDeciderCondition;
  readonly output:
    | ({ readonly kind: 'each' } & PlanNetworkRef)
    | { readonly kind: 'each-constant'; readonly value: number }
    | { readonly kind: 'signal-constant'; readonly signal: SignalId; readonly value: number }
    | ({
        readonly kind: 'wildcard';
        readonly wildcard: 'anything' | 'everything';
      } & PlanNetworkRef)
    | ({ readonly kind: 'signal'; readonly signal: SignalId } & PlanNetworkRef);
  /** Multiple native Factorio 2.x output filters. `output` remains the first-filter compatibility view. */
  readonly outputs?: readonly DirectPlanDecider['output'][];
  readonly destinations: readonly PlanAttachment[];
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  readonly placement?: PlanEntityPlacement;
}

export interface DirectPlanConstant {
  readonly kind: 'constant';
  readonly outputs: readonly { readonly signal: SignalId; readonly value: number }[];
  readonly destinations: readonly PlanAttachment[];
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  readonly placement?: PlanEntityPlacement;
}

export type DirectPlanProducer = DirectPlanArithmetic | DirectPlanDecider | DirectPlanConstant;

export interface DirectElaborationPlan {
  readonly format: 'comblang-direct-plan';
  readonly version: 2;
  readonly networks: readonly DirectPlanNetwork[];
  readonly networkTransfers?: readonly DirectPlanNetworkTransfer[];
  readonly networkPairs?: readonly DirectPlanNetworkPair[];
  readonly capabilityUses?: readonly DirectPlanCapabilityUse[];
  readonly producers: readonly DirectPlanProducer[];
  readonly diagnostics?: readonly Diagnostic[];
}

export interface DirectPlanResult {
  readonly plan?: DirectElaborationPlan;
  readonly diagnostics: readonly Diagnostic[];
}

interface ArithmeticTemplate {
  readonly parameters: readonly string[];
  readonly expression: ts.Expression;
  readonly bindings: ReadonlyMap<
    string,
    { readonly expression: ts.Expression; readonly source: SourceSpan }
  >;
  readonly localNetworks: ReadonlyMap<
    string,
    { readonly source: SourceSpan; readonly fixedColor?: CircuitColor }
  >;
  readonly producerStatements: readonly ts.ExpressionStatement[];
  readonly returnNetwork?: string;
}

type LoweredExpression =
  | { readonly kind: 'constant'; readonly value: number }
  | { readonly kind: 'network'; readonly network: string }
  | { readonly kind: 'signal'; readonly network: string; readonly signal: SignalId };

interface LoweringContext {
  readonly values: Map<string, LoweredExpression>;
  readonly resolving: Set<string>;
  readonly localNetworkPrefix: string;
  readonly instancePath: readonly string[];
}

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

function arithmeticOperation(kind: ts.SyntaxKind): ArithmeticOperation | undefined {
  switch (kind) {
    case ts.SyntaxKind.PlusToken:
      return 'add';
    case ts.SyntaxKind.MinusToken:
      return 'subtract';
    case ts.SyntaxKind.AsteriskToken:
      return 'multiply';
    case ts.SyntaxKind.SlashToken:
      return 'divide';
    case ts.SyntaxKind.PercentToken:
      return 'modulo';
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return 'power';
    case ts.SyntaxKind.LessThanLessThanToken:
      return 'left-shift';
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      return 'right-shift';
    case ts.SyntaxKind.AmpersandToken:
      return 'bit-and';
    case ts.SyntaxKind.BarToken:
      return 'bit-or';
    case ts.SyntaxKind.CaretToken:
      return 'bit-xor';
    default:
      return undefined;
  }
}

function comparator(kind: ts.SyntaxKind): PlanComparator | undefined {
  switch (kind) {
    case ts.SyntaxKind.GreaterThanToken:
      return '>';
    case ts.SyntaxKind.LessThanToken:
      return '<';
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return '>=';
    case ts.SyntaxKind.LessThanEqualsToken:
      return '<=';
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
      return '=';
    case ts.SyntaxKind.ExclamationEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      return '!=';
    default:
      return undefined;
  }
}

function invertComparator(value: PlanComparator): PlanComparator {
  switch (value) {
    case '>':
      return '<=';
    case '<':
      return '>=';
    case '=':
      return '!=';
    case '>=':
      return '<';
    case '<=':
      return '>';
    case '!=':
      return '=';
  }
}

function reverseComparator(value: PlanComparator): PlanComparator {
  switch (value) {
    case '>':
      return '<';
    case '<':
      return '>';
    case '=':
      return '=';
    case '>=':
      return '<=';
    case '<=':
      return '>=';
    case '!=':
      return '!=';
  }
}

function networkColor(expression: ts.NewExpression): CircuitColor | undefined {
  const argument = expression.typeArguments?.[0]?.getText();
  return argument === 'R' ? 'red' : argument === 'G' ? 'green' : undefined;
}

function isNetworkType(node: ts.TypeNode | undefined): boolean {
  if (node === undefined) return false;
  const text = node.getText().replaceAll(/\s/g, '');
  return /^Network(?:<.+>)?$/.test(text) || /^Readonly<Network(?:<.+>)?>$/.test(text);
}

function wildcardKind(text: string): 'anything' | 'everything' | undefined {
  switch (text) {
    case 'Anything':
    case 'ANYTHING':
    case 'Any':
    case 'ANY':
      return 'anything';
    case 'Everything':
    case 'EVERYTHING':
    case 'All':
    case 'ALL':
      return 'everything';
    default:
      return undefined;
  }
}

function numericLiteral(expression: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expression.operand)
  ) {
    return -Number(expression.operand.text);
  }
  return undefined;
}

function sameSignal(left: SignalId, right: SignalId): boolean {
  return (
    left.type === right.type &&
    left.name === right.name &&
    (left.quality ?? 'normal') === (right.quality ?? 'normal')
  );
}

function foldCompileTimeInteger(
  operation: ArithmeticOperation,
  left: number,
  right: number,
): number | undefined {
  if ((operation === 'divide' || operation === 'modulo') && right === 0) return undefined;

  let result: number;
  switch (operation) {
    case 'add':
      result = left + right;
      break;
    case 'subtract':
      result = left - right;
      break;
    case 'multiply':
      result = left * right;
      break;
    case 'divide':
      result = left / right;
      break;
    case 'modulo':
      result = left % right;
      break;
    case 'power':
      result = left ** right;
      break;
    case 'left-shift':
      result = left << right;
      break;
    case 'right-shift':
      result = left >> right;
      break;
    case 'bit-and':
      result = left & right;
      break;
    case 'bit-or':
      result = left | right;
      break;
    case 'bit-xor':
      result = left ^ right;
      break;
  }
  return Number.isSafeInteger(result) ? result : undefined;
}

function functionTemplate(
  file: ParsedSourceFile,
  declaration: ts.FunctionDeclaration,
): ArithmeticTemplate | undefined {
  if (
    declaration.parameters.length === 0 ||
    declaration.parameters.length > 2 ||
    declaration.body === undefined ||
    !declaration.parameters.every(
      (parameter) => ts.isIdentifier(parameter.name) && isNetworkType(parameter.type),
    )
  ) {
    return undefined;
  }
  const returns = declaration.body.statements.filter(ts.isReturnStatement);
  if (returns.length !== 1 || returns[0]?.expression === undefined) return undefined;
  const expression = returns[0].expression;
  const bindings = new Map<
    string,
    { readonly expression: ts.Expression; readonly source: SourceSpan }
  >();
  const localNetworks = new Map<
    string,
    { readonly source: SourceSpan; readonly fixedColor?: CircuitColor }
  >();
  const producerStatements: ts.ExpressionStatement[] = [];
  for (const statement of declaration.body.statements) {
    if (statement === returns[0]) break;
    if (ts.isExpressionStatement(statement)) {
      producerStatements.push(statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const binding of statement.declarationList.declarations) {
      if (!ts.isIdentifier(binding.name) || binding.initializer === undefined) continue;
      if (
        ts.isNewExpression(binding.initializer) &&
        ts.isIdentifier(binding.initializer.expression) &&
        binding.initializer.expression.text === 'Network'
      ) {
        const fixedColor = networkColor(binding.initializer);
        localNetworks.set(binding.name.text, {
          source: spanForNode(file, binding),
          ...(fixedColor === undefined ? {} : { fixedColor }),
        });
      } else if ((statement.declarationList.flags & ts.NodeFlags.Const) !== 0) {
        bindings.set(binding.name.text, {
          expression: binding.initializer,
          source: spanForNode(file, binding),
        });
      }
    }
  }
  const structural = localNetworks.size > 0 || producerStatements.length > 0;
  const returnNetwork =
    structural && ts.isIdentifier(expression) && localNetworks.has(expression.text)
      ? expression.text
      : undefined;
  if (structural && returnNetwork === undefined) return undefined;
  return {
    parameters: declaration.parameters.map((parameter) => (parameter.name as ts.Identifier).text),
    expression,
    bindings,
    localNetworks,
    producerStatements,
    ...(returnNetwork === undefined ? {} : { returnNetwork }),
  };
}

/** Compiles the intentionally tiny Phase 3 subset without evaluating source code. */
export function compileDirectPlan(file: ParsedSourceFile): DirectPlanResult {
  const diagnostics: Diagnostic[] = [];
  const networks: DirectPlanNetwork[] = [];
  const networkNames = new Set<string>();
  const signals = new Map<string, SignalId>();
  const templates = new Map<string, ArithmeticTemplate>();
  const declaredFunctions = new Map<string, ts.FunctionDeclaration>();
  let temporaryNetworkOrdinal = 0;
  let functionCallOrdinal = 0;
  let directProducerOrdinal = 0;

  for (const statement of file.ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      declaredFunctions.set(statement.name.text, statement);
      const template = functionTemplate(file, statement);
      if (template !== undefined) templates.set(statement.name.text, template);
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined &&
        ts.isCallExpression(declaration.initializer) &&
        ts.isIdentifier(declaration.initializer.expression) &&
        declaration.initializer.expression.text === 'Signal'
      ) {
        const [typeOrNameNode, nameNode, qualityNode] = declaration.initializer.arguments;
        if (
          typeOrNameNode !== undefined &&
          nameNode === undefined &&
          ts.isStringLiteral(typeOrNameNode)
        ) {
          signals.set(declaration.name.text, Signal(typeOrNameNode.text));
        } else if (
          typeOrNameNode !== undefined &&
          nameNode !== undefined &&
          ts.isStringLiteral(typeOrNameNode) &&
          ts.isStringLiteral(nameNode) &&
          (qualityNode === undefined || ts.isStringLiteral(qualityNode)) &&
          signalTypes.includes(typeOrNameNode.text as (typeof signalTypes)[number])
        ) {
          signals.set(
            declaration.name.text,
            Signal(
              typeOrNameNode.text as (typeof signalTypes)[number],
              nameNode.text,
              qualityNode?.text,
            ),
          );
        } else {
          diagnostics.push({
            code: 'CL1019',
            severity: 'error',
            message:
              'Signal requires an item name, or an explicit valid type, name, and optional quality string.',
            span: spanForNode(file, declaration.initializer),
          });
        }
        continue;
      }
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.initializer === undefined ||
        !ts.isNewExpression(declaration.initializer) ||
        declaration.initializer.expression.getText(file.ast) !== 'Network'
      ) {
        continue;
      }
      const name = declaration.name.text;
      networkNames.add(name);
      const fixedColor = networkColor(declaration.initializer);
      networks.push({
        name,
        ...(fixedColor === undefined ? {} : { fixedColor }),
        source: spanForNode(file, declaration),
        instancePath: [],
      });
    }
  }

  const producers: DirectPlanProducer[] = [];

  const lowerExpression = (
    expression: ts.Expression,
    template: ArithmeticTemplate,
    argumentNetworks: ReadonlyMap<string, string>,
    context: LoweringContext,
    destination?: readonly PlanAttachment[],
    requestedOutputSignal?: SignalId,
  ): LoweredExpression | undefined => {
    if (ts.isParenthesizedExpression(expression)) {
      return lowerExpression(
        expression.expression,
        template,
        argumentNetworks,
        context,
        destination,
        requestedOutputSignal,
      );
    }
    if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === 'as'
    ) {
      const receiver = expression.expression.expression;
      if (
        ts.isCallExpression(receiver) &&
        ts.isIdentifier(receiver.expression) &&
        declaredFunctions.has(receiver.expression.text)
      ) {
        diagnostics.push({
          code: 'CL1043',
          severity: 'error',
          message: `.as(SIGNAL) cannot cross the Network return boundary of ${receiver.expression.text}(...); bind the producer output inside that function.`,
          span: spanForNode(file, expression),
        });
        return undefined;
      }
      const signalExpression = expression.arguments[0];
      const selectedSignal =
        expression.arguments.length === 1 &&
        signalExpression !== undefined &&
        ts.isIdentifier(signalExpression)
          ? signals.get(signalExpression.text)
          : undefined;
      if (selectedSignal === undefined) {
        diagnostics.push({
          code: 'CL1031',
          severity: 'error',
          message: '.as(...) requires exactly one declared Signal identifier.',
          span: spanForNode(file, expression),
        });
        return undefined;
      }
      if (
        requestedOutputSignal !== undefined &&
        !sameSignal(requestedOutputSignal, selectedSignal)
      ) {
        diagnostics.push({
          code: 'CL1032',
          severity: 'error',
          message: 'The producer .as(...) Signal conflicts with its destination Signal.',
          span: spanForNode(file, expression),
        });
        return undefined;
      }
      return lowerExpression(
        expression.expression.expression,
        template,
        argumentNetworks,
        context,
        destination,
        selectedSignal,
      );
    }
    if (ts.isIdentifier(expression) && argumentNetworks.has(expression.text)) {
      return { kind: 'network', network: argumentNetworks.get(expression.text)! };
    }
    if (ts.isIdentifier(expression) && networkNames.has(expression.text)) {
      return { kind: 'network', network: expression.text };
    }
    if (ts.isIdentifier(expression) && template.bindings.has(expression.text)) {
      const cached = context.values.get(expression.text);
      if (cached !== undefined) return cached;
      if (context.resolving.has(expression.text)) {
        diagnostics.push({
          code: 'CL1010',
          severity: 'error',
          message: `Circular local binding: ${expression.text}.`,
          span: spanForNode(file, expression),
        });
        return undefined;
      }
      const binding = template.bindings.get(expression.text)!;
      const localNetwork = `${context.localNetworkPrefix}:${expression.text}`;
      const bindingDestination = destination ?? [
        {
          network: localNetwork,
          source: binding.source,
          instancePath: context.instancePath,
        },
      ];
      context.resolving.add(expression.text);
      const value = lowerExpression(
        binding.expression,
        template,
        argumentNetworks,
        context,
        bindingDestination,
        requestedOutputSignal,
      );
      context.resolving.delete(expression.text);
      if (value !== undefined) {
        context.values.set(expression.text, value);
        if (
          destination === undefined &&
          value.kind === 'network' &&
          value.network === localNetwork
        ) {
          networkNames.add(localNetwork);
          networks.push({
            name: localNetwork,
            source: binding.source,
            instancePath: context.instancePath,
          });
        }
      }
      return value;
    }
    if (ts.isElementAccessExpression(expression)) {
      const base = lowerExpression(expression.expression, template, argumentNetworks, context);
      const signalName = expression.argumentExpression;
      if (base?.kind === 'network' && ts.isIdentifier(signalName) && signalName.text === 'EACH') {
        return base;
      }
      const selectedSignal = ts.isIdentifier(signalName) ? signals.get(signalName.text) : undefined;
      if (base?.kind !== 'network' || selectedSignal === undefined) {
        diagnostics.push({
          code: 'CL1019',
          severity: 'error',
          message: 'A Network signal access requires a declared Signal identifier.',
          span: spanForNode(file, expression),
        });
        return undefined;
      }
      return { kind: 'signal', network: base.network, signal: selectedSignal };
    }
    if (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'Each'
    ) {
      const selected =
        expression.arguments.length === 1
          ? lowerExpression(expression.arguments[0]!, template, argumentNetworks, context)
          : undefined;
      if (selected?.kind !== 'network') {
        diagnostics.push({
          code: 'CL1028',
          severity: 'error',
          message: 'Each(...) requires exactly one Network value.',
          span: spanForNode(file, expression),
        });
        return undefined;
      }
      return selected;
    }
    if (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'CC'
    ) {
      if (requestedOutputSignal !== undefined) {
        diagnostics.push({
          code: 'CL1026',
          severity: 'error',
          message: 'CC outputs already declare their Signal identities and cannot be rebound.',
          span: spanForNode(file, expression),
        });
        return undefined;
      }
      const constantOutputs: { readonly signal: SignalId; readonly value: number }[] = [];
      for (const argument of expression.arguments) {
        const value = ts.isParenthesizedExpression(argument) ? argument.expression : argument;
        if (
          !ts.isBinaryExpression(value) ||
          value.operatorToken.kind !== ts.SyntaxKind.AsteriskToken
        ) {
          diagnostics.push({
            code: 'CL1024',
            severity: 'error',
            message: 'Each CC entry must be an int32 count multiplied by a declared Signal.',
            span: spanForNode(file, argument),
          });
          return undefined;
        }
        const leftCount = numericLiteral(value.left);
        const rightCount = numericLiteral(value.right);
        const leftSignal = ts.isIdentifier(value.left) ? signals.get(value.left.text) : undefined;
        const rightSignal = ts.isIdentifier(value.right)
          ? signals.get(value.right.text)
          : undefined;
        const count = leftCount ?? rightCount;
        const outputSignal = leftSignal ?? rightSignal;
        if (
          count === undefined ||
          outputSignal === undefined ||
          count < INT32_MIN ||
          count > INT32_MAX
        ) {
          diagnostics.push({
            code: 'CL1024',
            severity: 'error',
            message: 'Each CC entry must be an int32 count multiplied by a declared Signal.',
            span: spanForNode(file, argument),
          });
          return undefined;
        }
        constantOutputs.push({ signal: outputSignal, value: count });
      }
      if (constantOutputs.length === 0) {
        diagnostics.push({
          code: 'CL1024',
          severity: 'error',
          message: 'CC requires at least one count * Signal entry.',
          span: spanForNode(file, expression),
        });
        return undefined;
      }
      const signalKeys = constantOutputs.map(
        ({ signal }) => `${signal.type}:${signal.name}:${signal.quality ?? ''}`,
      );
      if (new Set(signalKeys).size !== signalKeys.length) {
        diagnostics.push({
          code: 'CL1025',
          severity: 'error',
          message: 'A CC declaration cannot contain the same Signal more than once.',
          span: spanForNode(file, expression),
        });
        return undefined;
      }

      let attachments = destination;
      if (attachments === undefined) {
        temporaryNetworkOrdinal += 1;
        const outputNetwork = `$tmp:${temporaryNetworkOrdinal}`;
        networkNames.add(outputNetwork);
        networks.push({
          name: outputNetwork,
          source: spanForNode(file, expression),
          instancePath: context.instancePath,
        });
        attachments = [
          {
            network: outputNetwork,
            source: spanForNode(file, expression),
            instancePath: context.instancePath,
          },
        ];
      }
      producers.push({
        kind: 'constant',
        outputs: constantOutputs,
        destinations: attachments,
        source: spanForNode(file, expression),
        instancePath: context.instancePath,
      });
      return { kind: 'network', network: attachments[0]!.network };
    }
    let compactDecider:
      | {
          readonly form: 'IF' | 'when(...).then';
          readonly condition: ts.Expression | undefined;
          readonly output: ts.Expression | undefined;
          readonly validArity: boolean;
        }
      | undefined;
    if (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'IF'
    ) {
      compactDecider = {
        form: 'IF',
        condition: expression.arguments[0],
        output: expression.arguments[1],
        validArity: expression.arguments.length === 2,
      };
    } else if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === 'then' &&
      ts.isCallExpression(expression.expression.expression) &&
      ts.isIdentifier(expression.expression.expression.expression) &&
      expression.expression.expression.expression.text === 'when'
    ) {
      const whenCall = expression.expression.expression;
      compactDecider = {
        form: 'when(...).then',
        condition: whenCall.arguments[0],
        output: expression.arguments[0],
        validArity: whenCall.arguments.length === 1 && expression.arguments.length === 1,
      };
    }
    if (compactDecider !== undefined) {
      const conditionExpression = compactDecider.condition;
      const outputExpression = compactDecider.output;
      if (
        !compactDecider.validArity ||
        conditionExpression === undefined ||
        outputExpression === undefined
      ) {
        diagnostics.push({
          code: 'CL1013',
          severity: 'error',
          message: `${compactDecider.form} requires one condition and one Network output.`,
          span: spanForNode(file, expression),
        });
        return undefined;
      }
      let conditionCount = 0;
      let groupCount = 0;
      const lowerCondition = (
        node: ts.Expression,
        negated = false,
      ): PlanDeciderCondition | undefined => {
        if (ts.isParenthesizedExpression(node)) return lowerCondition(node.expression, negated);
        if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
          return lowerCondition(node.operand, !negated);
        }
        if (!ts.isBinaryExpression(node)) return undefined;
        const sourceGroupKind =
          node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
            ? 'and'
            : node.operatorToken.kind === ts.SyntaxKind.BarBarToken
              ? 'or'
              : undefined;
        if (sourceGroupKind !== undefined) {
          const groupKind = negated ? (sourceGroupKind === 'and' ? 'or' : 'and') : sourceGroupKind;
          const left = lowerCondition(node.left, negated);
          const right = lowerCondition(node.right, negated);
          if (left === undefined || right === undefined) return undefined;
          groupCount += 1;
          const conditions = [left, right].flatMap((condition) =>
            condition.kind === groupKind ? condition.conditions : [condition],
          );
          return { kind: groupKind, conditions };
        }

        const comparison = comparator(node.operatorToken.kind);
        const wildcardSelection = (
          expression: ts.Expression,
        ):
          | { readonly network: string; readonly wildcard: 'anything' | 'everything' }
          | undefined => {
          const selected = ts.isParenthesizedExpression(expression)
            ? expression.expression
            : expression;
          let wildcard: 'anything' | 'everything' | undefined;
          let networkExpression: ts.Expression | undefined;
          if (
            ts.isCallExpression(selected) &&
            ts.isIdentifier(selected.expression) &&
            selected.arguments.length === 1
          ) {
            wildcard = wildcardKind(selected.expression.text);
            networkExpression = selected.arguments[0];
          } else if (
            ts.isElementAccessExpression(selected) &&
            ts.isIdentifier(selected.argumentExpression)
          ) {
            wildcard = wildcardKind(selected.argumentExpression.text);
            networkExpression = selected.expression;
          }
          if (wildcard === undefined || networkExpression === undefined) return undefined;
          const network = lowerExpression(networkExpression, template, argumentNetworks, context);
          return network?.kind === 'network' ? { network: network.network, wildcard } : undefined;
        };
        const leftWildcard = wildcardSelection(node.left);
        const rightWildcard = wildcardSelection(node.right);
        const leftLiteral = numericLiteral(node.left);
        const rightLiteral = numericLiteral(node.right);
        const normalizedWildcard =
          leftWildcard !== undefined && rightLiteral !== undefined
            ? { selection: leftWildcard, constant: rightLiteral, comparison }
            : rightWildcard !== undefined && leftLiteral !== undefined
              ? {
                  selection: rightWildcard,
                  constant: leftLiteral,
                  comparison: comparison === undefined ? undefined : reverseComparator(comparison),
                }
              : undefined;
        if (normalizedWildcard?.comparison !== undefined) {
          if (normalizedWildcard.constant < INT32_MIN || normalizedWildcard.constant > INT32_MAX) {
            diagnostics.push({
              code: 'CL1008',
              severity: 'error',
              message: `Circuit constant ${normalizedWildcard.constant} is outside the signed int32 range; use an explicit wrapping operation when that syntax is available.`,
              span: spanForNode(file, leftWildcard === undefined ? node.left : node.right),
            });
            return undefined;
          }
          conditionCount += 1;
          return {
            kind: 'compare-wildcard',
            refKind: 'single',
            network: normalizedWildcard.selection.network,
            wildcard: normalizedWildcard.selection.wildcard,
            comparator: negated
              ? invertComparator(normalizedWildcard.comparison)
              : normalizedWildcard.comparison,
            constant: normalizedWildcard.constant,
          };
        }
        const left = lowerExpression(node.left, template, argumentNetworks, context);
        const right = lowerExpression(node.right, template, argumentNetworks, context);
        if (comparison === undefined || left === undefined || right === undefined) return undefined;
        const signalComparison =
          left.kind === 'signal' && right.kind === 'signal'
            ? {
                kind: 'compare-signals' as const,
                left: { refKind: 'single' as const, network: left.network, signal: left.signal },
                comparator: negated ? invertComparator(comparison) : comparison,
                right: { refKind: 'single' as const, network: right.network, signal: right.signal },
              }
            : undefined;
        if (signalComparison !== undefined) {
          conditionCount += 1;
          return signalComparison;
        }
        const normalized =
          (left.kind === 'network' || left.kind === 'signal') && right.kind === 'constant'
            ? {
                operand: left,
                constant: right.value,
                comparison,
                constantExpression: node.right,
              }
            : left.kind === 'constant' && (right.kind === 'network' || right.kind === 'signal')
              ? {
                  operand: right,
                  constant: left.value,
                  comparison: reverseComparator(comparison),
                  constantExpression: node.left,
                }
              : undefined;
        if (normalized === undefined) return undefined;
        if (normalized.constant < INT32_MIN || normalized.constant > INT32_MAX) {
          diagnostics.push({
            code: 'CL1008',
            severity: 'error',
            message: `Circuit constant ${normalized.constant} is outside the signed int32 range; use an explicit wrapping operation when that syntax is available.`,
            span: spanForNode(file, normalized.constantExpression),
          });
          return undefined;
        }
        conditionCount += 1;
        const normalizedComparator = negated
          ? invertComparator(normalized.comparison)
          : normalized.comparison;
        return normalized.operand.kind === 'signal'
          ? {
              kind: 'compare-signal',
              refKind: 'single',
              network: normalized.operand.network,
              signal: normalized.operand.signal,
              comparator: normalizedComparator,
              constant: normalized.constant,
            }
          : {
              kind: 'compare-each',
              refKind: 'single',
              network: normalized.operand.network,
              comparator: normalizedComparator,
              constant: normalized.constant,
            };
      };
      const condition = lowerCondition(conditionExpression);
      const unwrappedOutput = ts.isParenthesizedExpression(outputExpression)
        ? outputExpression.expression
        : outputExpression;
      const constantEachCandidate =
        ts.isBinaryExpression(unwrappedOutput) &&
        unwrappedOutput.operatorToken.kind === ts.SyntaxKind.AsteriskToken
          ? ts.isIdentifier(unwrappedOutput.left) && unwrappedOutput.left.text === 'EACH'
            ? numericLiteral(unwrappedOutput.right)
            : ts.isIdentifier(unwrappedOutput.right) && unwrappedOutput.right.text === 'EACH'
              ? numericLiteral(unwrappedOutput.left)
              : undefined
          : undefined;
      const mentionsEach =
        ts.isBinaryExpression(unwrappedOutput) &&
        ((ts.isIdentifier(unwrappedOutput.left) && unwrappedOutput.left.text === 'EACH') ||
          (ts.isIdentifier(unwrappedOutput.right) && unwrappedOutput.right.text === 'EACH'));
      if (
        mentionsEach &&
        (constantEachCandidate === undefined ||
          constantEachCandidate < INT32_MIN ||
          constantEachCandidate > INT32_MAX)
      ) {
        diagnostics.push({
          code: 'CL1027',
          severity: 'error',
          message: 'A constant EACH output must be a signed int32 literal multiplied by EACH.',
          span: spanForNode(file, outputExpression),
        });
        return undefined;
      }
      const wildcardOutput = (() => {
        let wildcard: 'anything' | 'everything' | undefined;
        let networkExpression: ts.Expression | undefined;
        if (
          ts.isCallExpression(unwrappedOutput) &&
          ts.isIdentifier(unwrappedOutput.expression) &&
          unwrappedOutput.arguments.length === 1
        ) {
          wildcard = wildcardKind(unwrappedOutput.expression.text);
          networkExpression = unwrappedOutput.arguments[0];
        } else if (
          ts.isElementAccessExpression(unwrappedOutput) &&
          ts.isIdentifier(unwrappedOutput.argumentExpression)
        ) {
          wildcard = wildcardKind(unwrappedOutput.argumentExpression.text);
          networkExpression = unwrappedOutput.expression;
        }
        if (wildcard === undefined || networkExpression === undefined) return undefined;
        const network = lowerExpression(networkExpression, template, argumentNetworks, context);
        return network?.kind === 'network' ? { network: network.network, wildcard } : undefined;
      })();
      const output =
        constantEachCandidate === undefined && wildcardOutput === undefined
          ? lowerExpression(outputExpression, template, argumentNetworks, context)
          : undefined;
      const copyOutput =
        output?.kind === 'network' || output?.kind === 'signal' ? output : undefined;
      if (
        condition === undefined ||
        (constantEachCandidate === undefined &&
          wildcardOutput === undefined &&
          copyOutput === undefined)
      ) {
        diagnostics.push({
          code: 'CL1014',
          severity: 'error',
          message:
            'This IF slice supports Network values compared with an int32 constant or two explicit Network[Signal] values, plus a matching Network output form.',
          span: spanForNode(file, expression),
        });
        return undefined;
      }
      if (conditionCount > 64 || groupCount > 16) {
        diagnostics.push({
          code: 'CL1015',
          severity: 'error',
          message: `IF condition expansion exceeds the current limit of 64 comparisons and 16 boolean groups.`,
          span: spanForNode(file, conditionExpression),
        });
        return undefined;
      }
      const conditionUsesEach = (value: PlanDeciderCondition): boolean =>
        value.kind === 'compare-each' ||
        ((value.kind === 'and' || value.kind === 'or') && value.conditions.some(conditionUsesEach));
      if (
        !conditionUsesEach(condition) &&
        requestedOutputSignal === undefined &&
        (constantEachCandidate !== undefined || copyOutput?.kind === 'network')
      ) {
        diagnostics.push({
          code: 'CL1029',
          severity: 'error',
          message:
            'An EACH output requires an Each condition; Anything, Everything, and specific-signal conditions need a specific output Signal.',
          span: spanForNode(file, outputExpression),
        });
        return undefined;
      }
      if (
        wildcardOutput !== undefined &&
        (requestedOutputSignal !== undefined ||
          (wildcardOutput.wildcard === 'everything' && conditionUsesEach(condition)))
      ) {
        diagnostics.push({
          code: 'CL1030',
          severity: 'error',
          message:
            requestedOutputSignal !== undefined
              ? 'An explicit Anything or Everything output cannot be rebound to a destination Signal.'
              : 'An Everything output is invalid when the condition uses Each.',
          span: spanForNode(file, outputExpression),
        });
        return undefined;
      }

      let attachments = destination;
      if (attachments === undefined) {
        temporaryNetworkOrdinal += 1;
        const outputNetwork = `$tmp:${temporaryNetworkOrdinal}`;
        networkNames.add(outputNetwork);
        networks.push({
          name: outputNetwork,
          source: spanForNode(file, expression),
          instancePath: context.instancePath,
        });
        attachments = [
          {
            network: outputNetwork,
            source: spanForNode(file, expression),
            instancePath: context.instancePath,
          },
        ];
      }
      let deciderOutput: DirectPlanDecider['output'];
      if (constantEachCandidate !== undefined) {
        deciderOutput = { kind: 'each-constant', value: constantEachCandidate };
      } else if (wildcardOutput !== undefined) {
        deciderOutput = { kind: 'wildcard', refKind: 'single', ...wildcardOutput };
      } else if (copyOutput?.kind === 'signal') {
        deciderOutput = {
          kind: 'signal',
          refKind: 'single',
          network: copyOutput.network,
          signal: requestedOutputSignal ?? copyOutput.signal,
        };
      } else if (requestedOutputSignal !== undefined) {
        deciderOutput = {
          kind: 'signal',
          refKind: 'single',
          network: copyOutput!.network,
          signal: requestedOutputSignal,
        };
      } else {
        deciderOutput = { kind: 'each', refKind: 'single', network: copyOutput!.network };
      }
      producers.push({
        kind: 'decider',
        condition,
        output: deciderOutput,
        destinations: attachments,
        source: spanForNode(file, expression),
        instancePath: context.instancePath,
      });
      return { kind: 'network', network: attachments[0]!.network };
    }
    const literal = numericLiteral(expression);
    if (literal !== undefined) {
      if (!Number.isSafeInteger(literal)) {
        diagnostics.push({
          code: 'CL1007',
          severity: 'error',
          message: 'Compile-time numeric values must be safe integers.',
          span: spanForNode(file, expression),
        });
        return undefined;
      }
      return { kind: 'constant', value: literal };
    }
    if (!ts.isBinaryExpression(expression)) {
      diagnostics.push({
        code: 'CL1003',
        severity: 'error',
        message:
          'Only arithmetic expressions over the Network parameter and integer literals are supported.',
        span: spanForNode(file, expression),
      });
      return undefined;
    }
    const operation = arithmeticOperation(expression.operatorToken.kind);
    if (operation === undefined) {
      diagnostics.push({
        code: 'CL1004',
        severity: 'error',
        message: `Unsupported circuit arithmetic operator: ${expression.operatorToken.getText(file.ast)}.`,
        span: spanForNode(file, expression.operatorToken),
      });
      return undefined;
    }
    const left = lowerExpression(expression.left, template, argumentNetworks, context);
    const right = lowerExpression(expression.right, template, argumentNetworks, context);
    if (left === undefined || right === undefined) return undefined;
    if (left.kind === 'constant' && right.kind === 'constant') {
      const value = foldCompileTimeInteger(operation, left.value, right.value);
      if (value === undefined) {
        diagnostics.push({
          code: 'CL1007',
          severity: 'error',
          message:
            'Compile-time arithmetic must produce a safe integer and cannot divide or take modulo by zero.',
          span: spanForNode(file, expression),
        });
        return undefined;
      }
      return { kind: 'constant', value };
    }
    const constant =
      left.kind === 'constant' ? left.value : right.kind === 'constant' ? right.value : undefined;
    if (constant !== undefined && (constant < INT32_MIN || constant > INT32_MAX)) {
      diagnostics.push({
        code: 'CL1008',
        severity: 'error',
        message: `Circuit constant ${constant} is outside the signed int32 range; use an explicit wrapping operation when that syntax is available.`,
        span: spanForNode(file, expression),
      });
      return undefined;
    }

    let attachments = destination;
    if (attachments === undefined) {
      temporaryNetworkOrdinal += 1;
      const outputNetwork = `$tmp:${temporaryNetworkOrdinal}`;
      networkNames.add(outputNetwork);
      networks.push({
        name: outputNetwork,
        source: spanForNode(file, expression),
        instancePath: context.instancePath,
      });
      attachments = [
        {
          network: outputNetwork,
          source: spanForNode(file, expression),
          instancePath: context.instancePath,
        },
      ];
    }
    const operand = (value: LoweredExpression): PlanArithmeticOperand =>
      value.kind === 'constant'
        ? value
        : value.kind === 'signal'
          ? { kind: 'signal', refKind: 'single', network: value.network, signal: value.signal }
          : { kind: 'each', refKind: 'single', network: value.network };
    const inferredOutputSignal =
      requestedOutputSignal ??
      (left.kind === 'signal' ? left.signal : right.kind === 'signal' ? right.signal : undefined);
    producers.push({
      kind: 'arithmetic',
      left: operand(left),
      operation,
      right: operand(right),
      output:
        inferredOutputSignal === undefined
          ? { kind: 'each' }
          : { kind: 'signal', signal: inferredOutputSignal },
      destinations: attachments,
      source: spanForNode(file, expression),
      instancePath: context.instancePath,
    });
    return { kind: 'network', network: attachments[0]!.network };
  };

  const lowerFunctionCall = (
    call: ts.CallExpression,
    destinations: readonly string[],
    destinationSource: SourceSpan,
    createDestination: boolean,
    requestedOutputSignal?: SignalId,
  ): void => {
    if (!ts.isIdentifier(call.expression)) return;
    const template = templates.get(call.expression.text);
    if (template === undefined) {
      diagnostics.push({
        code: declaredFunctions.has(call.expression.text) ? 'CL1033' : 'CL1001',
        severity: 'error',
        message: declaredFunctions.has(call.expression.text)
          ? `Unsupported circuit function body in ${call.expression.text}; a structural function requires Network parameters, supported producer statements, and one explicit returned local Network.`
          : 'A supported circuit function requires one or two declared Network arguments matching its parameters.',
        span: spanForNode(file, call),
      });
      return;
    }
    if (
      call.arguments.length !== template.parameters.length ||
      !call.arguments.every(ts.isIdentifier)
    ) {
      diagnostics.push({
        code: 'CL1001',
        severity: 'error',
        message:
          'A supported circuit function requires one or two declared Network arguments matching its parameters.',
        span: spanForNode(file, call),
      });
      return;
    }
    const argumentsByParameter = new Map<string, string>();
    for (const [index, parameter] of template.parameters.entries()) {
      const argument = call.arguments[index] as ts.Identifier;
      if (!networkNames.has(argument.text)) {
        diagnostics.push({
          code: 'CL1002',
          severity: 'error',
          message: `Unknown input Network: ${argument.text}.`,
          span: spanForNode(file, argument),
        });
        return;
      }
      argumentsByParameter.set(parameter, argument.text);
    }
    if (
      destinations.length === 0 ||
      destinations.length > 2 ||
      new Set(destinations).size !== destinations.length
    ) {
      diagnostics.push({
        code: 'CL1021',
        severity: 'error',
        message: 'A producer output requires one or two distinct destination Networks.',
        span: destinationSource,
      });
      return;
    }
    const instancePath = [`${call.expression.text}:${destinations.join('+')}`];
    for (const destination of destinations) {
      if (networkNames.has(destination)) continue;
      if (!createDestination) {
        diagnostics.push({
          code: 'CL1016',
          severity: 'error',
          message: `Unknown attachment Network: ${destination}.`,
          span: destinationSource,
        });
        return;
      }
      networkNames.add(destination);
      networks.push({ name: destination, source: destinationSource, instancePath });
    }
    const attachments = destinations.map((network) => ({
      network,
      source: destinationSource,
      instancePath,
    }));
    const callOrdinal = (functionCallOrdinal += 1);
    const context: LoweringContext = {
      values: new Map(),
      resolving: new Set(),
      localNetworkPrefix: `$local:${callOrdinal}`,
      instancePath,
    };
    if (template.returnNetwork !== undefined) {
      if (destinations.length !== 1) {
        diagnostics.push({
          code: 'CL1021',
          severity: 'error',
          message:
            'A structural function result currently requires exactly one destination Network.',
          span: destinationSource,
        });
        return;
      }
      const structuralNetworks = new Map(argumentsByParameter);
      for (const [name, declaration] of template.localNetworks) {
        if (name === template.returnNetwork) {
          structuralNetworks.set(name, destinations[0]!);
          continue;
        }
        const network = `$local:${callOrdinal}:${name}`;
        structuralNetworks.set(name, network);
        networkNames.add(network);
        networks.push({
          name: network,
          ...(declaration.fixedColor === undefined ? {} : { fixedColor: declaration.fixedColor }),
          source: declaration.source,
          instancePath,
        });
      }

      const structuralProducer = (
        statement: ts.ExpressionStatement,
      ):
        | { readonly expression: ts.Expression; readonly destinations: readonly string[] }
        | undefined => {
        const value = statement.expression;
        if (
          ts.isBinaryExpression(value) &&
          value.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
        ) {
          if (ts.isIdentifier(value.left)) {
            return { expression: value.right, destinations: [value.left.text] };
          }
          if (
            ts.isCallExpression(value.left) &&
            ts.isIdentifier(value.left.expression) &&
            value.left.expression.text === 'to' &&
            value.left.arguments.every(ts.isIdentifier)
          ) {
            return {
              expression: value.right,
              destinations: value.left.arguments.map(
                (argument) => (argument as ts.Identifier).text,
              ),
            };
          }
          return undefined;
        }
        if (
          ts.isCallExpression(value) &&
          ts.isPropertyAccessExpression(value.expression) &&
          value.expression.name.text === 'to' &&
          value.arguments.every(ts.isIdentifier)
        ) {
          return {
            expression: value.expression.expression,
            destinations: value.arguments.map((argument) => (argument as ts.Identifier).text),
          };
        }
        return undefined;
      };

      for (const statement of template.producerStatements) {
        const producer = structuralProducer(statement);
        const resolvedDestinations = producer?.destinations.map((name) =>
          structuralNetworks.get(name),
        );
        if (
          producer === undefined ||
          resolvedDestinations === undefined ||
          resolvedDestinations.some((network) => network === undefined)
        ) {
          diagnostics.push({
            code: 'CL1033',
            severity: 'error',
            message:
              'A structural function body currently supports producer.to(...) or to(...) += producer attachments to local Networks.',
            span: spanForNode(file, statement),
          });
          return;
        }
        const concreteDestinations = resolvedDestinations as string[];
        if (
          concreteDestinations.length === 0 ||
          concreteDestinations.length > 2 ||
          new Set(concreteDestinations).size !== concreteDestinations.length
        ) {
          diagnostics.push({
            code: 'CL1021',
            severity: 'error',
            message: 'A producer output requires one or two distinct destination Networks.',
            span: spanForNode(file, statement),
          });
          return;
        }
        const producerAttachments = concreteDestinations.map((network) => ({
          network,
          source: spanForNode(file, statement),
          instancePath,
        }));
        const producerCount = producers.length;
        const loweredProducer = lowerExpression(
          producer.expression,
          template,
          structuralNetworks,
          context,
          producerAttachments,
        );
        if (loweredProducer?.kind === 'constant' || producers.length === producerCount) {
          diagnostics.push({
            code: 'CL1033',
            severity: 'error',
            message: 'A structural attachment requires a physical producer expression.',
            span: spanForNode(file, producer.expression),
          });
          return;
        }
      }
      return;
    }
    const lowered = lowerExpression(
      template.expression,
      template,
      argumentsByParameter,
      context,
      attachments,
      requestedOutputSignal,
    );
    if (lowered?.kind === 'constant') {
      diagnostics.push({
        code: 'CL1009',
        severity: 'error',
        message:
          'A compile-time integer cannot be returned as a Network without a typed signal constant.',
        span: spanForNode(file, template.expression),
      });
    } else if (
      lowered?.kind === 'network' &&
      [...argumentsByParameter.values()].includes(lowered.network)
    ) {
      diagnostics.push({
        code: 'CL1006',
        severity: 'error',
        message: 'Returning a Network alias without a physical producer is not supported yet.',
        span: spanForNode(file, template.expression),
      });
    } else if (lowered?.kind === 'network' && !destinations.includes(lowered.network)) {
      diagnostics.push({
        code: 'CL1012',
        severity: 'error',
        message:
          'The returned Network alias was already materialized elsewhere and cannot name this call destination yet.',
        span: spanForNode(file, template.expression),
      });
    }
  };

  const lowerDirectProducer = (
    expression: ts.Expression,
    destinations: readonly string[],
    destinationSource: SourceSpan,
    requestedOutputSignal?: SignalId,
  ): void => {
    if (
      destinations.length === 0 ||
      destinations.length > 2 ||
      new Set(destinations).size !== destinations.length
    ) {
      diagnostics.push({
        code: 'CL1021',
        severity: 'error',
        message: 'A producer output requires one or two distinct destination Networks.',
        span: destinationSource,
      });
      return;
    }
    for (const destination of destinations) {
      if (networkNames.has(destination)) continue;
      diagnostics.push({
        code: 'CL1016',
        severity: 'error',
        message: `Unknown attachment Network: ${destination}.`,
        span: destinationSource,
      });
      return;
    }
    const instancePath = [`direct:${destinations.join('+')}`];
    const attachments = destinations.map((network) => ({
      network,
      source: destinationSource,
      instancePath,
    }));
    const template: ArithmeticTemplate = {
      parameters: [],
      expression,
      bindings: new Map(),
      localNetworks: new Map(),
      producerStatements: [],
    };
    const lowered = lowerExpression(
      expression,
      template,
      new Map(),
      {
        values: new Map(),
        resolving: new Set(),
        localNetworkPrefix: `$direct:${(directProducerOrdinal += 1)}`,
        instancePath,
      },
      attachments,
      requestedOutputSignal,
    );
    if (lowered?.kind === 'constant') {
      diagnostics.push({
        code: 'CL1009',
        severity: 'error',
        message: 'A compile-time integer cannot be attached as a Network producer.',
        span: spanForNode(file, expression),
      });
    } else if (lowered?.kind === 'network' && !destinations.includes(lowered.network)) {
      diagnostics.push({
        code: 'CL1017',
        severity: 'error',
        message: 'Attaching a bare Network is forbidden; use an explicit merge operation.',
        span: spanForNode(file, expression),
      });
    }
  };

  const isWhenThenExpression = (expression: ts.Expression): expression is ts.CallExpression =>
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'then' &&
    ts.isCallExpression(expression.expression.expression) &&
    ts.isIdentifier(expression.expression.expression.expression) &&
    expression.expression.expression.expression.text === 'when';

  const lowerUnboundProducer = (expression: ts.Expression, source: SourceSpan): void => {
    temporaryNetworkOrdinal += 1;
    const sink = `$unused:${temporaryNetworkOrdinal}`;
    const instancePath = [`unused:${temporaryNetworkOrdinal}`];
    networkNames.add(sink);
    networks.push({ name: sink, source, instancePath });
    diagnostics.push({
      code: 'CL2001',
      severity: 'warning',
      message:
        'This producer has no destination; its topology is checked, but its output is unused.',
      span: source,
    });
    lowerDirectProducer(expression, [sink], source);
  };

  for (const statement of file.ast.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const inferredFunctionResult =
          declaration.initializer !== undefined &&
          ts.isCallExpression(declaration.initializer) &&
          ts.isIdentifier(declaration.initializer.expression) &&
          declaredFunctions.has(declaration.initializer.expression.text);
        if (
          ts.isIdentifier(declaration.name) &&
          (isNetworkType(declaration.type) || inferredFunctionResult) &&
          declaration.initializer !== undefined &&
          !ts.isNewExpression(declaration.initializer)
        ) {
          const source = spanForNode(file, declaration);
          if (
            ts.isCallExpression(declaration.initializer) &&
            ts.isIdentifier(declaration.initializer.expression) &&
            declaration.initializer.expression.text !== 'CC' &&
            declaration.initializer.expression.text !== 'IF'
          ) {
            lowerFunctionCall(declaration.initializer, [declaration.name.text], source, true);
          } else {
            networkNames.add(declaration.name.text);
            networks.push({ name: declaration.name.text, source, instancePath: [] });
            lowerDirectProducer(declaration.initializer, [declaration.name.text], source);
          }
        }
      }
      continue;
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
      ts.isElementAccessExpression(statement.expression.left)
    ) {
      const destinationSelection = statement.expression.left;
      const signalNode = destinationSelection.argumentExpression;
      const selectedSignal = ts.isIdentifier(signalNode) ? signals.get(signalNode.text) : undefined;
      if (selectedSignal === undefined) {
        diagnostics.push({
          code: 'CL1019',
          severity: 'error',
          message: 'A destination signal binding requires a declared Signal identifier.',
          span: spanForNode(file, destinationSelection),
        });
        continue;
      }
      const destinationExpression = destinationSelection.expression;
      let destinations: readonly string[] | undefined;
      if (ts.isIdentifier(destinationExpression)) {
        destinations = [destinationExpression.text];
      } else if (
        ts.isCallExpression(destinationExpression) &&
        ts.isIdentifier(destinationExpression.expression) &&
        destinationExpression.expression.text === 'to' &&
        destinationExpression.arguments.every(ts.isIdentifier)
      ) {
        destinations = destinationExpression.arguments.map(
          (argument) => (argument as ts.Identifier).text,
        );
      }
      if (destinations === undefined) {
        diagnostics.push({
          code: 'CL1023',
          severity: 'error',
          message:
            'A signal-constrained destination must be Network[SIGNAL] or to(first, second)[SIGNAL].',
          span: spanForNode(file, destinationSelection),
        });
        continue;
      }
      const value = statement.expression.right;
      if (
        ts.isCallExpression(value) &&
        ts.isIdentifier(value.expression) &&
        templates.has(value.expression.text)
      ) {
        lowerFunctionCall(value, destinations, spanForNode(file, statement), false, selectedSignal);
      } else {
        lowerDirectProducer(value, destinations, spanForNode(file, statement), selectedSignal);
      }
      continue;
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
      ts.isCallExpression(statement.expression.left) &&
      ts.isIdentifier(statement.expression.left.expression) &&
      statement.expression.left.expression.text === 'to'
    ) {
      const destinationCall = statement.expression.left;
      const destinationArguments = [...destinationCall.arguments];
      if (!destinationArguments.every(ts.isIdentifier)) {
        diagnostics.push({
          code: 'CL1021',
          severity: 'error',
          message: 'to(...) destinations must be declared Network identifiers.',
          span: spanForNode(file, destinationCall),
        });
        continue;
      }
      const destinations = destinationArguments.map((argument) => (argument as ts.Identifier).text);
      const value = statement.expression.right;
      if (
        ts.isCallExpression(value) &&
        ts.isIdentifier(value.expression) &&
        templates.has(value.expression.text)
      ) {
        lowerFunctionCall(value, destinations, spanForNode(file, statement), false);
      } else {
        lowerDirectProducer(value, destinations, spanForNode(file, statement));
      }
      continue;
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      ts.isPropertyAccessExpression(statement.expression.expression) &&
      statement.expression.expression.name.text === 'to' &&
      ts.isCallExpression(statement.expression.expression.expression)
    ) {
      const producerCall = statement.expression.expression.expression;
      const destinationArguments = [...statement.expression.arguments];
      let selectedSignal: SignalId | undefined;
      if (
        destinationArguments.length === 1 &&
        ts.isElementAccessExpression(destinationArguments[0]!) &&
        ts.isIdentifier(destinationArguments[0]!.expression) &&
        ts.isIdentifier(destinationArguments[0]!.argumentExpression)
      ) {
        selectedSignal = signals.get(destinationArguments[0]!.argumentExpression.text);
        if (selectedSignal === undefined) {
          diagnostics.push({
            code: 'CL1019',
            severity: 'error',
            message: 'A selected .to(...) destination requires a declared Signal identifier.',
            span: spanForNode(file, destinationArguments[0]!),
          });
          continue;
        }
        destinationArguments[0] = destinationArguments[0]!.expression;
      } else {
        const finalArgument = destinationArguments.at(-1);
        selectedSignal =
          finalArgument !== undefined && ts.isIdentifier(finalArgument)
            ? signals.get(finalArgument.text)
            : undefined;
        if (selectedSignal !== undefined) destinationArguments.pop();
      }
      if (!destinationArguments.every(ts.isIdentifier)) {
        diagnostics.push({
          code: 'CL1021',
          severity: 'error',
          message: '.to(...) destinations must be declared Network identifiers.',
          span: spanForNode(file, statement.expression),
        });
        continue;
      }
      const destinations = destinationArguments.map((argument) => (argument as ts.Identifier).text);
      lowerFunctionCall(
        producerCall,
        destinations,
        spanForNode(file, statement),
        false,
        selectedSignal,
      );
      continue;
    }
    if (
      ts.isExpressionStatement(statement) &&
      ((ts.isCallExpression(statement.expression) &&
        ts.isIdentifier(statement.expression.expression) &&
        statement.expression.expression.text === 'IF') ||
        isWhenThenExpression(statement.expression))
    ) {
      lowerUnboundProducer(statement.expression, spanForNode(file, statement));
      continue;
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      arithmeticOperation(statement.expression.operatorToken.kind) !== undefined
    ) {
      lowerUnboundProducer(statement.expression, spanForNode(file, statement));
      continue;
    }
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isBinaryExpression(statement.expression) ||
      statement.expression.operatorToken.kind !== ts.SyntaxKind.PlusEqualsToken ||
      !ts.isIdentifier(statement.expression.left)
    ) {
      continue;
    }
    const destination = statement.expression.left.text;
    const value = statement.expression.right;
    if (ts.isIdentifier(value) && networkNames.has(value.text)) {
      diagnostics.push({
        code: 'CL1017',
        severity: 'error',
        message: 'Network += Network is forbidden; use an explicit merge operation.',
        span: spanForNode(file, statement.expression),
      });
    } else if (
      ts.isCallExpression(value) &&
      ts.isIdentifier(value.expression) &&
      templates.has(value.expression.text)
    ) {
      lowerFunctionCall(value, [destination], spanForNode(file, statement), false);
    } else if (networkNames.has(destination)) {
      lowerDirectProducer(value, [destination], spanForNode(file, statement));
    }
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return { diagnostics };
  return {
    plan: {
      format: 'comblang-direct-plan',
      version: 2,
      networks,
      producers,
    },
    diagnostics,
  };
}
