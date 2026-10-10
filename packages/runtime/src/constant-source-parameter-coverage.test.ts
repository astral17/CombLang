import {
  generateBlueprintJson,
  createTrustedEntityReplayContext,
  syntheticZeroPortEntityProfile,
  transformElaborationModule,
} from '@comblang/compiler';
import type { EntityProfile } from '@comblang/compiler/entity';
import { signal } from '@comblang/factorio';
import { parseFile, validateDslSemantics } from '@comblang/language';
import type { EntityPrototype } from '@comblang/prototypes';
import { sourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';
import { inspectConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-template.js';
import { createBlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';
import {
  ConstantConfigurationSourceError,
  normalizeConstantConfigurationSourceWithParameters,
} from './constant-configuration-source.js';
import { bindCapturedSourceConfigurationTemplates } from './executed-blueprint-configuration-binding.js';
import { tryElaborateDirectPlan } from './direct-plan.js';
import { executeElaborationProgramWithParameters } from './elaboration-program.js';
import {
  compileSourceProgram,
  bindSourceCompilationCircuit,
  listSourceCompilationParameters,
  sourceCompilationArtifact,
} from './source-compilation.js';

const sourceFile = sourceFileId('constant-source-parameter-coverage.ts');

function environment() {
  const constantProfile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:constant-combinator' as EntityProfile['ref']['prototypeKey'],
      profileId: 'profile:constant-parameter-canonical' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'constant-combinator',
  };
  const arithmeticProfile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:arithmetic-combinator' as EntityProfile['ref']['prototypeKey'],
      profileId: 'profile:arithmetic-parameter-canonical' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'arithmetic-combinator',
  };
  const profiles = [constantProfile, arithmeticProfile];
  const context = createTrustedEntityReplayContext({
    database: constantProfile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'constant-source-parameter-evidence',
    policyIdentity: 'constant-source-parameter-policy',
    profiles,
  });
  const prototypes: readonly EntityPrototype[] = [
    {
      key: constantProfile.ref.prototypeKey as EntityPrototype['key'],
      name: 'constant-combinator',
      type: 'constant-combinator',
      tileWidth: 1,
      tileHeight: 1,
    },
    {
      key: arithmeticProfile.ref.prototypeKey as EntityPrototype['key'],
      name: 'arithmetic-combinator',
      type: 'arithmetic-combinator',
      tileWidth: 1,
      tileHeight: 1,
    },
  ];
  return {
    trustedEntityReplayContext: context,
    entityPrototypeResolver: {
      database: context.database,
      getEntity(nameOrKey: string): EntityPrototype | undefined {
        return prototypes.find(
          (prototype) => nameOrKey === prototype.key || nameOrKey === prototype.name,
        );
      },
    },
  };
}

function execute(
  text: string,
  declarations?: (runtime: string) => string,
  testContextName?: string,
) {
  const parsed = parseFile({ path: sourceFile, text });
  expect(validateDslSemantics(parsed)).toEqual([]);
  const transformed =
    testContextName === undefined
      ? transformElaborationModule(parsed)
      : transformElaborationModule(parsed, { testContextName });
  const code =
    declarations === undefined
      ? transformed.code
      : `${declarations(transformed.runtimeParameter)}\n${transformed.code}`;
  return executeElaborationProgramWithParameters({ ...transformed, code }, environment());
}

describe('exact Constant source parameter capture', () => {
  test('binds a Signal parameter independently of a derived count in the same Constant row', () => {
    const compilation = compileSourceProgram(
      {
        path: 'constant-signal-and-expression.factorio.ts',
        text: `const channel = Param.signal('Channel', Signal('virtual', 'signal-A'));
const amount = Param.number('Amount', 5);
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: channel, value: amount + 1 }] }] });`,
      },
      environment(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const [channel, amount] = listSourceCompilationParameters(compilation);
    const defaults = bindSourceCompilationCircuit(compilation);
    expect(defaults.plan.producers[0]).toMatchObject({
      configuration: {
        sections: [{ filters: [{ signal: { type: 'virtual', name: 'signal-A' }, value: 6 }] }],
      },
    });
    const bound = bindSourceCompilationCircuit(compilation, [
      { parameter: channel!.parameter, value: signal('virtual', 'signal-B', 'excellent') },
      { parameter: amount!.parameter, value: 9 },
    ]);
    expect(bound.plan.producers[0]).toMatchObject({
      configuration: {
        sections: [
          {
            filters: [
              { signal: { type: 'virtual', name: 'signal-B', quality: 'excellent' }, value: 10 },
            ],
          },
        ],
      },
    });
    expect(bindSourceCompilationCircuit(compilation, []).plan.producers[0]).toEqual(
      defaults.plan.producers[0],
    );
  });

  test('captures registered numeric expressions in direct filter counts and multipliers', () => {
    const text = `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5);
const scale = Param.number('Scale', 2);
const output = new Network();
output += Constant({ sections: [{ multiplier: scale * 0.5, filters: [{ signal: A, value: amount + 1 }] }] });`;
    const compilation = compileSourceProgram(
      { path: 'constant-numeric-expression-baseline.factorio.ts', text },
      environment(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.plan!.producers[0]).toMatchObject({
      configuration: {
        sections: [{ multiplier: 1, filters: [{ signal: { name: 'signal-A' }, value: 6 }] }],
      },
    });
    const captured = execute(text);
    expect(captured.constantTemplates).toHaveLength(1);
    expect(captured.constantTemplates[0]!.template.sections[0]).toMatchObject({
      multiplier: { kind: 'binary' },
      filters: [{ value: { kind: 'binary' } }],
    });
  });

  test.each([1, 0.5])(
    'normal source compilation captures multiplier-only default %s on one linked Constant',
    (defaultValue) => {
      const text = `const A = Signal('virtual', 'signal-A');
const scale = Param.number('Scale', ${defaultValue});
const output = new Network();
output += Constant({ sections: [{ multiplier: scale, filters: [{ signal: A, value: 5 }] }] });`;
      const compilation = compileSourceProgram(
        { path: 'source-multiplier.factorio.ts', text },
        environment(),
      );
      expect(compilation.pipelineDiagnostics).toEqual([]);
      expect(compilation.plan!.producers).toHaveLength(1);
      expect(compilation.plan!.entities).toHaveLength(1);
      expect(compilation.plan!.producers[0]).toMatchObject({
        configuration: { sections: [{ multiplier: defaultValue }] },
      });
      expect(compilation.plan!.entities[0]).toMatchObject({
        configuration: { mode: 'constant', value: { sections: [{ multiplier: defaultValue }] } },
      });
      const captured = execute(text);
      expect(captured.constantTemplates).toHaveLength(1);
      expect(captured.constantTemplates[0]!.template.sections[0]!.multiplier).toBe(
        captured.parameters[0]!.handle,
      );
      expect(bindSourceCompilationCircuit(compilation).plan).toEqual(compilation.plan);
    },
  );

  test('shared multiplier/count and Signal slots retain ordered metadata and independent numeric domains', () => {
    const text = `const A = Signal('virtual', 'signal-A');
const shared = Param.number('Shared', 1);
const channel = Param.signal('Channel', A);
const output = new Network();
output += Constant({ isOn: false, sections: [
  { group: 'backup', active: false, multiplier: shared, filters: [{ signal: channel, value: shared }, { signal: A, value: 0 }, { signal: channel, value: shared }] },
  { multiplier: shared, filters: [] }, {}, { multiplier: 2, filters: [] },
] }).at(4, 5);`;
    const compilation = compileSourceProgram(
      { path: 'shared-multiplier.factorio.ts', text },
      environment(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const original = structuredClone(sourceCompilationArtifact(compilation));
    const [shared, channel] = listSourceCompilationParameters(compilation);
    const bound = bindSourceCompilationCircuit(compilation, [
      { parameter: shared!.parameter, value: 2147483648 },
      { parameter: channel!.parameter, value: signal('virtual', 'signal-B', 'excellent') },
    ]);
    const configuration = {
      isOn: false,
      sections: [
        {
          active: false,
          group: 'backup',
          multiplier: 2147483648,
          filters: [
            { signal: signal('virtual', 'signal-B', 'excellent'), value: -2147483648 },
            { signal: signal('virtual', 'signal-A'), value: 0 },
            { signal: signal('virtual', 'signal-B', 'excellent'), value: -2147483648 },
          ],
        },
        { active: true, multiplier: 2147483648, filters: [] },
        { active: true, multiplier: 1, filters: [] },
        { active: true, multiplier: 2, filters: [] },
      ],
    };
    expect(bound.plan.producers[0]).toEqual({ ...compilation.plan!.producers[0], configuration });
    expect(bound.plan.entities[0]).toEqual({
      ...compilation.plan!.entities[0],
      configuration: { mode: 'constant', value: configuration },
    });
    expect(bound.resolvedCircuit.ir.producers[0]).toMatchObject({ config: { configuration } });
    expect(bound.resolvedCircuit.ir.entities[0]).toMatchObject({
      configuration: { mode: 'constant', value: configuration },
    });
    expect(bound.plan.producers).toHaveLength(1);
    expect(bound.plan.entities).toHaveLength(1);
    for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        bindSourceCompilationCircuit(compilation, [{ parameter: shared!.parameter, value }]),
      ).toThrowError(expect.objectContaining({ code: 'CP1000', span: shared!.source }));
    }
    expect(bindSourceCompilationCircuit(compilation).plan).toEqual(compilation.plan);
    expect(sourceCompilationArtifact(compilation)).toEqual(original);
  });

  test.each([
    [
      "Param.signal('Wrong', A)",
      'Constant({ sections: [{ multiplier: scale }] })',
      '$.configuration.sections[0].multiplier',
    ],
    [
      "Param.number('Scale', 1)",
      "Constant({ sections: [{ multiplier: { kind: 'number', label: 'Scale', defaultValue: 1 } }] })",
      '$.configuration.sections[0].multiplier',
    ],
    [
      "Param.number('Scale', 1)",
      'Constant({ sections: [{ active: scale }] })',
      '$.configuration.sections[0].active',
    ],
    [
      "Param.number('Scale', 1)",
      'Constant({ sections: [{ group: scale }] })',
      '$.configuration.sections[0].group',
    ],
    ["Param.number('Scale', 1)", 'Constant({ isOn: scale })', '$.configuration.isOn'],
  ])('locates unsupported direct configuration use: %s / %s', (declaration, device, path) => {
    const text = `const A = Signal('virtual', 'signal-A'); const scale = ${declaration};
const output = new Network(); output += ${device};`;
    const compilation = compileSourceProgram(
      { path: 'invalid-multiplier.factorio.ts', text },
      environment(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        message: expect.stringContaining(path),
        span: expect.objectContaining({
          start: text.indexOf('Constant('),
          end: text.lastIndexOf(';'),
        }),
      }),
    ]);
    expect(compilation.resolvedCircuit).toBeUndefined();
  });

  test.each(['CC(scale * Section([A, 5]))', 'CC(scale * A)'])(
    'does not enable convenience scaling: %s',
    (device) => {
      const text = `const A = Signal('virtual', 'signal-A'); const scale = Param.number('Scale', 1);
const output = new Network(); output += ${device};`;
      const compilation = compileSourceProgram(
        { path: 'bare-scaling.factorio.ts', text },
        environment(),
      );
      expect(compilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({
          severity: 'error',
          span: expect.objectContaining({ fileId: compilation.fileId }),
        }),
      ]);
      expect(compilation.resolvedCircuit).toBeUndefined();
    },
  );

  test('source view copy remains a located reflection rejection before multiplier normalization', () => {
    const text = `const scale = Param.number('Scale', 1);
const output = new Network(); output += Constant({ sections: [{ multiplier: { ...scale } }] });`;
    const compilation = compileSourceProgram(
      { path: 'copied-multiplier.factorio.ts', text },
      environment(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'CP1001',
        message: expect.stringContaining('$.parameter'),
        span: expect.objectContaining({
          start: text.indexOf('Param.number('),
          end: text.indexOf(';'),
        }),
      }),
    ]);
    expect(compilation.resolvedCircuit).toBeUndefined();
  });

  test('failed multiplier construction leaves no ghost capture or hardware before a valid retry', () => {
    const execution = execute(`const A = Signal('virtual', 'signal-A');
const scale = Param.number('Scale', 1);
try { Constant({ sections: [{ multiplier: scale, active: scale }] }); } catch (error) { const caught = true; }
const output = new Network();
output += Constant({ sections: [{ multiplier: scale, filters: [{ signal: A, value: 5 }] }] });`);
    expect(execution.constantTemplates).toHaveLength(1);
    expect(execution.plan.producers).toHaveLength(1);
    expect(execution.plan.entities).toHaveLength(1);
    expect(execution.constantTemplates[0]!.captureId).toBe(
      execution.plan.producers[0]!.debugCaptureIds![0],
    );
    expect(execution.constantTemplates[0]!.template.sections[0]!.multiplier).toBe(
      execution.parameters[0]!.handle,
    );
  });

  test('uses declared defaults in the concrete producer and captures the exact filter slots', () => {
    const execution = execute(
      `
const exact = Constant({ isOn: true, sections: [{ filters: [{ signal: signalSlot, value: amount }] }] });
const output = new Network();
output += exact;`,
      (runtime) => `
const defaultSignal = ${runtime}.signal('virtual', 'signal-default', { start: 0, end: 1 });
const signalSlot = ${runtime}.declareBlueprintSignalParameter('signal slot', defaultSignal, undefined, { start: 0, end: 1 });
const amount = ${runtime}.declareBlueprintNumberParameter('amount', 5, undefined, { start: 0, end: 1 });`,
    );

    expect(execution.plan.producers).toHaveLength(1);
    expect(execution.plan.producers[0]).toMatchObject({
      kind: 'constant',
      configuration: {
        isOn: true,
        sections: [
          { filters: [{ signal: { type: 'virtual', name: 'signal-default' }, value: 5 }] },
        ],
      },
    });
    expect(execution.plan.entities).toHaveLength(1);
    expect(execution.plan.entities[0]?.configuration).toMatchObject({
      mode: 'constant',
      value: {
        sections: [
          { filters: [{ signal: { type: 'virtual', name: 'signal-default' }, value: 5 }] },
        ],
      },
    });
    expect(execution.plan).not.toHaveProperty('constantTemplates');
    expect(JSON.stringify(execution.plan)).not.toContain('constantTemplates');

    const captured = execution as typeof execution & {
      readonly constantTemplates?: readonly {
        readonly captureId: string;
        readonly template: unknown;
        readonly source: unknown;
      }[];
    };
    expect(captured.constantTemplates).toHaveLength(1);
    expect(captured.constantTemplates?.[0]?.captureId).toBe(
      execution.plan.producers[0]?.debugCaptureIds?.[0],
    );
    expect(captured.constantTemplates?.[0]?.source).toEqual(execution.plan.producers[0]?.source);
    expect(Object.isFrozen(captured.constantTemplates?.[0]?.source)).toBe(true);
    expect(
      inspectConstantConfigurationTemplate(
        captured.constantTemplates?.[0]?.template,
        '$.constantTemplates[0].template',
      ).session,
    ).toBe(execution.session);
    expect(
      inspectConstantConfigurationTemplate(
        captured.constantTemplates?.[0]?.template,
        '$.constantTemplates[0].template',
      ).usedParameters,
    ).toEqual(execution.parameters.map(({ handle }) => handle));
  });

  test('reports a wrong-kind direct filter slot at its Constant call span', () => {
    const text = `
const count = Param.number('Count', 5);
const exact = Constant({ sections: [{ filters: [{ signal: amount, value: count + 1 }] }] });`;
    const parsed = parseFile({ path: sourceFile, text });
    const callStart = text.indexOf('Constant(');
    const callEnd = text.indexOf(';', callStart);
    let caught: unknown;
    try {
      execute(
        text,
        (runtime) =>
          `const amount = ${runtime}.declareBlueprintNumberParameter('amount', 5, undefined, { start: 0, end: 1 });`,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'RT2027',
      span: { fileId: parsed.id, start: callStart, end: callEnd },
    });
    expect(caught).toHaveProperty(
      'message',
      expect.stringContaining('expected a signal parameter'),
    );
    expect(caught).toHaveProperty(
      'message',
      expect.stringContaining('$.configuration.sections[0].filters[0].signal:'),
    );
  });

  test.each([
    [
      'foreign',
      'comblang.test.foreign-constant-signal',
      'parameter belongs to a different parameter session',
    ],
    ['forged', 'comblang.test.forged-constant-signal', 'unregistered parameter-like object'],
  ] as const)(
    'validates a %s Signal independently of a derived Constant count',
    (_kind, symbolKey, message) => {
      const key = Symbol.for(symbolKey);
      const globalRecord = globalThis as Record<PropertyKey, unknown>;
      const previous = {
        had: Object.hasOwn(globalRecord, key),
        value: globalRecord[key],
      };
      globalRecord[key] =
        _kind === 'foreign'
          ? createBlueprintParameterSession().signal('Foreign', {
              defaultValue: signal('virtual', 'signal-A'),
            })
          : { kind: 'signal', label: 'Forged', defaultValue: signal('virtual', 'signal-A') };
      try {
        const text = `const channel = globalThis[Symbol.for('${symbolKey}')];
const amount = Param.number('Amount', 5);
const exact = Constant({ sections: [{ filters: [{ signal: channel, value: amount + 1 }] }] });`;
        const parsed = parseFile({ path: sourceFile, text });
        let caught: unknown;
        try {
          execute(text);
        } catch (error) {
          caught = error;
        }
        expect(caught).toMatchObject({
          code: 'RT2027',
          span: {
            fileId: parsed.id,
            start: text.indexOf('Constant('),
            end: text.lastIndexOf(';'),
          },
        });
        expect(caught).toHaveProperty(
          'message',
          expect.stringContaining('$.configuration.sections[0].filters[0].signal:'),
        );
        expect(caught).toHaveProperty('message', expect.stringContaining(message));
      } finally {
        if (previous.had) globalRecord[key] = previous.value;
        else delete globalRecord[key];
      }
    },
  );

  test.each([
    [
      'nested filter expression',
      `const A = Signal('virtual', 'signal-A');
const exact = Constant({ sections: [{ filters: [[A, amount]] }] });`,
    ],
  ])('rejects %s instead of capturing it', (_label, text) => {
    const parsed = parseFile({ path: sourceFile, text });
    const callStart = text.indexOf('Constant(');
    const callEnd = text.indexOf(';', callStart);
    let caught: unknown;
    try {
      execute(
        text,
        (runtime) =>
          `const amount = ${runtime}.declareBlueprintNumberParameter('amount', 5, undefined, { start: 0, end: 1 });`,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'RT2027',
      span: { fileId: parsed.id, start: callStart, end: callEnd },
    });
  });

  test.each(['filter', 'multiplier'] as const)(
    'rejects foreign and forged parameter handles in direct %s slots',
    (field) => {
      const foreignKey = Symbol.for('comblang.test.foreign-constant-number');
      const forgedKey = Symbol.for('comblang.test.forged-constant-number');
      const globalRecord = globalThis as Record<PropertyKey, unknown>;
      const previous = new Map<PropertyKey, { readonly had: boolean; readonly value: unknown }>([
        [
          foreignKey,
          { had: Object.hasOwn(globalRecord, foreignKey), value: globalRecord[foreignKey] },
        ],
        [
          forgedKey,
          { had: Object.hasOwn(globalRecord, forgedKey), value: globalRecord[forgedKey] },
        ],
      ]);
      globalRecord[foreignKey] = createBlueprintParameterSession().number('foreign', {
        defaultValue: 5,
      });
      globalRecord[forgedKey] = { kind: 'number', label: 'forged', defaultValue: 5 };
      try {
        for (const [key, symbolKey, message] of [
          [
            foreignKey,
            'comblang.test.foreign-constant-number',
            'parameter belongs to a different parameter session',
          ],
          [forgedKey, 'comblang.test.forged-constant-number', 'unregistered parameter-like object'],
        ] as const) {
          const text = `const A = Signal('virtual', 'signal-A');
const exact = Constant({ sections: [{ ${field === 'filter' ? `filters: [{ signal: A, value: globalThis[Symbol.for('${symbolKey}')] }]` : `multiplier: globalThis[Symbol.for('${symbolKey}')]`} }] });`;
          expect(() => execute(text)).toThrowError(
            expect.objectContaining({
              code: 'RT2027',
              message: expect.stringContaining(message),
              span: {
                fileId: parseFile({ path: sourceFile, text }).id,
                start: text.indexOf('Constant('),
                end: text.lastIndexOf(';'),
              },
            }),
          );
        }
      } finally {
        for (const [key, value] of previous) {
          if (value.had) globalRecord[key] = value.value;
          else delete globalRecord[key];
        }
      }
    },
  );

  test('rejects missing defaults at either direct filter slot', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount');
    const signalSlot = session.signal('signal');
    const A = signal('virtual', 'signal-A');
    const context = {
      isSignal: (value: unknown): value is typeof A => value === A,
      isSignalValue: (_value: unknown): _value is never => false,
    };
    expect(() =>
      normalizeConstantConfigurationSourceWithParameters(
        { sections: [{ filters: [{ signal: A, value: amount }] }] },
        context,
        session,
      ),
    ).toThrowError(
      expect.objectContaining({
        name: 'ConstantConfigurationSourceError',
        message: expect.stringContaining('number parameter requires a numeric default'),
      } satisfies Partial<ConstantConfigurationSourceError>),
    );
    expect(() =>
      normalizeConstantConfigurationSourceWithParameters(
        { sections: [{ filters: [{ signal: signalSlot, value: 1 }] }] },
        context,
        session,
      ),
    ).toThrowError(
      expect.objectContaining({
        name: 'ConstantConfigurationSourceError',
        message: expect.stringContaining('Signal parameter requires a concrete default'),
      } satisfies Partial<ConstantConfigurationSourceError>),
    );
  });

  test.each(['filter', 'multiplier'] as const)(
    'captures distinct dynamic producers and rolls back a failed enclosing instance with %s parameter',
    (field) => {
      const host = environment();
      const execution = execute(
        `
const A = Signal('virtual', 'signal-A');
function Make() {
  const exact = Constant({ sections: [{ ${field === 'filter' ? 'filters: [{ signal: A, value: amount }]' : 'multiplier: amount, filters: [{ signal: A, value: 5 }]'} }] });
  const sink = new Network();
  sink += exact;
  return exact;
}
function Broken() {
  const exact = Constant({ sections: [{ ${field === 'filter' ? 'filters: [{ signal: A, value: amount }]' : 'multiplier: amount, filters: [{ signal: A, value: 5 }]'} }] });
  const sink = new Network();
  sink += exact;
  return [exact, () => {}];
}
try { t.instantiate(Broken); } catch (error) { const caught = true; }
const first = t.instantiate(Make);
const second = t.instantiate(Make);`,
        (runtime) =>
          `const amount = ${runtime}.declareBlueprintNumberParameter('amount', 5, undefined, { start: 0, end: 1 });`,
        't',
      );

      expect(execution.plan.producers).toHaveLength(2);
      expect(execution.plan.entities).toHaveLength(2);
      expect(execution.constantTemplates).toHaveLength(2);
      expect(execution.constantTemplates.map(({ captureId }) => captureId)).toEqual([
        'producer:1',
        'producer:3',
      ]);
      expect(execution.plan.producers.map(({ debugCaptureIds }) => debugCaptureIds)).toEqual([
        ['producer:1', 'producer:2'],
        ['producer:3', 'producer:4'],
      ]);
      expect(new Set(execution.constantTemplates.map(({ captureId }) => captureId)).size).toBe(2);
      expect(execution.plan.debugInstances).toHaveLength(2);
      expect(
        tryElaborateDirectPlan(execution.plan, host.trustedEntityReplayContext).diagnostics,
      ).toEqual([]);
    },
  );

  test('binds mixed Arithmetic and Constant captures atomically without changing topology', () => {
    const host = environment();
    const text = `
const A = Signal('virtual', 'signal-A');
const input = new Network();
const arithmetic = Arithmetic({ left: input[A], operation: 'add', right: amount, output: A });
const arithmeticOutput = new Network();
arithmeticOutput += arithmetic;
const exact = Constant({ sections: [{ filters: [{ signal: signalSlot, value: amount }] }] }).at(4, 5);
const constantOutput = new Network();
constantOutput += exact;`;
    const execution = execute(
      text,
      (runtime) => `
const defaultSignal = ${runtime}.signal('virtual', 'signal-default', { start: 0, end: 1 });
const signalSlot = ${runtime}.declareBlueprintSignalParameter('signal slot', defaultSignal, undefined, { start: 0, end: 1 });
const amount = ${runtime}.declareBlueprintNumberParameter('amount', 5, undefined, { start: 0, end: 1 });`,
    );
    const lowered = tryElaborateDirectPlan(execution.plan, host.trustedEntityReplayContext);
    expect(lowered.diagnostics).toEqual([]);
    expect(execution.arithmeticTemplates).toHaveLength(1);
    expect(execution.constantTemplates).toHaveLength(1);
    const canonicalExecution = lowered.execution!;
    const originalIr = canonicalExecution.circuit.ir;
    const originalConstant = originalIr.producers.find(({ kind }) => kind === 'constant')!;
    const originalArithmetic = originalIr.producers.find(({ kind }) => kind === 'arithmetic')!;
    const originalEntity = originalIr.entities.find(({ id }) => id === originalConstant.entityId)!;

    const defaultCircuit = bindCapturedSourceConfigurationTemplates(execution, canonicalExecution);
    expect(defaultCircuit).toEqual(originalIr);
    const boundCircuit = bindCapturedSourceConfigurationTemplates(execution, canonicalExecution, [
      { parameter: execution.parameters[0]!.handle, value: signal('virtual', 'signal-bound') },
      { parameter: execution.parameters[1]!.handle, value: 7 },
    ]);
    const boundConstant = boundCircuit.producers.find(({ kind }) => kind === 'constant')!;
    const boundArithmetic = boundCircuit.producers.find(({ kind }) => kind === 'arithmetic')!;
    const boundEntity = boundCircuit.entities.find(({ id }) => id === originalEntity.id)!;

    expect(boundCircuit.networks.map(({ id }) => id)).toEqual(
      originalIr.networks.map(({ id }) => id),
    );
    expect(boundCircuit.producers.map(({ id }) => id)).toEqual(
      originalIr.producers.map(({ id }) => id),
    );
    expect(boundCircuit.entities.map(({ id }) => id)).toEqual(
      originalIr.entities.map(({ id }) => id),
    );
    expect(boundArithmetic).toMatchObject({
      kind: 'arithmetic',
      config: { right: { kind: 'constant', value: 7 } },
    });
    expect(boundConstant).toMatchObject({
      kind: 'constant',
      config: {
        configuration: {
          sections: [{ filters: [{ signal: signal('virtual', 'signal-bound'), value: 7 }] }],
        },
      },
    });
    expect(boundEntity.configuration).toMatchObject({
      mode: 'constant',
      value: {
        sections: [{ filters: [{ signal: signal('virtual', 'signal-bound'), value: 7 }] }],
      },
    });
    expect(boundEntity.placement).toEqual(originalEntity.placement);
    expect(originalArithmetic).toMatchObject({
      kind: 'arithmetic',
      config: { right: { kind: 'constant', value: 5 } },
    });
    const json = JSON.stringify(generateBlueprintJson(boundCircuit));
    expect(json).not.toContain('constantTemplates');
    expect(json).not.toContain('signal slot');
    expect(json).not.toContain('amount');
    const beforeInvalidBinding = JSON.stringify(canonicalExecution.circuit.ir);
    expect(() =>
      bindCapturedSourceConfigurationTemplates(execution, canonicalExecution, [
        { parameter: execution.parameters[1]!.handle, value: Number.MAX_SAFE_INTEGER + 1 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000' }));
    expect(JSON.stringify(canonicalExecution.circuit.ir)).toBe(beforeInvalidBinding);

    const constantCapture = execution.constantTemplates[0]!;
    const missingCapture = {
      ...execution,
      constantTemplates: [{ ...constantCapture, captureId: 'producer:missing' }],
    };
    expect(() =>
      bindCapturedSourceConfigurationTemplates(missingCapture, canonicalExecution),
    ).toThrowError(expect.objectContaining({ path: '$.constantTemplates[0].captureId' }));
    const duplicateCapture = {
      ...execution,
      constantTemplates: [constantCapture, constantCapture],
    };
    expect(() =>
      bindCapturedSourceConfigurationTemplates(duplicateCapture, canonicalExecution),
    ).toThrowError(expect.objectContaining({ path: '$.constantTemplates[1].captureId' }));
  });
});
