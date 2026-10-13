import { BlueprintDocumentError, DEFAULT_BLUEPRINT_CODEC_LIMITS } from '@comblang/blueprint';
import { classifyBlueprintDocument } from '@comblang/blueprint/classification';
import { parseLosslessJson } from '@comblang/blueprint/document';
import {
  analyzeBlueprintImport,
  type BlueprintImportCoverageNotice,
  type BlueprintImportDiagnostic,
  type BlueprintImportEntity,
} from '@comblang/blueprint/import-analysis';
import { generateCanonicalBlueprintSource } from '@comblang/compiler/blueprint-import-source-assembly';
import type {
  BlueprintSourceRetainedMetadataNotice,
  CompleteCanonicalBlueprintSource,
} from '@comblang/compiler/blueprint-import-source-assembly';
import {
  verifyCanonicalBlueprintSourceRoundTrip,
  type CanonicalBlueprintSourceVerificationDiagnostic,
} from '@comblang/compiler/blueprint-import-source-verification';
import type { TrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import { compileSourceProgram, type SourceCompilationEnvironment } from './source-compilation.js';

type ProfileSelection = Parameters<typeof generateCanonicalBlueprintSource>[1][number];

export interface BlueprintSourceImportPath {
  readonly path: string;
}

/**
 * Host-local formatting context for a blocked verification result. Do not send
 * this field through a Worker or include it in a CLI failure projection.
 */
export interface BlueprintSourceImportDiagnosticContext {
  readonly path: string;
  readonly text: string;
  readonly fileId: string;
}

export interface BlueprintSourceImportProfileIssue {
  readonly category:
    'unsupported-canonical-family' | 'missing-profile-selection' | 'ambiguous-canonical-profile';
  readonly message: string;
  readonly path: string;
  readonly entityNumber: number;
}

export interface BlueprintSourceImportAuthorityIssue {
  readonly category: 'missing-trusted-context';
  readonly message: string;
}

export type BlueprintSourceImportDiagnostic =
  | BlueprintImportDiagnostic
  | BlueprintImportCoverageNotice
  | BlueprintSourceImportProfileIssue
  | BlueprintSourceImportAuthorityIssue
  | BlueprintSourceRetainedMetadataNotice
  | CanonicalBlueprintSourceVerificationDiagnostic;

export interface VerifiedCanonicalBlueprintSourceImport {
  readonly state: 'verified';
  readonly source: CompleteCanonicalBlueprintSource['source'];
  readonly correspondence: CompleteCanonicalBlueprintSource['correspondence'];
  readonly diagnostics: readonly BlueprintSourceImportDiagnostic[];
  /** Host-local formatting context; omit from Worker and CLI response projections. */
  readonly diagnosticContext?: Readonly<BlueprintSourceImportDiagnosticContext>;
  readonly verification: Readonly<{
    state: 'verified';
    entityCount: number;
    networkCount: number;
  }>;
}

export interface BlockedCanonicalBlueprintSourceImport {
  readonly state: 'blocked';
  readonly diagnostics: readonly BlueprintSourceImportDiagnostic[];
  /** Host-only and formatting-only; omit from all public/Worker failure reports. */
  readonly diagnosticContext?: Readonly<BlueprintSourceImportDiagnosticContext>;
}

export type CanonicalBlueprintSourceImportResult =
  VerifiedCanonicalBlueprintSourceImport | BlockedCanonicalBlueprintSourceImport;

interface ProfileSelectionResult {
  readonly selections: readonly ProfileSelection[];
  readonly issues: readonly BlueprintSourceImportProfileIssue[];
}

function blocked(
  diagnostics: readonly BlueprintSourceImportDiagnostic[],
  diagnosticContext?: BlueprintSourceImportDiagnosticContext,
): BlockedCanonicalBlueprintSourceImport {
  return Object.freeze({
    state: 'blocked',
    diagnostics: Object.freeze([...diagnostics]),
    ...(diagnosticContext === undefined
      ? {}
      : { diagnosticContext: Object.freeze({ ...diagnosticContext }) }),
  });
}

function selectCanonicalProfiles(
  entities: readonly BlueprintImportEntity[],
  context: TrustedEntityReplayContext,
): ProfileSelectionResult {
  const profilesByPrototypeKey = new Map<string, (typeof context.profiles)[number][]>();
  for (const profile of context.profiles) {
    const key = profile.ref.prototypeKey as string;
    const bucket = profilesByPrototypeKey.get(key);
    if (bucket === undefined) profilesByPrototypeKey.set(key, [profile]);
    else bucket.push(profile);
  }

  const selections: ProfileSelection[] = [];
  const issues: BlueprintSourceImportProfileIssue[] = [];
  for (const entity of entities) {
    const prototypeKey =
      entity.name === 'constant-combinator' ||
      entity.name === 'arithmetic-combinator' ||
      entity.name === 'decider-combinator' ||
      entity.name === 'selector-combinator'
        ? `entity:${entity.name}`
        : undefined;
    if (prototypeKey === undefined) {
      issues.push(
        Object.freeze({
          category: 'unsupported-canonical-family',
          message: `Blueprint prototype ${entity.name} is outside the Constant/Arithmetic/Decider/Selector import subset.`,
          path: `${entity.path}.name`,
          entityNumber: entity.entityNumber,
        }),
      );
      continue;
    }
    const candidates = profilesByPrototypeKey.get(prototypeKey) ?? [];
    if (candidates.length === 0) {
      issues.push(
        Object.freeze({
          category: 'missing-profile-selection',
          message: `No trusted profile has the exact canonical key ${prototypeKey}.`,
          path: `${entity.path}.name`,
          entityNumber: entity.entityNumber,
        }),
      );
      continue;
    }
    if (candidates.length > 1) {
      issues.push(
        Object.freeze({
          category: 'ambiguous-canonical-profile',
          message: `The trusted replay context contains multiple profiles with the exact key ${prototypeKey}.`,
          path: `${entity.path}.name`,
          entityNumber: entity.entityNumber,
        }),
      );
      continue;
    }
    selections.push({ entityNumber: entity.entityNumber, profile: candidates[0]!.ref });
  }
  return { selections, issues };
}

/**
 * Imports one native JSON string using only the host's already-provisioned
 * compilation environment. This synchronous, browser-compatible operation
 * performs structural verification only; it does not assert native Factorio
 * behavior. It never reads files, resolves providers, or executes user TS.
 */
export function importCanonicalBlueprintSource(
  documentText: string,
  source: BlueprintSourceImportPath,
  environment: SourceCompilationEnvironment,
): CanonicalBlueprintSourceImportResult {
  if (
    typeof source?.path !== 'string' ||
    source.path.trim().length === 0 ||
    source.path.includes('\0')
  ) {
    throw new TypeError('path must be a nonempty string without NUL.');
  }
  if (typeof documentText !== 'string') {
    throw new BlueprintDocumentError('BPD1001', 'JSON input must be a string.', { path: '$' });
  }
  if (
    new TextEncoder().encode(documentText).byteLength >
    DEFAULT_BLUEPRINT_CODEC_LIMITS.maxDecompressedBytes
  ) {
    throw new BlueprintDocumentError('BPD1004', 'JSON input byte limit exceeded.', { path: '$' });
  }

  const document = parseLosslessJson(documentText);
  const classification = classifyBlueprintDocument(document);
  const analysis = analyzeBlueprintImport(classification);
  const inventoryDiagnostics = [...analysis.diagnostics, ...analysis.coverage];
  if (
    analysis.kind !== 'blueprint' ||
    analysis.entities === undefined ||
    analysis.wires === undefined ||
    analysis.partial ||
    analysis.diagnostics.length > 0 ||
    analysis.coverage.length > 0
  ) {
    return blocked(inventoryDiagnostics);
  }

  const context = environment.trustedEntityReplayContext;
  if (context === undefined) {
    return blocked([
      Object.freeze({
        category: 'missing-trusted-context',
        message:
          'Blueprint import requires a trusted Entity replay context, including for an empty blueprint.',
      }),
    ]);
  }

  const profileSelection = selectCanonicalProfiles(analysis.entities, context);
  if (profileSelection.issues.length > 0) return blocked(profileSelection.issues);

  const assembled = generateCanonicalBlueprintSource(
    analysis,
    profileSelection.selections,
    context,
    { path: source.path },
  );
  if (assembled.state === 'blocked') {
    return blocked([...assembled.retainedMetadata, ...assembled.diagnostics]);
  }

  const compilation = compileSourceProgram(assembled.source, environment);
  const diagnosticContext: BlueprintSourceImportDiagnosticContext = {
    ...assembled.source,
    fileId: compilation.fileId,
  };
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
  const diagnostics = [...assembled.retainedMetadata, ...verification.diagnostics];
  if (verification.state !== 'verified') return blocked(diagnostics, diagnosticContext);

  return Object.freeze({
    state: 'verified',
    source: assembled.source,
    correspondence: assembled.correspondence,
    diagnostics: Object.freeze(diagnostics),
    diagnosticContext: Object.freeze({ ...diagnosticContext }),
    verification: Object.freeze({
      state: 'verified',
      entityCount: verification.entities.length,
      networkCount: verification.networks.length,
    }),
  });
}
