import { constantConfigurationLimits, type SignalId } from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';

import {
  assertBlueprintParameterExactKeys,
  assertBlueprintParameterNumberValue,
  canonicalizeBlueprintParameterSignal,
  createBlueprintParameterDataBudget,
  lookupBlueprintParameterSlot,
  openBlueprintParameterArray,
  openBlueprintParameterRecord,
  readBlueprintParameterBindings,
  type BlueprintParameterBinding,
} from '../../compiler/src/blueprint-parameter-validation.js';
import {
  BlueprintParameterError,
  canonicalBlueprintParameterHandle,
  inspectBlueprintParameterHandle,
  type BlueprintNumberParameterMetadata,
  type BlueprintParameterHandle,
  type BlueprintParameterRegistration,
  type BlueprintParameterSession,
} from '../../compiler/src/blueprint-parameters.js';
import {
  inspectArithmeticConfigurationTemplate,
  type ArithmeticConfigurationTemplate,
} from '../../compiler/src/arithmetic-configuration-template.js';
import {
  inspectConstantConfigurationTemplate,
  type ConstantConfigurationTemplate,
} from '../../compiler/src/constant-configuration-template.js';
import {
  inspectDeciderConfigurationTemplate,
  type DeciderConfigurationTemplate,
} from '../../compiler/src/decider-configuration-template.js';
import {
  inspectSelectorConfigurationTemplate,
  type SelectorConfigurationTemplate,
} from '../../compiler/src/selector-configuration-template.js';
import type { CapturedBlueprintParameter } from './blueprint-parameter-capture.js';

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

export interface SourceResolvedParameterSnapshot {
  readonly handle: BlueprintParameterHandle;
  readonly kind: 'number' | 'signal';
  readonly label: string;
  readonly defaultValue: number | SignalId;
  readonly source?: SourceSpan;
  readonly metadata?: BlueprintNumberParameterMetadata;
}

/** Host-local binding context; snapshots are not authentic registry registrations. */
export interface SourceResolvedNumberDefaultContext {
  readonly declarations: readonly SourceResolvedParameterSnapshot[];
  bindingsForConstantTemplate(
    template: ConstantConfigurationTemplate,
    overrides?: unknown,
  ): readonly BlueprintParameterBinding[];
  bindingsForArithmeticTemplate(
    template: ArithmeticConfigurationTemplate,
    overrides?: unknown,
  ): readonly BlueprintParameterBinding[];
  bindingsForDeciderTemplate(
    template: DeciderConfigurationTemplate,
    overrides?: unknown,
  ): readonly BlueprintParameterBinding[];
  bindingsForSelectorTemplate(
    template: SelectorConfigurationTemplate,
    overrides?: unknown,
  ): readonly BlueprintParameterBinding[];
}

interface ValidatedDeclaration {
  readonly handle: BlueprintParameterHandle;
  readonly registration: BlueprintParameterRegistration;
}

function fail(
  code: 'CP1000' | 'CP1001' | 'CP1002',
  path: string,
  message: string,
  source?: SourceSpan,
): never {
  throw new BlueprintParameterError(code, path, message, source);
}

function copySource(source: SourceSpan | undefined): SourceSpan | undefined {
  return source === undefined
    ? undefined
    : Object.freeze({ fileId: source.fileId, start: source.start, end: source.end });
}

function copyMetadata(
  metadata: BlueprintNumberParameterMetadata | undefined,
): BlueprintNumberParameterMetadata | undefined {
  return metadata === undefined
    ? undefined
    : Object.freeze({
        ...(metadata.variable === undefined ? {} : { variable: metadata.variable }),
        ...(metadata.formula === undefined ? {} : { formula: metadata.formula }),
        ...(metadata.dependent === undefined ? {} : { dependent: metadata.dependent }),
      });
}

