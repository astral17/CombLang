#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type {
  DirectPlanCapabilityUse,
  DirectPlanNetworkPair,
  DirectPlanNetworkTransfer,
} from '@comblang/compiler/direct-plan-schema';
import {
  EntityReplayContextError,
  entityReplayContextIdentity,
  entityReplayContextTransport,
  type EntityReplayContextTransport,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import { parseProject } from '@comblang/language';
import {
  applyEntityCircuitSupplement,
  CircuitSupplementError,
  FactorioDumpError,
  generatePrototypeAsset,
  loadPrototypeAsset,
  loadPrototypeEvidence,
  loadPrototypeDatabase,
  loadPrototypeDatabaseJson,
  normalizeFactorioDataDump,
  PrototypeAssetError,
  PrototypeEvidenceError,
  PrototypeInputError,
  PrototypeValidationError,
  prototypeCircuitFactFields,
  type FactorioDumpMetadata,
  type PrototypeProvider,
} from '@comblang/prototypes';
import { runExecutedDirectPlanTests, type ExecutedDirectPlan } from '@comblang/runtime';
import {
  conservativeEntityProvisioningPolicy,
  EntityProvisioningService,
} from '@comblang/runtime/entity-provisioning';
import { compileParsedSourceProgram } from '@comblang/runtime/source-compilation';
import { offsetToPosition, type Diagnostic, type DiagnosticPolicy } from '@comblang/shared';
import { resolveProjectOptions } from './project-profile.js';

import {
  CliInputError,
  parseCompilationOptions,
  selectPrototypeProvider,
} from './prototype-options.js';

const usage = `factorio-dsl

Usage:
  factorio-dsl check [--json] --project <comblang.json> [file...]
  factorio-dsl test [--json] --project <comblang.json> [source.factorio.ts circuit.test.js]
  factorio-dsl check [--json] [--prototypes <database.json>] [--prototype-identity <id>] <file...>
  factorio-dsl test [--json] [--prototypes <database.json>] [--prototype-identity <id>] <source.factorio.ts> <circuit.test.js>
  factorio-dsl prototypes normalize <data-raw-dump.json> <metadata.json> <output.json>
  factorio-dsl prototypes asset generate [--check] <data-raw-dump.json> <metadata.json> <output.json>
  factorio-dsl prototypes asset verify <database.json> <manifest.json>
  factorio-dsl prototypes supplement [--json] <database.json> <circuit.json> <output.json>
  factorio-dsl prototypes evidence [--json] <database.json> <evidence.json>

Checks circuits, executes browser/Node-neutral JavaScript test files, and processes prototype dumps, circuit supplements, or evidence manifests.`;

interface LoadedSource {
  readonly path: string;
  readonly text: string;
}

export interface CliCompilationEnvironment {
  readonly prototypes?: PrototypeProvider;
  readonly entityReplayContext?: EntityReplayContextTransport;
  readonly trustedEntityReplayContext?: TrustedEntityReplayContext;
  readonly diagnosticPolicy?: DiagnosticPolicy;
}

function provisionCliEnvironment(
  environment: CliCompilationEnvironment,
  prototypes: PrototypeProvider | undefined,
): CliCompilationEnvironment {
  if (prototypes === undefined) return environment;
  if (environment.trustedEntityReplayContext !== undefined) {
    const trustedTransport = entityReplayContextTransport(environment.trustedEntityReplayContext);
    if (
      trustedTransport.database.schemaVersion !== prototypes.schemaVersion ||
      trustedTransport.database.identity !== prototypes.identity ||
      (environment.entityReplayContext !== undefined &&
        entityReplayContextIdentity(environment.entityReplayContext) !==
          entityReplayContextIdentity(trustedTransport))
    ) {
      throw new EntityReplayContextError(
        'ER1001',
        '$.entityReplayContext',
        'host-bound Entity context does not match the selected provider.',
      );
    }
    return { ...environment, prototypes };
  }
  const provisioned = new EntityProvisioningService().provision(
    prototypes,
    conservativeEntityProvisioningPolicy,
  );
  if (
    environment.entityReplayContext !== undefined &&
    entityReplayContextIdentity(environment.entityReplayContext) !==
      entityReplayContextIdentity(provisioned.entityReplayContext)
  ) {
    throw new EntityReplayContextError(
      'ER1001',
      '$.entityReplayContext',
      'selected Entity replay identity does not match the loaded provider.',
    );
  }
  return {
    ...environment,
    prototypes,
    trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
    entityReplayContext: provisioned.entityReplayContext,
  };
}

function environmentReport(environment: CliCompilationEnvironment) {
  const provider = environment.prototypes;
  const entityReplayContext =
    environment.entityReplayContext ??
    (environment.trustedEntityReplayContext === undefined
      ? undefined
      : entityReplayContextTransport(environment.trustedEntityReplayContext));
  return provider === undefined
    ? entityReplayContext === undefined
      ? {}
      : {
          entityReplayContext,
          entityReplayIdentity: entityReplayContextIdentity(entityReplayContext),
        }
    : {
        prototypeEnvironment: {
          identity: provider.identity,
          ...provider.environment,
          capabilities: provider.capabilities,
        },
        ...(entityReplayContext === undefined
          ? {}
          : {
              entityReplayContext,
              entityReplayIdentity: entityReplayContextIdentity(entityReplayContext),
            }),
      };
}

function formatDiagnostic(
  diagnostic: Diagnostic,
  files: ReadonlyMap<string, LoadedSource>,
): string {
  const rule =
    diagnostic.ruleId === undefined
      ? ''
      : ` ${diagnostic.ruleId}${diagnostic.category === undefined ? '' : `/${diagnostic.category}`}`;
  const occurrences =
    diagnostic.occurrences === undefined
      ? ''
      : ` (${diagnostic.occurrences} occurrence${diagnostic.occurrences === 1 ? '' : 's'})`;
  const paths =
    diagnostic.instancePaths ??
    (diagnostic.instancePath === undefined ? [] : [diagnostic.instancePath]);
  const provenance =
    paths.length === 0
      ? ''
      : ` [instances: ${paths.map((path) => JSON.stringify(path)).join(', ')}]`;
  const label = `${diagnostic.severity} ${diagnostic.code}${rule}${occurrences}${provenance}: ${diagnostic.message}`;
  if (diagnostic.span === undefined) {
    return label;
  }

  const source = files.get(diagnostic.span.fileId);
  if (source === undefined) {
    return label;
  }

  const position = offsetToPosition(source.text, diagnostic.span.start);
  return `${source.path}:${position.line + 1}:${position.column + 1} - ${label}`;
}

function projectOnlyDiagnostics(project: ReturnType<typeof parseProject>): readonly Diagnostic[] {
  const fileDiagnostics = new Set(
    [...project.files.values()].flatMap((file) => [...file.diagnostics]),
  );
  return project.diagnostics.filter((diagnostic) => !fileDiagnostics.has(diagnostic));
}

async function check(
  fileNames: readonly string[],
  json: boolean,
  environment: CliCompilationEnvironment,
): Promise<number> {
  if (fileNames.length === 0) {
    console.error(usage);
    return 2;
  }

  const sources = await Promise.all(
    fileNames.map(async (fileName): Promise<LoadedSource> => {
      const absolute = resolve(fileName);
      return {
        path: relative(process.cwd(), absolute).replaceAll('\\', '/'),
        text: await readFile(absolute, 'utf8'),
      };
    }),
  );
  const project = parseProject(sources);
  const byId = new Map(
    [...project.files].map(([id, file]) => [id as string, { path: file.path, text: file.text }]),
  );

  const diagnostics: Diagnostic[] = [...projectOnlyDiagnostics(project)];
  let producerCount = 0;
  const capabilityUses: DirectPlanCapabilityUse[] = [];
  const networkTransfers: DirectPlanNetworkTransfer[] = [];
  const networkPairs: DirectPlanNetworkPair[] = [];
  for (const file of project.files.values()) {
    const compiled = compileParsedSourceProgram(file, environment);
    diagnostics.push(...compiled.pipelineDiagnostics);
    if (compiled.plan === undefined) continue;
    producerCount += compiled.plan.producers.length;
    capabilityUses.push(...(compiled.plan.capabilityUses ?? []));
    networkTransfers.push(...(compiled.plan.networkTransfers ?? []));
    networkPairs.push(...(compiled.plan.networkPairs ?? []));
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          diagnostics,
          producerCount,
          capabilityUses,
          networkTransfers,
          networkPairs,
          ...environmentReport(environment),
        },
        null,
        2,
      ),
    );
  } else if (diagnostics.length === 0) {
    console.log(
      `Checked ${project.files.size} file(s): circuit semantics are valid (${producerCount} producer(s)).`,
    );
  } else {
    for (const diagnostic of diagnostics) {
      const formatted = formatDiagnostic(diagnostic, byId);
      if (diagnostic.severity === 'error') console.error(formatted);
      else console.warn(formatted);
    }
  }

  return diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 1 : 0;
}

