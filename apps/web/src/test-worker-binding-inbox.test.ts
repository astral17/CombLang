import { describe, expect, it } from 'vitest';
import { TestWorkerBindingInbox } from './test-worker-binding-inbox.js';
import type { TestWorkerBindResponse } from './test-worker-protocol.js';

describe('test Worker binding inbox', () => {
  it('preserves missing versus empty metadata and accepts only the matching response once', async () => {
    const inbox = new TestWorkerBindingInbox();
    inbox.begin(8, 41);
    const first = inbox.request();
    expect(first.request).toEqual({
      kind: 'test-bind-request',
      revision: 8,
      sourceRevision: 41,
      requestId: 1,
      hasParameters: false,
    });
    const pair = { plan: {} as never, resolvedCircuit: {} as never };
    const firstResponse: TestWorkerBindResponse = {
      kind: 'test-bind-response',
      revision: 8,
      sourceRevision: 41,
      requestId: 1,
      result: { ok: true, ...pair },
    };
    expect(inbox.receive({ ...firstResponse, revision: 7 })).toBe(false);
    expect(inbox.receive({ ...firstResponse, sourceRevision: 40 })).toBe(false);
    expect(inbox.receive({ ...firstResponse, requestId: 2 })).toBe(false);
    expect(inbox.receive(firstResponse)).toBe(true);
    await expect(first.pair).resolves.toEqual(pair);
    expect(inbox.receive(firstResponse)).toBe(false);

    const second = inbox.request([]);
    expect(second.request).toMatchObject({ hasParameters: true, parameters: [], requestId: 2 });
    expect(inbox.receive(firstResponse)).toBe(false);
    const secondResponse = { ...firstResponse, requestId: 2 };
    expect(inbox.receive(secondResponse)).toBe(true);
    await expect(second.pair).resolves.toEqual(pair);
  });

  it('settles a cancelled wait and ignores the late response', async () => {
    const inbox = new TestWorkerBindingInbox();
    inbox.begin(9, 42);
    const pending = inbox.request([{ id: 0, value: 7 }]);
    inbox.cancel();
    await expect(pending.pair).rejects.toThrow('cancelled');
    expect(
      inbox.receive({
        kind: 'test-bind-response',
        revision: 9,
        sourceRevision: 42,
        requestId: pending.request.requestId,
        result: { ok: true, plan: {} as never, resolvedCircuit: {} as never },
      }),
    ).toBe(false);
  });

  it('passes cloneable diagnostic failures to the runtime caller', async () => {
    const inbox = new TestWorkerBindingInbox();
    inbox.begin(10, 43);
    const pending = inbox.request([]);
    const error = {
      message: '$.parameters[0].value: invalid source value.',
      code: 'CP1002',
      path: '$.parameters[0].value',
      span: { fileId: 'main.factorio.ts' as never, start: 3, end: 9 },
    };
    expect(
      inbox.receive({
        kind: 'test-bind-response',
        revision: 10,
        sourceRevision: 43,
        requestId: pending.request.requestId,
        result: { ok: false, error },
      }),
    ).toBe(true);
    await expect(pending.pair).rejects.toEqual(error);
  });
});
