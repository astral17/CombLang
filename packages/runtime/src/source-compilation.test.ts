import { loadPrototypeDatabase, syntheticPrototypeDatabase } from '@comblang/prototypes';
import { sourceFileId, sourceSpan, type Diagnostic } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import {
  compileSourceProgram,
  sourceCompilationArtifact,
  type SourceCompilationStage,
} from './source-compilation.js';

describe('shared source compilation service', () => {
  test('runs every compilation stage and core lowering exactly once', () => {
    const stages: SourceCompilationStage[] = [];
    const compilation = compileSourceProgram(
      {
        path: 'shared.factorio.ts',
        text: `const input = new Network();
const output = new Network();
output += input + 1;`,
      },
      {},
      [],
      (stage) => stages.push(stage),
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.execution?.circuit.graph.producers).toHaveLength(1);
    expect(stages).toEqual(['parse', 'semantic', 'transform', 'execute', 'lower']);
    expect(stages.filter((stage) => stage === 'lower')).toHaveLength(1);
  });

  test('compiles every supported CC source form through the shared host service', () => {
    const compilation = compileSourceProgram({
      path: 'ordered-constant.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const sameA = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B', 'legendary');
const output = new Network();
output += CC(
  1 * A,
  [sameA, 2],
  [[B, 3]],
  new Map([[A, 4], [sameA, 5], ['iron-plate', 6]]),
  { [B]: 7, 'copper-plate': 0 },
);`,
    });

    expect(compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error')).toEqual(
      [],
    );
    expect(compilation.execution).toBeDefined();
    const producers = compilation.execution!.circuit.graph.producers;
    expect(producers).toHaveLength(1);
    expect(producers[0]).toMatchObject({ kind: 'constant' });

    const producer = producers[0]!;
    if (producer.kind !== 'constant') throw new Error('Expected one constant producer.');
    expect(
      producer.config.outputs.map(({ signal, value }) => [
        signal.type,
        signal.name,
        signal.quality,
        value,
      ]),
    ).toEqual([
      ['virtual', 'signal-A', undefined, 1],
      ['virtual', 'signal-A', undefined, 2],
      ['virtual', 'signal-B', 'legendary', 3],
      ['virtual', 'signal-A', undefined, 4],
      ['virtual', 'signal-A', undefined, 5],
      ['item', 'iron-plate', undefined, 6],
      ['virtual', 'signal-B', 'legendary', 7],
      ['item', 'copper-plate', undefined, 0],
    ]);

    const [first, second, , fourth, fifth] = producer.config.outputs;
    expect(first!.signal).not.toBe(second!.signal);
    expect(first!.signal).not.toBe(fifth!.signal);
    expect(first!.signal).toEqual(second!.signal);
    expect(first!.signal).toEqual(fifth!.signal);
  });

  test('separates host-local execution from a structured-clone-safe artifact', () => {
    const compilation = compileSourceProgram({
      path: 'transport.factorio.ts',
      text: 'const output = new Network();',
    });
    const artifact = sourceCompilationArtifact(compilation);

    expect(compilation.execution).toBeDefined();
    expect(artifact).not.toHaveProperty('execution');
    expect(structuredClone(artifact)).toEqual(artifact);
  });

  test('retains prototype identity and earlier warnings when execution fails', async () => {
    const { prototypes } = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const fileId = sourceFileId('failure.factorio.ts');
    const preflight: Diagnostic = {
      code: 'ENV_WARNING',
      severity: 'warning',
      message: 'Selected test environment.',
      span: sourceSpan(fileId, 0, 8),
    };
    const stages: SourceCompilationStage[] = [];
    const compilation = compileSourceProgram(
      {
        path: 'failure.factorio.ts',
        text: `throw new Error('stop');`,
      },
      { prototypes },
      [preflight],
      (stage) => stages.push(stage),
    );

    expect(compilation.prototypeIdentity).toBe(prototypes.identity);
    expect(compilation.plan).toBeUndefined();
    expect(compilation.pipelineDiagnostics.map(({ code }) => code)).toEqual([
      'ENV_WARNING',
      'EX1001',
    ]);
    expect(stages).toEqual(['parse', 'semantic', 'transform', 'execute']);
  });

  test('still emits transformed JavaScript but skips execution after a preflight error', () => {
    const stages: SourceCompilationStage[] = [];
    const compilation = compileSourceProgram(
      { path: 'blocked.factorio.ts', text: 'throw new Error("must not run");' },
      {},
      [{ code: 'ENV_ERROR', severity: 'error', message: 'Invalid environment.' }],
      (stage) => stages.push(stage),
    );

    expect(compilation.elaborationJavaScript).toContain('must not run');
    expect(compilation.pipelineDiagnostics.map(({ code }) => code)).toEqual(['ENV_ERROR']);
    expect(stages).toEqual(['parse', 'semantic', 'transform']);
  });
});
