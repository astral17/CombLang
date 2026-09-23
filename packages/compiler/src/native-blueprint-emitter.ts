import type { FactorioBlueprintJson } from './blueprint-json.js';
import type { NativeBlueprintFcir } from './native-blueprint-ir.js';
import { validateNativeBlueprintFcir } from './native-blueprint-ir.js';

/** Emits only exportable FCIR fields; provenance stays diagnostic-only. */
export function emitNativeBlueprintJson(fcir: NativeBlueprintFcir): FactorioBlueprintJson {
  validateNativeBlueprintFcir(fcir);
  return {
    blueprint: {
      ...fcir.header,
      entities: fcir.entities.map(
        ({ entityNumber, nativeBeforeNumber, native }): Record<string, unknown> => ({
          ...nativeBeforeNumber,
          entity_number: entityNumber,
          ...native,
        }),
      ),
      wires: fcir.wires.map(({ from, to }): [number, number, number, number] => [
        from.entityNumber,
        from.connector,
        to.entityNumber,
        to.connector,
      ]),
    },
  };
}
