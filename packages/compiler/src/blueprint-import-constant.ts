import {
  canonicalizeConstantConfiguration,
  constantConfigurationLimits,
  ConstantConfigurationError,
  Signal,
  signalTypes,
  type ConstantConfiguration,
  type ConstantConfigurationFilter,
  type ConstantConfigurationSection,
  type SignalId,
  type SignalType,
} from '@comblang/factorio';
import {
  LosslessJsonArray,
  LosslessJsonNumber,
  LosslessJsonObject,
  type LosslessJsonValue,
} from '@comblang/blueprint/document';

export interface DecodeBlueprintConstantControlBehaviorOptions {
  readonly path?: string;
  readonly signal?: AbortSignal;
}

export interface BlueprintConstantImportDiagnostic {
  readonly category: 'unsupported-constant-configuration';
  readonly message: string;
  readonly path: string;
}

export type BlueprintConstantImportResult =
  | {
      readonly state: 'complete';
      readonly configuration: ConstantConfiguration;
      readonly diagnostics: readonly [];
    }
  | {
      readonly state: 'blocked';
      readonly configuration: undefined;
      readonly diagnostics: readonly [BlueprintConstantImportDiagnostic];
    };

interface ResolvedOptions {
  readonly path: string;
  readonly signal: AbortSignal | undefined;
}

