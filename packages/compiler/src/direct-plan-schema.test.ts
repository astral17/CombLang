import { describe, expect, it } from 'vitest';

describe('direct plan schema boundary', () => {
  it('has no runtime surface', async () => {
    const schema = await import('./direct-plan-schema.js');

    expect(Object.keys(schema)).toEqual([]);
  });
});
