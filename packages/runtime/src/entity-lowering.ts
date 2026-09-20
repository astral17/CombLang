import type { EntityPlanRecord, EntityPhysicalRecord } from '@comblang/compiler/entity';
import {
  EntityConfigurationError,
  resolveEntityPhysicalConfiguration,
} from '@comblang/compiler/entity-configuration';
import {
  resolveEntityReplayProfile,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import type { SourceSpan } from '@comblang/shared';
import { RuntimeDiagnosticError, type NetworkHandle } from './elaboration.js';

function fail(message: string, span: SourceSpan): never {
  throw new RuntimeDiagnosticError({ code: 'RT3010', severity: 'error', message, span });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

interface PreparedEntityRecord {
  readonly record: EntityPlanRecord;
  readonly prototypeName: string;
  readonly nativeConnectors: readonly (number | undefined)[];
  readonly physicalConfiguration: EntityPhysicalRecord['configuration'];
}

export interface PreparedEntityRecords {
  readonly records: readonly PreparedEntityRecord[];
}

/** Prepares all trusted Entity/profile/native metadata before runtime allocation. */
export function prepareEntityRecords(
  records: readonly EntityPlanRecord[],
  context: TrustedEntityReplayContext,
): PreparedEntityRecords {
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  const prepared = records.map((record) => {
    const source = record.provenance.source;
    if (ids.has(record.id) || ordinals.has(record.ordinal))
      fail('Duplicate physical Entity identity or ordinal.', source);
    ids.add(record.id);
    ordinals.add(record.ordinal);

    let profile;
    try {
      profile = resolveEntityReplayProfile(record.profile, context);
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Entity profile mismatch.', source);
    }
    const key = profile.ref.prototypeKey;
    if (!/^entity:[^:\s]+$/.test(key))
      fail('Expected canonical entity:<name> prototype key.', source);

    let physicalConfiguration: EntityPhysicalRecord['configuration'];
    if (record.configuration !== undefined) {
      try {
        physicalConfiguration = resolveEntityPhysicalConfiguration(
          record.configuration as import('@comblang/compiler/entity').EntityConfiguration,
          profile,
        );
      } catch (error) {
        if (error instanceof EntityConfigurationError) fail(error.message, source);
        throw error;
      }
    }
    const nativeConnectors = record.connectorBindings.map((binding) => {
      const endpoint = binding.endpoint;
      const connector = profile.connectors.find(({ key }) => key === endpoint.connector);
      const lane = connector?.lanes.find(({ key }) => key === endpoint.lane);
      if (!lane || lane.color !== endpoint.color) {
        fail('Entity endpoint does not match trusted profile.', binding.provenance.source);
      }
      if (binding.network === undefined) return undefined;
      const native = lane.nativeEndpoint;
      if (
        !native ||
        native.endpoint.connector !== endpoint.connector ||
        native.endpoint.lane !== endpoint.lane ||
        native.endpoint.color !== endpoint.color ||
        !Number.isSafeInteger(native.nativeConnector) ||
        native.nativeConnector < 1
      ) {
        fail(
          'Bound Entity lane requires a matching trusted native endpoint with a positive connector ordinal.',
          binding.provenance.source,
        );
      }
      return native.nativeConnector;
    });
    return Object.freeze({
      record,
      prototypeName: key.slice('entity:'.length),
      nativeConnectors: Object.freeze(nativeConnectors),
      physicalConfiguration,
    });
  });
  return Object.freeze({ records: Object.freeze(prepared) });
}

/** Substitutes validated plan names after topology execution and freezes physical records. */
export function lowerPreparedEntityRecords(
  prepared: PreparedEntityRecords,
  networks: ReadonlyMap<string, NetworkHandle>,
): readonly EntityPhysicalRecord[] {
  return Object.freeze(
    prepared.records.map(({ record, prototypeName, nativeConnectors, physicalConfiguration }) => {
      const connectorBindings = record.connectorBindings.map((binding, index) => {
        const { network: name, ...rest } = binding;
        if (name === undefined) return { ...rest };
        const handle = networks.get(name);
        if (!handle) {
          throw new RuntimeDiagnosticError({
            code: 'RT1099',
            severity: 'error',
            message: `Internal Entity Network mapping is missing: ${name}.`,
            span: binding.provenance.source,
          });
        }
        const nativeConnector = nativeConnectors[index];
        if (nativeConnector === undefined) {
          throw new RuntimeDiagnosticError({
            code: 'RT1099',
            severity: 'error',
            message: 'Internal Entity native connector mapping is missing.',
            span: binding.provenance.source,
          });
        }
        return { ...rest, network: handle.id, nativeConnector };
      });
      // Detach nested transport data before freezing so callers retain ownership of their input.
      return freeze(
        structuredClone({
          ...record,
          ...(physicalConfiguration === undefined ? {} : { configuration: physicalConfiguration }),
          prototypeName,
          connectorBindings,
        }),
      ) as EntityPhysicalRecord;
    }),
  );
}

/** Resolves validated plan declarations after topology transfers, preserving physical Entity identity. */
export function lowerEntityRecords(
  records: readonly EntityPlanRecord[],
  context: TrustedEntityReplayContext,
  resolveNetwork: (name: string) => NetworkHandle | undefined,
): readonly EntityPhysicalRecord[] {
  const prepared = prepareEntityRecords(records, context);
  const networks = new Map<string, NetworkHandle>();
  for (const { record } of prepared.records) {
    for (const binding of record.connectorBindings) {
      if (binding.network === undefined || networks.has(binding.network)) continue;
      const handle = resolveNetwork(binding.network);
      if (!handle)
        fail(`Unknown Entity Network declaration: ${binding.network}.`, binding.provenance.source);
      networks.set(binding.network, handle);
    }
  }
  return lowerPreparedEntityRecords(prepared, networks);
}
