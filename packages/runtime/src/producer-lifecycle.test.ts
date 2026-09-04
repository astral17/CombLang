import type { DirectPlanProducer } from '@comblang/compiler/direct-plan-schema';
import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import type { ProducerValue } from './elaboration-values.js';
import { ProducerLifecycle } from './producer-lifecycle.js';

const source = { fileId: 'file:lifecycle.ts' as SourceFileId, start: 0, end: 1 };

function producerValue(identity: object, bindingName?: string): ProducerValue {
  const producer: DirectPlanProducer = {
    kind: 'constant',
    ...(bindingName === undefined ? {} : { bindingName }),
    outputs: [],
    destinations: [],
    source,
    instancePath: [],
  };
  return { kind: 'producer', identity, producer };
}

describe('Producer lifecycle', () => {
  test('keeps identity state across wrappers and finalizes only unattached Producers once', () => {
    const lifecycle = new ProducerLifecycle();
    const firstIdentity = {};
    const attached = producerValue(firstIdentity);
    lifecycle.register(attached);
    lifecycle.register(producerValue(firstIdentity, 'attached'));
    lifecycle.markAttached(attached, source, 3);

    const unused = producerValue({});
    lifecycle.register(unused);
    const discarded: { value: ProducerValue; ordinal: number }[] = [];
    lifecycle.finalizeUnused((value, ordinal) => discarded.push({ value, ordinal }));
    lifecycle.finalizeUnused((value, ordinal) => discarded.push({ value, ordinal }));

    expect(discarded).toEqual([{ value: unused, ordinal: 1 }]);
    expect(lifecycle.attachmentSource(attached)).toBe(source);
  });

  test('reports the plan index when a capture happens after attachment', () => {
    const lifecycle = new ProducerLifecycle();
    const value = producerValue({});
    lifecycle.markAttached(value, source, 2);

    expect(lifecycle.capture(value)).toEqual({
      captureId: 'producer:1',
      attachedPlanIndex: 2,
    });
    expect(lifecycle.captureIds(value)).toEqual(['producer:1']);
  });
});
