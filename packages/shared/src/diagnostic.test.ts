import { describe, expect, it } from 'vitest';

import {
  defaultDiagnosticInstanceDetails,
  normalizeDiagnosticPolicy,
  parseDiagnosticPolicy,
  tryParseDiagnosticPolicy,
} from './diagnostic.js';

describe('diagnostic policy', () => {
  it('normalizes the documented defaults', () => {
    expect(parseDiagnosticPolicy()).toEqual({
      levels: { error: true, warning: true, note: true, hint: false },
      rules: {},
      maxInstanceDetails: defaultDiagnosticInstanceDetails,
    });
  });

  it('accepts cloneable overrides and does not retain input objects', () => {
    const input = {
      levels: { warning: false, hint: true },
      rules: {
        'producer.unused-output': { enabled: false, group: true },
        'function.unrestricted-network-parameter': { severity: 'note' },
      },
      maxInstanceDetails: 7,
    };
    const policy = normalizeDiagnosticPolicy(input);

    input.levels.warning = true;
    input.rules['producer.unused-output'].group = false;
    expect(policy).toEqual({
      levels: { error: true, warning: false, note: true, hint: true },
      rules: {
        'producer.unused-output': { enabled: false, group: true },
        'function.unrestricted-network-parameter': { severity: 'note' },
      },
      maxInstanceDetails: 7,
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.levels)).toBe(true);
    expect(Object.isFrozen(policy.rules)).toBe(true);
    expect(Object.isFrozen(policy.rules['producer.unused-output'])).toBe(true);
    expect(structuredClone(policy)).toEqual(policy);
  });

  it.each([
    ['array root', []],
    ['unknown root field', { levels: {}, unexpected: true }],
    ['unknown level field', { levels: { info: true } }],
    ['invalid rule ID', { rules: { 'Producer.Unused': { enabled: false } } }],
    ['invalid severity', { rules: { 'producer.unused-output': { severity: 'info' } } }],
    ['non-boolean level', { levels: { warning: 'yes' } }],
    ['non-boolean rule option', { rules: { 'producer.unused-output': { group: 1 } } }],
    ['negative provenance bound', { maxInstanceDetails: -1 }],
    ['unreasonable provenance bound', { maxInstanceDetails: 101 }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseDiagnosticPolicy(value)).toThrow();
  });

  it('rejects attempts to hide errors', () => {
    expect(() => parseDiagnosticPolicy({ levels: { error: false } })).toThrow(
      /error diagnostics must remain visible/,
    );
    expect(() =>
      parseDiagnosticPolicy({
        rules: { 'producer.unused-output': { enabled: false, severity: 'error' } },
      }),
    ).toThrow(/cannot be disabled/);
  });

  it('rejects accessors, symbols, inherited data and pollution-shaped keys', () => {
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'levels', { get: () => ({ warning: false }) });
    expect(() => parseDiagnosticPolicy(accessor)).toThrow(/accessors/);

    const symbol = Symbol('policy');
    const symbolInput = { levels: {} } as Record<string | symbol, unknown>;
    Object.defineProperty(symbolInput, symbol, { value: true });
    expect(() => parseDiagnosticPolicy(symbolInput)).toThrow(/symbol keys/);

    const inherited = Object.create({ levels: { warning: false } }) as Record<string, unknown>;
    expect(() => parseDiagnosticPolicy(inherited)).toThrow(/plain object/);

    const pollution = JSON.parse(
      '{"rules":{"__proto__":{"enabled":false},"constructor":{"group":true}}}',
    );
    expect(() => parseDiagnosticPolicy(pollution)).toThrow(/rule ID/);
  });

  it('returns a structured error through the non-throwing helper', () => {
    const result = tryParseDiagnosticPolicy({ levels: { error: false } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe('levels.error');
  });
});
