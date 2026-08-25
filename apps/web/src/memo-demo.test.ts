import { describe, expect, test } from 'vitest';

import { runMemoCellDemo } from './memo-demo.js';

describe('MemoCell homepage proof', () => {
  test('is backed by an elaborated circuit and retained simulation state', () => {
    const demo = runMemoCellDemo();

    expect(demo.combinators).toBe(2);
    expect(demo.attachments).toBe(4);
    expect(demo.colors).toEqual([
      { name: 'input', color: 'red' },
      { name: 'out', color: 'red' },
      { name: 'mem', color: 'green' },
    ]);
    expect(demo.waveform.map(({ input, output }) => ({ input, output }))).toEqual([
      { input: 42, output: 0 },
      { input: 0, output: 42 },
      { input: 0, output: 42 },
      { input: 0, output: 42 },
    ]);
  });
});
