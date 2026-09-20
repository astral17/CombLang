import { describe, expect, test } from 'vitest';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { ResolvedCircuit } from '@comblang/compiler/resolved-circuit';
import { compileSourceProgram } from '@comblang/runtime/source-compilation';

import { createSourceCircuitArtifact } from './source-circuit-artifact.js';

describe('canonical source circuit artifact', () => {
  test('hydrates a canonical entity-free compilation for preview and simulation', () => {
    const compilation = compileSourceProgram({
      path: 'canonical-artifact.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
const constant: ConstantCombinator = CC(2 * A);
output += constant;`,
    });
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.plan).toBeDefined();
    expect(compilation.resolvedCircuit).toBeDefined();

    const artifact = createSourceCircuitArtifact(
      compilation.plan as DirectElaborationPlan,
      compilation.resolvedCircuit as unknown as ResolvedCircuit,
    );
    expect(artifact.resolvedCircuit.format).toBe('comblang-resolved-circuit');
    expect(Object.hasOwn(artifact.resolvedCircuit.ir, 'version')).toBe(false);
    expect(artifact.blueprint.blueprint.entities).toHaveLength(1);
    expect(() => artifact.execution.circuit.createSimulation().step()).not.toThrow();
  });

  test('rejects stale canonical resolved data before preview hydration', () => {
    const compilation = compileSourceProgram({
      path: 'canonical-stale-artifact.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const output = new Network();
output += CC(2 * A);`,
    });
    if (compilation.plan === undefined || compilation.resolvedCircuit === undefined)
      throw new Error('Expected a canonical compilation artifact.');

    const stale = {
      ...compilation.resolvedCircuit,
      planFingerprint: 'plan-fnv1a64:0000000000000000',
    } as ResolvedCircuit;
    expect(() =>
      createSourceCircuitArtifact(compilation.plan as DirectElaborationPlan, stale),
    ).toThrow(/fingerprint does not match/i);
  });

  test('requires resolved physical data for an Entity-bearing plan', () => {
    const plan = {
      format: 'comblang-direct-plan',
      networks: [],
      producers: [],
      entities: [{}],
    } as unknown as DirectElaborationPlan;

    expect(() => createSourceCircuitArtifact(plan)).toThrow(/matching resolved circuit/i);
  });

  test('rejects malformed canonical resolved arrays before hydration', () => {
    const compilation = compileSourceProgram({
      path: 'canonical-malformed-artifact.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const output = new Network();
output += CC(2 * A);`,
    });
    if (compilation.plan === undefined || compilation.resolvedCircuit === undefined)
      throw new Error('Expected a canonical compilation artifact.');

    const networks = [] as unknown[];
    networks.length = compilation.resolvedCircuit.ir.networks.length;
    const malformed = {
      ...compilation.resolvedCircuit,
      ir: { ...compilation.resolvedCircuit.ir, networks },
    } as unknown as ResolvedCircuit;
    expect(() =>
      createSourceCircuitArtifact(compilation.plan as DirectElaborationPlan, malformed),
    ).toThrow(/holes/i);
  });
});
