import { canonicalizeConstantConfiguration, signal } from '@comblang/factorio';
import type { NetworkId, ProducerId, SourceFileId, SourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import type {
  ArithmeticProducerConfig,
  CircuitProducerNode,
  NativeCircuitIr,
  SelectorProducerConfig,
} from '@comblang/compiler/ir';
import { createBlueprintConfigurationSet } from '../../compiler/src/blueprint-configuration-set.js';
import { bindBlueprintConfigurationSet } from '../../compiler/src/blueprint-configuration-binding.js';
import { replaceBlueprintConfigurationSetInNativeCircuitIr } from '../../compiler/src/blueprint-configuration-binding.js';
import type { BlueprintNumericExpression } from '../../compiler/src/blueprint-numeric-expression.js';
import { createBlueprintNumericExpression } from '../../compiler/src/blueprint-numeric-expression.js';
import { createBlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';
import { createArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-template.js';
import { createConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-template.js';
import { createSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-template.js';
import { createSimulationFromNativeCircuitIr } from './elaboration.js';

const A = signal('virtual', 'signal-A');
const B = signal('virtual', 'signal-B');
const provenance = { instancePath: [], expansionStack: [] } as const;

function ticks(ir: NativeCircuitIr, network: NetworkId, outputSignal: typeof A): readonly number[] {
  const simulation = createSimulationFromNativeCircuitIr(ir);
  return Array.from({ length: 4 }, () => simulation.step().read(network).get(outputSignal));
}

function collectExpressionNodes(expression: BlueprintNumericExpression): Set<object> {
  const nodes = new Set<object>();
  const visit = (value: BlueprintNumericExpression): void => {
    if (nodes.has(value)) return;
    nodes.add(value);
    if (value.kind === 'negate') visit(value.operand);
    else if (value.kind === 'binary') {
      visit(value.left);
      visit(value.right);
    }
  };
  visit(expression);
  return nodes;
}

function containsReference(
  value: unknown,
  references: ReadonlySet<object>,
  seen = new Set<object>(),
): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (references.has(value)) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined &&
      'value' in descriptor &&
      containsReference(descriptor.value, references, seen)
    );
  });
}

describe('configuration-set replacement concrete consumers', () => {
  test('matches Constant+Arithmetic Blueprint JSON and multiple simulator ticks', () => {
    const input = 'network:replacement-input' as NetworkId;
    const output = 'network:replacement-output' as NetworkId;
    const constantId = 'producer:replacement-constant' as ProducerId;
    const arithmeticId = 'producer:replacement-arithmetic' as ProducerId;
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 7 });
    const offset = session.number('offset', { defaultValue: 5 });
    const constantTemplate = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: A, value: amount }] }],
    });
    const arithmeticTemplate = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'signal', signal: A, refKind: 'single', network: input },
      operation: 'add',
      right: { kind: 'constant', value: offset },
      output: { kind: 'signal', signal: B },
    });
    const set = createBlueprintConfigurationSet(session, [
      { key: 'source', kind: 'constant', template: constantTemplate },
      { key: 'sum', kind: 'arithmetic', template: arithmeticTemplate },
    ]);
    const constant = canonicalizeConstantConfiguration({
      sections: [{ filters: [{ signal: A, value: 1 }] }],
    });
    const arithmetic: ArithmeticProducerConfig = {
      left: { kind: 'signal', signal: A, refKind: 'single', network: input },
      operation: 'add',
      right: { kind: 'constant', value: 1 },
      output: { kind: 'signal', signal: B },
    };
    const constantProducer = {
      id: constantId,
      kind: 'constant',
      config: { configuration: constant },
      destinations: [input],
      provenance,
    } satisfies CircuitProducerNode;
    const arithmeticProducer = {
      id: arithmeticId,
      kind: 'arithmetic',
      config: arithmetic,
      destinations: [output],
      provenance,
    } satisfies CircuitProducerNode;
    const circuit: NativeCircuitIr = {
      format: 'comblang-ncir',
      networks: [
        { id: input, color: 'red', provenance },
        { id: output, color: 'green', provenance },
      ],
      entities: [],
      producers: [constantProducer, arithmeticProducer],
    };
    const replaced = replaceBlueprintConfigurationSetInNativeCircuitIr(
      set,
      circuit,
      [
        { key: 'source', producerId: constantId },
        { key: 'sum', producerId: arithmeticId },
      ],
      [
        { parameter: amount, value: 7 },
        { parameter: offset, value: 5 },
      ],
    );
    const manual: NativeCircuitIr = {
      ...circuit,
      producers: [
        {
          ...constantProducer,
          config: {
            configuration: canonicalizeConstantConfiguration({
              sections: [{ filters: [{ signal: A, value: 7 }] }],
            }),
          },
        },
        {
          ...arithmeticProducer,
          config: { ...arithmetic, right: { kind: 'constant', value: 5 } },
        },
      ],
    };

    expect(generateBlueprintJson(replaced)).toEqual(generateBlueprintJson(manual));
    expect(JSON.stringify(replaced)).not.toContain('amount');
    expect(JSON.stringify(replaced)).not.toContain('offset');
    const replacedTicks = ticks(replaced, output, B);
    const manualTicks = ticks(manual, output, B);
    expect(replacedTicks).toEqual(manualTicks);
    expect(replacedTicks).toContain(12);

    const originalBeforeFailure = JSON.stringify(circuit);
    const beforeFailure = JSON.stringify(replaced);
    expect(() =>
      replaceBlueprintConfigurationSetInNativeCircuitIr(
        set,
        circuit,
        [
          { key: 'source', producerId: constantId },
          { key: 'sum', producerId: arithmeticId },
        ],
        [{ parameter: amount, value: Number.NaN }],
      ),
    ).toThrow();
    expect(JSON.stringify(circuit)).toBe(originalBeforeFailure);
    expect(JSON.stringify(replaced)).toBe(beforeFailure);

    const nextResult = replaceBlueprintConfigurationSetInNativeCircuitIr(
      set,
      circuit,
      [
        { key: 'source', producerId: constantId },
        { key: 'sum', producerId: arithmeticId },
      ],
      [
        { parameter: amount, value: 10 },
        { parameter: offset, value: 1 },
      ],
    );
    expect(replacedTicks).toEqual(ticks(replaced, output, B));
    expect(nextResult.producers[0]).not.toBe(replaced.producers[0]);
    expect(JSON.stringify(replaced)).toBe(beforeFailure);
  });

  test('binds shared numeric expressions into detached NCIR without symbolic leakage', () => {
    const input = 'network:expression-input' as NetworkId;
    const output = 'network:expression-output' as NetworkId;
    const constantId = 'producer:expression-constant' as ProducerId;
    const arithmeticId = 'producer:expression-arithmetic' as ProducerId;
    const source: SourceSpan = {
      fileId: 'numeric-expression-replacement.test.ts' as SourceFileId,
      start: 5,
      end: 24,
    };
    const session = createBlueprintParameterSession();
    const formula = session.number('formula-only-label', { defaultValue: 3, source });
    const amount = session.number('amount-only-label', { defaultValue: 7 });
    const offset = session.number('offset-only-label', { defaultValue: 5 });
    const shared = {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: formula },
      right: { kind: 'literal', value: 1 },
    };
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'multiply',
      left: shared,
      right: shared,
    });
    const constantTemplate = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: A, value: amount }] }],
    });
    const arithmeticTemplate = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: expression },
      operation: 'add',
      right: { kind: 'constant', value: offset },
      output: { kind: 'signal', signal: B },
    });
    const set = createBlueprintConfigurationSet(session, [
      { key: 'source', kind: 'constant', template: constantTemplate },
      { key: 'formula', kind: 'arithmetic', template: arithmeticTemplate },
    ]);
    const bindings = [
      { parameter: formula, value: 4 },
      { parameter: amount, value: 7 },
      { parameter: offset, value: 6 },
    ];
    const bound = bindBlueprintConfigurationSet(set, bindings);
    expect(bound[0]).toMatchObject({ config: { sections: [{ filters: [{ value: 7 }] }] } });
    expect(bound[1]).toMatchObject({
      config: {
        left: { kind: 'constant', value: 25 },
        right: { kind: 'constant', value: 6 },
      },
    });

    const constant = canonicalizeConstantConfiguration({
      sections: [{ filters: [{ signal: A, value: 1 }] }],
    });
    const arithmetic: ArithmeticProducerConfig = {
      left: { kind: 'constant', value: 0 },
      operation: 'add',
      right: { kind: 'constant', value: 0 },
      output: { kind: 'signal', signal: B },
    };
    const constantProducer = {
      id: constantId,
      kind: 'constant',
      config: { configuration: constant },
      destinations: [input],
      provenance,
    } satisfies CircuitProducerNode;
    const arithmeticProducer = {
      id: arithmeticId,
      kind: 'arithmetic',
      config: arithmetic,
      destinations: [output],
      provenance,
    } satisfies CircuitProducerNode;
    const circuit: NativeCircuitIr = {
      format: 'comblang-ncir',
      networks: [
        { id: input, color: 'red', provenance },
        { id: output, color: 'green', provenance },
      ],
      entities: [],
      producers: [constantProducer, arithmeticProducer],
    };
    const assignments = [
      { key: 'source', producerId: constantId },
      { key: 'formula', producerId: arithmeticId },
    ];
    const replaced = replaceBlueprintConfigurationSetInNativeCircuitIr(
      set,
      circuit,
      assignments,
      bindings,
    );
    const manual: NativeCircuitIr = {
      ...circuit,
      producers: [
        {
          ...constantProducer,
          config: {
            configuration: canonicalizeConstantConfiguration({
              sections: [{ filters: [{ signal: A, value: 7 }] }],
            }),
          },
        },
        {
          ...arithmeticProducer,
          config: {
            left: { kind: 'constant', value: 25 },
            operation: 'add',
            right: { kind: 'constant', value: 6 },
            output: { kind: 'signal', signal: B },
          },
        },
      ],
    };

    const symbolicReferences = collectExpressionNodes(expression);
    symbolicReferences.add(formula);
    symbolicReferences.add(amount);
    symbolicReferences.add(offset);
    expect(containsReference(bound, symbolicReferences)).toBe(false);
    expect(containsReference(replaced, symbolicReferences)).toBe(false);
    expect(generateBlueprintJson(replaced)).toEqual(generateBlueprintJson(manual));
    expect(JSON.stringify(replaced)).not.toContain('formula-only-label');
    expect(JSON.stringify(replaced)).not.toContain('amount-only-label');
    expect(JSON.stringify(replaced)).not.toContain('offset-only-label');
    expect(replaced).not.toBe(circuit);
    expect(replaced.networks).toEqual(circuit.networks);
    expect(replaced.producers.map(({ id }) => id)).toEqual(circuit.producers.map(({ id }) => id));
    expect(replaced.producers.map(({ destinations }) => destinations)).toEqual(
      circuit.producers.map(({ destinations }) => destinations),
    );

    const boundBeforeFailure = JSON.stringify(bound);
    const circuitBeforeFailure = JSON.stringify(circuit);
    const replacedBeforeFailure = JSON.stringify(replaced);
    expect(() =>
      replaceBlueprintConfigurationSetInNativeCircuitIr(set, circuit, assignments, [
        { parameter: formula, value: 1.5 },
        { parameter: amount, value: 8 },
        { parameter: offset, value: 9 },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.entries[1].left.value',
        span: source,
      }),
    );
    expect(JSON.stringify(bound)).toBe(boundBeforeFailure);
    expect(JSON.stringify(circuit)).toBe(circuitBeforeFailure);
    expect(JSON.stringify(replaced)).toBe(replacedBeforeFailure);

    const next = replaceBlueprintConfigurationSetInNativeCircuitIr(set, circuit, assignments, [
      { parameter: formula, value: 5 },
      { parameter: amount, value: 9 },
      { parameter: offset, value: 2 },
    ]);
    expect(next.producers[1]).not.toBe(replaced.producers[1]);
    expect(JSON.stringify(replaced)).toBe(replacedBeforeFailure);
    expect(JSON.stringify(circuit)).toBe(circuitBeforeFailure);
  });

  test('matches Selector Blueprint JSON and repeated simulator ticks', () => {
    const red = 'network:replacement-red' as NetworkId;
    const green = 'network:replacement-green' as NetworkId;
    const output = 'network:replacement-selector-output' as NetworkId;
    const redSourceId = 'producer:replacement-red-source' as ProducerId;
    const greenSourceId = 'producer:replacement-green-source' as ProducerId;
    const selectorId = 'producer:replacement-selector' as ProducerId;
    const session = createBlueprintParameterSession();
    const index = session.number('selector index', { defaultValue: 1 });
    const input = { refKind: 'pair', networks: [green, red] } as const;
    const template = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input,
      selectMax: true,
      index,
    });
    const set = createBlueprintConfigurationSet(session, [
      { key: 'selector', kind: 'selector', template },
    ]);
    const selector: SelectorProducerConfig = {
      operation: 'select',
      input,
      selectMax: true,
      index: 0,
    };
    const redProducer = {
      id: redSourceId,
      kind: 'constant',
      config: {
        configuration: canonicalizeConstantConfiguration({
          sections: [{ filters: [{ signal: A, value: 2 }] }],
        }),
      },
      destinations: [red],
      provenance,
    } satisfies CircuitProducerNode;
    const greenProducer = {
      id: greenSourceId,
      kind: 'constant',
      config: {
        configuration: canonicalizeConstantConfiguration({
          sections: [{ filters: [{ signal: B, value: 1 }] }],
        }),
      },
      destinations: [green],
      provenance,
    } satisfies CircuitProducerNode;
    const selectorProducer = {
      id: selectorId,
      kind: 'selector',
      config: selector,
      destinations: [output],
      provenance,
    } satisfies CircuitProducerNode;
    const circuit: NativeCircuitIr = {
      format: 'comblang-ncir',
      networks: [
        { id: red, color: 'red', provenance },
        { id: green, color: 'green', provenance },
        { id: output, color: 'red', provenance },
      ],
      entities: [],
      producers: [redProducer, greenProducer, selectorProducer],
    };
    const replaced = replaceBlueprintConfigurationSetInNativeCircuitIr(
      set,
      circuit,
      [{ key: 'selector', producerId: selectorId }],
      [{ parameter: index, value: 1 }],
    );
    const defaultBound = replaceBlueprintConfigurationSetInNativeCircuitIr(set, circuit, [
      { key: 'selector', producerId: selectorId },
    ]);
    expect(
      defaultBound.producers[2]?.kind === 'selector' &&
        defaultBound.producers[2].config.operation === 'select'
        ? defaultBound.producers[2].config.index
        : null,
    ).toBe(1);
    const manual: NativeCircuitIr = {
      ...circuit,
      producers: [
        redProducer,
        greenProducer,
        { ...selectorProducer, config: { ...selector, index: 1 } },
      ],
    };

    expect(generateBlueprintJson(replaced)).toEqual(generateBlueprintJson(manual));
    expect(ticks(replaced, output, A)).toEqual(ticks(manual, output, A));
  });
});
