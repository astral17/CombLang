import { resolve } from 'node:path';

import { DEFAULT_BLUEPRINT_CODEC_LIMITS } from '@comblang/blueprint';
import { classifyBlueprintDocument } from '@comblang/blueprint/classification';
import { parseLosslessJson } from '@comblang/blueprint/document';
import {
  analyzeBlueprintImport,
  type BlueprintImportEntity,
} from '@comblang/blueprint/import-analysis';
import { generateCanonicalBlueprintSource } from '@comblang/compiler/blueprint-import-source-assembly';
import { verifyCanonicalBlueprintSourceRoundTrip } from '@comblang/compiler/blueprint-import-source-verification';
import type { TrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import type { Diagnostic, SourceSpan } from '@comblang/shared';
import { offsetToPosition } from '@comblang/shared';
import { compileSourceProgram } from '@comblang/runtime/source-compilation';

import { BlueprintCliError, readBoundedUtf8File, writeExclusiveText } from './blueprint-command.js';
import type { CliCompilationEnvironment } from './main.js';

export const sourceBlueprintImportUsage = `Usage:
  factorio-dsl blueprint import [--json] [--output <source.factorio.ts>] [--prototypes <database.json>] [--prototype-identity <id>] <document.json>`;

export interface SourceBlueprintImportOptions {
  readonly inputPath: string;
  readonly json: boolean;
  readonly output?: string;
  readonly prototypePath?: string;
  readonly prototypeIdentity?: string;
}

type ProfileSelection = Parameters<typeof generateCanonicalBlueprintSource>[1][number];

interface ImportErrorReport {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

type ImportDiagnostic = object & { readonly message?: unknown };
type SourceImportDiagnosticFormatter = (diagnostic: Diagnostic) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDiagnostic(value: unknown): value is Diagnostic {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.severity === 'string' &&
    typeof value.message === 'string'
  );
}

export function sourceBlueprintImportJsonHint(args: readonly string[]): boolean {
  return args.slice(0, args.includes('--') ? args.indexOf('--') : args.length).includes('--json');
}

function optionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--') || value.trim().length === 0) {
    throw new BlueprintCliError('CLIBP1001', `${option} requires a nonblank value.`);
  }
  if (value.includes('\0')) {
    throw new BlueprintCliError('CLIBP1001', `${option} must not contain NUL.`);
  }
  return value;
}

/** Parses and validates every import argument before provider loading or file access. */
export function parseSourceBlueprintImportOptions(
  args: readonly string[],
): SourceBlueprintImportOptions {
  let json = false;
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--') {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (argument === '--json') {
      if (json) throw new BlueprintCliError('CLIBP1001', 'Duplicate option: --json.');
      json = true;
      continue;
    }
    if (
      argument === '--output' ||
      argument === '--prototypes' ||
      argument === '--prototype-identity'
    ) {
      if (values.has(argument)) {
        throw new BlueprintCliError('CLIBP1001', `Duplicate option: ${argument}.`);
      }
      values.set(argument, optionValue(args, index, argument));
      index += 1;
      continue;
    }
    if (
      argument === '--project' ||
      argument === '--parameters' ||
      argument === '--overrides' ||
      argument === '--input-file'
    ) {
      throw new BlueprintCliError('CLIBP1001', `${argument} is not supported by blueprint import.`);
    }
    if (argument.startsWith('-')) {
      throw new BlueprintCliError('CLIBP1001', `Unknown blueprint import option: ${argument}.`);
    }
    positional.push(argument);
  }

  if (positional.length !== 1 || positional[0]!.trim().length === 0) {
    throw new BlueprintCliError('CLIBP1001', 'import requires exactly one JSON document path.');
  }
  const inputPath = positional[0]!;
  const output = values.get('--output');
  const prototypePath = values.get('--prototypes');
  if (inputPath.includes('\0')) {
    throw new BlueprintCliError('CLIBP1001', 'Input path must not contain NUL.');
  }
  if (output?.includes('\0')) {
    throw new BlueprintCliError('CLIBP1001', '--output must not contain NUL.');
  }
  if (prototypePath?.includes('\0')) {
    throw new BlueprintCliError('CLIBP1001', '--prototypes must not contain NUL.');
  }
  return {
    inputPath,
    json,
    ...(output === undefined ? {} : { output }),
    ...(prototypePath === undefined ? {} : { prototypePath }),
    ...(values.get('--prototype-identity') === undefined
      ? {}
      : { prototypeIdentity: values.get('--prototype-identity')! }),
  };
}

