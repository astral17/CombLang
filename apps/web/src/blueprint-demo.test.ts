import { compileDirectPlan } from '@comblang/compiler/direct-plan';
import { parseFile } from '@comblang/language';
import { describe, expect, test } from 'vitest';

import { blueprintJsonForPlan } from './blueprint-demo.js';

describe('source blueprint JSON preview', () => {
  test('converts source through lowering, color solving, and JSON generation', () => {
    const parsed = parseFile({
      path: 'blueprint.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const constants: Network = CC(5 * A);
const output: Network = constants * 2;`,
    });
    const compiled = compileDirectPlan(parsed);
    const generated = blueprintJsonForPlan(compiled.plan!);

    expect(compiled.diagnostics).toEqual([]);
    expect(generated.blueprint.entities.map((entity) => entity.name)).toEqual([
      'constant-combinator',
      'arithmetic-combinator',
    ]);
    expect(generated.blueprint.wires).toHaveLength(1);
  });
});
