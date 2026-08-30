import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import { printErasedTypeScript } from './typescript-erase.js';

describe('TypeScript syntax erasure boundary', () => {
  test('erases annotations with the pinned compiler API', () => {
    const source = ts.createSourceFile(
      'erase.ts',
      'const value: number = 4;',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const output = printErasedTypeScript(source, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    });

    expect(output).not.toContain(': number');
    expect(output).toContain('const value = 4;');
  });
});
