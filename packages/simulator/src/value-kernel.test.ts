import type { DeviceId, NetworkId } from '@comblang/shared';
import { describe, expect, it } from 'vitest';

import { throughDevice, unknownBus } from './bus-value.js';
import { ValueSimulationKernel } from './value-kernel.js';

const input = 'network:input' as NetworkId;
const output = 'network:output' as NetworkId;

describe('ValueSimulationKernel', () => {
  it('propagates Unknown across synchronous boundaries with its dependency path', () => {
    const kernel = new ValueSimulationKernel();
    const deviceId = 'device:copy' as DeviceId;
    kernel.addDevice({
      id: deviceId,
      evaluate: (snapshot) => [
        { networkId: output, value: throughDevice(snapshot.read(input), deviceId) },
      ],
    });
    kernel.setInitialNetwork(
      input,
      unknownBus([{ id: 'object:chest', description: 'unmodeled chest output' }]),
    );

    expect(kernel.step().read(output)).toEqual({
      kind: 'unknown',
      origins: [
        {
          id: 'object:chest',
          description: 'unmodeled chest output',
          path: [deviceId],
        },
      ],
    });
  });

  it('aggregates origins independently of device traversal order', () => {
    const build = (ids: readonly string[]) => {
      const kernel = new ValueSimulationKernel();
      for (const id of ids) {
        kernel.addDevice({
          id: `device:${id}` as DeviceId,
          evaluate: () => [
            {
              networkId: output,
              value: unknownBus([{ id, description: id.toUpperCase() }]),
            },
          ],
        });
      }
      return kernel.step().read(output);
    };

    expect(build(['b', 'a'])).toEqual(build(['a', 'b']));
  });
});
