import type { DiagnosticCategory, DiagnosticSeverity } from './diagnostic.js';

export type DiagnosticRuleGrouping = 'none' | 'source-site';

export interface DiagnosticRuleDefinition {
  readonly ruleId: string;
  readonly code: string;
  readonly category: DiagnosticCategory;
  readonly defaultSeverity: DiagnosticSeverity;
  readonly grouping: DiagnosticRuleGrouping;
}

/** The single source of truth for configurable advisory provenance. */
export const diagnosticRuleRegistry = Object.freeze({
  'producer.unused-output': Object.freeze({
    ruleId: 'producer.unused-output',
    code: 'CL2001',
    category: 'correctness',
    defaultSeverity: 'warning',
    grouping: 'source-site',
  }),
  'function.unrestricted-network-parameter': Object.freeze({
    ruleId: 'function.unrestricted-network-parameter',
    code: 'CL2002',
    category: 'ownership',
    defaultSeverity: 'warning',
    grouping: 'none',
  }),
} as const satisfies Readonly<Record<string, DiagnosticRuleDefinition>>);

export type DiagnosticRuleId = keyof typeof diagnosticRuleRegistry;
