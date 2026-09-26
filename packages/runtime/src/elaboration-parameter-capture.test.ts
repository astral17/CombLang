import { assertBlueprintParameterFromSession } from '../../compiler/src/blueprint-parameters.js';
import { constantConfigurationLimits } from '@comblang/factorio';
import { sourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import {
  executeElaborationProgram,
  executeElaborationProgramWithParameters,
} from './elaboration-program.js';
import * as publicRuntime from './index.js';
import { canonicalDirectPlan } from './canonical-circuit.js';
import { tryElaborateDirectPlan } from './direct-plan.js';
import { compileSourceProgram, sourceCompilationArtifact } from './source-compilation.js';
import { BlueprintParameterCapture } from './blueprint-parameter-capture.js';

function parameterProgram(code: string) {
  return {
    format: 'comblang-elaboration-js' as const,
    fileId: sourceFileId('parameter-capture.factorio.ts'),
    runtimeParameter: '__runtime',
    containsUnsupportedAsync: false,
    code,
  };
}

describe('host-local source parameter capture', () => {
  test('captures positional number and nominal Signal defaults with declaration spans', () => {
    const result = executeElaborationProgramWithParameters(
      parameterProgram(`
const amount = __runtime.declareBlueprintNumberParameter(
  'amount', 5, undefined, { start: 10, end: 46 }
);
const source = __runtime.signal('virtual', 'signal-A', { start: 60, end: 97 });
const channel = __runtime.declareBlueprintSignalParameter(
  'channel', source, {}, { start: 48, end: 121 }
);`),
    );

    expect(result.parameters.map(({ registration }) => registration)).toEqual([
      {
        kind: 'number',
        label: 'amount',
        defaultValue: 5,
        source: { fileId: sourceFileId('parameter-capture.factorio.ts'), start: 10, end: 46 },
      },
      {
        kind: 'signal',
        label: 'channel',
        defaultValue: { type: 'virtual', name: 'signal-A' },
        source: { fileId: sourceFileId('parameter-capture.factorio.ts'), start: 48, end: 121 },
      },
    ]);
    expect(JSON.stringify(result.plan)).not.toContain('amount');
    expect(JSON.stringify(result.plan)).not.toContain('signal-A');
    expect(() =>
      executeElaborationProgram(
        parameterProgram(`
__runtime.declareBlueprintNumberParameter('amount', 5, undefined, { start: 1, end: 2 });`),
      ),
    ).toThrow('is not a function');
  });

  test('creates independent nominal handles for separate executions', () => {
    const program = parameterProgram(
      `__runtime.declareBlueprintNumberParameter('amount', 5, {}, { start: 1, end: 2 });`,
    );
    const first = executeElaborationProgramWithParameters(program);
    const second = executeElaborationProgramWithParameters(program);
    const firstHandle = first.parameters[0]!.handle;
    const secondHandle = second.parameters[0]!.handle;

    expect(firstHandle).not.toBe(secondHandle);
    expect(() =>
      assertBlueprintParameterFromSession(first.session, secondHandle, '$.parameter'),
    ).toThrow('parameter belongs to a different parameter session');
    expect(() =>
      assertBlueprintParameterFromSession(second.session, firstHandle, '$.parameter'),
    ).toThrow('parameter belongs to a different parameter session');
    expect(() => first.session.number('late declaration', { defaultValue: 1 })).toThrow(
      'parameter session is sealed',
    );
    expect(Object.isFrozen(first.parameters)).toBe(true);
    expect(Object.isFrozen(first.parameters[0])).toBe(true);
    expect('executeElaborationProgramWithParameters' in publicRuntime).toBe(false);
  });

  test('rejects a forged structural Signal default', () => {
    const program = parameterProgram(
      `__runtime.declareBlueprintSignalParameter(
  'channel', { type: 'virtual', name: 'signal-A' }, {}, { start: 1, end: 2 }
);`,
    );

    expect(() => executeElaborationProgramWithParameters(program)).toThrow(
      'Signal defaults must come from Signal(...) in this execution session.',
    );
  });

  test('normalizes shorthand and qualified source Signals without losing quality', () => {
    const result = executeElaborationProgramWithParameters(
      parameterProgram(`
const item = __runtime.signal('iron-plate', { start: 1, end: 24 });
const quality = __runtime.signal('virtual', 'signal-A', 'legendary', { start: 25, end: 72 });
__runtime.declareBlueprintSignalParameter('same label', item, {}, { start: 1, end: 73 });
__runtime.declareBlueprintSignalParameter('same label', quality, {}, { start: 74, end: 149 });`),
    );

    expect(result.parameters.map(({ registration }) => registration)).toEqual([
      {
        kind: 'signal',
        label: 'same label',
        defaultValue: { type: 'item', name: 'iron-plate' },
        source: { fileId: sourceFileId('parameter-capture.factorio.ts'), start: 1, end: 73 },
      },
      {
        kind: 'signal',
        label: 'same label',
        defaultValue: { type: 'virtual', name: 'signal-A', quality: 'legendary' },
        source: { fileId: sourceFileId('parameter-capture.factorio.ts'), start: 74, end: 149 },
      },
    ]);
    expect(result.parameters[0]!.handle).not.toBe(result.parameters[1]!.handle);
  });

  test('rejects a Signal handle created by a different execution', () => {
    const globalKey = Symbol.for('comblang.test.foreign-source-signal');
    const globalRecord = globalThis as Record<PropertyKey, unknown>;
    const hadPriorValue = Object.hasOwn(globalRecord, globalKey);
    const priorValue = globalRecord[globalKey];
    try {
      executeElaborationProgramWithParameters(
        parameterProgram(
          `globalThis[Symbol.for('comblang.test.foreign-source-signal')] = __runtime.signal('virtual', 'signal-foreign', { start: 1, end: 2 });`,
        ),
      );
      const foreign = globalRecord[globalKey];
      expect(() =>
        executeElaborationProgramWithParameters(
          parameterProgram(
            `__runtime.declareBlueprintSignalParameter('foreign', globalThis[Symbol.for('comblang.test.foreign-source-signal')], {}, { start: 1, end: 2 });`,
          ),
        ),
      ).toThrow('Signal defaults must come from Signal(...) in this execution session.');
      expect(foreign).toBeDefined();
    } finally {
      if (!hadPriorValue) delete globalRecord[globalKey];
      else globalRecord[globalKey] = priorValue;
    }
  });

  test('requires exact plain metadata and rejects blank labels', () => {
    const invalidPrograms = [
      `__runtime.declareBlueprintNumberParameter('amount', 5, null, { start: 1, end: 2 });`,
      `__runtime.declareBlueprintNumberParameter('amount', 5, { futureField: true }, { start: 1, end: 2 });`,
      `__runtime.declareBlueprintNumberParameter('   ', 5, {}, { start: 1, end: 2 });`,
    ];

    for (const code of invalidPrograms) {
      expect(() => executeElaborationProgramWithParameters(parameterProgram(code))).toThrow();
    }
    const accessorProgram = parameterProgram(
      `const metadata = Object.defineProperty({}, 'futureField', { enumerable: true, get() { throw new Error('metadata getter ran'); } });
__runtime.declareBlueprintNumberParameter('amount', 5, metadata, { start: 1, end: 2 });`,
    );
    expect(() => executeElaborationProgramWithParameters(accessorProgram)).toThrow(
      'metadata fields must be enumerable data properties',
    );
    expect(() =>
      executeElaborationProgramWithParameters(
        parameterProgram(
          `__runtime.declareBlueprintNumberParameter('no default', undefined, {}, { start: 1, end: 2 });`,
        ),
      ),
    ).toThrow('number declarations require a finite positional default');

    const bounded = new BlueprintParameterCapture();
    expect(() =>
      bounded.number('x'.repeat(constantConfigurationLimits.maxBytes + 1), 1, undefined, {
        fileId: sourceFileId('bounded.factorio.ts'),
        start: 1,
        end: 2,
      }),
    ).toThrow(`within the ${constantConfigurationLimits.maxBytes}-byte limit`);
  });

  test('seals successful and failed captures against delayed declarations', () => {
    const globalKey = Symbol.for('comblang.test.delayed-parameter-call');
    const globalRecord = globalThis as Record<PropertyKey, unknown>;
    const hadPriorValue = Object.hasOwn(globalRecord, globalKey);
    const priorValue = globalRecord[globalKey];
    const source = `
__runtime.declareBlueprintNumberParameter('amount', 5, {}, { start: 1, end: 2 });
globalThis[Symbol.for('comblang.test.delayed-parameter-call')] = () =>
  __runtime.declareBlueprintNumberParameter('late', 6, {}, { start: 3, end: 4 });`;
    try {
      const result = executeElaborationProgramWithParameters(parameterProgram(source));
      const lateCall = globalRecord[globalKey] as () => unknown;
      expect(() => lateCall()).toThrow('elaboration runtime is sealed');
      expect(result.parameters).toHaveLength(1);
      expect(() => result.session.number('late session declaration')).toThrow(
        'parameter session is sealed',
      );

      expect(() =>
        executeElaborationProgramWithParameters(
          parameterProgram(`${source}\nthrow new Error('source failed after declaration');`),
        ),
      ).toThrow('source failed after declaration');
      const failedLateCall = globalRecord[globalKey] as () => unknown;
      expect(() => failedLateCall()).toThrow('elaboration runtime is sealed');
    } finally {
      if (!hadPriorValue) delete globalRecord[globalKey];
      else globalRecord[globalKey] = priorValue;
    }
  });

  test('parameter handles reject arithmetic and object-key coercion but remain JS-truthy', () => {
    const arithmetic = parameterProgram(`
const amount = __runtime.declareBlueprintNumberParameter('amount', 5, {}, { start: 1, end: 2 });
if (typeof amount !== 'object') throw new Error('number declaration became a primitive');
amount + 1;`);
    expect(() => executeElaborationProgramWithParameters(arithmetic)).toThrow(
      'cannot be coerced to JavaScript primitives',
    );

    const objectKey = parameterProgram(`
const channel = __runtime.declareBlueprintSignalParameter(
  'channel', __runtime.signal('virtual', 'signal-A', { start: 1, end: 2 }), {}, { start: 3, end: 4 }
);
const values = {};
values[channel] = 1;`);
    expect(() => executeElaborationProgramWithParameters(objectKey)).toThrow(
      'cannot be coerced to JavaScript primitives',
    );

    const count = parameterProgram(`
const amount = __runtime.declareBlueprintNumberParameter('amount', 5, {}, { start: 1, end: 2 });
const source = __runtime.signal('virtual', 'signal-A', { start: 3, end: 4 });
__runtime.binary('*', amount, source, { start: 1, end: 4 });`);
    expect(() => executeElaborationProgramWithParameters(count)).toThrow(
      'A typed Signal value must use numericCount * Signal.',
    );

    const branch = executeElaborationProgramWithParameters(
      parameterProgram(`
const amount = __runtime.declareBlueprintNumberParameter('amount', 5, {}, { start: 1, end: 2 });
if (amount) __runtime.declareBlueprintNumberParameter('branch ran', 1, {}, { start: 3, end: 4 });`),
    );
    expect(branch.parameters.map(({ registration }) => registration.label)).toEqual([
      'amount',
      'branch ran',
    ]);
  });

  test('leaves ordinary parameter-free execution output byte-for-byte stable', () => {
    const program = parameterProgram(
      `__runtime.network(undefined, undefined, { start: 1, end: 2 });`,
    );
    const ordinary = executeElaborationProgram(program);
    const captureEnabled = executeElaborationProgramWithParameters(program);

    expect(JSON.stringify(captureEnabled.plan)).toBe(JSON.stringify(ordinary));
    expect(captureEnabled.parameters).toEqual([]);

    const canonical = canonicalDirectPlan(captureEnabled.plan);
    expect(JSON.stringify(canonical)).toBe(JSON.stringify(captureEnabled.plan));
    const lowered = tryElaborateDirectPlan(canonical);
    expect(lowered.diagnostics).toEqual([]);
    expect(JSON.stringify(lowered.resolvedCircuit)).not.toContain('parameters');

    const compilation = compileSourceProgram({
      path: 'parameter-free-artifact.factorio.ts',
      text: 'const output = new Network();',
    });
    const artifact = sourceCompilationArtifact(compilation);
    expect('execution' in artifact).toBe(false);
    expect('parameters' in artifact).toBe(false);
    expect('session' in artifact).toBe(false);
    expect(JSON.stringify(artifact)).not.toContain('signal-A');
  });
});
