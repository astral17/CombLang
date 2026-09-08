import type { EntityPhysicalRecord } from '@comblang/compiler/entity';
import type { NetworkId } from '@comblang/shared';
import type { CircuitObjectAdapter, CircuitObjectConnector } from '@comblang/simulator';

interface MutableConnector {
  readonly inputNetworks: NetworkId[];
  readonly outputNetworks: NetworkId[];
}

function appendUnique(values: NetworkId[], network: NetworkId): void {
  if (!values.includes(network)) values.push(network);
}

/** Projects only the bound physical lanes; it creates no simulation device. */
export function projectEntityObjectConnectors(
  record: EntityPhysicalRecord,
): readonly CircuitObjectConnector[] {
  const grouped = new Map<string, MutableConnector>();
  for (const binding of record.connectorBindings) {
    if (binding.network === undefined) continue;
    const connector = grouped.get(binding.endpoint.connector) ?? {
      inputNetworks: [],
      outputNetworks: [],
    };
    grouped.set(binding.endpoint.connector, connector);
    appendUnique(
      binding.direction === 'input' ? connector.inputNetworks : connector.outputNetworks,
      binding.network,
    );
  }
  return Object.freeze(
    [...grouped].map(([name, connector]) =>
      Object.freeze({
        name,
        inputNetworks: Object.freeze([...connector.inputNetworks]),
        outputNetworks: Object.freeze([...connector.outputNetworks]),
      }),
    ),
  );
}

/** Stable adapter identity for one physical Entity in a TestSession. */
export const entityObjectAdapter: CircuitObjectAdapter<EntityPhysicalRecord> = Object.freeze({
  id: 'entity-physical-v3',
  instanceId: (record: EntityPhysicalRecord) => `ordinal-${record.ordinal}`,
  connectors: (record: EntityPhysicalRecord) => projectEntityObjectConnectors(record),
});
