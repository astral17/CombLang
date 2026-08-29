import { describe, expect, test } from 'vitest';

import { compileSource } from './compile-source.js';

describe('browser source compilation', () => {
  test('attaches a duplicate to(...) destination diagnostic to its source statement', () => {
    const statement = 'to(a, a) += input + 0;';
    const text = `const input = new Network();
const a = new Network();
${statement}`;
    const result = compileSource({ path: 'main.factorio.ts', text });
    const duplicate = result.compilerDiagnostics.find(({ code }) => code === 'RT2004');

    expect(duplicate).toMatchObject({ severity: 'error', span: expect.any(Object) });
    expect(
      duplicate?.span === undefined
        ? undefined
        : text.slice(duplicate.span.start, duplicate.span.end),
    ).toBe(statement.slice(0, -1));
  });
});