function diagnosticPath(value: unknown): string | undefined {
  return isRecord(value) && typeof value.path === 'string' ? value.path : undefined;
}

function diagnosticMessage(value: unknown): string {
  return isRecord(value) && typeof value.message === 'string'
    ? value.message
    : 'Blueprint import was refused.';
}

function diagnosticCategory(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const category = value['category'];
  return typeof category === 'string' ? category : undefined;
}

function diagnosticSource(value: unknown): unknown {
  return isRecord(value) ? value['source'] : undefined;
}

function errorReport(error: unknown): ImportErrorReport {
  const typed =
    error instanceof Error ? (error as Error & { code?: unknown; path?: unknown }) : null;
  return {
    code: typeof typed?.code === 'string' ? typed.code : 'CLIBP1000',
    message: typed?.message ?? String(error),
    ...(typeof typed?.path === 'string' ? { path: typed.path } : {}),
  };
}

function sourceLocation(
  value: unknown,
  source: { readonly path: string; readonly text: string; readonly fileId: string } | undefined,
): string | undefined {
  if (!isRecord(value) || source === undefined) return undefined;
  const { fileId, start } = value;
  if (
    fileId !== source.fileId ||
    typeof start !== 'number' ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    start > source.text.length
  ) {
    return undefined;
  }
  const position = offsetToPosition(source.text, start);
  return `${source.path}:${position.line + 1}:${position.column + 1}`;
}

function formatImportDiagnostic(
  value: ImportDiagnostic,
  source: { readonly path: string; readonly text: string; readonly fileId: string } | undefined,
  format: SourceImportDiagnosticFormatter | undefined,
): string {
  if (isDiagnostic(value)) return format?.(value) ?? `${value.code}: ${value.message}`;
  const path = diagnosticPath(value);
  const category = diagnosticCategory(value);
  const message = diagnosticMessage(value);
  const head = `${path === undefined ? '' : `${path}: `}${category === undefined ? '' : `${category}: `}${message}`;
  const generated = sourceLocation(diagnosticSource(value), source);
  return generated === undefined ? head : `${head}\nGenerated source ${generated}`;
}

function publishFailure(
  error: ImportErrorReport,
  json: boolean,
  diagnostics: readonly ImportDiagnostic[] = [],
  source?: { readonly path: string; readonly text: string; readonly fileId: string },
  format?: SourceImportDiagnosticFormatter,
): number {
  if (json) {
    console.log(
      JSON.stringify({
        ok: false,
        error,
        ...(diagnostics.length === 0 ? {} : { diagnostics }),
      }),
    );
  } else {
    console.error(
      `${error.code}${error.path === undefined ? '' : ` ${error.path}`}: ${error.message}`,
    );
    for (const diagnostic of diagnostics) {
      console.error(formatImportDiagnostic(diagnostic, source, format));
    }
  }
  return 2;
}

/** Retains native JSON paths and, separately, any related generated-source location. */
function refuseDiagnostics(
  diagnostics: readonly ImportDiagnostic[],
  fallbackMessage: string,
): ImportErrorReport {
  const first =
    diagnostics.find((diagnostic) => isDiagnostic(diagnostic) && diagnostic.severity === 'error') ??
    diagnostics.find(
      (diagnostic) => diagnosticCategory(diagnostic) === 'source-verification-mismatch',
    ) ??
    diagnostics[0];
  if (first === undefined) return { code: 'CLIBP1006', message: fallbackMessage };
  const path = diagnosticPath(first);
  if (isDiagnostic(first) && first.severity === 'error') {
    return {
      code: first.code,
      message: first.message,
      ...(path === undefined ? {} : { path }),
    };
  }
  return {
    code: 'CLIBP1006',
    message: diagnosticMessage(first),
    ...(path === undefined ? {} : { path }),
  };
}

