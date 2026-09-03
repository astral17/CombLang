#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { transformElaborationModule } from '@comblang/compiler';
import type {
  DirectElaborationPlan,
  DirectPlanCapabilityUse,
  DirectPlanNetworkPair,
  DirectPlanNetworkTransfer,
} from '@comblang/compiler/direct-plan';
import { parseProject, validateDslSemantics } from '@comblang/language';
import {
  applyEntityCircuitSupplement,
  CircuitSupplementError,
  CircuitObservationError,
  parseCircuitObservationsJsonl,
  compareCircuitObservationEnvironment,
  FactorioDumpError,
  loadPrototypeDatabase,
  loadPrototypeDatabaseJson,
  normalizeFactorioDataDump,
  PrototypeValidationError,
  type FactorioDumpMetadata,
  type PrototypeProvider,
} from '@comblang/prototypes';
import {
  ElaborationExecutionError,
  ElaborationOperationLimitError,
  executeElaborationProgram,
  runDirectPlanTests,
  tryElaborateDirectPlan,
} from '@comblang/runtime';
import { offsetToPosition, type Diagnostic } from '@comblang/shared';
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
  factorio-dsl prototypes supplement [--json] <database.json> <circuit.json> <output.json>
  factorio-dsl prototypes observations [--json] <circuit-observations.jsonl>
  factorio-dsl prototypes compare-observations [--json] <database.json> <circuit-observations.jsonl>

