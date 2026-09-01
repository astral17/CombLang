import type { DeviceId, NetworkId } from '@comblang/shared';

import { cloneBusValue, type BusValue } from './bus-value.js';

export interface CircuitObjectConnector<Name extends string = string> {
  readonly name: Name;
  /** Logical Networks whose committed values are aggregated as this connector's input. */
  readonly inputNetworks: readonly NetworkId[];
  /** Logical Networks that receive the connector's one-boundary output contribution. */
  readonly outputNetworks: readonly NetworkId[];
}

/**
 * Maps one future typed-object instance onto the generic circuit test boundary.
 * The adapter describes identity/connectors, not the object's reactive behavior.
 */
export interface CircuitObjectAdapter<Instance, Name extends string = string> {
  readonly id: string;
  instanceId(instance: Instance): string;
  connectors(instance: Instance): readonly CircuitObjectConnector<Name>[];
  /** Per-instance default, resolved once when the object is bound. */
  defaultOutput?(instance: Instance, connector: Name): BusValue | undefined;
  /** Adapter/class default used when the instance has no default for this connector. */
  classDefaultOutput?(connector: Name): BusValue | undefined;
}

export interface BoundCircuitObjectConnector<
  Name extends string = string,
> extends CircuitObjectConnector<Name> {
  readonly instanceDefaultOutput?: BusValue;
  readonly classDefaultOutput?: BusValue;
}

export interface BoundCircuitObject<Name extends string = string> {
  readonly id: DeviceId;
  readonly adapterId: string;
  readonly instanceId: string;
  readonly connectors: readonly BoundCircuitObjectConnector<Name>[];
}

function stableId(value: string, label: string): string {
  if (!/^[0-9A-Z_a-z.-]+$/.test(value)) {
    throw new Error(`${label} must use only ASCII letters, digits, dot, underscore, or hyphen.`);
  }
  return value;
}

function uniqueNetworks(values: readonly NetworkId[], label: string): readonly NetworkId[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new TypeError(`${label} must be an array of Network IDs.`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} cannot contain a repeated Network.`);
  }
  return Object.freeze([...values]);
}

export function bindCircuitObject<Instance, Name extends string>(
  adapter: CircuitObjectAdapter<Instance, Name>,
  instance: Instance,
): BoundCircuitObject<Name> {
  const adapterId = stableId(adapter.id, 'Object adapter ID');
  const instanceId = stableId(adapter.instanceId(instance), 'Object instance ID');
  const descriptors = adapter.connectors(instance);
  if (!Array.isArray(descriptors)) throw new TypeError('Object connectors must be an array.');
  const names = new Set<string>();
  const connectors = descriptors.map((descriptor) => {
    if (typeof descriptor.name !== 'string' || descriptor.name.length === 0) {
      throw new TypeError('Object connector name must be a non-empty string.');
    }
    if (names.has(descriptor.name)) {
      throw new Error(`Duplicate object connector name: ${descriptor.name}.`);
    }
    names.add(descriptor.name);
    const instanceDefaultOutput = adapter.defaultOutput?.(instance, descriptor.name);
    const classDefaultOutput =
      instanceDefaultOutput === undefined
        ? adapter.classDefaultOutput?.(descriptor.name)
        : undefined;
    return Object.freeze({
      name: descriptor.name,
      inputNetworks: uniqueNetworks(
        descriptor.inputNetworks,
        `Input Networks for connector ${descriptor.name}`,
      ),
      outputNetworks: uniqueNetworks(
        descriptor.outputNetworks,
        `Output Networks for connector ${descriptor.name}`,
      ),
      ...(instanceDefaultOutput === undefined
        ? {}
        : { instanceDefaultOutput: cloneBusValue(instanceDefaultOutput) }),
      ...(classDefaultOutput === undefined
        ? {}
        : { classDefaultOutput: cloneBusValue(classDefaultOutput) }),
    });
  });
  return Object.freeze({
    id: `testbench:object:${adapterId}:${instanceId}` as DeviceId,
    adapterId,
    instanceId,
    connectors: Object.freeze(connectors),
  });
}