function inventoryDiagnostics(
  analysis: ReturnType<typeof analyzeBlueprintImport>,
): ImportDiagnostic[] {
  return [...analysis.diagnostics, ...analysis.coverage];
}

function inventoryRefusal(analysis: ReturnType<typeof analyzeBlueprintImport>): {
  readonly error: ImportErrorReport;
  readonly diagnostics: readonly ImportDiagnostic[];
} {
  const diagnostics = inventoryDiagnostics(analysis);
  return {
    error: refuseDiagnostics(diagnostics, 'Blueprint inventory is incomplete or unsupported.'),
    diagnostics,
  };
}

interface ProfileSelectionIssue {
  readonly category:
    'unsupported-canonical-family' | 'missing-profile-selection' | 'ambiguous-canonical-profile';
  readonly message: string;
  readonly path: string;
  readonly entityNumber: number;
}

function selectCanonicalProfiles(
  entities: readonly BlueprintImportEntity[],
  context: TrustedEntityReplayContext,
): {
  readonly selections: readonly ProfileSelection[];
  readonly issues: readonly ProfileSelectionIssue[];
} {
  const profilesByPrototypeKey = new Map<string, (typeof context.profiles)[number][]>();
  for (const profile of context.profiles) {
    const key = profile.ref.prototypeKey as string;
    const bucket = profilesByPrototypeKey.get(key);
    if (bucket === undefined) profilesByPrototypeKey.set(key, [profile]);
    else bucket.push(profile);
  }

  const selections: ProfileSelection[] = [];
  const issues: ProfileSelectionIssue[] = [];
  for (const entity of entities) {
    const prototypeKey =
      entity.name === 'constant-combinator' || entity.name === 'arithmetic-combinator'
        ? `entity:${entity.name}`
        : undefined;
    if (prototypeKey === undefined) {
      issues.push({
        category: 'unsupported-canonical-family',
        message: `Blueprint prototype ${entity.name} is outside the Constant/Arithmetic import subset.`,
        path: `${entity.path}.name`,
        entityNumber: entity.entityNumber,
      });
      continue;
    }
    const candidates = profilesByPrototypeKey.get(prototypeKey) ?? [];
    if (candidates.length === 0) {
      issues.push({
        category: 'missing-profile-selection',
        message: `No trusted profile has the exact canonical key ${prototypeKey}.`,
        path: `${entity.path}.name`,
        entityNumber: entity.entityNumber,
      });
      continue;
    }
    if (candidates.length > 1) {
      issues.push({
        category: 'ambiguous-canonical-profile',
        message: `The trusted replay context contains multiple profiles with the exact key ${prototypeKey}.`,
        path: `${entity.path}.name`,
        entityNumber: entity.entityNumber,
      });
      continue;
    }
    selections.push({ entityNumber: entity.entityNumber, profile: candidates[0]!.ref });
  }
  return { selections, issues };
}

