import { signal } from '@comblang/factorio';
import { sourceFileId, sourceSpan, type NetworkId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { bindArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-binding.js';
import { createArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-template.js';
import { createBlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';
import { bindConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-binding.js';
import { createConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-template.js';
import { bindSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-binding.js';
import { createSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-template.js';
import type { ArithmeticProducerConfig, SelectorProducerConfig } from '../../compiler/src/ir.js';
import { CombinatorRegistry } from './combinator-registry.js';
import type { CombinatorDescriptor, CombinatorValue, NetworkValue } from './elaboration-values.js';

const source = sourceSpan(sourceFileId('combinator-registry.test.ts'), 2, 18);

function network(name: string): NetworkValue {
  return { kind: 'network', name, declaration: source, capability: 'owned', generation: 0 };
}

function value(): CombinatorValue {
  return { kind: 'combinator', identity: {} };
}

describe('pending Constant registry state', () => {
  test('preserves pending identity and metadata until an exact configuration is installed', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { source });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: amount }] }],
    });
    const producer = value();
    const primary = network('$constant:primary');
    const secondary = network('$constant:secondary');
    const primaryAttachment = {
      network: primary.name,
      source,
      instancePath: ['root'],
    };
    const secondaryAttachment = {
      network: secondary.name,
      source,
      instancePath: ['root', 'secondary'],
    };
    const descriptor: CombinatorDescriptor = {
      kind: 'constant',
      pendingConfiguration: template,
      source,
      instancePath: ['root'],
    };
    const registry = new CombinatorRegistry();
    const state = registry.register(producer, descriptor, primary, primaryAttachment);
    const primaryLane = state.outputPort.primary;

    registry.addSecondary(producer, secondary, secondaryAttachment);
    registry.bindName(producer, 'parameterized-constant');
    registry.markOutputUsed(producer);
    const capture = registry.capture(producer);
    const pendingSnapshot = registry.snapshot();
    const pendingDescriptorAtSnapshot = state.descriptor;

    expect(state.descriptor).toMatchObject({
      kind: 'constant',
      pendingConfiguration: template,
      bindingName: 'parameterized-constant',
    });
    expect(state.outputUsed).toBe(true);
    expect(state.debugCaptureIds).toEqual([capture.captureId]);
    expect(registry.secondary(producer)).toBe(secondary);
    expect(() => registry.toPlan(state)).toThrowError(
      expect.objectContaining({
        code: 'RT2027',
        span: source,
        message: expect.stringContaining('installed'),
      }),
    );

    const configuration = bindConstantConfigurationTemplate(template, [
      { parameter: amount, value: 9 },
    ]);
    registry.installPendingConstant(producer, configuration);

    expect(state.outputPort.primary).toBe(primaryLane);
    expect(state.descriptor).toMatchObject({
      kind: 'constant',
      configuration,
      bindingName: 'parameterized-constant',
    });
    expect(state.descriptor).not.toHaveProperty('pendingConfiguration');
    const concreteSnapshot = registry.snapshot();
    const concreteDescriptorAtSnapshot = state.descriptor;
    const plan = registry.toPlan(state);
    expect(plan).toMatchObject({
      kind: 'constant',
      configuration,
      bindingName: 'parameterized-constant',
      debugCaptureIds: [capture.captureId],
      destinations: [primaryAttachment, secondaryAttachment],
    });

    registry.restore(pendingSnapshot);
    const restoredPending = registry.stateFor(producer);
    expect(restoredPending.descriptor).toBe(pendingDescriptorAtSnapshot);
    expect(
      'pendingConfiguration' in restoredPending.descriptor
        ? restoredPending.descriptor.pendingConfiguration
        : undefined,
    ).toBe(template);
    expect(restoredPending.descriptor).toMatchObject({ pendingConfiguration: template });
    expect(restoredPending.outputUsed).toBe(true);
    expect(restoredPending.debugCaptureIds).toEqual([capture.captureId]);
    expect(registry.secondary(producer)).toBe(secondary);
    expect(() => registry.toPlan(restoredPending)).toThrowError(
      expect.objectContaining({ code: 'RT2027', span: source }),
    );

    registry.restore(concreteSnapshot);
    const restoredConcrete = registry.stateFor(producer);
    expect(restoredConcrete.descriptor).toBe(concreteDescriptorAtSnapshot);
    expect(registry.toPlan(restoredConcrete)).toMatchObject({
      kind: 'constant',
      configuration,
      debugCaptureIds: [capture.captureId],
    });
  });

  test('rejects installation for another kind and rejects a second installation', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { source, defaultValue: 2 });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: amount }] }],
    });
    const registry = new CombinatorRegistry();
    const arithmetic = value();
    registry.register(
      arithmetic,
      {
        kind: 'arithmetic',
        left: { kind: 'constant', value: 1 },
        operation: 'add',
        right: { kind: 'constant', value: 2 },
        output: { kind: 'signal', signal: signal('virtual', 'signal-out') },
        source,
        instancePath: ['root'],
      },
      network('$arithmetic:primary'),
      { network: '$arithmetic:primary', source, instancePath: ['root'] },
    );
    const pending = value();
    registry.register(
      pending,
      {
        kind: 'constant',
        pendingConfiguration: template,
        source,
        instancePath: ['root'],
      },
      network('$constant:primary'),
      { network: '$constant:primary', source, instancePath: ['root'] },
    );
    const configuration = bindConstantConfigurationTemplate(template);

    expect(() => registry.installPendingConstant(arithmetic, configuration)).toThrowError(
      /pending Constant/i,
    );
    registry.installPendingConstant(pending, configuration);
    expect(() => registry.installPendingConstant(pending, configuration)).toThrowError(
      /already installed/i,
    );
  });
});