function validateDeclarations(
  session: BlueprintParameterSession,
  declarationsValue: readonly CapturedBlueprintParameter[],
): readonly ValidatedDeclaration[] {
  const budget = createBlueprintParameterDataBudget();
  const opened = openBlueprintParameterArray(declarationsValue, '$.declarations', 0, budget);
  const declarations: ValidatedDeclaration[] = [];
  const seen = new Set<BlueprintParameterHandle>();
  try {
    if (opened.value.length > constantConfigurationLimits.maxNodes) {
      fail(
        'CP1000',
        '$.declarations',
        `declarations exceed the node limit of ${constantConfigurationLimits.maxNodes}.`,
      );
    }
    for (let index = 0; index < opened.value.length; index += 1) {
      const path = `$.declarations[${index}]`;
      const entry = openBlueprintParameterRecord(opened.value[index], path, 1, budget);
      try {
        assertBlueprintParameterExactKeys(entry.value, ['handle', 'registration'], path);
        if (!Object.hasOwn(entry.value, 'handle'))
          fail('CP1000', `${path}.handle`, 'handle is required.');
        if (!Object.hasOwn(entry.value, 'registration')) {
          fail('CP1000', `${path}.registration`, 'registration is required.');
        }

        const handle = entry.value.handle as BlueprintParameterHandle;
        const suppliedRegistration = entry.value.registration;
        const registration = inspectBlueprintParameterHandle(handle, `${path}.handle`);
        if (registration !== suppliedRegistration) {
          fail(
            'CP1001',
            `${path}.registration`,
            'declaration must retain the exact authentic registration for its handle.',
            registration.source,
          );
        }
        const slot = lookupBlueprintParameterSlot(
          handle,
          registration.kind,
          session,
          `${path}.handle`,
        );
        if (slot === undefined || slot.handle !== handle || slot.registration !== registration) {
          fail(
            'CP1001',
            `${path}.handle`,
            'declaration is not an authentic owner handle.',
            registration.source,
          );
        }
        if (seen.has(slot.handle)) {
          fail('CP1001', `${path}.handle`, 'duplicate declaration handle.', registration.source);
        }
        seen.add(slot.handle);
        if (registration.kind === 'signal' && registration.defaultValue === undefined) {
          fail(
            'CP1002',
            `${path}.defaultValue`,
            'Signal declarations without an explicit default are unsupported by this source binding context.',
            registration.source,
          );
        }
        declarations.push(Object.freeze({ handle: slot.handle, registration }));
      } finally {
        entry.release();
      }
    }
  } finally {
    opened.release();
  }
  return Object.freeze(declarations);
}

function validateChoices(
  session: BlueprintParameterSession,
  declarations: readonly ValidatedDeclaration[],
  choicesValue: unknown,
): ReadonlyMap<BlueprintParameterHandle, number> {
  const byHandle = new Map(declarations.map((declaration) => [declaration.handle, declaration]));
  const missingNumbers = declarations.filter(
    ({ registration }) => registration.kind === 'number' && registration.defaultValue === undefined,
  );
  const explicitNumbers = new Set(
    declarations.flatMap(({ registration }) =>
      registration.kind === 'number' && registration.defaultValue !== undefined
        ? [registration.defaultValue as number]
        : [],
    ),
  );
  const parsed = readBlueprintParameterBindings(
    session,
    choicesValue === undefined ? [] : choicesValue,
  );
  const choices = new Map<BlueprintParameterHandle, number>();
  const selected = new Set<number>();

  parsed.forEach(({ parameter, value, registration }, index) => {
    const path = `$.choices[${index}]`;
    const declaration = byHandle.get(parameter);
    if (declaration === undefined || declaration.registration !== registration) {
      fail(
        'CP1001',
        `${path}.parameter`,
        'choice is not in the authentic declaration list.',
        registration.source,
      );
    }
    if (registration.kind !== 'number') {
      fail(
        'CP1000',
        `${path}.parameter`,
        'automatic defaults are supported only for NUMBER declarations.',
        registration.source,
      );
    }
    if (registration.defaultValue !== undefined) {
      fail(
        'CP1000',
        `${path}.parameter`,
        'explicitly defaulted declarations cannot receive an automatic default.',
        registration.source,
      );
    }
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < INT32_MIN ||
      value > INT32_MAX
    ) {
      fail(
        'CP1000',
        `${path}.value`,
        'automatic defaults must be signed int32 integers.',
        registration.source,
      );
    }
    if (value === 0) {
      fail('CP1000', `${path}.value`, 'automatic defaults must be nonzero.', registration.source);
    }
    if (selected.has(value)) {
      fail('CP1000', `${path}.value`, 'automatic defaults must be distinct.', registration.source);
    }
    if (explicitNumbers.has(value)) {
      fail(
        'CP1000',
        `${path}.value`,
        'automatic default collides with an explicit numeric default.',
        registration.source,
      );
    }
    selected.add(value);
    choices.set(parameter, value);
  });

  for (const { handle, registration } of missingNumbers) {
    if (!choices.has(handle)) {
      fail(
        'CP1000',
        '$.choices',
        'exactly one automatic default is required for every missing NUMBER default.',
        registration.source,
      );
    }
  }
  if (choices.size !== missingNumbers.length) {
    fail(
      'CP1000',
      '$.choices',
      'choices must contain exactly the declarations missing NUMBER defaults.',
    );
  }
  return choices;
}

