import { signal } from '@comblang/factorio';
import { sourceFileId, type NetworkId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { createSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-template.js';
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

function literalConstant(name: string): CombinatorDescriptor {
  return {
    kind: 'constant',
    configuration: {
      isOn: true,
      sections: [{ filters: [{ signal: signal('virtual', name), value: 1 }] }],
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
      { parameter: index, value: signal('virtual', 'parameter-0') },
    ]);
    expect(context?.bindingsForSelectorTemplate(counted)).toEqual([
      { parameter: count, value: signal('virtual', 'parameter-1') },
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
      defaultValue: signal('virtual', 'parameter-0'),
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
