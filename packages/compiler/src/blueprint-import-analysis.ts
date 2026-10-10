import type {
  BlueprintImportAnalysis,
  BlueprintImportDiagnostic,
  BlueprintImportCoverageNotice,
} from '@comblang/blueprint/import-analysis';
import {
  analyzeBlueprintConnectivity,
  type BlueprintConnectivityComponent,
  type BlueprintConnectivityDiagnostic,
} from '@comblang/blueprint/import-connectivity';
import type {
  BlueprintImportEntity,
  BlueprintImportWire,
} from '@comblang/blueprint/import-analysis';

import type { TrustedEntityReplayContext } from './entity-replay-context.js';
import {
  projectBlueprintImportProfileMappings,
  type BlueprintImportProfileMappingDiagnostic,
  type BlueprintImportProfileMappingEntry,
  type BlueprintImportProfileMappingOptions,
} from './blueprint-import-profile-mappings.js';

export interface ProfiledBlueprintImportCoverageDiagnostic {
  readonly category: 'missing-profile-selection' | 'profile-prototype-mismatch';
  readonly message: string;
  readonly path: string;
  readonly entityNumber: number;
  readonly relatedPath?: string;
}

export type ProfiledBlueprintImportDiagnostic =
  | BlueprintImportDiagnostic
  | BlueprintImportCoverageNotice
  | BlueprintConnectivityDiagnostic
  | BlueprintImportProfileMappingDiagnostic
  | ProfiledBlueprintImportCoverageDiagnostic;

export interface ProfiledBlueprintImportResult {
  readonly state: 'complete' | 'blocked';
  readonly analysis: BlueprintImportAnalysis;
  readonly components: readonly BlueprintConnectivityComponent[];
  readonly diagnostics: readonly ProfiledBlueprintImportDiagnostic[];
}

const emptyComponents: readonly BlueprintConnectivityComponent[] = Object.freeze([]);

function result(
  state: 'complete' | 'blocked',
  analysis: BlueprintImportAnalysis,
  components: readonly BlueprintConnectivityComponent[],
  diagnostics: readonly ProfiledBlueprintImportDiagnostic[],
): ProfiledBlueprintImportResult {
  return Object.freeze({
    state,
    analysis,
    components,
    diagnostics: Object.freeze(diagnostics.slice()),
  });
}

function completeInventory(
  analysis: BlueprintImportAnalysis,
): analysis is BlueprintImportAnalysis & {
  readonly kind: 'blueprint';
  readonly entities: readonly BlueprintImportEntity[];
  readonly wires: readonly BlueprintImportWire[];
} {
  return (
    analysis.kind === 'blueprint' &&
    analysis.entities !== undefined &&
    analysis.wires !== undefined &&
    !analysis.partial &&
    analysis.diagnostics.length === 0 &&
    analysis.coverage.length === 0
  );
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Blueprint import profile mapping was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function coverageDiagnostic(
  category: ProfiledBlueprintImportCoverageDiagnostic['category'],
  message: string,
  path: string,
  entityNumber: number,
): ProfiledBlueprintImportCoverageDiagnostic {
  return Object.freeze({ category, message, path, entityNumber });
}

/** Composes complete structural inventory, explicit trusted profiles, and data-only wire components. */
export function analyzeProfiledBlueprintImport(
  analysis: BlueprintImportAnalysis,
  selections: readonly BlueprintImportProfileMappingEntry[],
  context: TrustedEntityReplayContext,
  options?: BlueprintImportProfileMappingOptions,
): ProfiledBlueprintImportResult {
  if (!completeInventory(analysis)) {
    const connectivity = analyzeBlueprintConnectivity(analysis, [], options);
    return result('blocked', analysis, connectivity.components, connectivity.diagnostics);
  }

  const projected = projectBlueprintImportProfileMappings(selections, context, options);
  const signal = options?.signal;
  const selectedByNumber = new Map<
    number,
    { readonly entry: BlueprintImportProfileMappingEntry; readonly index: number }
  >();
  for (let index = 0; index < selections.length; index += 1) {
    checkAborted(signal);
    const selection = selections[index]!;
    selectedByNumber.set(selection.entityNumber, { entry: selection, index });
  }

  const entityNumbers = new Set<number>();
  for (const entity of analysis.entities) {
    checkAborted(signal);
    entityNumbers.add(entity.entityNumber);
  }
  for (const selection of selections) {
    checkAborted(signal);
    if (!entityNumbers.has(selection.entityNumber)) {
      throw new TypeError(
        `Blueprint profile selection references entity_number ${selection.entityNumber} absent from the inventory.`,
      );
    }
  }

  const diagnostics: ProfiledBlueprintImportDiagnostic[] = [...projected.diagnostics];
  for (const entity of analysis.entities) {
    checkAborted(signal);
    const selected = selectedByNumber.get(entity.entityNumber);
    if (selected === undefined) {
      diagnostics.push(
        coverageDiagnostic(
          'missing-profile-selection',
          `No trusted profile was selected for entity ${entity.entityNumber}.`,
          `${entity.path}.name`,
          entity.entityNumber,
        ),
      );
    } else if (selected.entry.profile.prototypeKey !== `entity:${entity.name}`) {
      diagnostics.push(
        Object.freeze({
          ...coverageDiagnostic(
            'profile-prototype-mismatch',
            `The selected trusted profile does not match blueprint prototype ${entity.name}.`,
            `${entity.path}.name`,
            entity.entityNumber,
          ),
          relatedPath: `$.entries[${selected.index}].profile.prototypeKey`,
        }),
      );
    }
  }

  if (projected.state === 'blocked' || diagnostics.length > 0) {
    return result('blocked', analysis, emptyComponents, diagnostics);
  }

  const connectivity = analyzeBlueprintConnectivity(analysis, projected.mappings, options);
  const combinedDiagnostics: ProfiledBlueprintImportDiagnostic[] = [
    ...diagnostics,
    ...connectivity.diagnostics,
  ];
  return result(connectivity.state, analysis, connectivity.components, combinedDiagnostics);
}
