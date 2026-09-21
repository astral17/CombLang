import { defaultDiagnosticPolicy, type Diagnostic, type DiagnosticPolicy } from './diagnostic.js';
import { diagnosticRuleRegistry } from './diagnostic-rules.js';

interface GroupAccumulator {
  readonly index: number;
  count: number;
  readonly paths: string[][];
  readonly pathKeys: Set<string>;
}

function sourceSiteKey(diagnostic: Diagnostic): string | undefined {
  const span = diagnostic.span;
  if (span === undefined) return undefined;
  return `${diagnostic.ruleId}\u0000${span.fileId}\u0000${span.start}\u0000${span.end}`;
}

function groupingEnabled(diagnostic: Diagnostic, policy: DiagnosticPolicy): boolean {
  // Promotion to error makes the diagnostic authoritative; errors are never collapsed.
  if (diagnostic.severity === 'error') return false;
  if (diagnostic.ruleId === undefined || !Object.hasOwn(policy.rules, diagnostic.ruleId)) {
    return false;
  }
  const override = policy.rules[diagnostic.ruleId];
  const definition = Object.hasOwn(diagnosticRuleRegistry, diagnostic.ruleId)
    ? diagnosticRuleRegistry[diagnostic.ruleId as keyof typeof diagnosticRuleRegistry]
    : undefined;
  return override?.group === true && definition?.grouping === 'source-site';
}

function diagnosticPaths(diagnostic: Diagnostic): readonly (readonly string[])[] {
  return (
    diagnostic.instancePaths ??
    (diagnostic.instancePath === undefined ? [] : [diagnostic.instancePath])
  );
}

function withRuleOverride(
  diagnostic: Diagnostic,
  policy: DiagnosticPolicy,
): Diagnostic | undefined {
  const override =
    diagnostic.ruleId !== undefined && Object.hasOwn(policy.rules, diagnostic.ruleId)
      ? policy.rules[diagnostic.ruleId]
      : undefined;

  if (diagnostic.severity === 'error') {
    // Errors are authoritative and cannot be hidden or downgraded by policy.
    return diagnostic;
  }
  if (override?.enabled === false) return undefined;

  const severity = override?.severity ?? diagnostic.severity;
  if (!policy.levels[severity]) return undefined;
  return severity === diagnostic.severity ? diagnostic : { ...diagnostic, severity };
}

function addGroupedDiagnostic(
  output: Diagnostic[],
  groups: Map<string, GroupAccumulator>,
  diagnostic: Diagnostic,
  policy: DiagnosticPolicy,
): void {
  if (!groupingEnabled(diagnostic, policy)) {
    output.push(diagnostic);
    return;
  }

  const key = sourceSiteKey(diagnostic);
  if (key === undefined) {
    output.push(diagnostic);
    return;
  }

  const existing = groups.get(key);
  if (existing === undefined) {
    const accumulator: GroupAccumulator = {
      index: output.length,
      count: diagnostic.occurrences ?? 1,
      paths: [],
      pathKeys: new Set(),
    };
    for (const path of diagnosticPaths(diagnostic)) {
      const pathKey = JSON.stringify(path);
      if (
        accumulator.pathKeys.has(pathKey) ||
        accumulator.paths.length >= policy.maxInstanceDetails
      )
        continue;
      accumulator.pathKeys.add(pathKey);
      accumulator.paths.push([...path]);
    }
    groups.set(key, accumulator);
    output.push({
      ...diagnostic,
      occurrences: accumulator.count,
      ...(accumulator.paths.length === 0
        ? {}
        : { instancePaths: Object.freeze(accumulator.paths.map((path) => Object.freeze(path))) }),
    });
    return;
  }

  existing.count += diagnostic.occurrences ?? 1;
  for (const path of diagnosticPaths(diagnostic)) {
    const pathKey = JSON.stringify(path);
    if (existing.pathKeys.has(pathKey) || existing.paths.length >= policy.maxInstanceDetails)
      continue;
    existing.pathKeys.add(pathKey);
    existing.paths.push([...path]);
  }
  const first = output[existing.index];
  if (first === undefined) throw new Error('Diagnostic grouping index was not retained.');
  output[existing.index] = {
    ...first,
    occurrences: existing.count,
    ...(existing.paths.length === 0
      ? {}
      : { instancePaths: Object.freeze(existing.paths.map((path) => Object.freeze(path))) }),
  };
}

/** Resolves visibility, severity overrides and opt-in rule grouping in input order. */
export function resolveDiagnostics(
  diagnostics: readonly Diagnostic[],
  policy: DiagnosticPolicy = defaultDiagnosticPolicy,
): readonly Diagnostic[] {
  const resolvedPolicy = policy;
  const output: Diagnostic[] = [];
  const groups = new Map<string, GroupAccumulator>();
  for (const diagnostic of diagnostics) {
    const resolved = withRuleOverride(diagnostic, resolvedPolicy);
    if (resolved !== undefined) addGroupedDiagnostic(output, groups, resolved, resolvedPolicy);
  }
  return output;
}
