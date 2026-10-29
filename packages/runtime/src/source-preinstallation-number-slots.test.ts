import { constantConfigurationLimits, signal } from '@comblang/factorio';
import type { EntityId } from '@comblang/compiler/entity';
import type { CircuitProducerNode, NativeCircuitIr } from '@comblang/compiler/ir';
import { sourceFileId, type NetworkId, type ProducerId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { createBlueprintNumericExpression } from '../../compiler/src/blueprint-numeric-expression.js';
import { createArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-template.js';
import {
  createConstantConfigurationTemplate,
  inspectConstantConfigurationTemplate,
} from '../../compiler/src/constant-configuration-template.js';
import { createDeciderConfigurationTemplate } from '../../compiler/src/decider-configuration-template.js';
import { createBlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';
import { createSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-template.js';
import { bindArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-binding.js';
import { bindConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-binding.js';
import { bindDeciderConfigurationTemplate } from '../../compiler/src/decider-configuration-binding.js';
import { bindSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-binding.js';
import { CombinatorRegistry, type CombinatorRuntimeState } from './combinator-registry.js';
import { collectOccupiedAutomaticNumberValues } from './source-automatic-number-defaults.js';
import type { CombinatorDescriptor } from './elaboration-values.js';
import { collectPreinstallationNumericSlots } from './source-preinstallation-number-slots.js';

const source = Object.freeze({
  fileId: sourceFileId('preinstallation-number-slots.test.ts'),
  start: 3,
  end: 19,
});
const A = signal('virtual', 'signal-A');

describe('producer preinstallation numeric-slot inventory', () => {
  test('does not impose a per-configuration node budget on the whole circuit', () => {
    const session = createBlueprintParameterSession();
    const producers: CombinatorDescriptor[] = Array.from(
      { length: constantConfigurationLimits.maxNodes + 1 },
      () => ({
        kind: 'arithmetic',
        left: { kind: 'constant', value: 1 },
        operation: 'add',
        right: { kind: 'constant', value: 2 },
        output: { kind: 'signal', signal: A },
        source,
        instancePath: [],
      }),
    );

    expect(collectPreinstallationNumericSlots(session, producers)).toHaveLength(
      producers.length * 2,
    );
  });

  test('does not impose one traversal budget across producers and numeric slots', () => {
    const session = createBlueprintParameterSession();
    const producers: CombinatorDescriptor[] = Array.from({ length: 2049 }, () => ({
      kind: 'arithmetic',
      left: { kind: 'constant', value: 1 },
      operation: 'add',
      right: { kind: 'constant', value: 2 },
      output: { kind: 'signal', signal: A },
      source,
      instancePath: [],
    }));

    expect(producers).toHaveLength(2049);
    expect(collectPreinstallationNumericSlots(session, producers)).toHaveLength(4098);
  });

  test('accounts repeated parameter expressions per section across a 7071-row template', () => {
    const session = createBlueprintParameterSession();
    const target = session.signal('Target', { defaultValue: A });
    const amount = session.number('Amount', { defaultValue: 2 });
    const unused = session.number('Unused', { defaultValue: 99 });
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: amount },
      right: { kind: 'literal', value: 1 },
    });
    const sectionSizes = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 71];
    const input = {
      sections: sectionSizes.map((filterCount, sectionIndex) => ({
        active: sectionIndex !== 1,
        multiplier: 1,
        filters: Array.from({ length: filterCount }, () => ({ signal: target, value: expression })),
      })),
    };
    const originalFilters = input.sections.map(({ filters }) => filters);
    const template = createConstantConfigurationTemplate(session, input);

    expect(template.sections.map(({ filters }) => filters.length)).toEqual(sectionSizes);
    expect(template.sections[7]?.filters[70]?.value).toBe(expression);
    expect(input.sections.map(({ filters }) => filters)).toEqual(originalFilters);
    expect(input.sections[7]?.filters[70]?.value).toBe(expression);
    const usedParameters = inspectConstantConfigurationTemplate(
      template,
      '$.template',
    ).usedParameters;
    expect(usedParameters).toEqual([target, amount]);
    expect(usedParameters).not.toContain(unused);

    const firstBinding = bindConstantConfigurationTemplate(template, [
      { parameter: amount, value: 4 },
    ]);
    const rebound = bindConstantConfigurationTemplate(template, [{ parameter: amount, value: 6 }]);
    expect(firstBinding.sections[7]?.filters[70]).toEqual({ signal: A, value: 5 });
    expect(rebound.sections[7]?.filters[70]).toEqual({ signal: A, value: 7 });
    expect(template.sections[7]?.filters[70]?.value).toBe(expression);

    const producer: CombinatorDescriptor = {
      kind: 'constant',
      source,
      instancePath: [],
      pendingConfiguration: template,
    };
    const slots = collectPreinstallationNumericSlots(session, [producer]);
    const filterSlots = slots.filter(({ role }) => role === 'filter-value');
    expect(filterSlots).toHaveLength(7071);
    expect(filterSlots.every(({ root }) => root === expression)).toBe(true);
    expect(slots.at(-1)).toMatchObject({
      role: 'filter-value',
      fieldPath: '$.producers[0].pendingConfiguration.sections[7].filters[70].value',
      root: expression,
    });
  });

  test('retains the authentic template literal after factory-owned int32 conversion', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('Amount', { defaultValue: 7 });
    const template = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: 2_147_483_648 },
      operation: 'add',
      right: { kind: 'constant', value: amount },
      output: { kind: 'signal', signal: A },
    });
    const producer: CombinatorDescriptor = {
      kind: 'arithmetic',
      left: { kind: 'constant' },
      operation: 'add',
      right: { kind: 'constant' },
      pendingConfiguration: template,
      source,
      instancePath: [],
    };

    expect(bindArithmeticConfigurationTemplate(template).left).toEqual({
      kind: 'constant',
      value: -2_147_483_648,
    });
    const slots = collectPreinstallationNumericSlots(session, [producer]);
    expect(slots[0]?.root).toBe(
      template.left.kind === 'constant' ? template.left.value : undefined,
    );
    expect(slots[0]?.root).toBe(-2_147_483_648);
    expect(slots[1]?.root).toBe(amount);
  });

  test('retains authenticated pending Constant roots and their declared paths', () => {
    const session = createBlueprintParameterSession();
    const multiplier = session.number('Multiplier');
    const amount = session.number('Amount');
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: amount },
      right: { kind: 'literal', value: 2 },
    });
    const template = createConstantConfigurationTemplate(session, {
      isOn: true,
      sections: [
        {
          multiplier,
          filters: [
            { signal: A, value: amount },
            { signal: A, value: expression },
          ],
        },
      ],
    });
    const producer = {
      kind: 'constant',
      source,
      instancePath: [],
      pendingConfiguration: template,
    } as unknown as CombinatorDescriptor;

    const slots = collectPreinstallationNumericSlots(session, [producer]);

    expect(
      slots.map(({ family, role, numericDomain, fieldPath, root }) => ({
        family,
        role,
        numericDomain,
        fieldPath,
        root,
      })),
    ).toEqual([
      {
        family: 'constant',
        role: 'multiplier',
        numericDomain: 'finite-number',
        fieldPath: '$.producers[0].pendingConfiguration.sections[0].multiplier',
        root: multiplier,
      },
      {
        family: 'constant',
        role: 'filter-value',
        numericDomain: 'int32',
        fieldPath: '$.producers[0].pendingConfiguration.sections[0].filters[0].value',
        root: amount,
      },
      {
        family: 'constant',
        role: 'filter-value',
        numericDomain: 'int32',
        fieldPath: '$.producers[0].pendingConfiguration.sections[0].filters[1].value',
        root: expression,
      },
    ]);
    expect(
      slots.every(({ producerIndex, source: span }) => producerIndex === 0 && span === source),
    ).toBe(true);
    expect(Object.isFrozen(slots)).toBe(true);
    expect(slots.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(template)).toBe(true);
  });

  test('records concrete Constant multipliers separately from int32 filter values', () => {
    const session = createBlueprintParameterSession();
    const producer = {
      kind: 'constant',
      source,
      instancePath: [],
      configuration: {
        isOn: true,
        sections: [{ active: false, multiplier: 2.5, filters: [{ signal: A, value: 7 }] }],
      },
    } as unknown as CombinatorDescriptor;

    expect(
      collectPreinstallationNumericSlots(session, [producer]).map((slot) => [
        slot.role,
        slot.numericDomain,
        slot.root,
        slot.fieldPath,
      ]),
    ).toEqual([
      ['multiplier', 'finite-number', 2.5, '$.producers[0].configuration.sections[0].multiplier'],
      ['filter-value', 'int32', 7, '$.producers[0].configuration.sections[0].filters[0].value'],
    ]);
  });

  test('enumerates only concrete native numeric fields in producer and template order', () => {
    const session = createBlueprintParameterSession();
    const firstOutput = { kind: 'signal-constant', signal: A, value: 41 };
    const secondOutput = { kind: 'each-constant', value: 42 };
    const thirdOutput = {
      kind: 'wildcard-constant',
      wildcard: 'anything',
      value: 40,
    };
    const elseOutput = { kind: 'signal-constant', signal: A, value: 43 };
    const producers = [
      {
        kind: 'constant',
        source,
        instancePath: [],
        placement: { x: 101, y: -72, direction: 4 },
        configuration: {
          isOn: false,
          sections: [
            {
              active: false,
              group: 'ignored 88',
              multiplier: 2.5,
              filters: [{ signal: A, value: 7 }],
            },
          ],
        },
      },
      {
        kind: 'constant',
        source,
        instancePath: [],
        outputs: [],
      },
      {
        kind: 'arithmetic',
        source,
        instancePath: [],
        left: { kind: 'constant', value: -9 },
        operation: 'add',
        right: { kind: 'constant', value: 10 },
        output: { kind: 'signal', signal: A },
      },
      {
        kind: 'decider',
        source,
        instancePath: [],
        condition: {
          kind: 'and',
          conditions: [
            {
              kind: 'compare-each',
              refKind: 'single',
              network: 'input',
              comparator: '>',
              constant: 11,
            },
            {
              kind: 'or',
              conditions: [
                {
                  kind: 'compare-signal',
                  refKind: 'single',
                  network: 'input',
                  signal: A,
                  comparator: '<',
                  constant: 12,
                },
                {
                  kind: 'compare-signals',
                  left: { refKind: 'single', network: 'input', signal: A },
                  comparator: '=',
                  right: { refKind: 'single', network: 'input', signal: A },
                },
              ],
            },
          ],
        },
        output: firstOutput,
        outputs: [firstOutput, secondOutput, thirdOutput],
        elseOutputs: [elseOutput],
      },
      {
        kind: 'decider',
        source,
        instancePath: [],
        condition: {
          kind: 'compare-wildcard-signal',
          left: { refKind: 'single', network: 'input', wildcard: 'each' },
          comparator: '>',
          right: { refKind: 'single', network: 'input', signal: A },
        },
        output: { kind: 'each-constant', value: 44 },
      },
      {
        kind: 'decider',
        source,
        instancePath: [],
        condition: {
          kind: 'compare-each',
          refKind: 'single',
          network: 'input',
          comparator: '>',
          constant: 45,
        },
        output: undefined,
        elseOutputs: [{ kind: 'each-constant', value: 46 }],
      },
      {
        kind: 'selector',
        source,
        instancePath: [],
        operation: 'select',
        input: { refKind: 'single', network: 'input' },
        selectMax: false,
        index: 13,
        placement: { x: 3, y: 5, direction: 2 },
      },
      {
        kind: 'selector',
        source,
        instancePath: [],
        operation: 'select',
        input: { refKind: 'single', network: 'input' },
        selectMax: false,
        index: A,
      },
      {
        kind: 'selector',
        source,
        instancePath: [],
        operation: 'count',
        input: { refKind: 'single', network: 'input' },
        output: A,
      },
      {
        kind: 'constant',
        source,
        instancePath: [],
        outputs: [{ signal: A, value: 47 }],
      },
    ] as unknown as CombinatorDescriptor[];

    const slots = collectPreinstallationNumericSlots(session, producers);

    expect(
      slots.map(({ producerIndex, family, role, numericDomain, fieldPath, root }) => [
        producerIndex,
        family,
        role,
        numericDomain,
        fieldPath,
        root,
      ]),
    ).toEqual([
      [
        0,
        'constant',
        'multiplier',
        'finite-number',
        '$.producers[0].configuration.sections[0].multiplier',
        2.5,
      ],
      [
        0,
        'constant',
        'filter-value',
        'int32',
        '$.producers[0].configuration.sections[0].filters[0].value',
        7,
      ],
      [1, 'constant', 'multiplier', 'finite-number', '$.producers[1].outputs', 1],
      [2, 'arithmetic', 'operand', 'int32', '$.producers[2].left.value', -9],
      [2, 'arithmetic', 'operand', 'int32', '$.producers[2].right.value', 10],
      [
        3,
        'decider',
        'condition-threshold',
        'int32',
        '$.producers[3].condition.conditions[0].constant',
        11,
      ],
      [
        3,
        'decider',
        'condition-threshold',
        'int32',
        '$.producers[3].condition.conditions[1].conditions[0].constant',
        12,
      ],
      [3, 'decider', 'output-value', 'int32', '$.producers[3].outputs[0].value', 41],
      [3, 'decider', 'output-value', 'int32', '$.producers[3].outputs[1].value', 42],
      [3, 'decider', 'output-value', 'int32', '$.producers[3].outputs[2].value', 40],
      [3, 'decider', 'output-value', 'int32', '$.producers[3].elseOutputs[0].value', 43],
      [4, 'decider', 'output-value', 'int32', '$.producers[4].output.value', 44],
      [5, 'decider', 'condition-threshold', 'int32', '$.producers[5].condition.constant', 45],
      [5, 'decider', 'output-value', 'int32', '$.producers[5].elseOutputs[0].value', 46],
      [6, 'selector', 'select-index', 'int32', '$.producers[6].index', 13],
      [9, 'constant', 'multiplier', 'finite-number', '$.producers[9].outputs', 1],
      [9, 'constant', 'filter-value', 'int32', '$.producers[9].outputs[0].value', 47],
    ]);
    expect(producers[0]).toMatchObject({
      placement: { x: 101, y: -72, direction: 4 },
      configuration: { sections: [{ filters: [{ value: 7 }] }] },
    });
  });

  test('reads authentic pending roots for all four families before defaults or installation', () => {
    const session = createBlueprintParameterSession();
    const shared = session.number('Shared');
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: shared },
      right: { kind: 'literal', value: 2 },
    });
    const constantTemplate = createConstantConfigurationTemplate(session, {
      sections: [{ multiplier: shared, filters: [{ signal: A, value: expression }] }],
    });
    const arithmeticTemplate = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: shared },
      operation: 'add',
      right: { kind: 'constant', value: expression },
      output: { kind: 'signal', signal: A },
    });
    const deciderTemplate = createDeciderConfigurationTemplate(session, {
      condition: {
        kind: 'and',
        conditions: [
          {
            kind: 'compare',
            left: { kind: 'wildcard', value: 'each', refKind: 'single', network: 'input' },
            comparator: '>',
            right: { kind: 'constant', value: shared },
          },
          {
            kind: 'or',
            conditions: [
              {
                kind: 'compare',
                left: { kind: 'signal', signal: A, refKind: 'single', network: 'input' },
                comparator: '<',
                right: { kind: 'constant', value: expression },
              },
              {
                kind: 'compare',
                left: { kind: 'wildcard', value: 'anything', refKind: 'single', network: 'input' },
                comparator: '=',
                right: { kind: 'signal', signal: A, refKind: 'single', network: 'input' },
              },
            ],
          },
        ],
      },
      outputs: [],
    });
    const selectorTemplate = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input: { refKind: 'single', network: 'input' },
      selectMax: false,
      index: expression,
    });
    const firstOutput = { kind: 'signal-constant', signal: A, value: 51 };
    const latestOutput = { kind: 'each-constant', value: 52 };
    const elseOnlyOutput = { kind: 'signal-constant', signal: A, value: 53 };
    const producers = [
      { kind: 'constant', source, instancePath: [], pendingConfiguration: constantTemplate },
      {
        kind: 'arithmetic',
        source,
        instancePath: [],
        left: { kind: 'constant' },
        operation: 'add',
        right: { kind: 'constant' },
        pendingConfiguration: arithmeticTemplate,
      },
      {
        kind: 'decider',
        source,
        instancePath: [],
        condition: {
          kind: 'compare-each',
          refKind: 'single',
          network: 'input',
          comparator: '>',
          constant: { kind: 'constant' },
        },
        pendingConfiguration: deciderTemplate,
        output: firstOutput,
        outputs: [firstOutput, latestOutput],
        elseOutputs: [elseOnlyOutput],
      },
      {
        kind: 'selector',
        source,
        instancePath: [],
        operation: 'select',
        input: { refKind: 'single', network: 'input' },
        selectMax: false,
        pendingConfiguration: selectorTemplate,
      },
      {
        kind: 'selector',
        source,
        instancePath: [],
        operation: 'select',
        input: { refKind: 'single', network: 'input' },
        selectMax: false,
        pendingConfiguration: createSelectorConfigurationTemplate(session, {
          operation: 'select',
          input: { refKind: 'single', network: 'input' },
          selectMax: false,
          index: A,
        }),
      },
      {
        kind: 'selector',
        source,
        instancePath: [],
        operation: 'count',
        input: { refKind: 'single', network: 'input' },
        pendingConfiguration: createSelectorConfigurationTemplate(session, {
          operation: 'count',
          input: { refKind: 'single', network: 'input' },
          output: A,
        }),
      },
      {
        kind: 'decider',
        source,
        instancePath: [],
        condition: {
          kind: 'compare-each',
          refKind: 'single',
          network: 'input',
          comparator: '>',
          constant: { kind: 'constant' },
        },
        pendingConfiguration: createDeciderConfigurationTemplate(session, {
          condition: {
            kind: 'compare',
            left: { kind: 'wildcard', value: 'each', refKind: 'single', network: 'input' },
            comparator: '>',
            right: { kind: 'constant', value: shared },
          },
          outputs: [],
        }),
        output: undefined,
        elseOutputs: [elseOnlyOutput],
      },
    ] as unknown as CombinatorDescriptor[];
    const before = producers.map((producer) => ({ ...producer }));

    const slots = collectPreinstallationNumericSlots(session, producers);

    expect(
      slots.map(({ producerIndex, role, fieldPath, root }) => [
        producerIndex,
        role,
        fieldPath,
        root,
      ]),
    ).toEqual([
      [0, 'multiplier', '$.producers[0].pendingConfiguration.sections[0].multiplier', shared],
      [
        0,
        'filter-value',
        '$.producers[0].pendingConfiguration.sections[0].filters[0].value',
        expression,
      ],
      [1, 'operand', '$.producers[1].pendingConfiguration.left.value', shared],
      [1, 'operand', '$.producers[1].pendingConfiguration.right.value', expression],
      [
        2,
        'condition-threshold',
        '$.producers[2].pendingConfiguration.condition.conditions[0].right.value',
        shared,
      ],
      [
        2,
        'condition-threshold',
        '$.producers[2].pendingConfiguration.condition.conditions[1].conditions[0].right.value',
        expression,
      ],
      [2, 'output-value', '$.producers[2].outputs[0].value', 51],
      [2, 'output-value', '$.producers[2].outputs[1].value', 52],
      [2, 'output-value', '$.producers[2].elseOutputs[0].value', 53],
      [3, 'select-index', '$.producers[3].pendingConfiguration.index', expression],
      [
        6,
        'condition-threshold',
        '$.producers[6].pendingConfiguration.condition.right.value',
        shared,
      ],
      [6, 'output-value', '$.producers[6].elseOutputs[0].value', 53],
    ]);
    expect(slots[0]?.root).toBe(shared);
    expect(slots[1]?.root).toBe(expression);
    expect(producers).toEqual(before);
  });

  test('refuses foreign or forged template authority and accepts a valid retry', () => {
    const session = createBlueprintParameterSession();
    const foreignSession = createBlueprintParameterSession();
    const parameter = session.number('Amount');
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: A, value: parameter }] }],
    });
    const descriptor = (pendingConfiguration: unknown) =>
      ({
        kind: 'constant',
        source,
        instancePath: [],
        pendingConfiguration,
      }) as unknown as CombinatorDescriptor;

    expect(() =>
      collectPreinstallationNumericSlots(foreignSession, [descriptor(template)]),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.producers[0].pendingConfiguration' }),
    );
    expect(() =>
      collectPreinstallationNumericSlots(session, [descriptor({ ...template })]),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1002', path: '$.producers[0].pendingConfiguration' }),
    );
    expect(() =>
      collectPreinstallationNumericSlots(session, [
        {
          kind: 'decider',
          source,
          instancePath: [],
          condition: {
            kind: 'compare-each',
            refKind: 'single',
            network: 'input',
            comparator: '>',
            constant: { kind: 'constant' },
          },
          output: undefined,
        } as unknown as CombinatorDescriptor,
      ]),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1002', path: '$.producers[0].condition.constant' }),
    );

    const accepted = collectPreinstallationNumericSlots(session, [descriptor(template)]);
    expect(accepted.map(({ root }) => root)).toEqual([1, parameter]);
  });

  test('family binders resolve inventory roots to the existing NCIR occupancy census values', () => {
    const session = createBlueprintParameterSession();
    const shared = session.number('Shared');
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: shared },
      right: { kind: 'literal', value: 2 },
    });
    const constantTemplate = createConstantConfigurationTemplate(session, {
      sections: [{ multiplier: shared, filters: [{ signal: A, value: shared }] }],
    });
    const arithmeticTemplate = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: expression },
      operation: 'add',
      right: { kind: 'constant', value: shared },
      output: { kind: 'signal', signal: A },
    });
    const deciderTemplate = createDeciderConfigurationTemplate(session, {
      condition: {
        kind: 'compare',
        left: { kind: 'wildcard', value: 'each', refKind: 'single', network: 'input' },
        comparator: '>',
        right: { kind: 'constant', value: shared },
      },
      outputs: [],
    });
    const selectorTemplate = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input: { refKind: 'single', network: 'input' },
      selectMax: false,
      index: shared,
    });
    const binding = [{ parameter: shared, value: 9 }];
    const constantConfiguration = bindConstantConfigurationTemplate(constantTemplate, binding);
    const arithmeticConfiguration = bindArithmeticConfigurationTemplate(
      arithmeticTemplate,
      binding,
    );
    const conditionConfiguration = bindDeciderConfigurationTemplate(deciderTemplate, binding);
    const selectorConfiguration = bindSelectorConfigurationTemplate(selectorTemplate, binding);
    const normalOutput = { kind: 'signal-constant', signal: A, value: 4 } as const;
    const elseOutput = { kind: 'each-constant', value: 5 } as const;
    const pending = [
      { kind: 'constant', source, instancePath: [], pendingConfiguration: constantTemplate },
      {
        kind: 'arithmetic',
        source,
        instancePath: [],
        left: { kind: 'constant' },
        operation: 'add',
        right: { kind: 'constant' },
        pendingConfiguration: arithmeticTemplate,
      },
      {
        kind: 'decider',
        source,
        instancePath: [],
        condition: {
          kind: 'compare-each',
          refKind: 'single',
          network: 'input',
          comparator: '>',
          constant: { kind: 'constant' },
        },
        pendingConfiguration: deciderTemplate,
        output: normalOutput,
        outputs: [normalOutput],
        elseOutputs: [elseOutput],
      },
      {
        kind: 'selector',
        source,
        instancePath: [],
        operation: 'select',
        input: { refKind: 'single', network: 'input' },
        selectMax: false,
        pendingConfiguration: selectorTemplate,
      },
    ] as unknown as CombinatorDescriptor[];
    const inventory = collectPreinstallationNumericSlots(session, pending);
    const concreteDeciderConfiguration = {
      ...conditionConfiguration,
      outputs: [{ mode: 'constant', signal: { kind: 'signal', signal: A }, value: 4 }],
      elseOutputs: [{ mode: 'constant', signal: { kind: 'wildcard', value: 'each' }, value: 5 }],
    } as const;
    const physicalIds = {
      constant: 'entity:constant' as EntityId,
      arithmetic: 'entity:arithmetic' as EntityId,
      decider: 'entity:decider' as EntityId,
      selector: 'entity:selector' as EntityId,
    };
    const provenance = { source, instancePath: [], expansionStack: [] } as const;
    const producers: CircuitProducerNode[] = [
      {
        id: 'producer:constant' as ProducerId,
        entityId: physicalIds.constant,
        kind: 'constant',
        config: { configuration: constantConfiguration },
        destinations: [],
        provenance,
      },
      {
        id: 'producer:arithmetic' as ProducerId,
        entityId: physicalIds.arithmetic,
        kind: 'arithmetic',
        config: arithmeticConfiguration,
        destinations: [],
        provenance,
      },
      {
        id: 'producer:decider' as ProducerId,
        entityId: physicalIds.decider,
        kind: 'decider',
        config: concreteDeciderConfiguration,
        destinations: [],
        provenance,
      },
      {
        id: 'producer:selector' as ProducerId,
        entityId: physicalIds.selector,
        kind: 'selector',
        config: selectorConfiguration,
        destinations: [],
        provenance,
      },
    ];
    const entity = (id: EntityId, mode: string, configuration: unknown) => ({
      id,
      ordinal: 1,
      prototypeName: `${mode}-combinator`,
      profile: {
        prototypeKey: `entity:${mode}-combinator`,
        database: { schemaVersion: 1, identity: 'preinstallation-number-slots-test' },
        profileId: `profile:${mode}-test`,
      },
      provenance,
      placement: { x: 0, y: 0, direction: 0 },
      connectorBindings: [],
      configuration,
    });
    const ir = {
      format: 'comblang-ncir',
      networks: [{ id: 'network:inventory' as NetworkId, color: 'red', provenance }],
      producers,
      entities: [
        entity(physicalIds.constant, 'constant', {
          mode: 'constant',
          value: constantConfiguration,
        }),
        entity(physicalIds.arithmetic, 'arithmetic', {
          mode: 'arithmetic',
          ...arithmeticConfiguration,
        }),
        entity(physicalIds.decider, 'decider', {
          mode: 'decider',
          ...concreteDeciderConfiguration,
        }),
        entity(physicalIds.selector, 'selector', { mode: 'selector', ...selectorConfiguration }),
      ],
    } as unknown as NativeCircuitIr;
    const occupied = collectOccupiedAutomaticNumberValues(ir).map(({ value }) => value);

    expect(inventory.map(({ root }) => root)).toEqual([
      shared,
      shared,
      expression,
      shared,
      shared,
      4,
      5,
      shared,
    ]);
    expect(occupied).toEqual([
      constantConfiguration.sections[0]?.multiplier,
      constantConfiguration.sections[0]?.filters[0]?.value,
      arithmeticConfiguration.left.kind === 'constant'
        ? arithmeticConfiguration.left.value
        : undefined,
      arithmeticConfiguration.right.kind === 'constant'
        ? arithmeticConfiguration.right.value
        : undefined,
      9,
      4,
      5,
      selectorConfiguration.operation === 'select' ? selectorConfiguration.index : undefined,
    ]);
    expect(occupied).toEqual([9, 9, 11, 9, 9, 4, 5, 9]);
  });

  test('ordinary producer plan serialization refuses an unresolved registry descriptor', () => {
    const session = createBlueprintParameterSession();
    const parameter = session.number('Not installed');
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: A, value: parameter }] }],
    });
    const descriptor = {
      kind: 'constant',
      source,
      instancePath: [],
      pendingConfiguration: template,
    } as unknown as CombinatorDescriptor;
    const state = { descriptor } as unknown as CombinatorRuntimeState;

    expect(() => new CombinatorRegistry().toPlan(state)).toThrowError(
      expect.objectContaining({
        code: 'RT2027',
        message: expect.stringContaining('installed before plan serialization'),
      }),
    );
  });
});
