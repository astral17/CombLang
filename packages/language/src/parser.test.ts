import { describe, expect, it } from 'vitest';

import { parseFile, parseProject, spanForNode, summarizeTopLevel } from './parser.js';

const source = `function Scale(input: Readonly<Network>): Network {
  return input * 10;
}
`;

describe('TypeScript parser adapter', () => {
  it('produces stable spans and syntax summaries', () => {
    const first = parseFile({ path: '.\\examples\\scale.ts', text: source });
    const second = parseFile({ path: './examples/scale.ts', text: source });

    expect(first.id).toBe(second.id);
    expect(first.diagnostics).toEqual([]);
    expect(spanForNode(first, first.ast.statements[0]!)).toEqual(
      spanForNode(second, second.ast.statements[0]!),
    );
    expect(summarizeTopLevel(first)).toMatchObject([
      { kind: 'FunctionDeclaration', text: expect.stringContaining('function Scale') },
    ]);
  });

  it('normalizes parser diagnostics', () => {
    const parsed = parseFile({ path: 'broken.ts', text: 'const value = ;' });
    expect(parsed.diagnostics[0]).toMatchObject({
      code: expect.stringMatching(/^TS\d+$/),
      severity: 'error',
      span: { fileId: 'file:broken.ts' },
    });
  });

  it('rejects duplicate normalized paths in a project', () => {
    const parsed = parseProject([
      { path: '.\\main.ts', text: '' },
      { path: './main.ts', text: '' },
    ]);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL0001', severity: 'error' }),
    );
  });
});
