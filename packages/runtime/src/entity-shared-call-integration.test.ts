import { readFileSync } from 'node:fs';
import { loadPrototypeDatabase } from '@comblang/prototypes';
import { describe, expect, test } from 'vitest';
import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import { resolvedCircuitPlanFingerprint } from '@comblang/compiler/resolved-circuit';

import builtinPrototypeDatabase from '../../prototypes/generated/space-age-2.1.17.json';
import {
  conservativeEntityProvisioningPolicy,
  EntityProvisioningService,
} from './entity-provisioning.js';
import { projectEntityObjectConnectors } from './entity-object-adapter.js';
import { lowerEntityRecords } from './entity-lowering.js';
import { executeResolvedDirectPlan } from './direct-plan.js';
import { compileSourceProgram } from './source-compilation.js';

async function compileBundledSource(path: string, text: string) {
  const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
  const provisioned = new EntityProvisioningService().provision(
    prototypes,
    conservativeEntityProvisioningPolicy,
  );
  const compilation = compileSourceProgram(
    { path, text },
    {
      prototypes,
      trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
      entityPrototypeResolver: provisioned.entityPrototypeResolver,
    },
  );
  return { provisioned, compilation };
}

function extractExamplesFromHeading(page: string, heading: string): string[] {
  const lines = page.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `### ${heading}`);
  if (start < 0) throw new Error(`Missing documentation heading: ${heading}`);
  const end = lines.findIndex((line, index) => index > start && /^#{1,3} /.test(line));
  const section = lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
  return [...section.matchAll(/```ts\r?\n([\s\S]*?)\r?\n```/g)].map((match) => match[1]!);
}