function resolveOptions(
  options: DecodeBlueprintConstantControlBehaviorOptions | undefined,
): ResolvedOptions {
  if (options === undefined) return { path: '$', signal: undefined };
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) {
    throw new TypeError('Blueprint Constant decoder options must be a plain object.');
  }

  let path = '$';
  let signal: AbortSignal | undefined;
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || (key !== 'path' && key !== 'signal')) {
      throw new TypeError(`Unknown blueprint Constant decoder option: ${String(key)}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`Blueprint Constant decoder option ${key} must be a data property.`);
    }
    if (key === 'path') {
      if (descriptor.value !== undefined && typeof descriptor.value !== 'string') {
        throw new TypeError('Blueprint Constant decoder path must be a string.');
      }
      if (typeof descriptor.value === 'string') path = descriptor.value;
    } else if (descriptor.value !== undefined) {
      const candidate: unknown = descriptor.value;
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        typeof (candidate as AbortSignal).aborted !== 'boolean'
      ) {
        throw new TypeError('Blueprint Constant decoder signal must be an AbortSignal.');
      }
      signal = candidate as AbortSignal;
    }
  }
  return { path, signal };
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Blueprint Constant decoding was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function diagnostic(message: string, path: string): BlueprintConstantImportDiagnostic {
  return Object.freeze({ category: 'unsupported-constant-configuration', message, path });
}

function blocked(message: string, path: string): BlueprintConstantImportResult {
  const diagnostics: readonly [BlueprintConstantImportDiagnostic] = Object.freeze([
    diagnostic(message, path),
  ]);
  return Object.freeze({
    state: 'blocked',
    configuration: undefined,
    diagnostics,
  });
}

function complete(configuration: ConstantConfiguration): BlueprintConstantImportResult {
  const diagnostics: readonly [] = Object.freeze([]);
  return Object.freeze({
    state: 'complete',
    configuration,
    diagnostics,
  });
}

function isObjectNode(value: LosslessJsonValue | undefined): value is LosslessJsonObject {
  return (
    value instanceof LosslessJsonObject &&
    Object.getPrototypeOf(value) === LosslessJsonObject.prototype
  );
}

function isArrayNode(value: LosslessJsonValue | undefined): value is LosslessJsonArray {
  return (
    value instanceof LosslessJsonArray &&
    Object.getPrototypeOf(value) === LosslessJsonArray.prototype
  );
}

const identifierKeyPattern = /^[A-Za-z_$][\w$]*(?![\s\S])/;

function pathForKey(path: string, key: string): string {
  return identifierKeyPattern.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function unknownField(
  value: LosslessJsonObject,
  allowed: readonly string[],
  path: string,
  signal: AbortSignal | undefined,
): BlueprintConstantImportDiagnostic | undefined {
  for (const [key] of value.entries) {
    checkAborted(signal);
    if (!allowed.includes(key)) {
      return diagnostic(`Unsupported field ${key}.`, pathForKey(path, key));
    }
  }
  return undefined;
}

function exactSafeInteger(value: LosslessJsonValue | undefined): number | undefined {
  if (!(value instanceof LosslessJsonNumber)) return undefined;
  const number = value.toNumberIfExact();
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}

function expectedIndex(value: LosslessJsonValue | undefined, expected: number): boolean {
  return exactSafeInteger(value) === expected;
}

function finiteDouble(value: LosslessJsonValue | undefined): number | undefined {
  if (!(value instanceof LosslessJsonNumber)) return undefined;
  const number = Number(value.lexeme);
  return Number.isFinite(number) ? number : undefined;
}

function checkNodeBudget(sectionCount: number, filterCount: number, path: string): void {
  // Canonical shape nodes: root + sections array, each section + filters array,
  // and each filter + Signal object. This bounds allocations before conversion.
  const nodes = 2 + sectionCount * 2 + filterCount * 2;
  if (nodes > constantConfigurationLimits.maxNodes) {
    throw new ConstantConfigurationError(
      'FC1002',
      path,
      `configuration exceeds the node limit of ${constantConfigurationLimits.maxNodes}.`,
    );
  }
}

/** Decodes only the current exporter's explicit Constant control_behavior shape. */
export function decodeBlueprintConstantControlBehavior(
  value: LosslessJsonValue | undefined,
  options?: DecodeBlueprintConstantControlBehaviorOptions,
): BlueprintConstantImportResult {
  const resolved = resolveOptions(options);
  checkAborted(resolved.signal);

  if (!isObjectNode(value)) {
    return blocked('Expected a control_behavior object.', resolved.path);
  }
  const rootUnknown = unknownField(value, ['is_on', 'sections'], resolved.path, resolved.signal);
  if (rootUnknown !== undefined) {
    const diagnostics: readonly [BlueprintConstantImportDiagnostic] = Object.freeze([rootUnknown]);
    return Object.freeze({
      state: 'blocked',
      configuration: undefined,
      diagnostics,
    });
  }

  const isOnPath = `${resolved.path}.is_on`;
  const isOnValue = value.get('is_on');
  if (isOnValue === undefined) return blocked('Required is_on field is missing.', isOnPath);
  if (typeof isOnValue !== 'boolean') return blocked('Expected a boolean.', isOnPath);

  const sectionsPath = `${resolved.path}.sections`;
  const sectionsValue = value.get('sections');
  if (!isObjectNode(sectionsValue)) {
    return blocked('Expected a sections wrapper object.', sectionsPath);
  }
  const wrapperUnknown = unknownField(sectionsValue, ['sections'], sectionsPath, resolved.signal);
  if (wrapperUnknown !== undefined) {
    const diagnostics: readonly [BlueprintConstantImportDiagnostic] = Object.freeze([
      wrapperUnknown,
    ]);
    return Object.freeze({
      state: 'blocked',
      configuration: undefined,
      diagnostics,
    });
  }

  const sectionRowsPath = `${sectionsPath}.sections`;
  const sectionRows = sectionsValue.get('sections');
  if (sectionRows === undefined) {
    return blocked('Required sections array is missing.', sectionRowsPath);
  }
  if (!isArrayNode(sectionRows)) {
    return blocked('Expected a sections array.', sectionRowsPath);
  }
  checkNodeBudget(sectionRows.items.length, 0, sectionRowsPath);

  const sections: ConstantConfigurationSection[] = [];
  let totalFilters = 0;
  for (let sectionIndex = 0; sectionIndex < sectionRows.items.length; sectionIndex += 1) {
    checkAborted(resolved.signal);
    const sectionPath = `${sectionRowsPath}[${sectionIndex}]`;
    const sectionValue = sectionRows.items[sectionIndex];
    if (!isObjectNode(sectionValue)) {
      return blocked('Expected a section object.', sectionPath);
    }
    const sectionUnknown = unknownField(
      sectionValue,
      ['index', 'active', 'multiplier', 'group', 'filters'],
      sectionPath,
      resolved.signal,
    );
    if (sectionUnknown !== undefined) {
      const diagnostics: readonly [BlueprintConstantImportDiagnostic] = Object.freeze([
        sectionUnknown,
      ]);
      return Object.freeze({
        state: 'blocked',
        configuration: undefined,
        diagnostics,
      });
    }

    const indexPath = `${sectionPath}.index`;
    const indexValue = sectionValue.get('index');
    if (indexValue === undefined) return blocked('Required section index is missing.', indexPath);
    if (!expectedIndex(indexValue, sectionIndex + 1)) {
      return blocked('Section index must match its contiguous 1-based array position.', indexPath);
    }

    const activePath = `${sectionPath}.active`;
    const activeValue = sectionValue.get('active');
    if (activeValue === undefined) return blocked('Required active field is missing.', activePath);
    if (typeof activeValue !== 'boolean') return blocked('Expected a boolean.', activePath);

    const multiplierPath = `${sectionPath}.multiplier`;
    const multiplierValue = sectionValue.get('multiplier');
    if (multiplierValue === undefined) {
      return blocked('Required multiplier field is missing.', multiplierPath);
    }
    const multiplier = finiteDouble(multiplierValue);
    if (multiplier === undefined) return blocked('Expected a finite double.', multiplierPath);

    const groupValue = sectionValue.get('group');
    if (groupValue !== undefined && typeof groupValue !== 'string') {
      return blocked('Expected a group string.', `${sectionPath}.group`);
    }

    const filtersPath = `${sectionPath}.filters`;
    const filtersValue = sectionValue.get('filters');
    if (filtersValue === undefined)
      return blocked('Required filters array is missing.', filtersPath);
    if (!isArrayNode(filtersValue)) return blocked('Expected a filters array.', filtersPath);
    totalFilters += filtersValue.items.length;
    checkNodeBudget(sectionRows.items.length, totalFilters, filtersPath);

    const filters: ConstantConfigurationFilter[] = [];
    for (let filterIndex = 0; filterIndex < filtersValue.items.length; filterIndex += 1) {
      checkAborted(resolved.signal);
      const filterPath = `${filtersPath}[${filterIndex}]`;
      const filterValue = filtersValue.items[filterIndex];
      if (!isObjectNode(filterValue)) {
        return blocked('Expected a filter object.', filterPath);
      }
      const filterUnknown = unknownField(
        filterValue,
        ['index', 'name', 'type', 'quality', 'comparator', 'count'],
        filterPath,
        resolved.signal,
      );
      if (filterUnknown !== undefined) {
        const diagnostics: readonly [BlueprintConstantImportDiagnostic] = Object.freeze([
          filterUnknown,
        ]);
        return Object.freeze({
          state: 'blocked',
          configuration: undefined,
          diagnostics,
        });
      }

      const filterIndexPath = `${filterPath}.index`;
      const filterIndexValue = filterValue.get('index');
      if (filterIndexValue === undefined) {
        return blocked('Required filter index is missing.', filterIndexPath);
      }
      if (!expectedIndex(filterIndexValue, filterIndex + 1)) {
        return blocked(
          'Filter index must match its contiguous 1-based array position.',
          filterIndexPath,
        );
      }

      const namePath = `${filterPath}.name`;
      const nameValue = filterValue.get('name');
      if (nameValue === undefined) return blocked('Required filter name is missing.', namePath);
      if (typeof nameValue !== 'string' || nameValue.length === 0) {
        return blocked('Expected a non-empty signal name.', namePath);
      }
      if (nameValue.includes('\u0000')) return blocked('Signal name contains NUL.', namePath);

      const typePath = `${filterPath}.type`;
      const typeValue = filterValue.get('type');
      let type: SignalType = 'item';
      if (typeValue !== undefined) {
        if (typeof typeValue !== 'string' || !signalTypes.includes(typeValue as SignalType)) {
          return blocked('Expected a supported Signal type.', typePath);
        }
        type = typeValue as SignalType;
      }

      const qualityPath = `${filterPath}.quality`;
      const qualityValue = filterValue.get('quality');
      if (qualityValue === undefined) {
        return blocked('Required explicit quality is missing.', qualityPath);
      }
      if (typeof qualityValue !== 'string' || qualityValue.length === 0) {
        return blocked('Expected a non-empty signal quality.', qualityPath);
      }
      if (qualityValue.includes('\u0000'))
        return blocked('Signal quality contains NUL.', qualityPath);

      const comparatorPath = `${filterPath}.comparator`;
      const comparatorValue = filterValue.get('comparator');
      if (comparatorValue === undefined) {
        return blocked('Required comparator is missing.', comparatorPath);
      }
      if (comparatorValue !== '=') {
        return blocked('Only the explicit equals comparator is supported.', comparatorPath);
      }

      const countPath = `${filterPath}.count`;
      const countValue = filterValue.get('count');
      if (countValue === undefined) return blocked('Required filter count is missing.', countPath);
      const count = exactSafeInteger(countValue);
      if (count === undefined || count < -2_147_483_648 || count > 2_147_483_647) {
        return blocked('Filter count must be an exact signed int32 value.', countPath);
      }

      let signal: SignalId;
      try {
        signal = Signal(type, nameValue, qualityValue);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return blocked(error.message, namePath);
      }
      filters.push(Object.freeze({ signal, value: count }));
    }

    sections.push(
      Object.freeze({
        active: activeValue,
        ...(groupValue === undefined ? {} : { group: groupValue }),
        multiplier,
        filters: Object.freeze(filters),
      }),
    );
  }

  return complete(
    canonicalizeConstantConfiguration(
      { isOn: isOnValue, sections },
      constantConfigurationLimits,
      resolved.path,
    ),
  );
}
