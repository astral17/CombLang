import { signal } from '@comblang/factorio';
import { describe, expect, test } from 'vitest';

import { blueprintJsonForArtifact } from './blueprint-demo.js';
import { compileSource } from './compile-source.js';
import { createSourceCircuitArtifact } from './source-circuit-artifact.js';
import { runSourceCircuitDemo, SourceSimulationController } from './source-demo.js';

describe('source circuit artifact', () => {
  test('shares one elaborated circuit across preview consumers and fresh simulations', () => {
    const compiled = compileSource({
      path: 'shared-preview.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = new Network();
const output = new Network();
output += input * 2;`,
    });
    expect(compiled.compilerDiagnostics).toEqual([]);

    const artifact = createSourceCircuitArtifact(compiled.plan!);
    const controller = new SourceSimulationController(artifact);
    const demo = runSourceCircuitDemo(artifact, 3);
    controller.reset();

    expect(Object.isFrozen(artifact)).toBe(true);
    expect(demo.outputValue).toBe(6);
    expect(blueprintJsonForArtifact(artifact)).toBe(artifact.blueprint);
    expect(artifact.blueprint.blueprint.entities).toHaveLength(1);

    const input = controller.timeline[0]!.networks.find(({ name }) => name === 'input')!;
    controller.setSignalAt(0, input.id, signal('virtual', 'signal-A'), 4);
    controller.stepFrom(0);
    expect(controller.signalValueAt(1, 'output', signal('virtual', 'signal-A'))).toBe(8);
  });
});
