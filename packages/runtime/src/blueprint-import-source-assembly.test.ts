import { classifyBlueprintDocument } from '@comblang/blueprint/classification';
import { parseLosslessJson } from '@comblang/blueprint/document';
import { analyzeBlueprintImport } from '@comblang/blueprint/import-analysis';
import {
  generateCanonicalBlueprintSource,
  type BlueprintSourceEntityCorrespondence,
} from '@comblang/compiler/blueprint-import-source-assembly';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import type { EntityProfile, EntityProfileId } from '@comblang/compiler/entity';
import { createTrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import type { ArithmeticProducerConfig } from '@comblang/compiler/ir';
import type { EntityPrototype } from '@comblang/prototypes';
import { sourceFileId } from '@comblang/shared';

import type { EntityPrototypeResolver } from './entity-registry.js';
import { compileSourceProgram } from './source-compilation.js';

import { describe, expect, test } from 'vitest';

function trustedCanonicalHost(): {
  readonly profiles: readonly EntityProfile[];
  readonly trustedEntityReplayContext: ReturnType<typeof createTrustedEntityReplayContext>;
  readonly entityPrototypeResolver: EntityPrototypeResolver;
} {
  const families = [
    ['constant-combinator', 'constant-combinator'],
    ['arithmetic-combinator', 'arithmetic-combinator'],
  ] as const;
  const profiles = families.map(([name, prototypeType], index) => ({
    ...syntheticZeroPortEntityProfile,
    prototypeType,
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${name}` as EntityProfile['ref']['prototypeKey'],
      profileId: `profile:source-assembly-${index}` as EntityProfileId,
    },
  }));
  const prototypes = families.map(([name, type]) => ({
    key: `entity:${name}`,
    name,
    type,
  })) as EntityPrototype[];
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profiles[0]!.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'blueprint-source-assembly-runtime-test-evidence',
    policyIdentity: 'blueprint-source-assembly-runtime-test-policy',
    profiles,
  });
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: profiles[0]!.ref.database,
    getEntity(nameOrKey) {
      return prototypes.find(({ key, name }) => nameOrKey === key || nameOrKey === name);
    },
  };
  return { profiles, trustedEntityReplayContext, entityPrototypeResolver };
}

const host = trustedCanonicalHost();

function constantBehavior(signal = 'signal-A') {
  return {
    is_on: true,
    sections: {
      sections: [
        {
          index: 1,
          active: true,
          multiplier: 1,
          filters: [
            {
              index: 1,
              name: signal,
              quality: 'normal',
              comparator: '=',
              count: 7,
            },
          ],
        },
      ],
    },
  };
}

function arithmeticBehavior(options: { readonly red: boolean; readonly green: boolean }) {
  return {
    arithmetic_conditions: {
      first_signal: { name: 'signal-A' },
      first_signal_networks: options,
      operation: '+',
      second_constant: 2,
      output_signal: { name: 'signal-B' },
    },
  };
}

function prepare(source: string) {
  const analysis = analyzeBlueprintImport(classifyBlueprintDocument(parseLosslessJson(source)));
  const selections = (analysis.entities ?? []).map(({ entityNumber, name }) => ({
    entityNumber,
    profile: host.profiles.find(({ prototypeType }) => prototypeType === name)!.ref,
  }));
  return { analysis, selections };
}

function compile(source: string, path: string) {
  const { analysis, selections } = prepare(source);
  const assembled = generateCanonicalBlueprintSource(
    analysis,
    selections,
    host.trustedEntityReplayContext,
    { path },
  );
  expect(assembled, JSON.stringify(assembled.diagnostics)).toMatchObject({ state: 'complete' });
  if (assembled.state !== 'complete') throw new Error('Expected literal blueprint source.');
  const compilation = compileSourceProgram(assembled.source, {
    trustedEntityReplayContext: host.trustedEntityReplayContext,
    entityPrototypeResolver: host.entityPrototypeResolver,
  });
  expect(compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error')).toEqual(
    [],
  );
  if (compilation.resolvedCircuit === undefined) {
    throw new Error('Expected ordinary source compilation to produce a resolved circuit.');
  }
  return { analysis, assembled, compilation, ir: compilation.resolvedCircuit.ir };
}

function sourceSpanEquals(
  left: { readonly fileId: string; readonly start: number; readonly end: number } | undefined,
  right: { readonly fileId: string; readonly start: number; readonly end: number },
): boolean {
  return left?.fileId === right.fileId && left.start === right.start && left.end === right.end;
}

function assertPhysicalCorrespondence(
  entity: BlueprintSourceEntityCorrespondence,
  ir: NonNullable<ReturnType<typeof compileSourceProgram>['resolvedCircuit']>['ir'],
  placement: { readonly x: number; readonly y: number; readonly direction: number },
): void {
  const producer = ir.producers.find(({ provenance }) =>
    sourceSpanEquals(provenance.source, entity.constructionSpan),
  );
  expect(
    producer,
    `producer must match constructor span for entity ${entity.entityNumber}`,
  ).toBeDefined();
  if (producer === undefined) throw new Error('No producer matched the recorded constructor span.');
  expect(producer.entityId).toBeDefined();
  const physicalEntity = ir.entities.find(({ id }) => id === producer.entityId);
  expect(physicalEntity, 'producer must link to its physical Entity by entityId').toBeDefined();
  if (physicalEntity === undefined) throw new Error('Producer Entity link did not resolve.');
  expect(physicalEntity).toMatchObject({
    placement,
    prototypeName: entity.family === 'constant' ? 'constant-combinator' : 'arithmetic-combinator',
  });
  if (producer.kind === 'constant') {
    if (!('configuration' in producer.config)) {
      throw new Error('Expected an exact Constant producer configuration.');
    }
    expect(physicalEntity.configuration).toMatchObject({
      mode: 'constant',
      value: producer.config.configuration,
    });
  } else if (producer.kind === 'arithmetic') {
    expect(physicalEntity.configuration).toMatchObject({
      mode: 'arithmetic',
      left: producer.config.left,
      operation: producer.config.operation,
      right: producer.config.right,
      output: producer.config.output,
    });
  } else {
    throw new Error(`Unexpected linked producer family ${producer.kind}.`);
  }
  expect(producer.provenance.source).toEqual(entity.constructionSpan);
}

describe('assembled blueprint source through ordinary runtime compilation', () => {
  test('compiles an independently wired Constant-to-Arithmetic source and retains an outputless warning', () => {
    const path = 'constant-to-arithmetic-assembly.factorio.ts';
    const { analysis, assembled, compilation, ir } = compile(
      JSON.stringify({
        blueprint: {
          entities: [
            {
              entity_number: 11,
              name: 'arithmetic-combinator',
              position: { x: -2, y: 3 },
              direction: 0,
              control_behavior: arithmeticBehavior({ red: true, green: false }),
            },
            {
              entity_number: 400,
              name: 'constant-combinator',
              position: { x: 8, y: -1 },
              direction: 15,
              control_behavior: constantBehavior(),
            },
            {
              entity_number: 12,
              name: 'arithmetic-combinator',
              position: { x: 0, y: 4 },
              direction: 4,
              control_behavior: arithmeticBehavior({ red: true, green: false }),
            },
          ],
          wires: [
            [400, 1, 11, 1],
            [400, 1, 12, 1],
          ],
        },
      }),
      path,
    );

    expect(assembled.source.text.indexOf('const import_entity_1')).toBeLessThan(
      assembled.source.text.indexOf('const import_entity_2'),
    );
    expect(ir.producers.map(({ kind }) => kind)).toEqual(['arithmetic', 'constant', 'arithmetic']);
    expect(ir.entities).toHaveLength(3);
    for (const network of assembled.correspondence.networks) {
      const declaration = assembled.source.text.slice(
        network.declarationSpan.start,
        network.declarationSpan.end,
      );
      expect(declaration).toMatch(/^const import_network_\d+ = new Network<[RG]>\(\);$/);
      const expectedColor = declaration.includes('<R>') ? 'red' : 'green';
      const compiled = ir.networks.find(({ name }) => name === network.name);
      expect(compiled, `declared network ${network.name} must resolve`).toBeDefined();
      expect(compiled?.fixedColor).toBe(expectedColor);
    }

    const arithmetic = ir.producers[0]!;
    expect(arithmetic.kind).toBe('arithmetic');
    if (arithmetic.kind !== 'arithmetic') throw new Error('Expected Arithmetic producer.');
    const arithmeticLeft = arithmetic.config.left;
    expect(arithmeticLeft).toMatchObject({ kind: 'signal', refKind: 'single' });
    if (arithmeticLeft.kind !== 'signal' || arithmeticLeft.refKind !== 'single') {
      throw new Error('Expected a single-network Arithmetic operand.');
    }
    expect(ir.networks.find(({ id }) => id === arithmeticLeft.network)?.fixedColor).toBe('red');
    expect(assembled.correspondence.entities[0]?.attachmentSpans).toEqual([]);
    expect(assembled.correspondence.entities[2]?.attachmentSpans).toEqual([]);
    const secondArithmetic = ir.producers[2]!;
    expect(secondArithmetic.kind).toBe('arithmetic');
    if (secondArithmetic.kind !== 'arithmetic') {
      throw new Error('Expected the second fanout consumer to be Arithmetic.');
    }
    expect(secondArithmetic.config.left).toEqual(arithmeticLeft);
    expect(compilation.pipelineDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    );

    expect(assembled.correspondence.entities.map(({ entityNumber }) => entityNumber)).toEqual([
      11, 400, 12,
    ]);
    expect(analysis.document).toBe(assembled.analysis.document);
    const placements = new Map([
      [11, { x: -2, y: 3, direction: 0 }],
      [400, { x: 8, y: -1, direction: 15 }],
      [12, { x: 0, y: 4, direction: 4 }],
    ]);
    for (const entity of assembled.correspondence.entities) {
      assertPhysicalCorrespondence(entity, ir, placements.get(entity.entityNumber)!);
    }
    expect(assembled.correspondence.entities[0]?.constructionSpan.fileId).toBe(sourceFileId(path));
  });

  test('compiles red/green Arithmetic feedback with dual-output attachment and exact source provenance', () => {
    const path = 'arithmetic-feedback-assembly.factorio.ts';
    const { assembled, ir } = compile(
      JSON.stringify({
        blueprint: {
          entities: [
            {
              entity_number: 27,
              name: 'arithmetic-combinator',
              position: { x: 1.5, y: -3 },
              direction: 8,
              control_behavior: {
                arithmetic_conditions: {
                  first_signal: { name: 'signal-A' },
                  first_signal_networks: { red: true, green: false },
                  operation: '+',
                  second_signal: { name: 'signal-B' },
                  second_signal_networks: { red: false, green: true },
                  output_signal: { name: 'signal-C' },
                },
              },
            },
          ],
          wires: [
            [27, 3, 27, 1],
            [27, 4, 27, 2],
          ],
        },
      }),
      path,
    );

    expect(assembled.source.text).toContain('const import_network_1 = new Network<R>();');
    expect(assembled.source.text).toContain('const import_network_2 = new Network<G>();');
    expect(assembled.source.text).toContain(
      'to(import_network_1,import_network_2) += import_entity_1;',
    );
    expect(ir.networks.map(({ fixedColor }) => fixedColor)).toEqual(['red', 'green']);
    const producer = ir.producers[0]!;
    expect(producer.kind).toBe('arithmetic');
    if (producer.kind !== 'arithmetic') throw new Error('Expected Arithmetic producer.');
    const config: ArithmeticProducerConfig = producer.config;
    const left = config.left;
    const right = config.right;
    expect(left).toMatchObject({ refKind: 'single' });
    expect(right).toMatchObject({ refKind: 'single' });
    if (left.kind !== 'signal' || left.refKind !== 'single') {
      throw new Error('Expected the red Arithmetic input to resolve.');
    }
    if (right.kind !== 'signal' || right.refKind !== 'single') {
      throw new Error('Expected the green Arithmetic input to resolve.');
    }
    expect(ir.networks.find(({ id }) => id === left.network)?.fixedColor).toBe('red');
    expect(ir.networks.find(({ id }) => id === right.network)?.fixedColor).toBe('green');
    expect(producer.destinations).toHaveLength(2);
    const correspondence = assembled.correspondence.entities[0]!;
    expect(correspondence.attachmentSpans).toHaveLength(1);
    expect(
      assembled.source.text.slice(
        correspondence.attachmentSpans[0]!.start,
        correspondence.attachmentSpans[0]!.end,
      ),
    ).toBe('to(import_network_1,import_network_2) += import_entity_1;');
    assertPhysicalCorrespondence(correspondence, ir, { x: 1.5, y: -3, direction: 8 });
  });
});
