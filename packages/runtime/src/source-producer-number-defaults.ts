import { int32 } from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';

import {
  assertBlueprintParameterNumberValue,
  type BlueprintParameterBinding,
} from '../../compiler/src/blueprint-parameter-validation.js';
import {
  canonicalBlueprintParameterHandle,
  BlueprintParameterError,
  findBlueprintParameterHandle,
  type BlueprintParameterHandle,
  type BlueprintParameterRegistration,
  type BlueprintParameterSession,
} from '../../compiler/src/blueprint-parameters.js';
import {
  evaluateRegisteredBlueprintNumericExpression,
  inspectRegisteredBlueprintNumericExpression,
  isRegisteredBlueprintNumericExpression,
} from '../../compiler/src/blueprint-numeric-expression-bridge.js';
import type { BlueprintNumericExpression } from '../../compiler/src/blueprint-numeric-expression.js';
import type { CapturedBlueprintParameter } from './blueprint-parameter-capture.js';
import type { CombinatorDescriptor } from './elaboration-values.js';
import { collectPreinstallationNumericSlots } from './source-preinstallation-number-slots.js';
import {
  createSourceResolvedNumberDefaultContext,
  inspectSourceResolvedNumberDefaultDeclarations,
  type SourceResolvedNumberDefaultContext,
} from './source-resolved-number-defaults.js';
import { selectAutomaticNumberDefaults } from './source-automatic-number-defaults.js';
import type { PreinstallationNumericSlot } from './source-preinstallation-number-slots.js';

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

function fail(
  code: 'CP1001' | 'CP1002',
  path: string,
  message: string,
  source?: SourceSpan,
): never {
  throw new BlueprintParameterError(code, path, message, source);
}

function locateSlotFailure(slot: PreinstallationNumericSlot, error: unknown): never {
  if (error instanceof BlueprintParameterError) {
    const prefix = `${error.path}: `;
    const message = error.message.startsWith(prefix)
      ? error.message.slice(prefix.length)
      : error.message;
    throw new BlueprintParameterError(error.code, slot.fieldPath, message, slot.source);
  }
  fail(
    'CP1002',
    slot.fieldPath,
    error instanceof Error ? error.message : 'numeric slot could not be resolved.',
    slot.source,
  );
}

function locateProducerFailure(producers: readonly CombinatorDescriptor[], error: unknown): never {
  if (error instanceof BlueprintParameterError) {
    const index = /^\$\.producers\[(\d+)\]/.exec(error.path)?.[1];
    const producer = index === undefined ? undefined : producers[Number(index)];
    const prefix = `${error.path}: `;
    const message = error.message.startsWith(prefix)
      ? error.message.slice(prefix.length)
      : error.message;
    throw new BlueprintParameterError(
      error.code,
      error.path,
      message,
      producer?.source ?? error.span,
    );
  }
  throw error;
}

function isInt32(value: number): boolean {
  return Number.isSafeInteger(value) && value >= INT32_MIN && value <= INT32_MAX;
}

function declarationForRoot(
  root: unknown,
  slot: PreinstallationNumericSlot,
  declarationsByHandle: ReadonlyMap<BlueprintParameterHandle, CapturedBlueprintParameter>,
  registration: BlueprintParameterRegistration,
): CapturedBlueprintParameter {
  const handle = canonicalBlueprintParameterHandle(root);
  const declaration = handle === undefined ? undefined : declarationsByHandle.get(handle);
  if (declaration === undefined || declaration.registration !== registration) {
    fail(
      'CP1001',
      slot.fieldPath,
      'numeric slot dependency is outside the authentic captured declaration list.',
      slot.source,
    );
  }
  return declaration;
}

function finalSlotValue(slot: PreinstallationNumericSlot, value: number): number {
  const path = slot.fieldPath;
  const integer = slot.numericDomain === 'int32';
  const validated = assertBlueprintParameterNumberValue(
    value,
    path,
    integer ? 'safe-integer' : 'finite',
    slot.source,
    integer
      ? 'numeric producer values must be safe integers.'
      : 'numeric producer values must be finite.',
  );
  return integer ? int32(validated) : validated;
}