/** Imports one native JSON document through the existing source assembly and verifier seams. */
export async function runSourceBlueprintImport(
  options: SourceBlueprintImportOptions,
  environment: CliCompilationEnvironment,
  formatSourceDiagnostic: (
    diagnostic: Diagnostic,
    source: { readonly path: string; readonly text: string; readonly fileId: string },
  ) => string,
): Promise<number> {
  let diagnostics: readonly ImportDiagnostic[] = [];
  let sourceForFormatting:
    { readonly path: string; readonly text: string; readonly fileId: string } | undefined;
  let format: SourceImportDiagnosticFormatter | undefined;
  try {
    const inputPath = resolve(options.inputPath);
    const input = await readBoundedUtf8File(
      inputPath,
      DEFAULT_BLUEPRINT_CODEC_LIMITS.maxDecompressedBytes,
    );
    const document = parseLosslessJson(input);
    const classification = classifyBlueprintDocument(document);
    const analysis = analyzeBlueprintImport(classification);
    if (
      analysis.kind !== 'blueprint' ||
      analysis.entities === undefined ||
      analysis.wires === undefined ||
      analysis.partial ||
      analysis.diagnostics.length > 0 ||
      analysis.coverage.length > 0
    ) {
      const refusal = inventoryRefusal(analysis);
      return publishFailure(refusal.error, options.json, refusal.diagnostics);
    }

    const context = environment.trustedEntityReplayContext;
    if (context === undefined) {
      throw new BlueprintCliError(
        'CLIBP1006',
        'Blueprint import requires a trusted Entity replay context, including for an empty blueprint.',
      );
    }
    const profileSelection = selectCanonicalProfiles(analysis.entities, context);
    if (profileSelection.issues.length > 0) {
      const refusal = refuseDiagnostics(
        profileSelection.issues,
        'Blueprint entities do not have unique trusted canonical profiles.',
      );
      return publishFailure(refusal, options.json, profileSelection.issues);
    }

    const sourcePath = resolve(options.output ?? `${inputPath}.factorio.ts`);
    const assembled = generateCanonicalBlueprintSource(
      analysis,
      profileSelection.selections,
      context,
      { path: sourcePath },
    );
    if (assembled.state === 'blocked') {
      diagnostics = [...assembled.retainedMetadata, ...assembled.diagnostics];
      return publishFailure(
        refuseDiagnostics(assembled.diagnostics, 'Blueprint source assembly was blocked.'),
        options.json,
        diagnostics,
      );
    }

    const compilation = compileSourceProgram(assembled.source, environment);
    sourceForFormatting = {
      ...assembled.source,
      fileId: compilation.fileId,
    };
    format = (diagnostic) => formatSourceDiagnostic(diagnostic, sourceForFormatting!);
    const verification = verifyCanonicalBlueprintSourceRoundTrip(
      assembled,
      {
        source: assembled.source,
        ...(compilation.plan === undefined ? {} : { plan: compilation.plan }),
        ...(compilation.resolvedCircuit === undefined
          ? {}
          : { resolvedCircuit: compilation.resolvedCircuit }),
        diagnostics: compilation.pipelineDiagnostics,
      },
      profileSelection.selections,
      context,
    );
    diagnostics = [...assembled.retainedMetadata, ...verification.diagnostics];
    if (verification.state !== 'verified') {
      return publishFailure(
        refuseDiagnostics(
          verification.diagnostics,
          'Compiled source did not verify against the imported blueprint.',
        ),
        options.json,
        diagnostics,
        sourceForFormatting,
        format,
      );
    }

    const destination =
      options.output === undefined
        ? undefined
        : await writeExclusiveText(sourcePath, assembled.source.text);
    const response = {
      ok: true,
      source: assembled.source,
      correspondence: assembled.correspondence,
      verification: {
        state: 'verified' as const,
        entityCount: verification.entities.length,
        networkCount: verification.networks.length,
      },
      ...(diagnostics.length === 0 ? {} : { diagnostics }),
      ...(destination === undefined ? {} : { output: destination }),
    };
    if (options.json) console.log(JSON.stringify(response, null, 2));
    else {
      for (const diagnostic of diagnostics) {
        console.error(formatImportDiagnostic(diagnostic, sourceForFormatting, format));
      }
      console.log(destination === undefined ? assembled.source.text : `Wrote ${destination}`);
    }
    return 0;
  } catch (error) {
    return publishFailure(
      errorReport(error),
      options.json,
      diagnostics,
      sourceForFormatting,
      format,
    );
  }
}

/** Used by main before provider selection so --json parsing failures remain machine-safe. */
export function reportSourceBlueprintImportFailure(error: unknown, json: boolean): number {
  return publishFailure(errorReport(error), json);
}
