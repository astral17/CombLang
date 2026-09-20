import { describe, expect, test } from 'vitest';
import type { EntityProfile } from '@comblang/compiler/entity';
import {
  createTrustedEntityReplayContext,
  entityReplayContextTransport,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import { validateCanonicalDirectPlan } from './direct-plan.js';
import {
  compileParsedSourceProgram,
  compileSourceProgram,
  sourceCompilationArtifact,
  type SourceCompilationStage,
} from './source-compilation.js';
import { parseFile } from '@comblang/language';
import type { EntityPrototypeResolver } from './entity-registry.js';
import type { EntityPrototype } from '@comblang/prototypes';

function canonicalHost(): {
  trustedEntityReplayContext: TrustedEntityReplayContext;
  entityPrototypeResolver: EntityPrototypeResolver;
} {
  const families = [
    ['constant-combinator', 'constant-combinator'],
    ['arithmetic-combinator', 'arithmetic-combinator'],
    ['decider-combinator', 'decider-combinator'],
    ['selector-combinator', 'selector-combinator'],
    ['structural', 'container'],
  ] as const;
  const profiles = families.map(([name, prototypeType], index) => ({
    ...syntheticZeroPortEntityProfile,
    prototypeType,
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${name}` as EntityProfile['ref']['prototypeKey'],
      profileId: `profile:source-${index}` as EntityProfile['ref']['profileId'],
    },
  }));
  const prototypes = families.map(([name, type]) => ({
    key: `entity:${name}`,
    name,
    type,
  })) as EntityPrototype[];
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profiles[0]!.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'source-compilation-evidence',
    policyIdentity: 'source-compilation-policy',
    profiles,
  });
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: profiles[0]!.ref.database,
    getEntity(nameOrKey) {
      return prototypes.find(({ key, name }) => nameOrKey === key || nameOrKey === name);
    },
  };
  return { trustedEntityReplayContext, entityPrototypeResolver };
}

const entitySource = {
  path: 'canonical-source.factorio.ts',
  text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
const structural = Entity('entity:structural');
const constant: ConstantCombinator = Constant({ sections: [{ filters: [[A, 1]] }] });
const arithmetic: ArithmeticCombinator = Arithmetic({ left: input[A], operation: 'add', right: 1, output: A });
output += constant;
output += arithmetic;
void structural;`,
};

describe('canonical source compilation', () => {
  test('emits one version-free entity-free artifact and records pipeline stages', () => {
    const stages: SourceCompilationStage[] = [];
    const compilation = compileSourceProgram(
      {
        path: 'entity-free.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
output += CC(2 * A);`,
      },
      {},
      [],
      (stage) => stages.push(stage),
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(stages).toEqual(['parse', 'semantic', 'transform', 'execute', 'lower']);
    expect(compilation.plan?.entities).toEqual([]);
    expect(Object.hasOwn(compilation.plan ?? {}, 'version')).toBe(false);
    expect(compilation.resolvedCircuit?.format).toBe('comblang-resolved-circuit');
    expect(Object.hasOwn(compilation.resolvedCircuit?.ir ?? {}, 'version')).toBe(false);
    expect(compilation.execution).toBeDefined();
  });

  test('compiles trusted Entity source into the same canonical public result', () => {
    const host = canonicalHost();
    const compilation = compileSourceProgram(entitySource, host);

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.plan?.entities).toHaveLength(3);
    expect(
      compilation.plan?.producers.filter(({ entityId }) => entityId !== undefined),
    ).toHaveLength(2);
    expect(compilation.resolvedCircuit?.format).toBe('comblang-resolved-circuit');
    expect(compilation.resolvedCircuit?.ir.entities).toHaveLength(3);
    expect(
      validateCanonicalDirectPlan(compilation.plan, host.trustedEntityReplayContext).diagnostics,
    ).toEqual([]);
    expect(structuredClone(sourceCompilationArtifact(compilation))).toEqual(
      sourceCompilationArtifact(compilation),
    );
  });

  test('keeps parser and compiler diagnostics separate while returning no execution', () => {
    const compilation = compileSourceProgram({
      path: 'invalid.factorio.ts',
      text: 'const broken = ;',
    });

    expect(compilation.diagnostics.length).toBeGreaterThan(0);
    expect(compilation.pipelineDiagnostics.length).toBeGreaterThan(0);
    expect(compilation.execution).toBeUndefined();
    expect(compilation.plan).toBeUndefined();
    expect(compilation.resolvedCircuit).toBeUndefined();
  });

  test('does not emit physical data for an identity-only Entity request', () => {
    const trusted = createTrustedEntityReplayContext({
      database: syntheticZeroPortEntityProfile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'canonical-source-evidence',
      policyIdentity: 'canonical-source-policy',
      profiles: [syntheticZeroPortEntityProfile],
    });
    const compilation = compileSourceProgram(
      {
        path: 'identity-only.factorio.ts',
        text: "const entity = Entity('entity:synthetic-zero-port');",
      },
      { entityReplayContext: entityReplayContextTransport(trusted) },
    );

    expect(compilation.plan).toBeUndefined();
    expect(compilation.resolvedCircuit).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({ code: 'RT2027', severity: 'error' }),
    ]);
  });

  test('accepts an already parsed source without repeating parser work', () => {
    const parsed = parseFile({
      path: 'parsed.factorio.ts',
      text: 'const input = new Network(); const output = input + 1;',
    });
    const compilation = compileParsedSourceProgram(parsed);
    expect(compilation.fileId).toBe(parsed.id);
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    ]);
    expect(compilation.plan?.format).toBe('comblang-direct-plan');
  });

  test('keeps the host-local execution out of the cloneable canonical artifact', () => {
    const compilation = compileSourceProgram({
      path: 'transport.factorio.ts',
      text: 'const output = new Network();',
    });
    const artifact = sourceCompilationArtifact(compilation);

    expect(compilation.execution).toBeDefined();
    expect(artifact).not.toHaveProperty('execution');
    expect(artifact.resolvedCircuit?.format).toBe('comblang-resolved-circuit');
    expect(structuredClone(artifact)).toEqual(artifact);
  });

  test('retains transformed JavaScript while a preflight error skips execution', () => {
    const stages: SourceCompilationStage[] = [];
    const compilation = compileSourceProgram(
      { path: 'blocked.factorio.ts', text: 'throw new Error("must not run");' },
      {},
      [{ code: 'ENV_ERROR', severity: 'error', message: 'Invalid environment.' }],
      (stage) => stages.push(stage),
    );

    expect(compilation.elaborationJavaScript).toContain('must not run');
    expect(compilation.plan).toBeUndefined();
    expect(compilation.resolvedCircuit).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toEqual([
      { code: 'ENV_ERROR', severity: 'error', message: 'Invalid environment.' },
    ]);
    expect(stages).toEqual(['parse', 'semantic', 'transform']);
  });

  test('preserves ordered Constant outputs through the canonical source service', () => {
    const compilation = compileSourceProgram({
      path: 'ordered-constant.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B', 'legendary');
const output = new Network();
output += CC(1 * A, [A, 2], [[B, 3]], new Map([[A, 4]]), { [B]: 5 });`,
    });

    expect(compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error')).toEqual(
      [],
    );
    const producer = compilation.execution?.circuit.graph.producers[0];
    expect(producer).toMatchObject({ kind: 'constant' });
    if (producer?.kind !== 'constant') throw new Error('Expected one Constant producer.');
    expect(producer.config.outputs.map(({ signal, value }) => [signal.name, value])).toEqual([
      ['signal-A', 1],
      ['signal-A', 2],
      ['signal-B', 3],
      ['signal-A', 4],
      ['signal-B', 5],
    ]);
  });
});
