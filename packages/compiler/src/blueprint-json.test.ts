import { signal } from '@comblang/factorio';
import type { NetworkId, ProducerId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { BlueprintJsonError, generateBlueprintJson } from './blueprint-json.js';
import type { LogicalDeciderCondition, NativeCircuitIr } from './ir.js';

const network = (value: number) => `network:${value}` as NetworkId;
const producer = (value: number) => `producer:${value}` as ProducerId;

const provenance = { instancePath: [], expansionStack: [] };
const testNetworks: NativeCircuitIr['networks'] = [
  { id: network(1), color: 'red', provenance },
  { id: network(2), color: 'green', provenance },
  { id: network(3), color: 'red', provenance },
];
const compare = (name: string): LogicalDeciderCondition => ({
  kind: 'compare',
  left: { kind: 'signal', signal: signal('virtual', name), refKind: 'single', network: network(1) },
  comparator: '>',
  right: { kind: 'constant', value: 0 },
});
const deciderIr = (condition: LogicalDeciderCondition): NativeCircuitIr => ({
  format: 'comblang-ncir',
  version: 2,
  networks: testNetworks,
  producers: [
    {
      id: producer(1),
      kind: 'decider',
      provenance,
      destinations: [network(3)],
      config: { condition, outputs: [] },
    },
  ],
});

describe('Factorio blueprint JSON generator', () => {
  test('bounds distributive expansion, permits an explicit override, and retains source provenance', () => {
    const condition: LogicalDeciderCondition = {
      kind: 'and',
      conditions: [
        { kind: 'or', conditions: [compare('A'), compare('B')] },
        { kind: 'or', conditions: [compare('C'), compare('D')] },
      ],
    };
    const original = deciderIr(condition);
    const source = {
      fileId: 'file:export.ts' as import('@comblang/shared').SourceFileId,
      start: 12,
      end: 50,
    };
    const ir: NativeCircuitIr = {
      ...original,
      producers: original.producers.map((p) => ({ ...p, provenance: { ...p.provenance, source } })),
    };
    expect(() => generateBlueprintJson(ir, { maxDeciderConditionRows: 7 })).toThrowError(
      expect.objectContaining({
        code: 'BP1001',
        span: source,
        message: expect.stringContaining('7 rows'),
      }),
    );
    const output = generateBlueprintJson(ir, { maxDeciderConditionRows: 8 });
    const rows = (
      output.blueprint.entities[0]!.control_behavior as {
        decider_conditions: { conditions: unknown[] };
      }
    ).decider_conditions.conditions;
    expect(rows).toHaveLength(8);
    const large: LogicalDeciderCondition = {
      kind: 'and',
      conditions: Array.from({ length: 9 }, () => ({
        kind: 'or',
        conditions: [compare('A'), compare('B')],
      })),
    };
    expect(() => generateBlueprintJson(deciderIr(large))).toThrow('1024 rows');
    expect(() => generateBlueprintJson(ir, { maxDeciderConditionRows: 0 })).toThrow(
      'positive safe integer',
    );
    expect(() => generateBlueprintJson(deciderIr({ kind: 'and', conditions: [] }))).toThrow(
      BlueprintJsonError,
    );
  });

  test('rejects missing operand colors rather than reading the wrong physical input', () => {
    const ir = deciderIr(compare('A'));
    expect(() => generateBlueprintJson({ ...ir, networks: [] })).toThrowError(
      expect.objectContaining({ code: 'BP1001', message: expect.stringContaining('network:1') }),
    );
  });

  test('encodes separate red/green arithmetic operands and an explicit pair selection', () => {
    const A = signal('virtual', 'signal-A');
    const ir: NativeCircuitIr = {
      format: 'comblang-ncir',
      version: 2,
      networks: testNetworks,
      producers: [
        {
          id: producer(1),
          kind: 'arithmetic',
          provenance,
          destinations: [network(3)],
          config: {
            left: { kind: 'signal', signal: A, refKind: 'single', network: network(1) },
            right: { kind: 'signal', signal: A, refKind: 'single', network: network(2) },
            operation: 'subtract',
            output: { kind: 'signal', signal: A },
          },
        },
        {
          id: producer(2),
          kind: 'arithmetic',
          provenance,
          destinations: [network(3)],
          config: {
            left: { kind: 'each', refKind: 'pair', networks: [network(1), network(2)] },
            right: { kind: 'constant', value: 2 },
            operation: 'multiply',
            output: { kind: 'each' },
          },
        },
      ],
    };
    const configs = generateBlueprintJson(ir).blueprint.entities.map(
      (entity) =>
        (entity.control_behavior as { arithmetic_conditions: Record<string, unknown> })
          .arithmetic_conditions,
    );
    expect(configs[0]).toMatchObject({
      first_signal_networks: { red: true, green: false },
      second_signal_networks: { red: false, green: true },
    });
    expect(configs[1]).toMatchObject({ first_signal_networks: { red: true, green: true } });
    expect(configs[1]).not.toHaveProperty('second_signal_networks');
  });

  test('encodes Decider operand and normal/else output network selections', () => {
    const A = signal('virtual', 'signal-A');
    const ir: NativeCircuitIr = {
      format: 'comblang-ncir',
      version: 2,
      networks: testNetworks,
      producers: [
        {
          id: producer(1),
          kind: 'decider',
          provenance,
          destinations: [network(3)],
          config: {
            condition: {
              kind: 'compare',
              left: { kind: 'signal', signal: A, refKind: 'single', network: network(1) },
              comparator: '>',
              right: { kind: 'signal', signal: A, refKind: 'single', network: network(2) },
            },
            outputs: [
              {
                mode: 'copy',
                signal: { kind: 'signal', signal: A },
                input: { refKind: 'single', network: network(2) },
              },
              { mode: 'copy', signal: { kind: 'signal', signal: A } },
            ],
            elseOutputs: [
              {
                mode: 'copy',
                signal: { kind: 'wildcard', value: 'everything' },
                input: { refKind: 'pair', networks: [network(1), network(2)] },
              },
            ],
          },
        },
      ],
    };
    const config = (
      generateBlueprintJson(ir).blueprint.entities[0]!.control_behavior as {
        decider_conditions: Record<string, unknown>;
      }
    ).decider_conditions;
    expect(config).toMatchObject({
      conditions: [
        {
          first_signal_networks: { red: true, green: false },
          second_signal_networks: { red: false, green: true },
        },
      ],
      outputs: [{ networks: { red: false, green: true } }, {}],
      else_outputs: [{ networks: { red: true, green: true } }],
    });
    expect((config.outputs as Record<string, unknown>[])[1]).not.toHaveProperty('networks');
  });

  test.each<LogicalDeciderCondition>([
    {
      kind: 'or',
      conditions: [
        { kind: 'and', conditions: [compare('A'), compare('B')] },
        { kind: 'and', conditions: [compare('C'), compare('D')] },
      ],
    },
    {
      kind: 'and',
      conditions: [
        { kind: 'or', conditions: [compare('A'), compare('B')] },
        { kind: 'or', conditions: [compare('C'), compare('D')] },
      ],
    },
    {
      kind: 'and',
      conditions: [
        compare('A'),
        {
          kind: 'or',
          conditions: [compare('B'), { kind: 'and', conditions: [compare('C'), compare('D')] }],
        },
      ],
    },
  ])('preserves the truth table of nested Decider conditions: %j', (condition) => {
    const entity = generateBlueprintJson(deciderIr(condition)).blueprint.entities[0]!;
    const rows = (
      entity.control_behavior as {
        decider_conditions: {
          conditions: { first_signal: { name: string }; compare_type: 'and' | 'or' }[];
        };
      }
    ).decider_conditions.conditions;
    for (let bits = 0; bits < 16; bits++) {
      const value = (name: string) => (bits & (1 << ['A', 'B', 'C', 'D'].indexOf(name))) !== 0;
      const treeValue = (node: LogicalDeciderCondition): boolean =>
        node.kind === 'and'
          ? node.conditions.every(treeValue)
          : node.kind === 'or'
            ? node.conditions.some(treeValue)
            : value(node.left.kind === 'signal' ? node.left.signal.name : '');
      // Native flat list: compare_type joins the preceding row, AND binds before OR.
      let previousGroup = true;
      let anyPreviousGroup = false;
      for (const [index, row] of rows.entries()) {
        if (index > 0 && row.compare_type === 'or') {
          anyPreviousGroup ||= previousGroup;
          previousGroup = true;
        }
        previousGroup &&= value(row.first_signal.name);
      }
      expect(anyPreviousGroup || previousGroup, `input bits ${bits}`).toBe(treeValue(condition));
    }
  });

  test('emits entities, control behavior, placement, and circuit wires', () => {
    const A = signal('virtual', 'signal-A');
    const ir: NativeCircuitIr = {
      format: 'comblang-ncir',
      version: 2,
      networks: [
        {
          id: network(1),
          name: 'constants',
          color: 'red',
          provenance: { instancePath: [], expansionStack: [] },
        },
        {
          id: network(2),
          name: 'scaled',
          color: 'green',
          provenance: { instancePath: [], expansionStack: [] },
        },
      ],
      producers: [
        {
          id: producer(1),
          kind: 'constant',
          config: { outputs: [{ signal: A, value: 5 }] },
          destinations: [network(1)],
          provenance: { instancePath: [], expansionStack: [] },
        },
        {
          id: producer(2),
          kind: 'arithmetic',
          placement: { x: 12.5, y: -4, direction: 8 },
          config: {
            left: { kind: 'signal', signal: A, refKind: 'single', network: network(1) },
            operation: 'multiply',
            right: { kind: 'constant', value: 2 },
            output: { kind: 'signal', signal: A },
          },
          destinations: [network(2)],
          provenance: { instancePath: [], expansionStack: [] },
        },
      ],
    };

    const generated = generateBlueprintJson(ir, { label: 'Test circuit' });

    expect(generated.blueprint).toMatchObject({
      item: 'blueprint',
      label: 'Test circuit',
      entities: [
        {
          entity_number: 1,
          name: 'constant-combinator',
          position: { x: 0.5, y: 0.5 },
        },
        {
          entity_number: 2,
          name: 'arithmetic-combinator',
          position: { x: 12.5, y: -4 },
          direction: 8,
          control_behavior: {
            arithmetic_conditions: {
              first_signal: { type: 'virtual', name: 'signal-A' },
              operation: '*',
              second_constant: 2,
            },
          },
        },
      ],
      wires: [[1, 1, 2, 1]],
    });
    expect(JSON.parse(JSON.stringify(generated))).toEqual(generated);
  });

  test('omits the default item SignalID type in blueprint fields', () => {
    const IRON = signal('item', 'iron-plate');
    const ir: NativeCircuitIr = {
      format: 'comblang-ncir',
      version: 2,
      networks: [
        {
          id: network(1),
          name: 'constants',
          color: 'red',
          provenance: { instancePath: [], expansionStack: [] },
        },
      ],
      producers: [
        {
          id: producer(1),
          kind: 'constant',
          config: { outputs: [{ signal: IRON, value: 5 }] },
          destinations: [network(1)],
          provenance: { instancePath: [], expansionStack: [] },
        },
      ],
    };

    const filter = (
      generateBlueprintJson(ir).blueprint.entities[0]?.control_behavior as {
        sections: { sections: { filters: Record<string, unknown>[] }[] };
      }
    ).sections.sections[0]!.filters[0];
    expect(filter).toMatchObject({ name: 'iron-plate', count: 5 });
    expect(filter).not.toHaveProperty('type');
  });

  test('preserves ordered duplicate-signal Decider output rows', () => {
    const A = signal('virtual', 'signal-A');
    const ir: NativeCircuitIr = {
      format: 'comblang-ncir',
      version: 2,
      networks: [
        {
          id: network(1),
          name: 'input',
          color: 'red',
          provenance: { instancePath: [], expansionStack: [] },
        },
        {
          id: network(2),
          name: 'output',
          color: 'green',
          provenance: { instancePath: [], expansionStack: [] },
        },
      ],
      producers: [
        {
          id: producer(1),
          kind: 'decider',
          config: {
            condition: {
              kind: 'compare',
              left: {
                kind: 'wildcard',
                value: 'each',
                refKind: 'single',
                network: network(1),
              },
              comparator: '!=',
              right: { kind: 'constant', value: 0 },
            },
            outputs: [
              {
                mode: 'copy',
                signal: { kind: 'signal', signal: A },
                input: { refKind: 'single', network: network(1) },
              },
              { mode: 'constant', signal: { kind: 'signal', signal: A }, value: 1 },
            ],
          },
          destinations: [network(2)],
          provenance: { instancePath: [], expansionStack: [] },
        },
      ],
    };

    const entity = generateBlueprintJson(ir).blueprint.entities[0] as {
      control_behavior: { decider_conditions: { outputs: Record<string, unknown>[] } };
    };
    expect(entity.control_behavior.decider_conditions.outputs).toEqual([
      {
        signal: { type: 'virtual', name: 'signal-A' },
        copy_count_from_input: true,
        networks: { red: true, green: false },
      },
      {
        signal: { type: 'virtual', name: 'signal-A' },
        copy_count_from_input: false,
        constant: 1,
      },
    ]);
  });
});
