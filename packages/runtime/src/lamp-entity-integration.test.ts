import { readFileSync } from 'node:fs';
import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import { loadPrototypeDatabase, loadPrototypeInputJson } from '@comblang/prototypes';
import { describe, expect, test } from 'vitest';

import builtinPrototypeDatabase from '../../prototypes/generated/space-age-2.1.17.json';
import { executeResolvedDirectPlan } from './direct-plan.js';
import {
  conservativeEntityProvisioningPolicy,
  EntityProvisioningService,
} from './entity-provisioning.js';
import { compileSourceProgram } from './source-compilation.js';

function extractExamplesFromHeading(page: string, heading: string): string[] {
  const lines = page.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `### ${heading}`);
  if (start < 0) throw new Error(`Missing documentation heading: ${heading}`);
  const end = lines.findIndex((line, index) => index > start && /^#{1,3} /.test(line));
  const section = lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
  return [...section.matchAll(/```ts\r?\n([\s\S]*?)\r?\n```/g)].map((match) => match[1]!);
}

async function bundledProvider() {
  const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
  const provisioned = new EntityProvisioningService().provision(
    prototypes,
    conservativeEntityProvisioningPolicy,
  );
  return { prototypes, ...provisioned };
}

describe('provider-backed Lamp connector support', () => {
  test.each([
    { color: 'R', expected: 'red' },
    { color: 'G', expected: 'green' },
  ] as const)(
    'exports a bundled small-lamp call on the $color lane',
    async ({ color, expected }) => {
      const { prototypes, trustedEntityReplayContext, entityPrototypeResolver } =
        await bundledProvider();
      const compilation = compileSourceProgram(
        {
          path: `small-lamp-${color.toLowerCase()}-call.factorio.ts`,
          text: [
            "const signal = Signal('virtual', 'signal-A');",
            `const state = new Network<${color}>();`,
            'state += CC(1 * signal);',
            "const lamp = Lamp('small-lamp', {",
            '  control_behavior: {',
            '    circuit_enabled: true,',
            "    circuit_condition: { first_signal: signal, comparator: '>', constant: 0 },",
            '  },',
            '}).at(4, 5, 8);',
            'lamp(state);',
          ].join('\n'),
        },
        { prototypes, trustedEntityReplayContext, entityPrototypeResolver },
      );

      expect(
        compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error'),
      ).toEqual([]);
      const plan = compilation.plan;
      const resolved = compilation.resolvedCircuit;
      if (plan === undefined || resolved === undefined) {
        throw new Error('Expected the bundled lamp source to resolve to a Blueprint circuit.');
      }
      expect(plan.entities).toHaveLength(2);
      const lampPlan = plan.entities.find(
        ({ profile }) => profile.prototypeKey === 'entity:small-lamp',
      );
      expect(lampPlan).toBeDefined();
      expect(lampPlan?.sharedConnectorAttachments).toMatchObject([
        { connector: 'circuit', network: 'state', direction: 'input' },
      ]);
      const physical = resolved.ir.entities.find(
        ({ prototypeName }) => prototypeName === 'small-lamp',
      )!;
      expect(physical.prototypeName).toBe('small-lamp');
      expect(physical.connectorBindings).toHaveLength(1);
      expect(physical.connectorBindings[0]).toMatchObject({
        endpoint: { connector: 'circuit', color: expected },
        direction: 'input',
        nativeConnector: 1,
      });

      const replayed = executeResolvedDirectPlan(plan, resolved);
      expect(replayed.circuit.ir.entities).toEqual(resolved.ir.entities);
      const blueprint = generateBlueprintJson(resolved.ir).blueprint;
      expect(blueprint.entities).toHaveLength(2);
      expect(blueprint.entities.find(({ name }) => name === 'small-lamp')).toMatchObject({
        name: 'small-lamp',
        position: { x: 4, y: 5 },
        direction: 8,
        control_behavior: {
          circuit_enabled: true,
          circuit_condition: {
            first_signal: { type: 'virtual', name: 'signal-A' },
            comparator: '>',
            constant: 0,
          },
        },
      });
      expect(blueprint.wires).toHaveLength(1);
    },
  );

  test('compiles the documented bundled Lamp example', async () => {
    const page = readFileSync(new URL('../../../docs/api/entity.md', import.meta.url), 'utf8');
    const [example] = extractExamplesFromHeading(page, 'Callable Lamp');
    expect(example).toBeDefined();

    const { prototypes, trustedEntityReplayContext, entityPrototypeResolver } =
      await bundledProvider();
    const compilation = compileSourceProgram(
      { path: 'entity-api-callable-lamp.factorio.ts', text: example! },
      { prototypes, trustedEntityReplayContext, entityPrototypeResolver },
    );
    expect(compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error')).toEqual(
      [],
    );
    expect(
      compilation.resolvedCircuit?.ir.entities.map(({ prototypeName }) => prototypeName),
    ).toEqual(['constant-combinator', 'small-lamp']);
  });

  test('refuses a callable lamp when raw connector evidence is absent', async () => {
    const metadata = {
      factorioVersion: '2.1.17',
      expansions: ['space-age'],
      mods: [
        { name: 'base', version: '2.1.17' },
        { name: 'space-age', version: '2.1.17' },
      ],
    };
    const rawDump = {
      item: {},
      fluid: {},
      recipe: {},
      'recipe-category': {},
      quality: { normal: { type: 'quality', name: 'normal', level: 0 } },
      'virtual-signal': { 'signal-A': { type: 'virtual-signal', name: 'signal-A' } },
      lamp: {
        'unwired-lamp': {
          type: 'lamp',
          name: 'unwired-lamp',
          flags: ['player-creation'],
          draw_circuit_wires: true,
          sprites: { connector_main: { filename: 'connector.png' } },
        },
      },
    };
    const loaded = await loadPrototypeInputJson(JSON.stringify(rawDump), {
      factorioDumpMetadata: JSON.stringify(metadata),
    });
    const provisioned = new EntityProvisioningService().provision(
      loaded.prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'unwired-lamp-call.factorio.ts',
        text: ["const lamp = Lamp('unwired-lamp');", 'lamp(new Network());'].join('\n'),
      },
      {
        prototypes: loaded.prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(loaded.prototypes.getEntity('unwired-lamp')?.circuitConnectorTopology).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toContainEqual(
      expect.objectContaining({
        code: 'RT2027',
        severity: 'error',
        span: expect.objectContaining({ start: expect.any(Number), end: expect.any(Number) }),
      }),
    );
  });
});