async function testCircuit(
  fileNames: readonly string[],
  json: boolean,
  environment: CliCompilationEnvironment,
): Promise<number> {
  if (fileNames.length !== 2) {
    console.error(usage);
    return 2;
  }
  const [sourceName, testName] = fileNames as readonly [string, string];
  const absoluteSource = resolve(sourceName);
  const absoluteTest = resolve(testName);
  const source: LoadedSource = {
    path: relative(process.cwd(), absoluteSource).replaceAll('\\', '/'),
    text: await readFile(absoluteSource, 'utf8'),
  };
  const testSource = await readFile(absoluteTest, 'utf8');
  const project = parseProject([source]);
  const file = [...project.files.values()][0];
  const diagnostics: Diagnostic[] = [...projectOnlyDiagnostics(project)];
  let execution: ExecutedDirectPlan | undefined;

  if (file !== undefined && !diagnostics.some(({ severity }) => severity === 'error')) {
    const compiled = compileParsedSourceProgram(file, environment);
    diagnostics.push(...compiled.pipelineDiagnostics);
    execution = compiled.execution;
  }

  const tests =
    execution === undefined || diagnostics.some(({ severity }) => severity === 'error')
      ? undefined
      : runExecutedDirectPlanTests(execution, testSource, {
          sourceName: relative(process.cwd(), absoluteTest).replaceAll('\\', '/'),
          stackLineOffset: 3,
        });

  if (json) {
    console.log(
      JSON.stringify(
        {
          diagnostics,
          ...(tests === undefined ? {} : { tests }),
          ...environmentReport(environment),
        },
        null,
        2,
      ),
    );
  } else {
    const files = new Map([[file?.id as string, source]]);
    for (const diagnostic of diagnostics) {
      const formatted = formatDiagnostic(diagnostic, files);
      if (diagnostic.severity === 'error') console.error(formatted);
      else console.warn(formatted);
    }
    if (tests !== undefined) {
      for (const result of tests.results) {
        const label = result.status === 'passed' ? 'PASS' : 'FAIL';
        const location = result.line === undefined ? '' : `:${result.line}:${result.column ?? 1}`;
        const code = result.code === undefined ? '' : ` ${result.code}`;
        const message = result.message === undefined ? '' : ` - ${result.message}`;
        const formatted = `${label} ${result.name}${location}${code}${message}`;
        if (result.status === 'passed') console.log(formatted);
        else {
          console.error(formatted);
          for (const candidate of result.candidates ?? [])
            console.error(`  candidate: ${candidate}`);
        }
      }
      console.log(`${tests.passed} passed, ${tests.failed} failed.`);
    }
  }

  if (diagnostics.some(({ severity }) => severity === 'error')) return 1;
  return tests !== undefined && tests.failed > 0 ? 1 : 0;
}

