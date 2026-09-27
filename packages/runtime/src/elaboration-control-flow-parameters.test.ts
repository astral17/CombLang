import { transformElaborationModule } from '@comblang/compiler/elaboration-transform';
import { createBlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';
import { parseFile } from '@comblang/language';
import type { SignalId } from '@comblang/factorio';
import { describe, expect, test } from 'vitest';

import {
  ElaborationExecutionError,
  executeElaborationProgramWithParameters,
} from './elaboration-program.js';

function parameterizedProgram(source: string) {
  const parsed = parseFile({ path: 'parameter-control-flow.factorio.ts', text: source });
  const transformed = transformElaborationModule(parsed);
  const runtime = transformed.runtimeParameter;
  return {
    ...transformed,
    code: `const flowGuard = ${runtime}.declareBlueprintNumberParameter(
  'flow guard', 1, undefined, { start: 0, end: 1 }
);\n${transformed.code}`,
  };
}

function expectControlGuard(source: string, testedName: string, spanText = testedName): void {
  const program = parameterizedProgram(source);
  const error = (() => {
    try {
      executeElaborationProgramWithParameters(program);
    } catch (caught) {
      return caught;
    }
    return undefined;
  })();
  const start = source.lastIndexOf(spanText);

  expect(error).toBeInstanceOf(ElaborationExecutionError);
  expect(error).toMatchObject({
    code: 'RT2029',
    span: {
      fileId: program.fileId,
      start,
      end: start + spanText.length,
    },
  });
}

describe('parameter handles in transformed JavaScript control flow', () => {
  test.each([
    ['direct if test', 'if (flowGuard) {}', 'flowGuard'],
    ['aliased if test', 'const alias = flowGuard; if (alias) {}', 'alias'],
    ['direct conditional expression', 'const selected = flowGuard ? 1 : 0;', 'flowGuard'],
    [
      'aliased conditional expression',
      'const alias = flowGuard; const selected = alias ? 1 : 0;',
      'alias',
    ],
    ['direct while test', 'while (flowGuard) { break; }', 'flowGuard'],
    ['aliased for test', 'const alias = flowGuard; for (; alias;) { break; }', 'alias'],
  ])('rejects a parameter before %s branches', (_name, source, testedName) => {
    expectControlGuard(source, testedName);
  });

  test('preserves ordinary booleans, short-circuit order, and loop behavior', () => {
    const source = `
let order = '';
function predicate(value) { order += value; return value === 't'; }
if (predicate('f')) order += 'i';
const selected = predicate('t') ? 'yes' : 'no';
const skippedAnd = false && predicate('x');
const skippedOr = true || predicate('y');
let sum = 0;
for (let i = 0; i < 2; i++) sum += i;
while (predicate('f')) order += 'w';
do { order += 'd'; } while (false);
if (
  order !== 'ftfd' ||
  selected !== 'yes' ||
  skippedAnd !== false ||
  skippedOr !== true ||
  sum !== 1
) {
  throw new Error('ordinary control semantics changed');
}`;

    expect(() =>
      executeElaborationProgramWithParameters(parameterizedProgram(source)),
    ).not.toThrow();
  });

  test.each([
    ['and left operand', 'const result = flowGuard && false;', 'flowGuard && false'],
    ['or left operand', 'const result = flowGuard || true;', 'flowGuard || true'],
    [
      'aliased and left operand',
      'const alias = flowGuard; const result = alias && false;',
      'alias && false',
    ],
    ['negation operand', 'const result = !flowGuard;', '!flowGuard'],
    [
      'nested logical operand',
      'const result = (true && flowGuard) && false;',
      '(true && flowGuard) && false',
    ],
  ])('guards a parameter before evaluating %s', (_name, source, spanText) => {
    expectControlGuard(source, source.includes('alias') ? 'alias' : 'flowGuard', spanText);
  });

  test('does not evaluate the right side after a parameter left operand', () => {
    const key = Symbol.for('comblang.test.logical-right-side');
    const globalRecord = globalThis as Record<PropertyKey, unknown>;
    const hadPriorValue = Object.hasOwn(globalRecord, key);
    const priorValue = globalRecord[key];
    const source = `
const result = flowGuard && (globalThis[Symbol.for('comblang.test.logical-right-side')] = true);`;
    try {
      expect(() => executeElaborationProgramWithParameters(parameterizedProgram(source))).toThrow(
        ElaborationExecutionError,
      );
      expect(globalRecord[key]).toBeUndefined();
    } finally {
      if (!hadPriorValue) delete globalRecord[key];
      else globalRecord[key] = priorValue;
    }
  });

  test('keeps circuit Conditions composable with logical operators', () => {
    const source = `
const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = IF(input[A] > 0 && input[A] < 10, 1 * A);
const sink = new Network();
sink += output;`;

    expect(() =>
      executeElaborationProgramWithParameters(parameterizedProgram(source)),
    ).not.toThrow();
  });

  test.each([
    ['switch selector', 'switch (flowGuard) { case 1: break; }', 'flowGuard'],
    ['for-of collection', 'for (const value of flowGuard) { void value; }', 'flowGuard'],
    ['for-in collection', 'for (const key in flowGuard) { void key; }', 'flowGuard'],
  ])('rejects a parameter before %s branches or iterates', (_name, source, spanText) => {
    expectControlGuard(source, 'flowGuard', spanText);
  });

  test('preserves ordinary switch and iteration values and evaluates each once', () => {
    const source = `
let calls = '';
function selector() { calls += 's'; return 2; }
function values() { calls += 'v'; return [3, 4]; }
function record() { calls += 'r'; return { first: 1, second: 2 }; }
let selected = 0;
switch (selector()) { case 2: selected = 7; break; }
let sum = 0;
for (const value of values()) sum += value;
let keys = 0;
for (const key in record()) keys++;
if (calls !== 'svr' || selected !== 7 || sum !== 7 || keys !== 2) {
  throw new Error('ordinary switch or iteration semantics changed');
}`;

    expect(() =>
      executeElaborationProgramWithParameters(parameterizedProgram(source)),
    ).not.toThrow();
  });

  test('guards array-retrieved parameters in nested functions on repeated calls', () => {
    const source = `
const savedValues = [flowGuard];
function inspect(observed) { if (observed) {} }
inspect(false);
inspect(savedValues[0]);`;

    expectControlGuard(source, 'observed');
  });

  test('documents an unpropagated host-JavaScript coercion boundary', () => {
    const source = `
if (Boolean(flowGuard)) throw new Error('host coercion branch ran');`;

    expect(() => executeElaborationProgramWithParameters(parameterizedProgram(source))).toThrow(
      'host coercion branch ran',
    );
  });

  test.each([
    [
      'foreign number handle',
      createBlueprintParameterSession().number('foreign number', { defaultValue: 1 }),
    ],
    [
      'foreign Signal handle',
      createBlueprintParameterSession().signal('foreign Signal', {
        defaultValue: { type: 'virtual', name: 'signal-A' } as SignalId,
      }),
    ],
  ])('rejects a %s by registry identity', (_name, handle) => {
    const key = Symbol.for('comblang.test.foreign-handle');
    const globalRecord = globalThis as Record<PropertyKey, unknown>;
    const hadPriorValue = Object.hasOwn(globalRecord, key);
    const priorValue = globalRecord[key];
    const source = `if (globalThis[Symbol.for('comblang.test.foreign-handle')]) {}`;
    const expression = `globalThis[Symbol.for('comblang.test.foreign-handle')]`;
    try {
      globalRecord[key] = handle;
      expectControlGuard(source, expression, expression);
    } finally {
      if (!hadPriorValue) delete globalRecord[key];
      else globalRecord[key] = priorValue;
    }
  });

  test('leaves forged lookalikes to ordinary JavaScript control semantics', () => {
    const valueKey = Symbol.for('comblang.test.forged-lookalike');
    const resultKey = Symbol.for('comblang.test.forged-lookalike-result');
    const globalRecord = globalThis as Record<PropertyKey, unknown>;
    const oldValue = globalRecord[valueKey];
    const oldResult = globalRecord[resultKey];
    const hadValue = Object.hasOwn(globalRecord, valueKey);
    const hadResult = Object.hasOwn(globalRecord, resultKey);
    const result: string[] = [];
    globalRecord[valueKey] = { kind: 'number', label: 'forged', defaultValue: 1 };
    globalRecord[resultKey] = result;
    try {
      const source = `
const forged = globalThis[Symbol.for('comblang.test.forged-lookalike')];
if (forged) globalThis[Symbol.for('comblang.test.forged-lookalike-result')].push('if');
switch (forged) { case forged: globalThis[Symbol.for('comblang.test.forged-lookalike-result')].push('switch'); }
for (const key in forged) globalThis[Symbol.for('comblang.test.forged-lookalike-result')].push(key);`;

      expect(() =>
        executeElaborationProgramWithParameters(parameterizedProgram(source)),
      ).not.toThrow();
      expect(result).toEqual(['if', 'switch', 'kind', 'label', 'defaultValue']);
    } finally {
      if (hadValue) globalRecord[valueKey] = oldValue;
      else delete globalRecord[valueKey];
      if (hadResult) globalRecord[resultKey] = oldResult;
      else delete globalRecord[resultKey];
    }
  });

  test('withholds partial capture and rejects delayed calls after a guarded control failure', () => {
    const key = Symbol.for('comblang.test.failed-guard-delayed-call');
    const globalRecord = globalThis as Record<PropertyKey, unknown>;
    const hadPriorValue = Object.hasOwn(globalRecord, key);
    const priorValue = globalRecord[key];
    const transformed = parameterizedProgram(
      `if (flowGuard) throw new Error('guarded branch should not run');`,
    );
    const program = {
      ...transformed,
      code: `globalThis[Symbol.for('comblang.test.failed-guard-delayed-call')] = ${transformed.runtimeParameter};\n${transformed.code}`,
    };
    try {
      let caught: unknown;
      try {
        executeElaborationProgramWithParameters(program);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ElaborationExecutionError);
      expect(caught).toMatchObject({ code: 'RT2029' });
      const failedRuntime = globalRecord[key] as {
        declareBlueprintNumberParameter: (...args: unknown[]) => unknown;
      };
      expect(() =>
        failedRuntime.declareBlueprintNumberParameter('late', 2, undefined, {
          start: 0,
          end: 1,
        }),
      ).toThrow('cannot be used as a JavaScript control-flow value');
    } finally {
      if (!hadPriorValue) delete globalRecord[key];
      else globalRecord[key] = priorValue;
    }
  });

  test('seals a partial capture when execution fails inside a guarded branch', () => {
    const key = Symbol.for('comblang.test.branch-failure-runtime');
    const globalRecord = globalThis as Record<PropertyKey, unknown>;
    const hadPriorValue = Object.hasOwn(globalRecord, key);
    const priorValue = globalRecord[key];
    const transformed = parameterizedProgram(
      `if (true) throw new Error('branch failed after declaration');`,
    );
    const program = {
      ...transformed,
      code: `globalThis[Symbol.for('comblang.test.branch-failure-runtime')] = ${transformed.runtimeParameter};\n${transformed.code}`,
    };
    try {
      expect(() => executeElaborationProgramWithParameters(program)).toThrow(
        'branch failed after declaration',
      );
      const failedRuntime = globalRecord[key] as {
        declareBlueprintNumberParameter: (...args: unknown[]) => unknown;
      };
      expect(() =>
        failedRuntime.declareBlueprintNumberParameter('late', 2, undefined, {
          start: 0,
          end: 1,
        }),
      ).toThrow('elaboration runtime is sealed');
    } finally {
      if (!hadPriorValue) delete globalRecord[key];
      else globalRecord[key] = priorValue;
    }
  });
});
