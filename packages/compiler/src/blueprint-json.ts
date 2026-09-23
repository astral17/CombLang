import type { NativeCircuitIr } from './ir.js';
import { emitNativeBlueprintJson } from './native-blueprint-emitter.js';
import { buildNativeBlueprintFcir } from './native-blueprint-projector.js';

export { BlueprintJsonError } from './blueprint-native-config.js';

export interface FactorioBlueprintJson {
  readonly blueprint: {
    readonly item: 'blueprint';
    readonly label: string;
    readonly version: number;
    readonly icons: readonly {
      readonly signal: { readonly type: 'item'; readonly name: 'blueprint' };
      readonly index: 1;
    }[];
    readonly entities: readonly Record<string, unknown>[];
    readonly wires: readonly (readonly [number, number, number, number])[];
  };
}

export interface BlueprintJsonOptions {
  readonly label?: string;
  /** Export-time expansion guard, not a language/DSL operation limit. Default: 1024. */
  readonly maxDeciderConditionRows?: number;
}

/** Generates readable, uncompressed Factorio 2.x blueprint JSON from resolved circuit IR. */
export function generateBlueprintJson(
  ir: NativeCircuitIr,
  options: BlueprintJsonOptions = {},
): FactorioBlueprintJson {
  return emitNativeBlueprintJson(
    buildNativeBlueprintFcir(ir, {
      label: options.label ?? 'CombLang generated circuit',
      maxDeciderConditionRows: options.maxDeciderConditionRows ?? 1024,
    }),
  );
}
