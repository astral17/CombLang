import { describe, expect, it } from 'vitest';

import { parseDiagnosticPolicy, type Diagnostic } from './diagnostic.js';
import { resolveDiagnostics } from './diagnostic-resolution.js';
import { sourceFileId } from './ids.js';

const source = { fileId: sourceFileId('main.ts'), start: 2, end: 7 } as const;

function warning(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    code: 'CL2001',
    severity: 'warning',
    message: 'Unused output.',
    span: source,
    ruleId: 'producer.unused-output',
    category: 'correctness',
    ...overrides,
  };
}

describe('diagnostic resolution', () => {
  it('keeps defaults and input order without opt-in grouping', () => {
    const diagnostics = [
      warning({ instancePath: ['loop=1'] }),
      warning({ instancePath: ['loop=2'] }),
    ];
    expect(resolveDiagnostics(diagnostics)).toEqual(diagnostics);
  });

  it('hides configured levels and rules without changing raw diagnostic data', () => {
    const diagnostics: Diagnostic[] = [
      warning(),
      { code: 'N', severity: 'note', message: 'Note.' },
      { code: 'H', severity: 'hint', message: 'Hint.' },
    ];
    const policy = parseDiagnosticPolicy({
      levels: { note: false, hint: true },
      rules: { 'producer.unused-output': { enabled: false } },
    });
    expect(resolveDiagnostics(diagnostics, policy)).toEqual([
      { code: 'H', severity: 'hint', message: 'Hint.' },
    ]);
    expect(diagnostics[0]?.severity).toBe('warning');
  });

  it('promotes and demotes advisory rules while retaining error invariants', () => {
    const diagnostics: Diagnostic[] = [
      warning(),
      { code: 'E', severity: 'error', message: 'Fatal.', ruleId: 'producer.unused-output' },
    ];
    const policy = parseDiagnosticPolicy({
      rules: {
        'producer.unused-output': { severity: 'error' },
      },
    });
    expect(resolveDiagnostics(diagnostics, policy).map(({ severity }) => severity)).toEqual([
      'error',
      'error',
    ]);
  });

  it('never groups advisories after policy promotes them to errors', () => {
    const diagnostics = [
      warning({ instancePath: ['loop=1'] }),
      warning({ instancePath: ['loop=2'] }),
    ];
    const policy = parseDiagnosticPolicy({
      rules: { 'producer.unused-output': { severity: 'error', group: true } },
    });
    expect(resolveDiagnostics(diagnostics, policy)).toEqual([
      { ...diagnostics[0], severity: 'error' },
      { ...diagnostics[1], severity: 'error' },
    ]);
  });

  it('groups only opted-in advisory sites and keeps bounded distinct paths', () => {
    const diagnostics = [
      warning({ instancePath: ['loop=1'] }),
      warning({ message: 'Later wording.', instancePath: ['loop=2'] }),
      warning({ instancePath: ['loop=1'] }),
      warning({ span: { fileId: source.fileId, start: 8, end: 10 }, instancePath: ['other'] }),
    ];
    const policy = parseDiagnosticPolicy({
      rules: { 'producer.unused-output': { group: true } },
      maxInstanceDetails: 2,
    });
    expect(resolveDiagnostics(diagnostics, policy)).toEqual([
      {
        ...diagnostics[0],
        occurrences: 3,
        instancePaths: [['loop=1'], ['loop=2']],
      },
      {
        ...diagnostics[3],
        occurrences: 1,
        instancePaths: [['other']],
      },
    ]);
  });
});