async function normalizePrototypes(fileNames: readonly string[]): Promise<number> {
  if (fileNames.length !== 4 || fileNames[0] !== 'normalize') {
    console.error(usage);
    return 2;
  }
  const [, dumpName, metadataName, outputName] = fileNames as readonly [
    'normalize',
    string,
    string,
    string,
  ];
  const [dumpSource, metadataSource] = await Promise.all([
    readFile(resolve(dumpName), 'utf8'),
    readFile(resolve(metadataName), 'utf8'),
  ]);
  const normalized = normalizeFactorioDataDump(
    JSON.parse(dumpSource) as unknown,
    JSON.parse(metadataSource) as FactorioDumpMetadata,
  );
  await writeFile(resolve(outputName), `${JSON.stringify(normalized.database, null, 2)}\n`, 'utf8');
  console.log(
    `Normalized ${normalized.database.items.length} item(s), ${normalized.database.recipes.length} recipe(s), and ${normalized.database.entities.length} entity prototype(s).`,
  );
  for (const warning of normalized.warnings) {
    console.warn(`${warning.code} ${warning.path}: ${warning.message}`);
  }
  return 0;
}

async function generatePrototypeDatabaseAsset(
  fileNames: readonly string[],
  check: boolean,
  json: boolean,
): Promise<number> {
  if (fileNames.length !== 5 || fileNames[0] !== 'asset' || fileNames[1] !== 'generate') {
    console.error(usage);
    return 2;
  }
  const [, , dumpName, metadataName, outputName] = fileNames as readonly [
    'asset',
    'generate',
    string,
    string,
    string,
  ];
  const manifestName = `${outputName}.manifest.json`;
  const [dumpSource, metadataSource] = await Promise.all([
    readFile(resolve(dumpName), 'utf8'),
    readFile(resolve(metadataName), 'utf8'),
  ]);
  const generated = await generatePrototypeAsset(dumpSource, metadataSource);

  if (check) {
    const [databaseSource, manifestSource] = await Promise.all([
      readFile(resolve(outputName), 'utf8'),
      readFile(resolve(manifestName), 'utf8'),
    ]);
    await loadPrototypeAsset(databaseSource, manifestSource, {
      rawDumpSource: dumpSource,
      metadataSource,
    });
    if (databaseSource !== generated.databaseJson || manifestSource !== generated.manifestJson) {
      throw new PrototypeAssetError(
        'PA1006',
        outputName,
        'generated asset bytes differ from the deterministic output.',
      );
    }
    const report = {
      status: 'reproducible',
      output: outputName,
      manifest: manifestName,
      databaseIdentity: generated.manifest.databaseIdentity,
    } as const;
    if (json) console.log(JSON.stringify(report, null, 2));
    else console.log(`Prototype asset is reproducible: ${outputName}.`);
  } else {
    await Promise.all([
      writeFile(resolve(outputName), generated.databaseJson, 'utf8'),
      writeFile(resolve(manifestName), generated.manifestJson, 'utf8'),
    ]);
    const report = {
      status: 'generated',
      output: outputName,
      manifest: manifestName,
      databaseIdentity: generated.manifest.databaseIdentity,
    } as const;
    if (json) console.log(JSON.stringify(report, null, 2));
    else console.log(`Generated prototype asset: ${outputName} (+ ${manifestName}).`);
  }
  for (const warning of generated.warnings) {
    console.warn(`${warning.code} ${warning.path}: ${warning.message}`);
  }
  return 0;
}

