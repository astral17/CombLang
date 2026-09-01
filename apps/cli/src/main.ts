#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
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
  ElaborationExecutionError,
  ElaborationOperationLimitError,
  executeElaborationProgram,
  runDirectPlanTests,
  tryElaborateDirectPlan,
} from '@comblang/runtime';
import { offsetToPosition, type Diagnostic } from '@comblang/shared';

const usage = `factorio-dsl

Usage:
  factorio-dsl check [--json] <file...>
  factorio-dsl test [--json] <source.factorio.ts> <circuit.test.js>

Checks circuits or executes browser/Node-neutral JavaScript test files.`;

interface LoadedSource {
  readonly path: string;
  readonly text: string;
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

async function check(fileNames: readonly string[], json: boolean): Promise<number> {
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
      const plan = executeElaborationProgram(transformElaborationModule(file));
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
        { diagnostics, producerCount, capabilityUses, networkTransfers, networkPairs },
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

async function testCircuit(fileNames: readonly string[], json: boolean): Promise<number> {
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
        plan = executeElaborationProgram(transformElaborationModule(file));
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
      JSON.stringify({ diagnostics, ...(tests === undefined ? {} : { tests }) }, null, 2),
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

export async function run(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(usage);
    return 0;
  }
  if (command !== 'check' && command !== 'test') {
    console.error(`Unknown command: ${command}\n\n${usage}`);
    return 2;
  }

  const json = rest.includes('--json');
  try {
    const files = rest.filter((argument) => argument !== '--json');
    return command === 'check' ? await check(files, json) : await testCircuit(files, json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Unable to ${command} source files: ${message}`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
