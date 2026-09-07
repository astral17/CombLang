import ts from 'typescript';

export type NetworkCapability = 'owned' | 'readonly' | 'ref' | 'move';
export type NetworkColorRequirement = 'red' | 'green';
export type ProducerHandleType =
  'Combinator' | 'Producer' | 'DeciderCombinator' | 'ArithmeticCombinator' | 'ConstantCombinator';

export type DslTypeSyntax =
  | {
      readonly kind: 'network';
      readonly capability: NetworkCapability;
      readonly color?: NetworkColorRequirement;
    }
  | { readonly kind: 'producer'; readonly producerType: ProducerHandleType }
  | { readonly kind: 'array'; readonly readonly: boolean; readonly element: DslTypeSyntax };

export type NetworkTypeSyntax = Extract<DslTypeSyntax, { readonly kind: 'network' }>;

export type DslParameterContract =
  | ({
      readonly kind: 'network';
      readonly capability: NetworkCapability;
      readonly color?: NetworkColorRequirement;
    } & {
      readonly text: string;
    })
  | ({ readonly kind: 'producer'; readonly producerType: ProducerHandleType } & {
      readonly text: string;
    })
  | {
      readonly kind: 'primitive';
      readonly value: 'number' | 'string' | 'boolean' | 'null' | 'undefined';
      readonly text: string;
    }
  | { readonly kind: 'dynamic'; readonly text: string }
  | {
      readonly kind: 'union';
      readonly members: readonly DslParameterContract[];
      readonly text: string;
    };

const producerTypes = new Set<ProducerHandleType>([
  'Combinator',
  'Producer',
  'DeciderCombinator',
  'ArithmeticCombinator',
  'ConstantCombinator',
]);

const colorFromArgument = (argument: string | undefined): NetworkColorRequirement | undefined =>
  argument === 'R' ? 'red' : argument === 'G' ? 'green' : undefined;

/** Parses only the stable public DSL annotations; it is deliberately not a TypeScript checker. */
export function parseDslTypeText(rawText: string): DslTypeSyntax | undefined {
  const text = rawText.replaceAll(/\s/g, '');
  if (producerTypes.has(text as ProducerHandleType)) {
    return { kind: 'producer', producerType: text as ProducerHandleType };
  }
  const directNetwork = /^Network(?:<(.+)>)?$/.exec(text);
  if (directNetwork !== null) {
    const color = colorFromArgument(directNetwork[1]);
    return {
      kind: 'network',
      capability: 'owned',
      ...(color === undefined ? {} : { color }),
    };
  }
  const wrappedNetwork = /^(Readonly|Ref|Move)<Network(?:<(.+)>)?>$/.exec(text);
  if (wrappedNetwork !== null) {
    const color = colorFromArgument(wrappedNetwork[2]);
    return {
      kind: 'network',
      capability:
        wrappedNetwork[1] === 'Readonly'
          ? 'readonly'
          : wrappedNetwork[1] === 'Ref'
            ? 'ref'
            : 'move',
      ...(color === undefined ? {} : { color }),
    };
  }
  const suffixElement = text.endsWith('[]') ? text.slice(0, -2) : undefined;
  const genericArray = /^(Array|ReadonlyArray)<(.+)>$/.exec(text);
  const elementText = suffixElement ?? genericArray?.[2];
  if (elementText === undefined) return undefined;
  const element = parseDslTypeText(elementText);
  return element === undefined
    ? undefined
    : {
        kind: 'array',
        readonly: genericArray?.[1] === 'ReadonlyArray',
        element,
      };
}

export function parseDslTypeAnnotation(
  node: ts.TypeNode | undefined,
  sourceFile?: ts.SourceFile,
): DslTypeSyntax | undefined {
  return node === undefined ? undefined : parseDslTypeText(node.getText(sourceFile));
}

export function producerHandleTypeFromAnnotation(
  node: ts.TypeNode | undefined,
  sourceFile?: ts.SourceFile,
): ProducerHandleType | undefined {
  const syntax = parseDslTypeAnnotation(node, sourceFile);
  return syntax?.kind === 'producer' ? syntax.producerType : undefined;
}

export function networkTypeFromAnnotation(
  node: ts.TypeNode | undefined,
  sourceFile?: ts.SourceFile,
): NetworkTypeSyntax | undefined {
  const syntax = parseDslTypeAnnotation(node, sourceFile);
  return syntax?.kind === 'network' ? syntax : undefined;
}

function parameterContractForNode(
  node: ts.TypeNode,
  sourceFile?: ts.SourceFile,
): DslParameterContract | undefined {
  const text = node.getText(sourceFile);
  if (ts.isParenthesizedTypeNode(node)) {
    const inner = parameterContractForNode(node.type, sourceFile);
    return inner === undefined ? undefined : { ...inner, text };
  }
  if (ts.isUnionTypeNode(node)) {
    const members = node.types.map((member) => parameterContractForNode(member, sourceFile));
    return members.some((member) => member === undefined)
      ? undefined
      : { kind: 'union', members: members as DslParameterContract[], text };
  }
  const syntax = parseDslTypeAnnotation(node, sourceFile);
  if (syntax?.kind === 'network') return { ...syntax, text };
  if (syntax?.kind === 'producer') return { ...syntax, text };
  switch (node.kind) {
    case ts.SyntaxKind.NumberKeyword:
      return { kind: 'primitive', value: 'number', text };
    case ts.SyntaxKind.StringKeyword:
      return { kind: 'primitive', value: 'string', text };
    case ts.SyntaxKind.BooleanKeyword:
      return { kind: 'primitive', value: 'boolean', text };
    case ts.SyntaxKind.NullKeyword:
      return { kind: 'primitive', value: 'null', text };
    case ts.SyntaxKind.UndefinedKeyword:
    case ts.SyntaxKind.VoidKeyword:
      return { kind: 'primitive', value: 'undefined', text };
    case ts.SyntaxKind.AnyKeyword:
    case ts.SyntaxKind.UnknownKeyword:
      return { kind: 'dynamic', text };
    default:
      return undefined;
  }
}

/** Parses the deliberately small executed parameter contract used by the compiler boundary. */
export function parseDslParameterContract(
  node: ts.TypeNode | undefined,
  sourceFile?: ts.SourceFile,
  optional = false,
): DslParameterContract {
  const parsed =
    node === undefined
      ? ({ kind: 'dynamic', text: '<untyped>' } satisfies DslParameterContract)
      : parameterContractForNode(node, sourceFile);
  if (parsed === undefined) {
    return { kind: 'dynamic', text: node?.getText(sourceFile) ?? '<untyped>' };
  }
  if (!optional || parsed.kind === 'dynamic') return parsed;
  const undefinedMember: DslParameterContract = {
    kind: 'primitive',
    value: 'undefined',
    text: 'undefined',
  };
  return parsed.kind === 'union'
    ? {
        ...parsed,
        members: [...parsed.members, undefinedMember],
        text: `${parsed.text} | undefined`,
      }
    : { kind: 'union', members: [parsed, undefinedMember], text: `${parsed.text} | undefined` };
}