describe('pending Arithmetic registry state', () => {
  test('retains topology and output binding around explicit installation and restore', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { source });
    const input = {
      refKind: 'pair' as const,
      networks: ['red-input', 'green-input'] as const,
    };
    const initialOutput = signal('virtual', 'initial-output');
    const reboundOutput = signal('virtual', 'rebound-output');
    const template = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: amount },
      operation: 'add',
      right: { kind: 'each', ...input },
      output: { kind: 'signal', signal: initialOutput },
    });
    const configuration = bindArithmeticConfigurationTemplate(template, [
      { parameter: amount, value: 7 },
    ]);
    const producer = value();
    const primary = network('$arithmetic:primary');
    const secondary = network('$arithmetic:secondary');
    const primaryAttachment = { network: primary.name, source, instancePath: ['root'] };
    const secondaryAttachment = {
      network: secondary.name,
      source,
      instancePath: ['root', 'secondary'],
    };
    const descriptor: CombinatorDescriptor = {
      kind: 'arithmetic',
      left: { kind: 'constant' },
      operation: 'add',
      right: { kind: 'each', ...input },
      output: configuration.output,
      pendingConfiguration: template,
      source,
      instancePath: ['root'],
      placement: { x: 4, y: 5 },
    };
    const registry = new CombinatorRegistry();
    const state = registry.register(producer, descriptor, primary, primaryAttachment);
    const primaryLane = state.outputPort.primary;
    registry.addSecondary(producer, secondary, secondaryAttachment);
    registry.bindName(producer, 'parameterized-arithmetic');
    registry.markOutputUsed(producer);
    const capture = registry.capture(producer);

    expect(state.descriptor).toMatchObject({
      kind: 'arithmetic',
      left: { kind: 'constant' },
      right: { kind: 'each', refKind: 'pair', networks: input.networks },
      operation: 'add',
      pendingConfiguration: template,
    });
    if (state.descriptor.kind !== 'arithmetic' || !('pendingConfiguration' in state.descriptor)) {
      throw new Error('Expected a pending Arithmetic descriptor.');
    }
    expect(state.descriptor.left).not.toHaveProperty('value');
    expect(() => registry.toPlan(state)).toThrowError(
      expect.objectContaining({ code: 'RT2027', span: source }),
    );

    const pendingDescriptor = state.descriptor;
    const replacementTemplate = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: amount },
      operation: 'add',
      right: { kind: 'each', ...input },
      output: { kind: 'signal', signal: initialOutput },
    });
    expect(() =>
      registry.update(producer, {
        ...pendingDescriptor,
        pendingConfiguration: replacementTemplate,
      } as CombinatorDescriptor),
    ).toThrowError(/cannot replace its prepared configuration template/i);
    expect(() =>
      registry.update(producer, {
        ...pendingDescriptor,
        operation: 'subtract',
      } as CombinatorDescriptor),
    ).toThrowError(/cannot change its operation or operand topology/i);
    expect(() =>
      registry.update(producer, {
        ...pendingDescriptor,
        right: { kind: 'each', refKind: 'single', network: 'other-input' },
      } as CombinatorDescriptor),
    ).toThrowError(/cannot change its operation or operand topology/i);
    expect(() =>
      registry.update(producer, {
        ...pendingDescriptor,
        left: { kind: 'constant', value: 0 },
      } as unknown as CombinatorDescriptor),
    ).toThrowError(/cannot contain concrete Arithmetic operands/i);

    const wrongOperation: ArithmeticProducerConfig = {
      ...configuration,
      operation: 'subtract',
    };
    const wrongTopology: ArithmeticProducerConfig = {
      ...configuration,
      right: { kind: 'each', refKind: 'single', network: 'other-input' as NetworkId },
    };
    const concreteConstant = value();
    registry.register(
      concreteConstant,
      {
        kind: 'constant',
        outputs: [],
        source,
        instancePath: ['root'],
      },
      network('$constant:primary'),
      { network: '$constant:primary', source, instancePath: ['root'] },
    );
    expect(() => registry.installPendingArithmetic(concreteConstant, configuration)).toThrowError(
      /only a pending Arithmetic/i,
    );
    expect(() => registry.installPendingArithmetic(producer, wrongOperation)).toThrowError(
      /operation or operand topology/i,
    );
    expect(() => registry.installPendingArithmetic(producer, wrongTopology)).toThrowError(
      /operation or operand topology/i,
    );
    expect(state.descriptor).toBe(pendingDescriptor);

    registry.bindOutput(producer, reboundOutput, source);
    const boundPendingDescriptor = state.descriptor;
    const pendingSnapshot = registry.snapshot();
    registry.installPendingArithmetic(producer, configuration);

    expect(state.outputPort.primary).toBe(primaryLane);
    expect(state.outputUsed).toBe(true);
    expect(state.descriptor).toMatchObject({
      kind: 'arithmetic',
      left: { kind: 'constant', value: 7 },
      right: { kind: 'each', refKind: 'pair', networks: input.networks },
      operation: 'add',
      output: { kind: 'signal', signal: reboundOutput },
      bindingName: 'parameterized-arithmetic',
      placement: { x: 4, y: 5 },
    });
    expect(state.descriptor).not.toHaveProperty('pendingConfiguration');
    expect(state.debugCaptureIds).toEqual([capture.captureId]);
    const concreteSnapshot = registry.snapshot();
    const concreteDescriptor = state.descriptor;
    expect(registry.toPlan(state)).toMatchObject({
      ...state.descriptor,
      debugCaptureIds: [capture.captureId],
      destinations: [primaryAttachment, secondaryAttachment],
    });
    expect(() => registry.installPendingArithmetic(producer, configuration)).toThrowError(
      /already installed/i,
    );

    registry.restore(pendingSnapshot);
    expect(registry.stateFor(producer).descriptor).toBe(boundPendingDescriptor);
    expect(registry.stateFor(producer).outputBinding?.signal).toEqual(reboundOutput);
    expect(() => registry.toPlan(registry.stateFor(producer))).toThrowError(
      expect.objectContaining({ code: 'RT2027' }),
    );
    registry.restore(concreteSnapshot);
    expect(registry.stateFor(producer).descriptor).toBe(concreteDescriptor);
    expect(registry.toPlan(registry.stateFor(producer))).toMatchObject({
      kind: 'arithmetic',
      output: { kind: 'signal', signal: reboundOutput },
      debugCaptureIds: [capture.captureId],
    });
  });
});

