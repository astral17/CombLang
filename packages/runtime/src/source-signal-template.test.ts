import { signal } from '@comblang/factorio';
import { sourceFileId, type NetworkId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { createSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-template.js';
import { createArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-template.js';
import { createConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-template.js';
import {
  createBlueprintParameterSession,
  inspectBlueprintParameterHandle,
  type BlueprintParameterHandle,
  type BlueprintParameterSession,
} from '../../compiler/src/blueprint-parameters.js';
import type { CapturedBlueprintParameter } from './blueprint-parameter-capture.js';
import type { CombinatorDescriptor } from './elaboration-values.js';
import { createSourceSignalTemplateContext } from './source-signal-template.js';

const source = {
  fileId: sourceFileId('source-signal-template.test.ts'),
  start: 2,
  end: 14,
};

function declarations(handles: readonly BlueprintParameterHandle[]): CapturedBlueprintParameter[] {
  return handles.map((handle) =>
    Object.freeze({
      handle,
      registration: inspectBlueprintParameterHandle(handle, '$.test.handle'),
    }),
  );
}

function pendingSelector(template: ReturnType<typeof selectTemplate>): CombinatorDescriptor {
  return {
    kind: 'selector',
    operation: template.operation,
    input: template.input,
    ...(template.operation === 'select' ? { selectMax: template.selectMax } : {}),
    pendingConfiguration: template,
    source,
    instancePath: [],
  } as unknown as CombinatorDescriptor;
}

function pendingArithmetic(
  template: ReturnType<typeof arithmeticTemplate>,
): Extract<CombinatorDescriptor, { readonly kind: 'arithmetic' }> {
  return {
    kind: 'arithmetic',
    left: { kind: 'constant' },
    operation: template.operation,
    right: { kind: 'constant' },
    pendingConfiguration: template,
    source,
    instancePath: [],
  } as unknown as Extract<CombinatorDescriptor, { readonly kind: 'arithmetic' }>;
}

function literalConstant(name: string): CombinatorDescriptor {
  return {
    kind: 'constant',
    configuration: {
      isOn: true,
      sections: [{ filters: [{ signal: signal('item', name), value: 1 }] }],
    },
    source,
    instancePath: [],
  } as unknown as CombinatorDescriptor;
}

function selectTemplate(session: BlueprintParameterSession, index: unknown) {
  return createSelectorConfigurationTemplate(session, {
    operation: 'select',
    input: { refKind: 'single', network: 'input' as NetworkId },
    selectMax: true,
    index: index as never,
  });
}

function countTemplate(session: BlueprintParameterSession, output: unknown) {
  return createSelectorConfigurationTemplate(session, {
    operation: 'count',
    input: { refKind: 'single', network: 'input' as NetworkId },
    output: output as never,
  });
}

function arithmeticTemplate(session: BlueprintParameterSession, output: unknown) {
  return createArithmeticConfigurationTemplate(session, {
    left: { kind: 'constant', value: 5 },
    operation: 'add',
    right: { kind: 'constant', value: 2 },
    output: { kind: 'signal', signal: output as never },
  });
}

describe('source-resolved Selector Signal templates', () => {
  test('allocates one required ID per declaration and projects only each template’s slots', () => {
    const session = createBlueprintParameterSession();
    const index = session.signal('Index channel', { source });
    const count = session.signal('Count channel', { source });
    const select = selectTemplate(session, index);
    const counted = countTemplate(session, count);
    const templates = {
      constants: [],
      arithmetics: [],
      deciders: [],
      selectors: [
        { template: select, source },
        { template: counted, source },
      ],
    };
    const context = createSourceSignalTemplateContext(
      session,
      declarations([index, count]),
      [pendingSelector(select), pendingSelector(counted)],
      templates,
    );

    expect(context?.requiredParameters).toEqual([index, count]);
    expect(context?.bindingsForSelectorTemplate(select)).toEqual([
      { parameter: index, value: signal('item', 'parameter-0') },
    ]);
    expect(context?.bindingsForSelectorTemplate(counted)).toEqual([
      { parameter: count, value: signal('item', 'parameter-1') },
    ]);
    expect(context?.placeholderFor(index)).toBe('parameter-0');
    expect(context?.placeholderFor(count)).toBe('parameter-1');

    const foreignSession = createBlueprintParameterSession();
    const foreign = selectTemplate(foreignSession, foreignSession.signal('Foreign'));
    expect(() => context?.bindingsForSelectorTemplate(foreign)).toThrowError(
      expect.objectContaining({ code: 'CP1002' }),
    );
  });

  test('does not treat an uncaptured pending descriptor as an authenticated Selector slot', () => {
    const session = createBlueprintParameterSession();
    const index = session.signal('Index channel', { source });
    const captured = selectTemplate(session, index);
    const differentIdentity = selectTemplate(session, index);

    expect(() =>
      createSourceSignalTemplateContext(
        session,
        declarations([index]),
        [pendingSelector(differentIdentity)],
        {
          constants: [],
          arithmetics: [],
          deciders: [],
          selectors: [{ template: captured, source }],
        },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        path: '$.parameters',
        span: source,
      }),
    );
  });

  test('reserves authored Selector/producer literals and explicit Signal defaults in the shared pool', () => {
    const session = createBlueprintParameterSession();
    const existing = session.signal('Existing', {
      defaultValue: signal('item', 'parameter-0'),
      source,
    });
    const required = session.signal('Required', { source });
    const template = selectTemplate(session, required);
    const context = createSourceSignalTemplateContext(
      session,
      declarations([existing, required]),
      [pendingSelector(template), literalConstant('parameter-1')],
      {
        constants: [],
        arithmetics: [],
        deciders: [],
        selectors: [{ template, source }],
      },
    );

    expect(context?.placeholderFor(required)).toBe('parameter-2');
  });

  test('reports a located pool exhaustion when Selector roles follow ten authored reserved IDs', () => {
    const session = createBlueprintParameterSession();
    const required = session.signal('Required', { source });
    const template = selectTemplate(session, required);
    expect(() =>
      createSourceSignalTemplateContext(
        session,
        declarations([required]),
        [
          pendingSelector(template),
          ...Array.from({ length: 10 }, (_, index) => literalConstant(`parameter-${index}`)),
        ],
        {
          constants: [],
          arithmetics: [],
          deciders: [],
          selectors: [{ template, source }],
        },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        path: '$.parameters',
        span: source,
        message: expect.stringContaining('parameter-0 through parameter-9 is exhausted'),
      }),
    );
  });
});

describe('source-resolved Arithmetic output Signal templates', () => {
  test('allocates and projects a default-free output through its exact captured owner', () => {
    const session = createBlueprintParameterSession();
    const output = session.signal('Arithmetic output', { source });
    const template = arithmeticTemplate(session, output);
    const owner = pendingArithmetic(template);
    const context = createSourceSignalTemplateContext(session, declarations([output]), [owner], {
      constants: [],
      arithmetics: [{ template, rawTemplate: template, ownerDescriptor: owner, source }],
      deciders: [],
      selectors: [],
    });

    expect(context?.requiredParameters).toEqual([output]);
    expect(context?.placeholderFor(output)).toBe('parameter-0');
    expect(context?.bindingsForArithmeticTemplate(template)).toEqual([
      { parameter: output, value: signal('item', 'parameter-0') },
    ]);
  });

  test('rejects a default-free output handle reused in an unsupported Arithmetic operand', () => {
    const session = createBlueprintParameterSession();
    const output = session.signal('Arithmetic output', { source });
    const template = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'signal', signal: output, refKind: 'single', network: 'input' as NetworkId },
      operation: 'add',
      right: { kind: 'constant', value: 2 },
      output: { kind: 'signal', signal: output },
    });
    const owner = pendingArithmetic(template);

    expect(() =>
      createSourceSignalTemplateContext(session, declarations([output]), [owner], {
        constants: [],
        arithmetics: [{ template, rawTemplate: template, ownerDescriptor: owner, source }],
        deciders: [],
        selectors: [],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        path: '$.parameters',
        span: source,
        message: expect.stringContaining('Arithmetic output Signal slot'),
      }),
    );
  });

  test('does not authenticate a copied Arithmetic descriptor by equal template contents', () => {
    const session = createBlueprintParameterSession();
    const output = session.signal('Arithmetic output', { source });
    const template = arithmeticTemplate(session, output);
    const owner = pendingArithmetic(template);
    const copied = { ...owner } as ReturnType<typeof pendingArithmetic>;

    expect(() =>
      createSourceSignalTemplateContext(session, declarations([output]), [copied], {
        constants: [],
        arithmetics: [{ template, rawTemplate: template, ownerDescriptor: owner, source }],
        deciders: [],
        selectors: [],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        path: '$.parameters',
        span: source,
      }),
    );
  });

  test('shares one allocated handle across Constant, Arithmetic, and both Selector slots', () => {
    const session = createBlueprintParameterSession();
    const shared = session.signal('Shared channel', { source });
    const arithmetic = arithmeticTemplate(session, shared);
    const select = selectTemplate(session, shared);
    const count = countTemplate(session, shared);
    const constant = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: shared, value: 4 }] }],
    });
    const arithmeticOwner = pendingArithmetic(arithmetic);
    const selectOwner = pendingSelector(select);
    const countOwner = pendingSelector(count);
    const context = createSourceSignalTemplateContext(
      session,
      declarations([shared]),
      [arithmeticOwner, selectOwner, countOwner],
      {
        constants: [{ template: constant, source }],
        arithmetics: [
          {
            template: arithmetic,
            rawTemplate: arithmetic,
            ownerDescriptor: arithmeticOwner,
            source,
          },
        ],
        deciders: [],
        selectors: [
          { template: select, source },
          { template: count, source },
        ],
      },
    );

    const binding = { parameter: shared, value: signal('item', 'parameter-0') };
    expect(context?.requiredParameters).toEqual([shared]);
    expect(context?.bindingsForConstantTemplate(constant)).toEqual([binding]);
    expect(context?.bindingsForArithmeticTemplate(arithmetic)).toEqual([binding]);
    expect(context?.bindingsForSelectorTemplate(select)).toEqual([binding]);
    expect(context?.bindingsForSelectorTemplate(count)).toEqual([binding]);
  });

  test('uses the shared placeholder pool and reports exhaustion for Arithmetic output roles', () => {
    const session = createBlueprintParameterSession();
    const output = session.signal('Arithmetic output', { source });
    const template = arithmeticTemplate(session, output);
    const owner = pendingArithmetic(template);
    const literals = Array.from({ length: 10 }, (_, index) =>
      literalConstant(`parameter-${index}`),
    );

    expect(() =>
      createSourceSignalTemplateContext(session, declarations([output]), [owner, ...literals], {
        constants: [],
        arithmetics: [{ template, rawTemplate: template, ownerDescriptor: owner, source }],
        deciders: [],
        selectors: [],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        path: '$.parameters',
        span: source,
        message: expect.stringContaining('parameter-0 through parameter-9 is exhausted'),
      }),
    );
  });
});
