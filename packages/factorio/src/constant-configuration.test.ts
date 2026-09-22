import { describe, expect, it } from 'vitest';

import {
  canonicalizeConstantConfiguration,
  classifyConstantConfigurationSupport,
  constantConfigurationFromOutputs,
  constantConfigurationToSparseBus,
  ConstantConfigurationError,
  constantConfigurationLimits,
  UnsupportedConstantConfigurationError,
} from './constant-configuration.js';
import { signal } from './signal.js';

const A = signal('virtual', 'signal-A');
const B = signal('virtual', 'signal-B');

describe('Constant configuration semantic core', () => {
  it('applies defaults, normalizes values, preserves order, and freezes the snapshot', () => {
    const configuration = canonicalizeConstantConfiguration({
      isOn: false,
      sections: [
        {
          active: false,
          group: 'first',
          multiplier: 0.5,
          filters: [
            { signal: { type: 'virtual', name: 'signal-A' }, value: 4_294_967_295 },
            { signal: { type: 'virtual', name: 'signal-A', quality: 'normal' }, value: -2 },
          ],
        },
        { filters: [{ signal: B, value: 0 }] },
      ],
    });

    expect(configuration).toEqual({
      isOn: false,
      sections: [
        {
          active: false,
          group: 'first',
          multiplier: 0.5,
          filters: [
            { signal: { type: 'virtual', name: 'signal-A' }, value: -1 },
            { signal: { type: 'virtual', name: 'signal-A', quality: 'normal' }, value: -2 },
          ],
        },
        {
          active: true,
          multiplier: 1,
          filters: [{ signal: B, value: 0 }],
        },
      ],
    });
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.sections)).toBe(true);
    expect(Object.isFrozen(configuration.sections[0])).toBe(true);
    expect(Object.isFrozen(configuration.sections[0]!.filters)).toBe(true);
    expect(Object.isFrozen(configuration.sections[0]!.filters[0]!.signal)).toBe(true);
  });

  it('defaults an omitted device and retains empty sections and group text', () => {
    expect(canonicalizeConstantConfiguration({})).toEqual({ isOn: true, sections: [] });
    expect(canonicalizeConstantConfiguration({ sections: [{}] })).toEqual({
      isOn: true,
      sections: [{ active: true, multiplier: 1, filters: [] }],
    });
    expect(canonicalizeConstantConfiguration({ sections: [{ group: '' }] })).toEqual({
      isOn: true,
      sections: [{ active: true, group: '', multiplier: 1, filters: [] }],
    });
  });

  it('rejects accessors without executing them and reports structural paths', () => {
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, 'isOn', {
      enumerable: true,
      get() {
        throw new Error('getter must not execute');
      },
    });

    expect(() => canonicalizeConstantConfiguration(value)).toThrowError(
      expect.objectContaining<Partial<ConstantConfigurationError>>({
        code: 'FC1001',
        path: '$.isOn',
        message: '$.isOn: accessors are not allowed.',
      }),
    );
  });

  it.each([
    ['unknown field', { nope: true }, '$.nope', 'FC1000'],
    [
      'non-integer filter',
      { sections: [{ filters: [{ signal: A, value: 1.5 }] }] },
      '$.sections[0].filters[0].value',
      'FC1001',
    ],
    [
      'invalid multiplier',
      { sections: [{ multiplier: Number.NaN }] },
      '$.sections[0].multiplier',
      'FC1001',
    ],
  ])('rejects %s at %s', (_name, value, path, code) => {
    expect(() => canonicalizeConstantConfiguration(value)).toThrowError(
      expect.objectContaining({ code, path }),
    );
  });

  it('enforces bounded input limits and rejects cycles', () => {
    const cyclic: { sections?: unknown } = {};
    cyclic.sections = [cyclic];
    expect(() => canonicalizeConstantConfiguration(cyclic)).toThrowError(
      expect.objectContaining({ code: 'FC1002', path: '$.sections[0]' }),
    );

    expect(() =>
      canonicalizeConstantConfiguration(
        { sections: [{ filters: [{ signal: A, value: 1 }] }] },
        { ...constantConfigurationLimits, maxNodes: 1 },
      ),
    ).toThrowError(expect.objectContaining({ code: 'FC1002' }));
  });

  it('accepts exact section/filter node and depth budgets but rejects the next node', () => {
    const configuration = {
      sections: [{ filters: [{ signal: A, value: 1 }] }],
    };

    expect(() =>
      canonicalizeConstantConfiguration(configuration, {
        ...constantConfigurationLimits,
        maxNodes: 6,
      }),
    ).not.toThrow();
    expect(() =>
      canonicalizeConstantConfiguration(configuration, {
        ...constantConfigurationLimits,
        maxNodes: 5,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'FC1002', path: '$.sections[0].filters[0].signal' }),
    );

    expect(() =>
      canonicalizeConstantConfiguration(configuration, {
        ...constantConfigurationLimits,
        maxDepth: 5,
      }),
    ).not.toThrow();
    expect(() =>
      canonicalizeConstantConfiguration(configuration, {
        ...constantConfigurationLimits,
        maxDepth: 4,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'FC1002', path: '$.sections[0].filters[0].signal' }),
    );
  });

  it('accepts the exact serialized byte budget but rejects one byte less', () => {
    const input = { sections: [{ filters: [{ signal: A, value: 1 }] }] };
    const canonical = canonicalizeConstantConfiguration(input);
    const bytes = new TextEncoder().encode(JSON.stringify(canonical)).byteLength;

    expect(() =>
      canonicalizeConstantConfiguration(input, { ...constantConfigurationLimits, maxBytes: bytes }),
    ).not.toThrow();
    expect(() =>
      canonicalizeConstantConfiguration(input, {
        ...constantConfigurationLimits,
        maxBytes: bytes - 1,
      }),
    ).toThrowError(expect.objectContaining({ code: 'FC1002', path: '$' }));
  });

  it('adapts legacy CC outputs without sorting, deduplicating, or retaining caller mutation', () => {
    const outputs: { signal: typeof A; value: number }[] = [
      { signal: A, value: 2_147_483_647 },
      { signal: { type: 'virtual', name: 'signal-A', quality: 'normal' }, value: -2_147_483_648 },
      { signal: B, value: 0 },
    ];
    const configuration = constantConfigurationFromOutputs(outputs);

    outputs[0]!.value = 0;
    outputs[1]!.signal = B;

    expect(configuration).toEqual({
      isOn: true,
      sections: [
        {
          active: true,
          multiplier: 1,
          filters: [
            { signal: A, value: 2_147_483_647 },
            {
              signal: { type: 'virtual', name: 'signal-A', quality: 'normal' },
              value: -2_147_483_648,
            },
            { signal: B, value: 0 },
          ],
        },
      ],
    });
  });

  it('evaluates only the supported subset and aggregates at the final bus boundary', () => {
    const configuration = canonicalizeConstantConfiguration({
      sections: [
        {
          filters: [
            { signal: A, value: 5 },
            { signal: A, value: -2 },
            { signal: B, value: 0 },
          ],
        },
        { active: false, filters: [{ signal: A, value: 100 }] },
      ],
    });

    expect(classifyConstantConfigurationSupport(configuration)).toEqual({ status: 'supported' });
    const values = constantConfigurationToSparseBus(configuration);
    expect(values.get(A)).toBe(3);
    expect(values.get(B)).toBe(0);
  });

  it('reports unsupported multiplier and group semantics instead of silently evaluating them', () => {
    const configuration = canonicalizeConstantConfiguration({
      sections: [{ group: 'g', multiplier: 2, filters: [{ signal: A, value: 5 }] }],
    });

    expect(classifyConstantConfigurationSupport(configuration)).toEqual({
      status: 'unsupported',
      reasons: ['non-unit-multiplier', 'group'],
    });
    expect(() => constantConfigurationToSparseBus(configuration)).toThrowError(
      expect.objectContaining<Partial<UnsupportedConstantConfigurationError>>({
        code: 'FC1003',
        reasons: ['non-unit-multiplier', 'group'],
      }),
    );
  });
});
