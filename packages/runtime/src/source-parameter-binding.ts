import { constantConfigurationLimits, type SignalId } from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';

import {
  assertBlueprintParameterExactKeys,
  assertBlueprintParameterNumberValue,
  canonicalizeBlueprintParameterSignal,
  createBlueprintParameterDataBudget,
  openBlueprintParameterArray,
  openBlueprintParameterRecord,
  type BlueprintParameterBinding,
} from '../../compiler/src/blueprint-parameter-validation.js';
import {
  BlueprintParameterError,
  type BlueprintNumberParameterMetadata,
  type BlueprintParameterHandle,
} from '../../compiler/src/blueprint-parameters.js';
import {
  bindSourceCompilationCircuit,
  listSourceCompilationParameters,
} from './source-compilation.js';
import type {
  BoundSourceCompilationCircuit,
  LocalSourceCompilation,
} from './source-compilation.js';

interface SourceParameterDescriptorBase {
  readonly id: number;
  readonly label: string;
  readonly source: SourceSpan;
}

export type SourceParameterDescriptor =
  | (SourceParameterDescriptorBase & {
      readonly kind: 'number';
      readonly defaultValue: number;
      readonly metadata?: BlueprintNumberParameterMetadata;
    })
  | (SourceParameterDescriptorBase & {
      readonly kind: 'signal';
      readonly defaultValue?: SignalId;
    });

export interface SourceParameterOverride {
  readonly id: number;
  readonly value: number | SignalId;
}

export interface SourceParameterBindingSession {
  readonly parameters: readonly SourceParameterDescriptor[];
  bind(overrides?: unknown): BoundSourceCompilationCircuit;
}

interface PrivateDeclaration {
  readonly handle: BlueprintParameterHandle;
  readonly descriptor: SourceParameterDescriptor;
}

function fail(path: string, detail: string, source?: SourceSpan): never {
  throw new BlueprintParameterError('CP1000', path, detail, source);
}

function copySource(source: SourceSpan): SourceSpan {
  return Object.freeze({ fileId: source.fileId, start: source.start, end: source.end });
}

function copyMetadata(
  metadata: BlueprintNumberParameterMetadata | undefined,
): BlueprintNumberParameterMetadata | undefined {
  if (metadata === undefined) return undefined;
  return Object.freeze({
    ...(metadata.variable === undefined ? {} : { variable: metadata.variable }),
    ...(metadata.formula === undefined ? {} : { formula: metadata.formula }),
    ...(metadata.dependent === undefined ? {} : { dependent: metadata.dependent }),
  });
}

function copyDefault(
  kind: 'number' | 'signal',
  value: number | SignalId,
  path: string,
  source: SourceSpan,
): number | SignalId {
  if (kind === 'number') return value as number;
  return canonicalizeBlueprintParameterSignal(value, path, source);
}

function readOverrides(
  value: unknown,
  declarations: readonly PrivateDeclaration[],
): readonly BlueprintParameterBinding[] {
  if (value === undefined) return [];

  const path = '$.overrides';
  const budget = createBlueprintParameterDataBudget();
  const openedArray = openBlueprintParameterArray(value, path, 0, budget);
  const bindings: BlueprintParameterBinding[] = [];
  const seen = new Set<number>();
  try {
    if (openedArray.value.length > constantConfigurationLimits.maxNodes) {
      fail(path, `data exceeds the node limit of ${constantConfigurationLimits.maxNodes}.`);
    }
    for (let index = 0; index < openedArray.value.length; index += 1) {
      const entryPath = `${path}[${index}]`;
      const openedRecord = openBlueprintParameterRecord(
        openedArray.value[index],
        entryPath,
        1,
        budget,
      );
      try {
        const record = openedRecord.value;
        assertBlueprintParameterExactKeys(record, ['id', 'value'], entryPath);
        if (!Object.hasOwn(record, 'id')) fail(`${entryPath}.id`, 'id is required.');

        const idValue = record.id;
        if (typeof idValue !== 'number' || !Number.isSafeInteger(idValue) || idValue < 0) {
          fail(`${entryPath}.id`, 'expected a non-negative safe integer declaration ID.');
        }
        const declaration = declarations[idValue];
        if (declaration === undefined) {
          fail(`${entryPath}.id`, 'unknown declaration ID.');
        }
        if (seen.has(idValue)) {
          fail(`${entryPath}.id`, 'duplicate declaration ID.', declaration.descriptor.source);
        }
        seen.add(idValue);
        if (!Object.hasOwn(record, 'value')) {
          fail(`${entryPath}.value`, 'value is required.', declaration.descriptor.source);
        }

        const valuePath = `${entryPath}.value`;
        const rawValue = record.value;
        const canonicalValue =
          declaration.descriptor.kind === 'number'
            ? assertBlueprintParameterNumberValue(
                rawValue,
                valuePath,
                'finite',
                declaration.descriptor.source,
              )
            : canonicalizeBlueprintParameterSignal(
                rawValue,
                valuePath,
                declaration.descriptor.source,
              );
        bindings.push({ parameter: declaration.handle, value: canonicalValue });
      } finally {
        openedRecord.release();
      }
    }
  } finally {
    openedArray.release();
  }
  return bindings;
}

/** Creates an immutable, host-local ID adapter over one owning parameter compilation. */
export function createSourceParameterBindingSession(
  compilation: LocalSourceCompilation,
): SourceParameterBindingSession {
  const listed = listSourceCompilationParameters(compilation);
  if (listed.length === 0) {
    throw new TypeError('Compilation has no host-local source parameter declarations.');
  }
  if (
    compilation.pipelineDiagnostics.some(({ severity }) => severity === 'error') ||
    (compilation.requiredParameterIds === undefined &&
      (compilation.plan === undefined || compilation.resolvedCircuit === undefined))
  ) {
    throw new TypeError('Source parameter binding requires a successful lowered compilation.');
  }

  const declarations = Object.freeze(
    listed.map((parameter, id): PrivateDeclaration => {
      const source = copySource(parameter.source);
      let descriptor: SourceParameterDescriptor;
      if (parameter.kind === 'number') {
        if (parameter.defaultValue === undefined) {
          throw new TypeError('NUMBER declarations must have a resolved concrete default.');
        }
        descriptor = Object.freeze({
          id,
          kind: 'number',
          label: parameter.label,
          defaultValue: parameter.defaultValue as number,
          source,
          ...(parameter.metadata === undefined
            ? {}
            : { metadata: copyMetadata(parameter.metadata)! }),
        });
      } else {
        descriptor = Object.freeze({
          id,
          kind: 'signal',
          label: parameter.label,
          source,
          ...(parameter.defaultValue === undefined
            ? {}
            : {
                defaultValue: copyDefault(
                  'signal',
                  parameter.defaultValue,
                  `$.parameters[${id}].defaultValue`,
                  source,
                ) as SignalId,
              }),
        });
      }
      return Object.freeze({ handle: parameter.parameter, descriptor });
    }),
  );
  const parameters = Object.freeze(declarations.map(({ descriptor }) => descriptor));
  const session: SourceParameterBindingSession = {
    parameters,
    bind(overrides?: unknown): BoundSourceCompilationCircuit {
      const bindings = readOverrides(overrides, declarations);
      return bindSourceCompilationCircuit(compilation, bindings);
    },
  };
  return Object.freeze(session);
}
