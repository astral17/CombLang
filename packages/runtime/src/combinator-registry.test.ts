import { signal } from '@comblang/factorio';
import { sourceFileId, sourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { createBlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';
import { bindConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-binding.js';
import { createConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-template.js';
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
