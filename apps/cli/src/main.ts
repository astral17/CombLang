#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { transformElaborationModule } from '@comblang/compiler';
import { parseProject, validateDslSemantics } from '@comblang/language';
import {
  ElaborationExecutionError,
  ElaborationOperationLimitError,
  executeElaborationProgram,
  tryElaborateDirectPlan,
} from '@comblang/runtime';
import { offsetToPosition, type Diagnostic } from '@comblang/shared';

const usage = `factorio-dsl

Usage:
  factorio-dsl check [--json] <file...>

Checks TypeScript syntax, DSL semantics, compile-time elaboration, and the resulting circuit.`;

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
  for (const file of project.files.values()) {
    if (file.diagnostics.some(({ severity }) => severity === 'error')) continue;
    const semanticDiagnostics = validateDslSemantics(file);
    diagnostics.push(...semanticDiagnostics);
    if (semanticDiagnostics.some(({ severity }) => severity === 'error')) continue;
    try {
      const plan = executeElaborationProgram(transformElaborationModule(file));
      diagnostics.push(...(plan.diagnostics ?? []));
      producerCount += plan.producers.length;
      diagnostics.push(...tryElaborateDirectPlan(plan).diagnostics);
    } catch (error) {
      diagnostics.push({
        code: error instanceof ElaborationOperationLimitError ? 'EX1003' : 'EX1001',
        severity: 'error',
        message: error instanceof Error ? error.message : 'Elaboration execution failed.',
        ...(error instanceof ElaborationExecutionError ? { span: error.span } : {}),
      });
    }
  }

  if (json) {
    console.log(JSON.stringify({ diagnostics, producerCount }, null, 2));
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

export async function run(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(usage);
    return 0;
  }
  if (command !== 'check') {
    console.error(`Unknown command: ${command}\n\n${usage}`);
    return 2;
  }

  const json = rest.includes('--json');
  try {
    return await check(
      rest.filter((argument) => argument !== '--json'),
      json,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Unable to check source files: ${message}`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