async function verifyPrototypeDatabaseAsset(
  fileNames: readonly string[],
  json: boolean,
): Promise<number> {
  if (fileNames.length !== 4 || fileNames[0] !== 'asset' || fileNames[1] !== 'verify') {
    console.error(usage);
    return 2;
  }
  const [, , databaseName, manifestName] = fileNames as readonly [
    'asset',
    'verify',
    string,
    string,
  ];
  const [databaseSource, manifestSource] = await Promise.all([
    readFile(resolve(databaseName), 'utf8'),
    readFile(resolve(manifestName), 'utf8'),
  ]);
  const loaded = await loadPrototypeAsset(databaseSource, manifestSource);
  const report = {
    status: 'integrity-verified',
    database: databaseName,
    manifest: manifestName,
    databaseIdentity: loaded.manifest.databaseIdentity,
  } as const;
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(`Prototype asset integrity verified: ${databaseName}.`);
  return 0;
}

async function supplementPrototypes(fileNames: readonly string[], json: boolean): Promise<number> {
  if (fileNames.length !== 4) {
    console.error(usage);
    return 2;
  }
  const [, databaseName, supplementName, outputName] = fileNames as readonly [
    string,
    string,
    string,
    string,
  ];
  const [databaseSource, supplementSource] = await Promise.all([
    readFile(resolve(databaseName), 'utf8'),
    readFile(resolve(supplementName), 'utf8'),
  ]);
  const base = await loadPrototypeDatabaseJson(databaseSource);
  let supplement: unknown;
  try {
    supplement = JSON.parse(supplementSource) as unknown;
  } catch {
    throw new CircuitSupplementError('PC1001', '<json>', 'invalid supplement JSON.');
  }
  const database = await applyEntityCircuitSupplement(base.database, supplement);
  const { prototypes } = await loadPrototypeDatabase(database);
  await writeFile(resolve(outputName), `${JSON.stringify(database, null, 2)}\n`, 'utf8');
  const report = {
    baseIdentity: base.prototypes.identity,
    identity: prototypes.identity,
    circuitCoverage: {
      known: database.entities.filter(({ circuit }) => circuit !== undefined).length,
      total: database.entities.length,
      complete: database.capabilities.entityCircuitCapabilities,
    },
  };
  if (json) console.log(JSON.stringify(report, null, 2));
  else
    console.log(
      `Circuit coverage: ${report.circuitCoverage.known}/${report.circuitCoverage.total} entity prototype(s).\nPrototype environment: ${report.identity}`,
    );
  return 0;
}

