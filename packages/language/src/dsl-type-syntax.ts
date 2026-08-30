import ts from 'typescript';

export type NetworkCapability = 'owned' | 'readonly' | 'ref' | 'move';
export type NetworkColorRequirement = 'red' | 'green';
export type ProducerHandleType =
  'Producer' | 'DeciderCombinator' | 'ArithmeticCombinator' | 'ConstantCombinator';

export type DslTypeSyntax =
  | {
      readonly kind: 'network';
      readonly capability: NetworkCapability;
      readonly color?: NetworkColorRequirement;
    }
  | { readonly kind: 'producer'; readonly producerType: ProducerHandleType }
  | { readonly kind: 'array'; readonly readonly: boolean; readonly element: DslTypeSyntax };

export type NetworkTypeSyntax = Extract<DslTypeSyntax, { readonly kind: 'network' }>;

const producerTypes = new Set<ProducerHandleType>([
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
