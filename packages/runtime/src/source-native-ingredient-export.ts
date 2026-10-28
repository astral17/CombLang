import { signal } from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';

import {
  BlueprintParameterError,
  type BlueprintSignalParameterHandle,
} from '../../compiler/src/blueprint-parameters.js';
import type { ConstantRecipeIngredientResolution } from '../../compiler/src/constant-configuration-template.js';
import type { NativeBlueprintParameter } from '../../compiler/src/native-blueprint-ir.js';

export interface NativeIngredientSignalUse {
  readonly parameter: BlueprintSignalParameterHandle;
  readonly index: number;
  readonly path: string;
  readonly source: SourceSpan;
}

export interface NativeIngredientRootAllocation {
  readonly parameter: BlueprintSignalParameterHandle;
  readonly placeholder: string;
}

export interface NativeIngredientSignalExport {
  readonly parameters: readonly NativeBlueprintParameter[];
  readonly resolutions: readonly ConstantRecipeIngredientResolution[];
  placeholderFor(parameter: BlueprintSignalParameterHandle, index: number): string | undefined;
}

/** Allocates derived ingredient IDs from the same bounded pool as root Signal IDs. */
export function createNativeIngredientSignalExport(
  uses: readonly NativeIngredientSignalUse[],
  roots: readonly NativeIngredientRootAllocation[],
  reservedNames: ReadonlySet<string>,
): NativeIngredientSignalExport {
  const fail = (use: NativeIngredientSignalUse, message: string): never => {
    throw new BlueprintParameterError('CP1002', use.path, message, use.source);
  };
  const maximumByParent = new Map<BlueprintSignalParameterHandle, NativeIngredientSignalUse>();
  for (const use of uses) {
    const previous = maximumByParent.get(use.parameter);
    if (previous === undefined || use.index > previous.index) {
      maximumByParent.set(use.parameter, use);
    }
  }
  const availableNames = Array.from({ length: 10 }, (_, index) => `parameter-${index}`).filter(
    (name) => !reservedNames.has(name),
  );
  const rootByParameter = new Map(roots.map((root) => [root.parameter, root] as const));
  let remainingCapacity = availableNames.length;
  const parentUses = roots.flatMap((root) => {
    const maximum = maximumByParent.get(root.parameter);
    return maximum === undefined ? [] : [{ root, maximum }];
  });
  for (const { maximum } of parentUses) {
    const root = rootByParameter.get(maximum.parameter);
    if (root === undefined || root.placeholder.length === 0) {
      fail(maximum, 'native ingredient export has no allocated parent Signal placeholder.');
    }
    // Check before adding one or iterating: even a safe index can exceed this pool.
    if (maximum.index >= remainingCapacity) {
      fail(
        maximum,
        'native Signal placeholder pool parameter-0 through parameter-9 is exhausted by ingredient metadata rows.',
      );
    }
    remainingCapacity -= maximum.index + 1;
  }

  const namesByParent = new Map<BlueprintSignalParameterHandle, ReadonlyMap<number, string>>();
  const parameters: NativeBlueprintParameter[] = [];
  let nextName = 0;
  for (const { root, maximum } of parentUses) {
    const names = new Map<number, string>();
    for (let index = 0; index <= maximum.index; index += 1) {
      const childPlaceholder = availableNames[nextName++];
      if (childPlaceholder === undefined) {
        return fail(maximum, 'native ingredient placeholder allocation is incomplete.');
      }
      names.set(index, childPlaceholder);
      parameters.push(
        Object.freeze({
          type: 'id',
          id: childPlaceholder,
          'ingredient-of': root.placeholder,
          'quality-condition': Object.freeze({ quality: 'normal', comparator: '=' }),
        }),
      );
    }
    namesByParent.set(root.parameter, names);
  }

  const seenIndices = new Map<BlueprintSignalParameterHandle, Set<number>>();
  const resolutions: ConstantRecipeIngredientResolution[] = [];
  for (const use of uses) {
    let indices = seenIndices.get(use.parameter);
    if (indices === undefined) {
      indices = new Set();
      seenIndices.set(use.parameter, indices);
    }
    if (indices.has(use.index)) continue;
    indices.add(use.index);
    const placeholder = namesByParent.get(use.parameter)?.get(use.index);
    if (placeholder === undefined || !rootByParameter.has(use.parameter)) {
      return fail(use, 'native ingredient Signal allocation is incomplete.');
    }
    resolutions.push(
      Object.freeze({
        parameter: use.parameter,
        index: use.index,
        status: 'present',
        signal: signal('item', placeholder),
      }),
    );
  }

  return Object.freeze({
    parameters: Object.freeze(parameters),
    resolutions: Object.freeze(resolutions),
    placeholderFor(parameter: BlueprintSignalParameterHandle, index: number) {
      return namesByParent.get(parameter)?.get(index);
    },
  });
}