describe('provider-backed shared Entity calls', () => {
  test.each([
    {
      path: '../../../docs/api/entity.md',
      heading: 'Reading a shared output',
      stem: 'entity-api-doc-shared-read',
    },
    {
      path: '../../../docs/language-reference.md',
      heading: 'Reading a shared Entity output',
      stem: 'language-reference-shared-read',
    },
  ])(
    'keeps valid and ambiguous examples in $heading aligned with the compiler',
    async ({ path, heading, stem }) => {
      const page = readFileSync(new URL(path, import.meta.url), 'utf8');
      const [valid, ambiguous] = extractExamplesFromHeading(page, heading);
      expect(valid).toBeDefined();
      expect(ambiguous).toBeDefined();

      const validCompilation = await compileBundledSource(`${stem}-valid.factorio.ts`, valid!);
      expect(
        validCompilation.compilation.pipelineDiagnostics.filter(
          ({ severity }) => severity === 'error',
        ),
      ).toEqual([]);

      const ambiguousCompilation = await compileBundledSource(
        `${stem}-ambiguous.factorio.ts`,
        ambiguous!,
      );
      expect(ambiguousCompilation.compilation.pipelineDiagnostics).toContainEqual(
        expect.objectContaining({ code: 'RT2032', severity: 'error' }),
      );
    },
  );

  test.each([
    {
      name: 'arithmetic',
      path: 'entity-shared-read-arithmetic.factorio.ts',
      source: `const input = new Network();
const machine = Entity('iron-chest');
const called = machine(input);
const doubled = called * 2;
const sink = new Network();
sink += doubled;`,
    },
    {
      name: 'concrete Signal selection',
      path: 'entity-shared-read-selection.factorio.ts',
      source: `const input = new Network();
const machine = Entity('iron-chest');
machine(input);
const doubled = machine[Signal('virtual', 'signal-A')] * 2;
const sink = new Network();
sink += doubled;`,
    },
    {
      name: 'typed Network initializer',
      path: 'entity-shared-read-typed-network.factorio.ts',
      source: `const input = new Network();
const machine = Entity('iron-chest');
machine(input);
const output: Network = machine;
const doubled = output * 2;
const sink = new Network();
sink += doubled;`,
    },
    {
      name: 'Readonly<Network> argument',
      path: 'entity-shared-readonly-argument.factorio.ts',
      source: `function Double(input: Readonly<Network>) { return input * 2; }
const input = new Network();
const machine = Entity('iron-chest');
machine(input);
const doubled = Double(machine);
const sink = new Network();
sink += doubled;`,
    },
    {
      name: 'existing output reuse',
      path: 'entity-shared-read-existing-output.factorio.ts',
      source: `const input = new Network();
const output = new Network();
const machine = Entity('iron-chest');
output += machine(input);
const doubled = machine * 2;
const sink = new Network();
sink += doubled;`,
    },
  ] as const)('reads the single shared output through $name', async ({ name, path, source }) => {
    const { compilation } = await compileBundledSource(path, source);
    expect(
      compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error'),
      name,
    ).toEqual([]);
    const plan = compilation.plan!;
    const ir = compilation.resolvedCircuit!.ir;
    const machines = ir.entities.filter(({ prototypeName }) => prototypeName === 'iron-chest');
    expect(machines).toHaveLength(1);
    expect(ir.producers).toHaveLength(1);
    expect(ir.producers[0]?.kind).toBe('arithmetic');
    const machine = machines[0]!;
    expect(machine.connectorBindings.map(({ direction }) => direction).sort()).toEqual([
      'input',
      'output',
    ]);
    expect(new Set(machine.connectorBindings.map(({ network }) => network)).size).toBe(2);
    expect(new Set(machine.connectorBindings.map(({ endpoint }) => endpoint.color))).toEqual(
      new Set(['red', 'green']),
    );
    expect(
      plan.entities?.find(({ id }) => id === machine.id)?.sharedConnectorAttachments,
    ).toHaveLength(2);
  });

  test('coalesces transferred input aliases before lazily attaching the output', async () => {
    const source = `const first = new Network();
const second = new Network();
const joined = new Network();
const machine = Entity('iron-chest');
machine(first, second);
joined.take(first);
joined.take(second);
const doubled = machine * 2;
const sink = new Network();
sink += doubled;`;
    const { compilation } = await compileBundledSource(
      'entity-shared-read-transferred-inputs.factorio.ts',
      source,
    );

    expect(compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error')).toEqual(
      [],
    );
    expect(compilation.plan?.entities?.[0]?.sharedConnectorAttachments).toHaveLength(3);
    const machine = compilation.resolvedCircuit?.ir.entities.find(
      ({ prototypeName }) => prototypeName === 'iron-chest',
    );
    expect(machine?.connectorBindings.map(({ direction }) => direction).sort()).toEqual([
      'input',
      'output',
    ]);
    expect(new Set(machine?.connectorBindings.map(({ network }) => network)).size).toBe(2);
  });

  test.each([
    { input: 'R', output: 'G', inputColor: 'red', outputColor: 'green' },
    { input: 'G', output: 'R', inputColor: 'green', outputColor: 'red' },
  ] as const)(
    'solves lazy output colors in either orientation ($input/$output)',
    async ({ input, output, inputColor, outputColor }) => {
      const source = `const input = new Network<${input}>();
const machine = Entity('iron-chest');
machine(input);
const output: Network<${output}> = machine;
const doubled = output * 2;
const sink = new Network();
sink += doubled;`;
      const { compilation } = await compileBundledSource(
        `entity-shared-read-color-${input}-${output}.factorio.ts`,
        source,
      );

      expect(
        compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error'),
      ).toEqual([]);
      const machine = compilation.resolvedCircuit?.ir.entities.find(
        ({ prototypeName }) => prototypeName === 'iron-chest',
      );
      expect(
        machine?.connectorBindings.map(({ direction, endpoint }) => ({
          direction,
          color: endpoint.color,
        })),
      ).toEqual(
        expect.arrayContaining([
          { direction: 'input', color: inputColor },
          { direction: 'output', color: outputColor },
        ]),
      );
    },
  );

  test('refuses a lazy output that conflicts with the input color', async () => {
    const source = `const input = new Network<R>();
const machine = Entity('iron-chest');
machine(input);
const output: Network<R> = machine;
const doubled = output * 2;
const sink = new Network();
sink += doubled;`;
    const { compilation } = await compileBundledSource(
      'entity-shared-read-color-conflict.factorio.ts',
      source,
    );

    expect(compilation.pipelineDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'RT2010' }),
    );
  });

  test('refuses ambiguous reads without leaving a private output behind', async () => {
    const source = `const first = new Network();
const second = new Network();
const machine = Entity('iron-chest');
machine(first, second);
try {
  const invalid = machine * 2;
  throw new Error('ambiguous read was accepted');
} catch (error) {
  if (error.code !== 'RT2032') throw error;
}
first += machine;
second += machine;`;
    const { compilation } = await compileBundledSource(
      'entity-shared-read-ambiguous-inputs.factorio.ts',
      source,
    );

    expect(compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error')).toEqual(
      [],
    );
    expect(compilation.plan?.networks).toHaveLength(2);
    expect(compilation.plan?.entities?.[0]?.sharedConnectorAttachments).toHaveLength(4);
    expect(compilation.resolvedCircuit?.ir.entities[0]?.connectorBindings).toHaveLength(4);
  });

  test.each([
    { expression: 'machine + unconnected', caseName: 'left arithmetic operand' },
    { expression: 'unconnected + machine', caseName: 'right arithmetic operand' },
    { expression: 'machine > unconnected', caseName: 'comparison operand' },
  ])(
    'rolls back a lazy Entity output when the other $caseName is unreadable',
    async ({ expression }) => {
      const { compilation } = await compileBundledSource(
        'entity-shared-read-invalid-operand-rollback.factorio.ts',
        `const input = new Network();
const machine = Entity('iron-chest');
machine(input);
const unconnected = Entity('iron-chest');
try { const invalid = ${expression}; } catch (error) {
  if (error.code !== 'RT2032') throw error;
}
const output = new Network();
output += machine;`,
      );
      expect(
        compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error'),
      ).toEqual([]);
      expect(compilation.plan?.networks).toHaveLength(2);
      expect(compilation.plan?.entities?.[0]?.sharedConnectorAttachments).toHaveLength(2);
    },
  );

  test('preserves an existing output when an Entity binary read fails', async () => {
    const { compilation } = await compileBundledSource(
      'entity-shared-read-invalid-operand-existing-output.factorio.ts',
      `const input = new Network();
const existing = new Network();
const machine = Entity('iron-chest');
machine(input);
existing += machine;
const unconnected = Entity('iron-chest');
try { const invalid = machine + unconnected; } catch (error) {
  if (error.code !== 'RT2032') throw error;
}
const output: Network = machine;`,
    );

    expect(compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error')).toEqual(
      [],
    );
    expect(compilation.plan?.networks).toHaveLength(2);
    expect(compilation.plan?.entities?.[0]?.sharedConnectorAttachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ direction: 'input', network: 'input' }),
        expect.objectContaining({ direction: 'output', network: 'existing' }),
      ]),
    );
    expect(compilation.plan?.entities?.[0]?.sharedConnectorAttachments).toHaveLength(2);
  });

  test('refuses two output candidates without manufacturing a third attachment', async () => {
    const source = `const first = new Network();
const second = new Network();
const machine = Entity('iron-chest');
first += machine;
second += machine;
try {
  const invalid = machine * 2;
  throw new Error('ambiguous read was accepted');
} catch (error) {
  if (error.code !== 'RT2032') throw error;
}`;
    const { compilation } = await compileBundledSource(
      'entity-shared-read-ambiguous-outputs.factorio.ts',
      source,
    );

    expect(compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error')).toEqual(
      [],
    );
    expect(compilation.plan?.networks).toHaveLength(2);
    expect(compilation.plan?.entities?.[0]?.sharedConnectorAttachments).toHaveLength(2);
    expect(compilation.plan?.entities?.[0]?.sharedConnectorAttachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ direction: 'output', network: 'first' }),
        expect.objectContaining({ direction: 'output', network: 'second' }),
      ]),
    );
  });

  test('reads an explicitly declared same-Network input and output', async () => {
    const source = `const input = new Network();
const machine = Entity('iron-chest');
machine(input);
input += machine;
const doubled = machine * 2;
const sink = new Network();
sink += doubled;`;
    const { compilation } = await compileBundledSource(
      'entity-shared-read-same-network-input-output.factorio.ts',
      source,
    );

    expect(compilation.pipelineDiagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'RT2032' }),
    );
    expect(compilation.plan?.entities?.[0]?.sharedConnectorAttachments).toHaveLength(2);
    const bindings = compilation.resolvedCircuit?.ir.entities[0]?.connectorBindings;
    expect(bindings).toHaveLength(2);
    expect(new Set(bindings?.map(({ network }) => network)).size).toBe(1);
  });

  test('returns an Entity without moving its same-Network roles twice', async () => {
    const source = `function Build(input: Move<Network>) {
  const machine = Entity('iron-chest');
  machine(input);
  input += machine;
  return machine;
}
const machine = Build(new Network());
const doubled = machine * 2;
const sink = new Network();
sink += doubled;`;
    const { compilation } = await compileBundledSource(
      'entity-shared-read-same-network-entity-return.factorio.ts',
      source,
    );

    expect(compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error')).toEqual(
      [],
    );
    const machine = compilation.resolvedCircuit?.ir.entities.find(
      ({ prototypeName }) => prototypeName === 'iron-chest',
    );
    expect(machine?.connectorBindings).toHaveLength(2);
    expect(new Set(machine?.connectorBindings.map(({ network }) => network)).size).toBe(1);
    expect(() =>
      executeResolvedDirectPlan(compilation.plan!, compilation.resolvedCircuit!),
    ).not.toThrow();
  });

  test('keeps a later unrelated output subject to shared connector capacity', async () => {
    const source = `const input = new Network();
const unrelated = new Network();
const machine = Entity('iron-chest');
machine(input);
const output: Network = machine;
unrelated += machine;
const doubled = output * 2;
const sink = new Network();
sink += doubled;`;
    const { compilation } = await compileBundledSource(
      'entity-shared-read-third-connection.factorio.ts',
      source,
    );

    expect(compilation.pipelineDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'RT2009' }),
    );
    expect(compilation.plan?.entities?.[0]?.sharedConnectorAttachments).toHaveLength(3);
    expect(
      new Set(
        compilation.plan?.entities?.[0]?.sharedConnectorAttachments?.map(({ network }) => network),
      ).size,
    ).toBe(3);
  });

  test('returns a locally created output with its Entity through nested functions', async () => {
    const source = `function Build(input: Move<Network>) {
  const machine = Entity('iron-chest');
  machine(input);
  const output: Network = machine;
  return machine;
}
function Wrap(input: Move<Network>) { return Build(input); }
const machine = Wrap(new Network());
const doubled = machine * 2;
const sink = new Network();
sink += doubled;`;
    const { compilation } = await compileBundledSource(
      'entity-shared-read-nested-entity-return.factorio.ts',
      source,
    );

    expect(compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error')).toEqual(
      [],
    );
    const machine = compilation.resolvedCircuit?.ir.entities.find(
      ({ prototypeName }) => prototypeName === 'iron-chest',
    );
    expect(machine?.connectorBindings.map(({ direction }) => direction).sort()).toEqual([
      'input',
      'output',
    ]);
    expect(new Set(machine?.connectorBindings.map(({ network }) => network)).size).toBe(2);
  });

  test.each(['machine', 'output'])(
    'returns a locally created Entity output as a Network value through %s',
    async (returned) => {
      const source = `function Build(): Network {
  const input = new Network();
  const machine = Entity('iron-chest');
  machine(input);
  const output: Network = machine;
  return ${returned};
}
const output = Build();
const doubled = output * 2;
const sink = new Network();
sink += doubled;`;
      const { compilation } = await compileBundledSource(
        'entity-shared-read-network-return.factorio.ts',
        source,
      );

      expect(
        compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error'),
      ).toEqual([]);
      const machine = compilation.resolvedCircuit?.ir.entities.find(
        ({ prototypeName }) => prototypeName === 'iron-chest',
      );
      expect(machine?.connectorBindings.map(({ direction }) => direction).sort()).toEqual([
        'input',
        'output',
      ]);
      expect(new Set(machine?.connectorBindings.map(({ network }) => network)).size).toBe(2);
    },
  );

  test('rebases an explicit Entity output through a nested Move<Network> return', async () => {
    const source = `function Pass(output: Move<Network>): Network {
  return output;
}
function Build(): Network {
  const input = new Network();
  const machine = Entity('iron-chest');
  machine(input);
  const output = new Network();
  output += machine;
  return Pass(output);
}
const output = Build();
const doubled = output * 2;
const sink = new Network();
sink += doubled;`;
    const { compilation } = await compileBundledSource(
      'entity-shared-read-move-network-return.factorio.ts',
      source,
    );

    expect(compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error')).toEqual(
      [],
    );
    const machine = compilation.resolvedCircuit?.ir.entities.find(
      ({ prototypeName }) => prototypeName === 'iron-chest',
    );
    expect(machine?.connectorBindings.map(({ direction }) => direction).sort()).toEqual([
      'input',
      'output',
    ]);
    expect(new Set(machine?.connectorBindings.map(({ network }) => network)).size).toBe(2);
    expect(() =>
      executeResolvedDirectPlan(compilation.plan!, compilation.resolvedCircuit!),
    ).not.toThrow();
  });

  test.each([
    { returned: 'output', access: 'built' },
    { returned: '{ output }', access: 'built.output' },
    { returned: '[output]', access: 'built[0]' },
  ])(
    'preserves Entity wiring when returning a projected Network through $returned',
    async ({ returned, access }) => {
      const { compilation } = await compileBundledSource(
        'entity-shared-read-aliased-return.factorio.ts',
        `function Build() {
  const input = new Network();
  const machine = Entity('iron-chest');
  machine(input);
  const output: Network = machine;
  return ${returned};
}
const built = Build();
const sink = new Network();
sink += ${access} * 2;`,
      );
      expect(
        compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error'),
      ).toEqual([]);
      expect(
        compilation.resolvedCircuit?.ir.entities.filter(
          ({ prototypeName }) => prototypeName === 'iron-chest',
        ),
      ).toHaveLength(1);
      expect(() =>
        executeResolvedDirectPlan(compilation.plan!, compilation.resolvedCircuit!),
      ).not.toThrow();
    },
  );

  test.each(['Entity', 'Combinator'] as const)(
    'retains physical %s wiring when a moved output is consumed by a helper',
    async (kind) => {
      const { compilation } = await compileBundledSource(
        'entity-shared-output-consumed-by-helper.factorio.ts',
        `function Scale(input: Move<Network>) { return input * 2; }
${
  kind === 'Entity'
    ? `const input = new Network();
const machine = Entity('iron-chest');
machine(input);
const output: Network = machine;`
    : `const output: Network = CC(1 * Signal('virtual', 'signal-A'));`
}
const scaled = Scale(output);
const sink = new Network();
sink += scaled;`,
      );
      expect(
        compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error'),
      ).toEqual([]);
      if (kind === 'Entity') {
        const machine = compilation.resolvedCircuit!.ir.entities.find(
          ({ prototypeName }) => prototypeName === 'iron-chest',
        )!;
        expect(machine.connectorBindings.map(({ direction }) => direction).sort()).toEqual([
          'input',
          'output',
        ]);
        expect(new Set(machine.connectorBindings.map(({ network }) => network))).toHaveLength(2);
      }
      const replayed = executeResolvedDirectPlan(compilation.plan!, compilation.resolvedCircuit!);
      expect(replayed).toBeDefined();
      const blueprint = generateBlueprintJson(compilation.resolvedCircuit!.ir).blueprint;
      if (kind === 'Entity') {
        expect(blueprint.entities.some(({ name }) => name === 'iron-chest')).toBe(true);
      }
      expect(blueprint.wires.length).toBeGreaterThan(0);
    },
  );

  test.each([
    {
      name: 'explicit Entity output',
      source: `function Scale(input: Move<Network>) { return input * 2; }
const input = new Network();
const machine = Entity('iron-chest');
machine(input);
const output = new Network();
output += machine;
const scaled = Scale(output);
const sink = new Network();
sink += scaled;`,
      directions: ['input', 'output'],
    },
    {
      name: 'Entity input',
      source: `function Scale(input: Move<Network>) { return input * 2; }
const input = new Network();
const machine = Entity('iron-chest');
machine(input);
const scaled = Scale(input);
const sink = new Network();
sink += scaled;`,
      directions: ['input'],
    },
    {
      name: 'nested Move helper',
      source: `function Scale(input: Move<Network>) { return input * 2; }
function Nested(input: Move<Network>) { return Scale(input); }
const input = new Network();
const machine = Entity('iron-chest');
machine(input);
const output: Network = machine;
const scaled = Nested(output);
const sink = new Network();
sink += scaled;`,
      directions: ['input', 'output'],
    },
  ])(
    'preserves physical Entity wiring when a Move is consumed by $name',
    async ({ name, source, directions }) => {
      const { compilation } = await compileBundledSource(
        `entity-shared-output-consumed-${name.replaceAll(' ', '-')}.factorio.ts`,
        source,
      );
      expect(
        compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error'),
      ).toEqual([]);
      const machine = compilation.resolvedCircuit!.ir.entities.find(
        ({ prototypeName }) => prototypeName === 'iron-chest',
      )!;
      expect(machine.connectorBindings.map(({ direction }) => direction).sort()).toEqual(
        [...directions].sort(),
      );
      expect(() =>
        executeResolvedDirectPlan(compilation.plan!, compilation.resolvedCircuit!),
      ).not.toThrow();
      const blueprint = generateBlueprintJson(compilation.resolvedCircuit!.ir).blueprint;
      expect(
        blueprint.entities.filter(({ name: prototype }) => prototype === 'iron-chest'),
      ).toHaveLength(1);
      expect(blueprint.wires.length).toBeGreaterThan(0);
    },
  );

  test.each([
    {
      name: 'stale caller alias',
      read: 'stale * 2',
      declaration: 'const stale = output;',
    },
    {
      name: 'lost Entity output',
      read: 'machine * 2',
      declaration: '',
    },
  ])('rejects $name after a Move helper consumes the output', async ({ read, declaration }) => {
    const { compilation } = await compileBundledSource(
      'entity-shared-output-consumed-invalid-read.factorio.ts',
      `function Scale(input: Move<Network>) { return input * 2; }
const input = new Network();
const machine = Entity('iron-chest');
machine(input);
const output: Network = machine;
${declaration}
const scaled = Scale(output);
const sink = new Network();
sink += scaled;
const invalid = ${read};`,
    );
    expect(compilation.pipelineDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'RT2019', severity: 'error' }),
    );
  });

  test('does not return an auto-readable Entity through a borrowed Ref input', async () => {
    const source = `function Escape(input: Ref<Network>) {
  const machine = Entity('iron-chest');
  machine(input);
  const output: Network = machine;
  return machine;
}
const input = new Network();
Escape(input);`;
    const { compilation } = await compileBundledSource(
      'entity-shared-read-ref-escape.factorio.ts',
      source,
    );

    expect(compilation.pipelineDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'RT2017' }),
    );
  });

  test.each([
    {
      callOrder: 'a,b',
      destination: 'a',
      captureOutput: 'before',
      expectedInputGeneration: 1,
    },
    {
      callOrder: 'a,b',
      destination: 'a',
      captureOutput: 'after',
      expectedInputGeneration: 1,
    },
    {
      callOrder: 'a,b',
      destination: 'b',
      captureOutput: 'before',
      expectedInputGeneration: 1,
    },
    {
      callOrder: 'a,b',
      destination: 'b',
      captureOutput: 'after',
      expectedInputGeneration: 1,
    },
    {
      callOrder: 'b,a',
      destination: 'a',
      captureOutput: 'before',
      expectedInputGeneration: 0,
    },
    {
      callOrder: 'b,a',
      destination: 'a',
      captureOutput: 'after',
      expectedInputGeneration: 0,
    },
    {
      callOrder: 'b,a',
      destination: 'b',
      captureOutput: 'before',
      expectedInputGeneration: 0,
    },
    {
      callOrder: 'b,a',
      destination: 'b',
      captureOutput: 'after',
      expectedInputGeneration: 0,
    },
  ] as const)(
    'coalesces transferred inputs across epochs ($callOrder, destination $destination, output $captureOutput)',
    async ({ callOrder, destination, captureOutput, expectedInputGeneration }) => {
      const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
      const provisioned = new EntityProvisioningService().provision(
        prototypes,
        conservativeEntityProvisioningPolicy,
      );
      const source = destination === 'a' ? 'b' : 'a';
      const attachOutput = `${destination} += machine;`;
      const compilation = compileSourceProgram(
        {
          path: 'entity-input-generation-collapse.factorio.ts',
          text: `function Make(): Network { return new Network(); }
const a = Make();
const b = new Network();
const machine = Entity('iron-chest');
machine(${callOrder});
${captureOutput === 'before' ? attachOutput : ''}
${destination}.take(${source});
${captureOutput === 'after' ? attachOutput : ''}`,
        },
        {
          prototypes,
          trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
          entityPrototypeResolver: provisioned.entityPrototypeResolver,
        },
      );
      expect(compilation.pipelineDiagnostics).toEqual([]);
      expect(compilation.plan?.entities).toHaveLength(1);
      const ir = compilation.resolvedCircuit!.ir;
      expect(ir.entities).toHaveLength(1);
      expect(ir.networks).toHaveLength(1);
      const bindings = ir.entities[0]!.connectorBindings;
      expect(bindings).toHaveLength(2);
      expect(bindings.map(({ direction }) => direction).sort()).toEqual(['input', 'output']);
      expect(new Set(bindings.map(({ network }) => network)).size).toBe(1);
      expect(bindings.find(({ direction }) => direction === 'input')?.generation).toBe(
        expectedInputGeneration,
      );
      expect(bindings.find(({ direction }) => direction === 'output')?.generation).toBe(
        destination === 'a' ? 1 : 0,
      );
      expect(() =>
        executeResolvedDirectPlan(compilation.plan!, compilation.resolvedCircuit!),
      ).not.toThrow();

      const networkColors = new Map(ir.networks.map(({ id, color }) => [id, color]));
      const lowered = lowerEntityRecords(
        compilation.plan!.entities!,
        provisioned.trustedEntityReplayContext,
        () => compilation.execution!.network(destination),
        networkColors,
      );
      expect(lowered[0]?.connectorBindings).toEqual(bindings);
    },
  );

  test('coalesces same-epoch input attachments after transfer', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-input-same-generation-collapse.factorio.ts',
        text: `const a = new Network();
const b = new Network();
const machine = Entity('iron-chest');
machine(a, b);
a.take(b);
a += machine;`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.resolvedCircuit?.ir.entities).toHaveLength(1);
    expect(compilation.resolvedCircuit?.ir.networks).toHaveLength(1);
    const bindings = compilation.resolvedCircuit!.ir.entities[0]!.connectorBindings;
    expect(bindings.map(({ direction }) => direction).sort()).toEqual(['input', 'output']);
    expect(new Set(bindings.map(({ network }) => network)).size).toBe(1);
  });

  test.each([
    { transfer: 'a.take(b);', returned: 'Build()' },
    { transfer: 'b.take(a);', returned: 'Build()' },
    { transfer: 'a.take(b); c.take(a);', returned: 'Wrap()' },
  ])(
    'returns a transferred Entity through $returned after $transfer',
    async ({ transfer, returned }) => {
      const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
      const provisioned = new EntityProvisioningService().provision(
        prototypes,
        conservativeEntityProvisioningPolicy,
      );
      const compilation = compileSourceProgram(
        {
          path: 'entity-return-transferred-shared-local.factorio.ts',
          text: `function Build() {
  const a = new Network();
  const b = new Network();
  ${transfer.includes('c.take') ? 'const c = new Network();' : ''}
  const machine = Entity('iron-chest');
  machine(a, b);
  a += machine;
  ${transfer}
  return machine;
}
function Wrap() { return Build(); }
const machine = ${returned};`,
        },
        {
          prototypes,
          trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
          entityPrototypeResolver: provisioned.entityPrototypeResolver,
        },
      );
      expect(compilation.pipelineDiagnostics).toEqual([]);
      expect(compilation.resolvedCircuit?.ir.entities).toHaveLength(1);
      expect(compilation.resolvedCircuit?.ir.networks).toHaveLength(1);
      const bindings = compilation.resolvedCircuit!.ir.entities[0]!.connectorBindings;
      expect(bindings.map(({ direction }) => direction).sort()).toEqual(['input', 'output']);
      expect(new Set(bindings.map(({ network }) => network)).size).toBe(1);
      expect(() =>
        executeResolvedDirectPlan(compilation.plan!, compilation.resolvedCircuit!),
      ).not.toThrow();
    },
  );

  test('paired replay rejects stale source and tampered physical shared-role records', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-transfer-replay-tampering.factorio.ts',
        text: `function Make(): Network { return new Network(); }
const a = Make();
const b = new Network();
const machine = Entity('iron-chest');
machine(a, b);
a.take(b);
a += machine;`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan!;
    const resolved = compilation.resolvedCircuit!;
    expect(() => executeResolvedDirectPlan(plan, resolved)).not.toThrow();

    const staleSourcePlan = structuredClone(plan) as any;
    const transferredSource = staleSourcePlan.entities[0].sharedConnectorAttachments.find(
      ({ network }: { network: string }) => network === 'b',
    );
    transferredSource.generation += 1;
    const staleSourceCircuit = structuredClone(resolved) as any;
    staleSourceCircuit.planFingerprint = resolvedCircuitPlanFingerprint(staleSourcePlan);
    expect(() => executeResolvedDirectPlan(staleSourcePlan, staleSourceCircuit)).toThrow();

    const tamperedGeneration = structuredClone(resolved) as any;
    const generationRepresentative = tamperedGeneration.ir.entities[0].connectorBindings.find(
      ({ direction }: { direction: string }) => direction === 'input',
    );
    generationRepresentative.generation += 2;
    expect(() => executeResolvedDirectPlan(plan, tamperedGeneration)).toThrow();

    const tamperedProvenance = structuredClone(resolved) as any;
    const provenanceRepresentative = tamperedProvenance.ir.entities[0].connectorBindings.find(
      ({ direction }: { direction: string }) => direction === 'input',
    );
    provenanceRepresentative.provenance.operationOrdinal += 1;
    expect(() => executeResolvedDirectPlan(plan, tamperedProvenance)).toThrow();

    const tamperedColor = structuredClone(resolved) as any;
    const physicalMachine = tamperedColor.ir.entities[0];
    const otherColor =
      physicalMachine.connectorBindings[0].endpoint.color === 'red' ? 'green' : 'red';
    const profile = provisioned.trustedEntityReplayContext.profiles.find(
      ({ ref }) => ref.prototypeKey === 'entity:iron-chest',
    )!;
    const sharedConnector = profile.connectors.find(
      ({ key }) => key === profile.sharedCallConnector,
    )!;
    const otherLane = sharedConnector.lanes.find(({ color }) => color === otherColor)!;
    tamperedColor.ir.networks[0].color = otherColor;
    for (const binding of physicalMachine.connectorBindings) {
      binding.endpoint.lane = otherLane.key;
      binding.endpoint.color = otherColor;
      binding.nativeConnector = otherLane.nativeEndpoint!.nativeConnector;
    }
    expect(() => executeResolvedDirectPlan(plan, tamperedColor)).toThrow();

    const missingRole = structuredClone(resolved) as any;
    missingRole.ir.entities[0].connectorBindings.pop();
    expect(() => executeResolvedDirectPlan(plan, missingRole)).toThrow();

    const addedRole = structuredClone(resolved) as any;
    const extraInput = structuredClone(
      addedRole.ir.entities[0].connectorBindings.find(
        ({ direction }: { direction: string }) => direction === 'input',
      ),
    );
    extraInput.provenance.operationOrdinal += 1;
    addedRole.ir.entities[0].connectorBindings.push(extraInput);
    expect(() => executeResolvedDirectPlan(plan, addedRole)).toThrow();
  });

  test('does not allow direct use of the consumed source alias after transfer', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-consumed-shared-source-alias.factorio.ts',
        text: `const a = new Network();
const b = new Network();
const machine = Entity('iron-chest');
machine(a, b);
a.take(b);
b += machine;`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );
    expect(compilation.pipelineDiagnostics).toMatchObject([
      { code: 'RT2012', message: expect.stringContaining('moved Network b') },
    ]);
  });

  test('returns one locally owned Network shared by input and output without moving it twice', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-return-shared-local.factorio.ts',
        text: `function Build() {
  const local = new Network();
  const machine = Entity('iron-chest');
  local += machine(local);
  return machine;
}
const machine = Build();`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.resolvedCircuit?.ir.entities).toHaveLength(1);
    const bindings = compilation.resolvedCircuit!.ir.entities[0]!.connectorBindings;
    expect(bindings.map(({ direction }) => direction).sort()).toEqual(['input', 'output']);
    expect(new Set(bindings.map(({ network }) => network)).size).toBe(1);
    expect(new Set(bindings.map(({ generation }) => generation)).size).toBe(1);
  });

  test('accepts the bundled assembler-3 call and output attachment repro', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-call-gap-repro.factorio.ts',
        text: `const input = new Network();
const output = new Network();
const machine = Entity('assembling-machine-3');
output += machine(input);`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.plan?.entities).toHaveLength(1);
    expect(compilation.plan?.entities[0]?.connectorBindings).toEqual([]);
    expect(compilation.plan?.entities[0]?.sharedConnectorAttachments).toMatchObject([
      { connector: 'circuit', network: 'input', direction: 'input' },
      { connector: 'circuit', network: 'output', direction: 'output' },
    ]);
    const ir = compilation.resolvedCircuit?.ir;
    expect(ir).toBeDefined();
    expect(ir?.entities).toHaveLength(1);
    const machine = ir!.entities[0]!;
    expect(machine.prototypeName).toBe('assembling-machine-3');
    expect(machine.connectorBindings).toHaveLength(2);
    expect(new Set(machine.connectorBindings.map(({ endpoint }) => endpoint.color))).toEqual(
      new Set(['red', 'green']),
    );
    const networkColors = new Map(ir!.networks.map(({ id, color }) => [id, color]));
    for (const binding of machine.connectorBindings) {
      expect(binding.endpoint.connector).toBe('circuit');
      expect(binding.nativeConnector).toBe(1);
      expect(networkColors.get(binding.network!)).toBe(binding.endpoint.color);
    }
    expect(new Set(machine.connectorBindings.map(({ network }) => network))).toEqual(
      new Set(ir!.networks.map(({ id }) => id)),
    );
    expect(machine.connectorBindings.map(({ direction }) => direction).sort()).toEqual([
      'input',
      'output',
    ]);
    const blueprint = generateBlueprintJson(ir!).blueprint;
    expect(blueprint.entities).toHaveLength(1);
    expect(blueprint.entities[0]).toMatchObject({ name: 'assembling-machine-3' });
    if (compilation.plan?.entities === undefined || compilation.execution === undefined) {
      throw new Error('Expected the checked Entity plan and execution.');
    }
    const lowered = lowerEntityRecords(
      compilation.plan.entities,
      provisioned.trustedEntityReplayContext,
      (name) => compilation.execution!.network(name),
      networkColors,
    );
    expect(lowered[0]?.connectorBindings).toEqual(machine.connectorBindings);
  });

  test.each([
    { a: 'R', b: 'G', aColor: 'red', bColor: 'green' },
    { a: 'G', b: 'R', aColor: 'green', bColor: 'red' },
  ] as const)(
    'attaches two readable Networks on one provider-backed Entity call ($a/$b)',
    async ({ a, b, aColor, bColor }) => {
      const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
      const provisioned = new EntityProvisioningService().provision(
        prototypes,
        conservativeEntityProvisioningPolicy,
      );
      const compilation = compileSourceProgram(
        {
          path: 'entity-call-multiple-inputs.factorio.ts',
          text: `const A = Signal('virtual', 'signal-A');
const a = new Network<${a}>();
const b = new Network<${b}>();
a += CC(1 * A);
b += CC(2 * A);
const machine = Entity('assembling-machine-3');
const x = machine(a, b);
a += x;
b += x;`,
        },
        {
          prototypes,
          trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
          entityPrototypeResolver: provisioned.entityPrototypeResolver,
        },
      );

      expect(compilation.pipelineDiagnostics).toEqual([]);
      expect(compilation.plan?.entities).toHaveLength(3);
      const plannedMachine = compilation.plan!.entities.find(
        ({ profile }) => profile.prototypeKey === 'entity:assembling-machine-3',
      );
      expect(plannedMachine?.sharedConnectorAttachments).toMatchObject([
        { connector: 'circuit', network: 'a', direction: 'input' },
        { connector: 'circuit', network: 'b', direction: 'input' },
        { connector: 'circuit', network: 'a', direction: 'output' },
        { connector: 'circuit', network: 'b', direction: 'output' },
      ]);

      const ir = compilation.resolvedCircuit?.ir;
      expect(ir?.entities).toHaveLength(3);
      const machine = ir!.entities.find(
        ({ prototypeName }) => prototypeName === 'assembling-machine-3',
      )!;
      expect(machine.connectorBindings).toHaveLength(4);
      expect(new Set(machine.connectorBindings.map(({ network }) => network)).size).toBe(2);
      expect(machine.connectorBindings.map(({ direction }) => direction).sort()).toEqual([
        'input',
        'input',
        'output',
        'output',
      ]);
      const networkColors = new Map(ir!.networks.map(({ id, color }) => [id, color]));
      const networkA = compilation.execution!.network('a').id;
      const networkB = compilation.execution!.network('b').id;
      for (const binding of machine.connectorBindings) {
        expect(networkColors.get(binding.network!)).toBe(binding.endpoint.color);
        if (binding.network === networkA) expect(binding.endpoint.color).toBe(aColor);
        if (binding.network === networkB) expect(binding.endpoint.color).toBe(bColor);
      }
      const [projected] = projectEntityObjectConnectors(machine);
      expect(projected?.inputNetworks).toEqual(expect.arrayContaining([networkA, networkB]));
      expect(projected?.inputNetworks).toHaveLength(2);
      expect(projected?.outputNetworks).toEqual(expect.arrayContaining([networkA, networkB]));
      expect(projected?.outputNetworks).toHaveLength(2);

      const blueprint = generateBlueprintJson(ir!).blueprint;
      expect(blueprint.entities).toHaveLength(3);
      expect(blueprint.wires).toHaveLength(2);
      const entityNumber = blueprint.entities.find(
        ({ name }) => name === 'assembling-machine-3',
      )?.entity_number;
      expect(entityNumber).toBeDefined();
      for (const binding of machine.connectorBindings) {
        const connectorId =
          binding.nativeConnector! * 2 - (binding.endpoint.color === 'red' ? 1 : 0);
        expect(
          blueprint.wires.filter(
            ([fromEntity, fromConnector, toEntity, toConnector]) =>
              (fromEntity === entityNumber && fromConnector === connectorId) ||
              (toEntity === entityNumber && toConnector === connectorId),
          ),
        ).toHaveLength(1);
      }
    },
  );

  test('projects both solved shared lanes to their native Blueprint wire connector IDs', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-call-native-wire-ids.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const input = CC(1 * A);
const output = new Network();
output += CC(2 * A);
const machine = Entity('assembling-machine-3');
output += machine(input);`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const ir = compilation.resolvedCircuit?.ir;
    expect(ir?.entities).toHaveLength(3);
    const machine = ir!.entities.find(
      ({ prototypeName }) => prototypeName === 'assembling-machine-3',
    );
    expect(machine).toBeDefined();
    const bindings = machine!.connectorBindings;
    expect(bindings).toHaveLength(2);
    const blueprint = generateBlueprintJson(ir!).blueprint;
    const entityNumber = blueprint.entities.find(
      ({ name }) => name === 'assembling-machine-3',
    )?.entity_number;
    expect(entityNumber).toBeDefined();
    expect(blueprint.wires).toHaveLength(2);
    for (const binding of bindings) {
      const connectorId = binding.nativeConnector! * 2 - (binding.endpoint.color === 'red' ? 1 : 0);
      const entityWire = blueprint.wires.filter(
        ([fromEntity, fromConnector, toEntity, toConnector]) =>
          (fromEntity === entityNumber && fromConnector === connectorId) ||
          (toEntity === entityNumber && toConnector === connectorId),
      );
      expect(entityWire).toHaveLength(1);
    }
  });

  test('coalesces same-Network roles in Blueprint wires and preserves both adapter directions', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-call-shared-loopback.factorio.ts',
        text: `const loop = new Network();
const machine = Entity('assembling-machine-3');
loop += machine(loop);`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const ir = compilation.resolvedCircuit?.ir;
    expect(ir?.entities).toHaveLength(1);
    const physical = ir!.entities[0]!;
    expect(physical.connectorBindings).toHaveLength(2);
    expect(physical.connectorBindings[0]?.network).toBe(physical.connectorBindings[1]?.network);
    expect(physical.connectorBindings[0]?.endpoint).toEqual(
      physical.connectorBindings[1]?.endpoint,
    );
    const network = physical.connectorBindings[0]!.network!;
    expect(projectEntityObjectConnectors(physical)).toEqual([
      { name: 'circuit', inputNetworks: [network], outputNetworks: [network] },
    ]);
    const blueprint = generateBlueprintJson(ir!).blueprint;
    expect(blueprint.entities).toHaveLength(1);
    expect(blueprint.wires).toEqual([]);
  });
});