async function inspectPrototypeEvidence(
  fileNames: readonly string[],
  json: boolean,
): Promise<number> {
  if (fileNames.length !== 3) {
    console.error(usage);
    return 2;
  }
  const [databaseSource, evidenceSource] = await Promise.all([
    readFile(resolve(fileNames[1]!), 'utf8'),
    readFile(resolve(fileNames[2]!), 'utf8'),
  ]);
  const loaded = await loadPrototypeEvidence(
    JSON.parse(databaseSource) as unknown,
    JSON.parse(evidenceSource) as unknown,
  );
  const circuitFacts = { verified: 0, unverified: 0, unknown: 0 };
  for (const entity of loaded.database.entities) {
    for (const field of prototypeCircuitFactFields) {
      circuitFacts[loaded.index.circuit(entity.key, field).status] += 1;
    }
  }
  const report = {
    databaseIdentity: loaded.databaseIdentity,
    evidenceIdentity: loaded.evidenceIdentity,
    structuralSourceCount: loaded.index.structuralSources.length,
    circuitFacts,
  };
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Database identity: ${report.databaseIdentity}`);
    console.log(`Evidence identity: ${report.evidenceIdentity}`);
    console.log(`Structural evidence sources: ${report.structuralSourceCount}.`);
    console.log(
      `Circuit facts: ${report.circuitFacts.verified} verified, ${report.circuitFacts.unverified} unverified, ${report.circuitFacts.unknown} unknown.`,
    );
    console.log('Unverified values are not native-confirmed.');
  }
  return 0;
}

export async function run(
  args: readonly string[],
  environment: CliCompilationEnvironment = {},
): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(usage);
    return 0;
  }
  if (command !== 'check' && command !== 'test' && command !== 'prototypes') {
    console.error(`Unknown command: ${command}\n\n${usage}`);
    return 2;
  }

  let json = rest
    .slice(0, rest.includes('--') ? rest.indexOf('--') : rest.length)
    .includes('--json');
  let prototypePath: string | undefined;
  try {
    if (command === 'prototypes') {
      const files = rest.filter((argument) => argument !== '--json');
      if (files[0] === 'evidence') return await inspectPrototypeEvidence(files, json);
      if (files[0] === 'asset') {
        const checkAsset = files.includes('--check');
        const assetFiles = files.filter((argument) => argument !== '--check');
        if (assetFiles[1] === 'verify') {
          if (checkAsset) {
            console.error(usage);
            return 2;
          }
          return await verifyPrototypeDatabaseAsset(assetFiles, json);
        }
        if (assetFiles[1] === 'generate')
          return await generatePrototypeDatabaseAsset(assetFiles, checkAsset, json);
        console.error(usage);
        return 2;
      }
      if (files[0] === 'supplement') return await supplementPrototypes(files, json);
      if (files[0] === 'normalize') return await normalizePrototypes(files);
      console.error(usage);
      return 2;
    }
    const parsedOptions = parseCompilationOptions(rest);
    json = parsedOptions.json;
    const options = await resolveProjectOptions(parsedOptions, command);
    prototypePath = options.prototypePath;
    if (options.files.length === 0 || (command === 'test' && options.files.length !== 2)) {
      throw new CliInputError(
        'CLI1001',
        command === 'test'
          ? 'test requires one source file and one test file.'
          : 'check requires at least one source file.',
      );
    }
    const prototypes = await selectPrototypeProvider(options, environment.prototypes);
    const selected = provisionCliEnvironment(
      options.diagnosticPolicy === undefined
        ? environment
        : { ...environment, diagnosticPolicy: options.diagnosticPolicy },
      prototypes,
    );
    if (!json && prototypes !== undefined) {
      console.log(
        `Prototype environment: ${prototypes.identity} (Factorio ${prototypes.environment.factorioVersion}).`,
      );
    }
    return command === 'check'
      ? await check(options.files, json, selected)
      : await testCircuit(options.files, json, selected);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const action = command === 'prototypes' ? 'process prototype data' : `${command} source files`;
    if (command !== 'prototypes') {
      const diagnostic = {
        code:
          error instanceof CliInputError ||
          error instanceof PrototypeValidationError ||
          error instanceof EntityReplayContextError
            ? error.code
            : 'CLI1004',
        severity: 'error',
        message,
        ...(error instanceof PrototypeValidationError
          ? { path: error.path, file: prototypePath }
          : {}),
      };
      if (json) console.log(JSON.stringify({ diagnostics: [diagnostic] }, null, 2));
      else
        console.error(
          `Unable to ${action}: ${diagnostic.code}: ${diagnostic.file === undefined ? '' : `${diagnostic.file}: `}${message}`,
        );
    } else {
      const diagnostic = {
        code:
          error instanceof CircuitSupplementError ||
          error instanceof PrototypeAssetError ||
          error instanceof PrototypeEvidenceError ||
          error instanceof PrototypeInputError ||
          error instanceof PrototypeValidationError ||
          error instanceof FactorioDumpError
            ? error.code
            : 'CLI1004',
        severity: 'error',
        message,
        ...(error instanceof CircuitSupplementError ||
        error instanceof PrototypeAssetError ||
        error instanceof PrototypeEvidenceError ||
        error instanceof PrototypeInputError ||
        error instanceof PrototypeValidationError ||
        error instanceof FactorioDumpError
          ? { path: error.path }
          : {}),
      };
      if (json) console.log(JSON.stringify({ diagnostics: [diagnostic] }, null, 2));
      else console.error(`Unable to ${action}: ${diagnostic.code}: ${message}`);
    }
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
