import ts from 'typescript';

/**
 * Erases TypeScript-only syntax through the same syntax transform used by TypeScript emit.
 * Keep the private compiler API isolated here so a TypeScript upgrade has one guarded boundary.
 */
export function printErasedTypeScript(
  sourceFile: ts.SourceFile,
  compilerOptions: ts.CompilerOptions,
): string {
  const internal = ts as typeof ts & {
    transformTypeScript?: ts.TransformerFactory<ts.SourceFile>;
  };
  if (internal.transformTypeScript === undefined) {
    throw new Error(
      'The installed TypeScript version does not expose the syntax-erasure transform expected by CombLang.',
    );
  }
  const erased = ts.transform(sourceFile, [internal.transformTypeScript], compilerOptions);
  try {
    return ts.createPrinter().printFile(erased.transformed[0]!);
  } finally {
    erased.dispose();
  }
}