describe('pending Selector registry state', () => {
  test('retains pending operations, topology, lanes, metadata, and captures through installation and restore', () => {
    const session = createBlueprintParameterSession();
    const numberIndex = session.number('number index', { source });
    const signalIndex = session.signal('signal index', { source });
    const countOutput = session.signal('count output', { source });
    const pairInput = {
      refKind: 'pair',
      networks: ['red-input' as NetworkId, 'green-input' as NetworkId],
    } as const;
    const singleInput = { refKind: 'single', network: 'count-input' as NetworkId } as const;
    const numberTemplate = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input: pairInput,
      selectMax: false,
      index: numberIndex,
    });
    const signalTemplate = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input: singleInput,
      selectMax: true,
      index: signalIndex,
    });
    const countTemplate = createSelectorConfigurationTemplate(session, {
      operation: 'count',
      input: pairInput,
      output: countOutput,
    });
    if (
      numberTemplate.operation !== 'select' ||
      signalTemplate.operation !== 'select' ||
      countTemplate.operation !== 'count'
    ) {
      throw new Error('Expected operation-specific Selector templates.');
    }
    const registry = new CombinatorRegistry();
    const selectors = [
      {
        producer: value(),
        descriptor: {
          kind: 'selector',
          operation: 'select',
          input: pairInput,
          selectMax: false,
          pendingConfiguration: numberTemplate,
          source,
          instancePath: ['root'],
        } satisfies CombinatorDescriptor,
        template: numberTemplate,
        primary: network('$selector:number:primary'),
        secondary: network('$selector:number:secondary'),
      },
      {
        producer: value(),
        descriptor: {
          kind: 'selector',
          operation: 'select',
          input: singleInput,
          selectMax: true,
          pendingConfiguration: signalTemplate,
          source,
          instancePath: ['root'],
        } satisfies CombinatorDescriptor,
        template: signalTemplate,
        primary: network('$selector:signal:primary'),
      },
      {
        producer: value(),
        descriptor: {
          kind: 'selector',
          operation: 'count',
          input: pairInput,
          pendingConfiguration: countTemplate,
          source,
          instancePath: ['root'],
        } satisfies CombinatorDescriptor,
        template: countTemplate,
        primary: network('$selector:count:primary'),
      },
    ] as const;

    const captures: string[] = [];
    for (const selector of selectors) {
      const state = registry.register(selector.producer, selector.descriptor, selector.primary, {
        network: selector.primary.name,
        source,
        instancePath: ['root'],
      });
      registry.bindName(selector.producer, selector.primary.name);
      if ('secondary' in selector) {
        registry.addSecondary(selector.producer, selector.secondary, {
          network: selector.secondary.name,
          source,
          instancePath: ['root', 'secondary'],
        });
      }
      registry.markOutputUsed(selector.producer);
      captures.push(registry.capture(selector.producer).captureId);
      expect(state.descriptor).toMatchObject({
        kind: 'selector',
        pendingConfiguration: selector.template,
        bindingName: selector.primary.name,
      });
      expect(state.descriptor).not.toHaveProperty('index');
      expect(state.descriptor).not.toHaveProperty('output');
      expect(() => registry.toPlan(state)).toThrowError(
        expect.objectContaining({
          code: 'RT2027',
          span: source,
          message: expect.stringContaining('installed'),
        }),
      );
    }

    const pendingSnapshot = registry.snapshot();
    const pendingDescriptors = selectors.map(
      ({ producer }) => registry.stateFor(producer).descriptor,
    );
    const firstPending = pendingDescriptors[0]!;
    if (
      firstPending.kind !== 'selector' ||
      firstPending.operation !== 'select' ||
      !('pendingConfiguration' in firstPending)
    ) {
      throw new Error('Expected the first Selector to remain pending.');
    }
    const replacementTemplate = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input: pairInput,
      selectMax: false,
      index: numberIndex,
    });
    if (replacementTemplate.operation !== 'select') {
      throw new Error('Expected a select replacement template.');
    }
    expect(() =>
      registry.update(selectors[0].producer, {
        ...firstPending,
        pendingConfiguration: replacementTemplate,
      }),
    ).toThrowError(/cannot replace its prepared configuration template/i);
    expect(() =>
      registry.update(selectors[0].producer, {
        kind: 'selector',
        operation: 'select',
        input: singleInput,
        selectMax: false,
        pendingConfiguration: firstPending.pendingConfiguration,
        source,
        instancePath: ['root'],
      }),
    ).toThrowError(/operation or registered input topology/i);
    expect(() =>
      registry.update(selectors[0].producer, {
        kind: 'selector',
        operation: 'select',
        input: pairInput,
        selectMax: false,
        index: 11,
        source,
        instancePath: ['root'],
      }),
    ).toThrowError(/pending combinator can only become concrete/i);

    const numberConfiguration = bindSelectorConfigurationTemplate(numberTemplate, [
      { parameter: numberIndex, value: 8 },
    ]);
    const signalConfiguration = bindSelectorConfigurationTemplate(signalTemplate, [
      { parameter: signalIndex, value: signal('virtual', 'signal-index') },
    ]);
    const countConfiguration = bindSelectorConfigurationTemplate(countTemplate, [
      { parameter: countOutput, value: signal('virtual', 'signal-count') },
    ]);
    if (
      numberConfiguration.operation !== 'select' ||
      signalConfiguration.operation !== 'select' ||
      countConfiguration.operation !== 'count'
    ) {
      throw new Error('Expected operation-specific concrete Selector configurations.');
    }

    const wrongOperation: SelectorProducerConfig = {
      operation: 'count',
      input: pairInput,
      output: signal('virtual', 'wrong-operation'),
    };
    const wrongTopology: SelectorProducerConfig = {
      ...numberConfiguration,
      input: { refKind: 'single', network: 'other-input' as NetworkId },
    };
    const wrongMode: SelectorProducerConfig = {
      ...numberConfiguration,
      selectMax: true,
    };
    const arithmetic = value();
    registry.register(
      arithmetic,
      {
        kind: 'arithmetic',
        left: { kind: 'constant', value: 1 },
        operation: 'add',
        right: { kind: 'constant', value: 2 },
        output: { kind: 'signal', signal: signal('virtual', 'signal-output') },
        source,
        instancePath: ['root'],
      },
      network('$arithmetic:primary'),
      { network: '$arithmetic:primary', source, instancePath: ['root'] },
    );
    expect(() => registry.installPendingSelector(arithmetic, numberConfiguration)).toThrowError(
      /only a pending Selector/i,
    );
    expect(() =>
      registry.installPendingSelector(selectors[0].producer, wrongOperation),
    ).toThrowError(/operation or input topology/i);
    expect(() =>
      registry.installPendingSelector(selectors[0].producer, wrongTopology),
    ).toThrowError(/operation or input topology/i);
    expect(() => registry.installPendingSelector(selectors[0].producer, wrongMode)).toThrowError(
      /select mode/i,
    );
    expect(registry.stateFor(selectors[0].producer).descriptor).toBe(pendingDescriptors[0]);

    registry.installPendingSelector(selectors[0].producer, numberConfiguration);
    registry.installPendingSelector(selectors[1].producer, signalConfiguration);
    registry.installPendingSelector(selectors[2].producer, countConfiguration);
    const concreteSnapshot = registry.snapshot();
    const expected = [
      { operation: 'select', input: pairInput, selectMax: false, index: 8 },
      {
        operation: 'select',
        input: singleInput,
        selectMax: true,
        index: signal('virtual', 'signal-index'),
      },
      { operation: 'count', input: pairInput, output: signal('virtual', 'signal-count') },
    ];
    for (let index = 0; index < selectors.length; index += 1) {
      const selector = selectors[index]!;
      const plan = registry.toPlan(registry.stateFor(selector.producer));
      expect(plan).toMatchObject({
        ...expected[index],
        bindingName: selector.primary.name,
        debugCaptureIds: [captures[index]],
      });
      expect(plan.destinations.map(({ network }) => network)).toEqual(
        'secondary' in selector
          ? [selector.primary.name, selector.secondary.name]
          : [selector.primary.name],
      );
      expect(plan).not.toHaveProperty('pendingConfiguration');
      expect(registry.stateFor(selector.producer).outputUsed).toBe(true);
    }
    expect(registry.secondary(selectors[0].producer)?.name).toBe('$selector:number:secondary');
    expect(() =>
      registry.installPendingSelector(selectors[0].producer, numberConfiguration),
    ).toThrowError(/already installed/i);

    registry.restore(pendingSnapshot);
    for (let index = 0; index < selectors.length; index += 1) {
      const state = registry.stateFor(selectors[index]!.producer);
      expect(state.descriptor).toBe(pendingDescriptors[index]);
      expect(state.debugCaptureIds).toEqual([captures[index]]);
      expect(state.outputUsed).toBe(true);
      expect(() => registry.toPlan(state)).toThrowError(
        expect.objectContaining({ code: 'RT2027' }),
      );
    }
    registry.restore(concreteSnapshot);
    expect(registry.toPlan(registry.stateFor(selectors[0].producer))).toMatchObject({
      operation: 'select',
      index: 8,
      debugCaptureIds: [captures[0]],
    });
  });
});