function validateOverrides(
  session: BlueprintParameterSession,
  declarations: ReadonlyMap<BlueprintParameterHandle, ValidatedDeclaration>,
  overridesValue: unknown,
): readonly BlueprintParameterBinding[] {
  const parsed = readBlueprintParameterBindings(
    session,
    overridesValue === undefined ? [] : overridesValue,
  );
  return Object.freeze(
    parsed.map(({ parameter, value, registration }, index) => {
      const path = `$.overrides[${index}].value`;
      const declaration = declarations.get(parameter);
      if (declaration === undefined || declaration.registration !== registration) {
        fail(
          'CP1001',
          `$.overrides[${index}].parameter`,
          'override is not in the authentic declaration list.',
          registration.source,
        );
      }
      if (value === undefined) {
        fail('CP1000', path, 'override value cannot be undefined.', registration.source);
      }
      const canonicalValue =
        registration.kind === 'number'
          ? assertBlueprintParameterNumberValue(value, path, 'finite', registration.source)
          : canonicalizeBlueprintParameterSignal(value, path, registration.source);
      return Object.freeze({ parameter, value: canonicalValue });
    }),
  );
}

function snapshotDeclaration(
  handle: BlueprintParameterHandle,
  registration: BlueprintParameterRegistration,
  effectiveDefault: number | SignalId,
): SourceResolvedParameterSnapshot {
  const source = registration.source;
  const snapshotDefault =
    registration.kind === 'number'
      ? effectiveDefault
      : canonicalizeBlueprintParameterSignal(
          effectiveDefault,
          `$.declarations.${registration.label}.defaultValue`,
          source,
        );
  return Object.freeze({
    handle,
    kind: registration.kind,
    label: registration.label,
    defaultValue: snapshotDefault,
    ...(registration.source === undefined ? {} : { source: copySource(registration.source)! }),
    ...(registration.metadata === undefined
      ? {}
      : { metadata: copyMetadata(registration.metadata)! }),
  });
}

/**
 * Creates an execution-local context from an authentic ordered declaration list.
 * Allocation and occupancy are caller responsibilities; this function chooses
 * nothing and never edits registered handles, registrations, or templates.
 */
