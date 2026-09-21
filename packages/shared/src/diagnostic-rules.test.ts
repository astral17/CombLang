import { describe, expect, it } from 'vitest';

import { diagnosticRuleRegistry } from './diagnostic-rules.js';

describe('diagnostic rule registry', () => {
  it('keeps the current advisory identity separate from display wording', () => {
    expect(diagnosticRuleRegistry).toEqual({
      'producer.unused-output': {
        ruleId: 'producer.unused-output',
        code: 'CL2001',
        category: 'correctness',
        defaultSeverity: 'warning',
        grouping: 'source-site',
      },
      'function.unrestricted-network-parameter': {
        ruleId: 'function.unrestricted-network-parameter',
        code: 'CL2002',
        category: 'ownership',
        defaultSeverity: 'warning',
        grouping: 'none',
      },
    });
    expect(Object.isFrozen(diagnosticRuleRegistry)).toBe(true);
    expect(Object.isFrozen(diagnosticRuleRegistry['producer.unused-output'])).toBe(true);
  });
});
