import { err, ok, type Result } from './result.js';
import type { SourceSpan } from './span.js';

export const diagnosticSeverities = ['error', 'warning', 'note', 'hint'] as const;
export type DiagnosticSeverity = (typeof diagnosticSeverities)[number];

export const diagnosticCategories = [
  'correctness',
  'ownership',
  'timing',
  'native-semantics',
  'semantic-trap',
  'style',
  'performance',
  'prototype-data',
] as const;
export type DiagnosticCategory = (typeof diagnosticCategories)[number];

export interface DiagnosticRelatedInformation {
  readonly message: string;
  readonly span: SourceSpan;
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly span?: SourceSpan;
  readonly related?: readonly DiagnosticRelatedInformation[];
  readonly ruleId?: string;
  readonly category?: DiagnosticCategory;
  readonly instancePath?: readonly string[];
  readonly instancePaths?: readonly (readonly string[])[];
  readonly occurrences?: number;
}

/** A per-rule override in the cloneable project diagnostic policy. */
export interface DiagnosticRuleOverride {
  readonly enabled?: boolean;
  readonly severity?: DiagnosticSeverity;
  readonly group?: boolean;
}

/**
 * The normalized, data-only diagnostic policy passed between project and
 * compiler boundaries. Missing level and rule options use resolver defaults.
 */
export interface DiagnosticPolicy {
  readonly levels: Readonly<Record<DiagnosticSeverity, boolean>>;
  readonly rules: Readonly<Record<string, DiagnosticRuleOverride>>;
  readonly maxInstanceDetails: number;
}

export type DiagnosticPolicyParseResult = Result<DiagnosticPolicy, DiagnosticPolicyError>;

export class DiagnosticPolicyError extends TypeError {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'DiagnosticPolicyError';
  }
}

/** The default number of generated instance paths retained by grouping. */
export const defaultDiagnosticInstanceDetails = 3;
/** Policies may not request unbounded diagnostic provenance. */
export const maxDiagnosticInstanceDetails = 100;

const ruleIdPattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;
const severitySet = new Set<string>(diagnosticSeverities);

const defaultDiagnosticLevels: DiagnosticPolicy['levels'] = Object.freeze({
  error: true,
  warning: true,
  note: true,
  hint: false,
});

export const defaultDiagnosticPolicy: DiagnosticPolicy = Object.freeze({
  levels: defaultDiagnosticLevels,
  rules: Object.freeze({}),
  maxInstanceDetails: defaultDiagnosticInstanceDetails,
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dataObject(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) throw new DiagnosticPolicyError(path, 'expected a plain object.');

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DiagnosticPolicyError(path, 'expected a plain object.');
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new DiagnosticPolicyError(path, 'symbol keys are not allowed.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new DiagnosticPolicyError(`${path}.${key}`, 'accessors are not allowed.');
    }
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new DiagnosticPolicyError(`${path}.${key}`, 'unknown field.');
  }
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new DiagnosticPolicyError(path, 'expected a boolean.');
  return value;
}

function optionalSeverity(value: unknown, path: string): DiagnosticSeverity | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !severitySet.has(value)) {
    throw new DiagnosticPolicyError(path, 'expected error, warning, note, or hint.');
  }
  return value as DiagnosticSeverity;
}

function parseLevels(value: unknown): DiagnosticPolicy['levels'] {
  if (value === undefined) return defaultDiagnosticLevels;
  const input = dataObject(value, 'levels');
  exactKeys(input, diagnosticSeverities, 'levels');
  const levels = {
    error: optionalBoolean(input.error, 'levels.error') ?? defaultDiagnosticLevels.error,
    warning: optionalBoolean(input.warning, 'levels.warning') ?? defaultDiagnosticLevels.warning,
    note: optionalBoolean(input.note, 'levels.note') ?? defaultDiagnosticLevels.note,
    hint: optionalBoolean(input.hint, 'levels.hint') ?? defaultDiagnosticLevels.hint,
  };
  if (!levels.error) {
    throw new DiagnosticPolicyError('levels.error', 'error diagnostics must remain visible.');
  }
  return Object.freeze(levels);
}

function parseRuleOverride(value: unknown, path: string): DiagnosticRuleOverride {
  const input = dataObject(value, path);
  exactKeys(input, ['enabled', 'severity', 'group'], path);
  const enabled = optionalBoolean(input.enabled, `${path}.enabled`);
  const severity = optionalSeverity(input.severity, `${path}.severity`);
  const group = optionalBoolean(input.group, `${path}.group`);
  if (severity === 'error' && enabled === false) {
    throw new DiagnosticPolicyError(
      path,
      'an error diagnostic cannot be disabled by a rule override.',
    );
  }
  return Object.freeze({
    ...(enabled === undefined ? {} : { enabled }),
    ...(severity === undefined ? {} : { severity }),
    ...(group === undefined ? {} : { group }),
  });
}

function parseRules(value: unknown): DiagnosticPolicy['rules'] {
  if (value === undefined) return Object.freeze({});
  const input = dataObject(value, 'rules');
  const entries: Array<readonly [string, DiagnosticRuleOverride]> = [];
  for (const ruleId of Object.keys(input)) {
    if (!ruleIdPattern.test(ruleId)) {
      throw new DiagnosticPolicyError(
        `rules.${ruleId}`,
        'expected a lowercase dotted rule ID such as producer.unused-output.',
      );
    }
    entries.push([ruleId, parseRuleOverride(input[ruleId], `rules.${ruleId}`)]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function parseInstanceDetails(value: unknown): number {
  if (value === undefined) return defaultDiagnosticInstanceDetails;
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > maxDiagnosticInstanceDetails
  ) {
    throw new DiagnosticPolicyError(
      'maxInstanceDetails',
      `expected an integer from 0 through ${maxDiagnosticInstanceDetails}.`,
    );
  }
  return Number(value);
}

function parseDiagnosticPolicyValue(value: unknown): DiagnosticPolicy {
  if (value === undefined) {
    return defaultDiagnosticPolicy;
  }
  const input = dataObject(value, 'diagnostics');
  exactKeys(input, ['levels', 'rules', 'maxInstanceDetails'], 'diagnostics');
  return Object.freeze({
    levels: parseLevels(input.levels),
    rules: parseRules(input.rules),
    maxInstanceDetails: parseInstanceDetails(input.maxInstanceDetails),
  });
}

/** Parses and deep-freezes a data-only diagnostic policy. */
export function parseDiagnosticPolicy(value?: unknown): DiagnosticPolicy {
  try {
    return parseDiagnosticPolicyValue(value);
  } catch (error) {
    if (error instanceof DiagnosticPolicyError) throw error;
    throw new DiagnosticPolicyError('diagnostics', 'could not inspect policy data.');
  }
}

/** Alias used by callers that already have an optional project configuration. */
export function normalizeDiagnosticPolicy(value?: unknown): DiagnosticPolicy {
  return parseDiagnosticPolicy(value);
}

/** Non-throwing boundary helper for transports and worker request validation. */
export function tryParseDiagnosticPolicy(value?: unknown): DiagnosticPolicyParseResult {
  try {
    return ok(parseDiagnosticPolicy(value));
  } catch (error) {
    if (error instanceof DiagnosticPolicyError) return err(error);
    throw error;
  }
}