function resolveExpression(
  slot: PreinstallationNumericSlot,
  expression: BlueprintNumericExpression,
  session: BlueprintParameterSession,
  declarationsByHandle: ReadonlyMap<BlueprintParameterHandle, CapturedBlueprintParameter>,
): number {
  let inspection: ReturnType<typeof inspectRegisteredBlueprintNumericExpression>;
  try {
    inspection = inspectRegisteredBlueprintNumericExpression(session, expression, slot.fieldPath);
  } catch (error) {
    locateSlotFailure(slot, error);
  }

  for (const dependency of inspection.dependencies) {
    let registration: BlueprintParameterRegistration | undefined;
    try {
      registration = findBlueprintParameterHandle(dependency);
    } catch (error) {
      locateSlotFailure(slot, error);
    }
    if (registration === undefined) {
      fail(
        'CP1001',
        slot.fieldPath,
        'numeric expression contains a dependency without an authentic registration.',
        slot.source,
      );
    }
    const declaration = declarationForRoot(dependency, slot, declarationsByHandle, registration);
    if (declaration.registration.kind !== 'number') {
      fail(
        'CP1001',
        slot.fieldPath,
        'numeric expression dependency is not a NUMBER declaration.',
        slot.source,
      );
    }
    if (declaration.registration.defaultValue === undefined) {
      fail(
        'CP1002',
        slot.fieldPath,
        `expression depends on NUMBER declaration "${declaration.registration.label}" without an explicit default.`,
        slot.source,
      );
    }
  }

  let evaluated: number;
  try {
    evaluated = evaluateRegisteredBlueprintNumericExpression(session, expression, []);
  } catch (error) {
    locateSlotFailure(slot, error);
  }
  try {
    return finalSlotValue(slot, evaluated);
  } catch (error) {
    locateSlotFailure(slot, error);
  }
}

function resolveSlotValue(
  slot: PreinstallationNumericSlot,
  session: BlueprintParameterSession,
  declarationsByHandle: ReadonlyMap<BlueprintParameterHandle, CapturedBlueprintParameter>,
): number | undefined {
  if (typeof slot.root === 'number') return finalSlotValue(slot, slot.root);

  const registration = findBlueprintParameterHandle(slot.root);
  if (registration !== undefined) {
    const declaration = declarationForRoot(slot.root, slot, declarationsByHandle, registration);
    if (declaration.registration.kind !== 'number') {
      fail('CP1001', slot.fieldPath, 'numeric slot root is not a NUMBER declaration.', slot.source);
    }
    const defaultValue = declaration.registration.defaultValue;
    if (defaultValue === undefined) return undefined;
    if (typeof defaultValue !== 'number') {
      fail('CP1001', slot.fieldPath, 'NUMBER declaration has a non-numeric default.', slot.source);
    }
    try {
      return finalSlotValue(slot, defaultValue);
    } catch (error) {
      locateSlotFailure(slot, error);
    }
  }

  if (isRegisteredBlueprintNumericExpression(slot.root)) {
    return resolveExpression(slot, slot.root, session, declarationsByHandle);
  }
  fail(
    'CP1002',
    slot.fieldPath,
    'numeric slot root is not an authentic literal, NUMBER handle, or registered expression.',
    slot.source,
  );
}

function reserveExplicitDefaults(
  declarations: readonly CapturedBlueprintParameter[],
  reservations: Set<number>,
): void {
  for (const { registration } of declarations) {
    const defaultValue = registration.defaultValue;
    if (
      registration.kind === 'number' &&
      typeof defaultValue === 'number' &&
      isInt32(defaultValue)
    ) {
      reservations.add(defaultValue);
    }
  }
}

/**
 * Composes producer numeric roots with the existing deterministic allocator and
 * resolved-default binding context. This producer-only slice does not establish
 * coverage of every physical Entity or authorize whole-source collision safety.
 */
export function createProducerNumberDefaultContext(
  session: BlueprintParameterSession,
  declarationsValue: readonly CapturedBlueprintParameter[],
  producers: readonly CombinatorDescriptor[],
): SourceResolvedNumberDefaultContext {
  const declarations = inspectSourceResolvedNumberDefaultDeclarations(session, declarationsValue);
  const declarationsByHandle = new Map(
    declarations.map((declaration) => [declaration.handle, declaration] as const),
  );
  const reservations = new Set<number>();
  reserveExplicitDefaults(declarations, reservations);

  let slots: readonly PreinstallationNumericSlot[];
  try {
    slots = collectPreinstallationNumericSlots(session, producers);
  } catch (error) {
    locateProducerFailure(producers, error);
  }
  for (const slot of slots) {
    const value = resolveSlotValue(slot, session, declarationsByHandle);
    if (value !== undefined && isInt32(value)) reservations.add(value);
  }

  const missingNumbers = declarations.filter(
    ({ registration }) => registration.kind === 'number' && registration.defaultValue === undefined,
  );
  const chosen = selectAutomaticNumberDefaults([...reservations], missingNumbers.length);
  const choices: BlueprintParameterBinding[] = missingNumbers.map(({ handle }, index) =>
    Object.freeze({ parameter: handle, value: chosen[index]! }),
  );
  return createSourceResolvedNumberDefaultContext(session, declarations, choices);
}