export function createSourceResolvedNumberDefaultContext(
  session: BlueprintParameterSession,
  declarationsValue: readonly CapturedBlueprintParameter[],
  choicesValue: unknown,
): SourceResolvedNumberDefaultContext {
  const declarations = validateDeclarations(session, declarationsValue);
  const chosenDefaults = validateChoices(session, declarations, choicesValue);
  const declarationByHandle = new Map(
    declarations.map((declaration) => [declaration.handle, declaration] as const),
  );
  const declarationsSnapshot = Object.freeze(
    declarations.map(({ handle, registration }) => {
      const effectiveDefault = registration.defaultValue ?? chosenDefaults.get(handle);
      if (effectiveDefault === undefined) {
        fail(
          'CP1002',
          '$.declarations',
          `NUMBER declaration "${registration.label}" has no resolved default.`,
          registration.source,
        );
      }
      return snapshotDeclaration(handle, registration, effectiveDefault);
    }),
  );

  const project = (
    templateSession: BlueprintParameterSession,
    usedParameters: readonly BlueprintParameterHandle[],
    overridesValue: unknown,
  ): readonly BlueprintParameterBinding[] => {
    if (templateSession !== session) {
      fail('CP1001', '$.template', 'template belongs to a different parameter session.');
    }
    if (!Array.isArray(usedParameters)) {
      fail(
        'CP1001',
        '$.template.usedParameters',
        'template inspection did not provide a parameter list.',
      );
    }
    const used: BlueprintParameterHandle[] = [];
    const seenUsed = new Set<BlueprintParameterHandle>();
    usedParameters.forEach((candidate, index) => {
      const discovered = canonicalBlueprintParameterHandle(candidate);
      if (discovered === undefined) {
        fail(
          'CP1001',
          `$.template.usedParameters[${index}]`,
          'template contains a non-authentic parameter handle.',
        );
      }
      const registration = inspectBlueprintParameterHandle(
        discovered,
        `$.template.usedParameters[${index}]`,
      );
      const slot = lookupBlueprintParameterSlot(
        candidate,
        registration.kind,
        session,
        `$.template.usedParameters[${index}]`,
      );
      if (
        slot === undefined ||
        slot.handle !== discovered ||
        declarationByHandle.get(discovered)?.registration !== slot.registration
      ) {
        fail(
          'CP1001',
          `$.template.usedParameters[${index}]`,
          'template parameter is outside the owning declaration list.',
          registration.source,
        );
      }
      if (seenUsed.has(discovered)) {
        fail(
          'CP1001',
          `$.template.usedParameters[${index}]`,
          'template parameter list contains a duplicate handle.',
          registration.source,
        );
      }
      seenUsed.add(discovered);
      used.push(discovered);
    });

    const validatedOverrides = validateOverrides(session, declarationByHandle, overridesValue);
    const overridesByHandle = new Map(
      validatedOverrides.map(({ parameter, value }) => [parameter, value] as const),
    );
    const projected: BlueprintParameterBinding[] = [];
    for (const parameter of used) {
      const declaration = declarationByHandle.get(parameter)!;
      if (overridesByHandle.has(parameter)) {
        projected.push(Object.freeze({ parameter, value: overridesByHandle.get(parameter)! }));
      } else if (
        declaration.registration.kind === 'number' &&
        declaration.registration.defaultValue === undefined
      ) {
        projected.push(Object.freeze({ parameter, value: chosenDefaults.get(parameter)! }));
      }
    }
    return Object.freeze(projected);
  };

  return Object.freeze({
    declarations: declarationsSnapshot,
    bindingsForConstantTemplate(template: ConstantConfigurationTemplate, overrides?: unknown) {
      const inspected = inspectConstantConfigurationTemplate(template, '$.template');
      return project(inspected.session, inspected.usedParameters, overrides);
    },
    bindingsForArithmeticTemplate(template: ArithmeticConfigurationTemplate, overrides?: unknown) {
      const inspected = inspectArithmeticConfigurationTemplate(template, '$.template');
      return project(inspected.session, inspected.usedParameters, overrides);
    },
    bindingsForDeciderTemplate(template: DeciderConfigurationTemplate, overrides?: unknown) {
      const inspected = inspectDeciderConfigurationTemplate(template, '$.template');
      return project(inspected.session, inspected.usedParameters, overrides);
    },
    bindingsForSelectorTemplate(template: SelectorConfigurationTemplate, overrides?: unknown) {
      const inspected = inspectSelectorConfigurationTemplate(template, '$.template');
      return project(inspected.session, inspected.usedParameters, overrides);
    },
  });
}