Checks circuits, executes browser/Node-neutral JavaScript test files, and processes prototype dumps, circuit supplements, or raw observations.`;

interface LoadedSource {
  readonly path: string;
  readonly text: string;
}

export interface CliCompilationEnvironment {
  readonly prototypes?: PrototypeProvider;
}

function environmentReport(environment: CliCompilationEnvironment) {
  const provider = environment.prototypes;
  return provider === undefined
    ? {}
    : {
        prototypeEnvironment: {
          identity: provider.identity,
          ...provider.environment,
          capabilities: provider.capabilities,
        },
      };
}

function formatDiagnostic(
  diagnostic: Diagnostic,
  files: ReadonlyMap<string, LoadedSource>,
): string {
  if (diagnostic.span === undefined) {
    return `${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`;
  }

  const source = files.get(diagnostic.span.fileId);
  if (source === undefined) {
    return `${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`;
  }

  const position = offsetToPosition(source.text, diagnostic.span.start);
  return `${source.path}:${position.line + 1}:${position.column + 1} - ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`;
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

  const diagnostics: Diagnostic[] = [...project.diagnostics];
  let producerCount = 0;
  const capabilityUses: DirectPlanCapabilityUse[] = [];
  const networkTransfers: DirectPlanNetworkTransfer[] = [];
  const networkPairs: DirectPlanNetworkPair[] = [];
  for (const file of project.files.values()) {
    if (file.diagnostics.some(({ severity }) => severity === 'error')) continue;
    const semanticDiagnostics = validateDslSemantics(file);
    diagnostics.push(...semanticDiagnostics);
    if (semanticDiagnostics.some(({ severity }) => severity === 'error')) continue;
    try {
      const plan = executeElaborationProgram(transformElaborationModule(file), environment);
      diagnostics.push(...(plan.diagnostics ?? []));
      producerCount += plan.producers.length;
      capabilityUses.push(...(plan.capabilityUses ?? []));
      networkTransfers.push(...(plan.networkTransfers ?? []));
      networkPairs.push(...(plan.networkPairs ?? []));
      diagnostics.push(...tryElaborateDirectPlan(plan).diagnostics);
    } catch (error) {
      diagnostics.push(executionFailure(error));
    }
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

function executionFailure(error: unknown): Diagnostic {
  return {
    code:
      error instanceof ElaborationOperationLimitError
        ? 'EX1003'
        : error instanceof ElaborationExecutionError
          ? error.code
          : 'EX1001',
    severity: 'error',
    message: error instanceof Error ? error.message : 'Elaboration execution failed.',
    ...(error instanceof ElaborationExecutionError ? { span: error.span } : {}),
    ...(error instanceof ElaborationExecutionError && error.related !== undefined
      ? { related: error.related }
      : {}),
  };
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
  const diagnostics: Diagnostic[] = [...project.diagnostics];
  let plan: DirectElaborationPlan | undefined;

  if (file !== undefined && !diagnostics.some(({ severity }) => severity === 'error')) {
    const semanticDiagnostics = validateDslSemantics(file);
    diagnostics.push(...semanticDiagnostics);
    if (!semanticDiagnostics.some(({ severity }) => severity === 'error')) {
      try {
        plan = executeElaborationProgram(transformElaborationModule(file), environment);
        diagnostics.push(...(plan.diagnostics ?? []));
        if (!diagnostics.some(({ severity }) => severity === 'error')) {
          diagnostics.push(...tryElaborateDirectPlan(plan).diagnostics);
        }
      } catch (error) {
        diagnostics.push(executionFailure(error));
      }
    }
  }

  const tests =
    plan === undefined || diagnostics.some(({ severity }) => severity === 'error')
      ? undefined
      : runDirectPlanTests(plan, testSource, {
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

async function inspectCircuitObservations(
  fileNames: readonly string[],
  json: boolean,
): Promise<number> {
  if (fileNames.length !== 2) {
    console.error(usage);
    return 2;
  }
  const observations = parseCircuitObservationsJsonl(
    await readFile(resolve(fileNames[1]!), 'utf8'),
  );
  if (json) console.log(JSON.stringify({ mode: 'observations-only', observations }, null, 2));
  else {
    console.log(
      `${observations.length} observation(s); no prototype capability assertions inferred.`,
    );
    for (const sample of observations) {
      const fields = sample.behavior.status === 'present' ? sample.behavior.fields : [];
      console.log(
        `${JSON.stringify(sample.label)} ${sample.entity.key} tick ${sample.tick}: behavior ${sample.behavior.status}; ${fields.filter(({ status }) => status === 'value').length} value(s), ${fields.filter(({ status }) => status === 'absent').length} absent, ${fields.filter(({ status }) => status === 'error' || status === 'unexpected-type').length} read failure(s).`,
      );
    }
  }
  return 0;
}

async function compareObservations(fileNames: readonly string[], json: boolean): Promise<number> {
  if (fileNames.length !== 3) {
    console.error(usage);
    return 2;
  }
  const [baseSource, observations] = await Promise.all([
    readFile(resolve(fileNames[1]!), 'utf8'),
    readFile(resolve(fileNames[2]!), 'utf8'),
  ]);
  const { database } = await loadPrototypeDatabaseJson(baseSource);
  const report = await compareCircuitObservationEnvironment(database, observations);
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Observation environment: ${report.status}. Native behavior is not verified.`);
    for (const sample of report.samples) {
      console.log(
        `line ${sample.line} ${sample.entityKey} ${JSON.stringify(sample.label)}: ${sample.status}`,
      );
      for (const issue of sample.issues)
        console.log(`  ${issue.kind} ${issue.path}: ${issue.message}`);
    }
  }
  return report.status === 'match' ? 0 : 1;
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
      if (files[0] === 'observations') return await inspectCircuitObservations(files, json);
      if (files[0] === 'compare-observations') return await compareObservations(files, json);
      return files[0] === 'supplement'
        ? await supplementPrototypes(files, json)
        : await normalizePrototypes(files);
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
    const selected = prototypes === undefined ? {} : { prototypes };
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
          error instanceof CliInputError || error instanceof PrototypeValidationError
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
          error instanceof CircuitObservationError ||
          error instanceof PrototypeValidationError ||
          error instanceof FactorioDumpError
            ? error.code
            : 'CLI1004',
        severity: 'error',
        message,
        ...(error instanceof CircuitSupplementError ||
        error instanceof CircuitObservationError ||
        error instanceof PrototypeValidationError ||
        error instanceof FactorioDumpError
          ? { path: error.path }
          : {}),
        ...(error instanceof CircuitObservationError ? { line: error.line } : {}),
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
