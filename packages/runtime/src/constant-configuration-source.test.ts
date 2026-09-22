import { describe, expect, test } from 'vitest';
import { signal, type SignalId } from '@comblang/factorio';

import {
  normalizeConstantConfigurationSource,
  ConstantConfigurationSourceError,
} from './constant-configuration-source.js';

const A = signal('virtual', 'signal-A');
const B = signal('virtual', 'signal-B', 'excellent');
const context = {
  isSignal: (value: unknown): value is SignalId => value === A || value === B,
  isSignalValue: (_value: unknown): _value is never => false,
};

describe('exact Constant source configuration', () => {
  test('normalizes ordered nested sources without merging duplicate or zero rows', () => {
    const configuration = normalizeConstantConfigurationSource(
      {
        isOn: false,
        sections: [
          {
            active: false,
            filters: [
              [A, 0],
              [B, 3],
            ],
          },
          { filters: new Map([['virtual/signal-A', -2]]) },
        ],
      },
      context,
    );

    expect(configuration).toEqual({
      isOn: false,
      sections: [
        {
          active: false,
          multiplier: 1,
          filters: [
            { signal: A, value: 0 },
            { signal: B, value: 3 },
          ],
        },
        {
          active: true,
          multiplier: 1,
          filters: [{ signal: A, value: -2 }],
        },
      ],
    });
    expect(configuration.sections[0]!.filters[0]!.signal).not.toBe(A);
    expect(configuration.sections[1]!.filters[0]!.signal).toEqual(A);
  });

  test('applies empty and omitted defaults', () => {
    expect(normalizeConstantConfigurationSource({}, context)).toEqual({
      isOn: true,
      sections: [],
    });
    expect(normalizeConstantConfigurationSource({ sections: [{}] }, context)).toEqual({
      isOn: true,
      sections: [{ active: true, multiplier: 1, filters: [] }],
    });
  });

  test.each([
    ['accessor', Object.defineProperty({}, 'isOn', { get: () => true })],
    [
      'cycle',
      (() => {
        const value: { sections?: unknown } = {};
        value.sections = [value];
        return value;
      })(),
    ],
  ])('reports %s without mutating the caller', (_name, value) => {
    const before = structuredClone(value);
    expect(() => normalizeConstantConfigurationSource(value, context)).toThrow(
      ConstantConfigurationSourceError,
    );
    expect(value).toEqual(before);
  });

  test('retains valid structural fields outside the evaluator subset', () => {
    expect(
      normalizeConstantConfigurationSource(
        { sections: [{ group: 'backup', multiplier: 1.5, filters: [[A, 2]] }] },
        context,
      ),
    ).toEqual({
      isOn: true,
      sections: [
        {
          active: true,
          group: 'backup',
          multiplier: 1.5,
          filters: [{ signal: A, value: 2 }],
        },
      ],
    });
  });
});
