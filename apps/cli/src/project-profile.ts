import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { CliInputError, type CompilationOptions } from './prototype-options.js';

interface ProjectProfile {
  readonly schemaVersion: 1;
  readonly source: string;
  readonly tests?: string;
  readonly prototypes: { readonly path: string; readonly identity?: string };
}

/** This v1 file is data only: no imports, executable config, or implicit parent search. */
export function parseProjectProfile(text: string, path: string): ProjectProfile {
  const invalid = (message: string): never => {
    throw new CliInputError('CLI1005', `${path}: ${message}`);
  };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid('Invalid project JSON.');
  }
  const object = (
    input: unknown,
    field: string,
    keys: readonly string[],
  ): Record<string, unknown> => {
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      return invalid(`${field} must be an object.`);
    for (const key of Object.keys(input)) {
      if (!keys.includes(key)) invalid(`Unknown project field: ${field}.${key}.`);
    }
    return input as Record<string, unknown>;
  };
  const string = (input: unknown, field: string): string => {
    if (typeof input !== 'string' || input.trim().length === 0 || input.includes('\0'))
      return invalid(`${field} must be a non-empty string without NUL.`);
    return input;
  };
  const root = object(value, 'project', ['schemaVersion', 'source', 'tests', 'prototypes']);
  if (root.schemaVersion !== 1) invalid('Unsupported project schemaVersion; expected 1.');
  const prototypes = object(root.prototypes, 'prototypes', ['path', 'identity']);
  return {
    schemaVersion: 1,
    source: string(root.source, 'source'),
    ...(root.tests === undefined ? {} : { tests: string(root.tests, 'tests') }),
    prototypes: {
      path: string(prototypes.path, 'prototypes.path'),
      ...(prototypes.identity === undefined
        ? {}
        : { identity: string(prototypes.identity, 'prototypes.identity') }),
    },
  };
}

export async function resolveProjectOptions(
  options: CompilationOptions,
  command: 'check' | 'test',
): Promise<CompilationOptions> {
  if (options.projectPath === undefined) return options;
  if (options.prototypePath !== undefined) {
    throw new CliInputError('CLI1001', 'Choose either --project or --prototypes, not both.');
  }
  const projectPath = resolve(options.projectPath);
  let text: string;
  try {
    text = await readFile(projectPath, 'utf8');
  } catch (error) {
    throw new CliInputError(
      'CLI1005',
      `Cannot read project ${projectPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const profile = parseProjectProfile(text, projectPath);
  if (
    profile.prototypes.identity !== undefined &&
    options.prototypeIdentity !== undefined &&
    profile.prototypes.identity !== options.prototypeIdentity
  ) {
    throw new CliInputError(
      'CLI1003',
      'The --prototype-identity option conflicts with the project pin; change the project file explicitly to select another identity.',
    );
  }
  const base = dirname(projectPath);
  let files = options.files;
  if (files.length === 0) {
    if (command === 'test' && profile.tests === undefined) {
      throw new CliInputError(
        'CLI1001',
        `${projectPath}: test requires a configured tests path or explicit source and test filenames.`,
      );
    }
    files = [
      resolve(base, profile.source),
      ...(command === 'test' ? [resolve(base, profile.tests!)] : []),
    ];
  }
  const prototypeIdentity = profile.prototypes.identity ?? options.prototypeIdentity;
  return {
    ...options,
    files,
    prototypePath: resolve(base, profile.prototypes.path),
    ...(prototypeIdentity === undefined ? {} : { prototypeIdentity }),
  };
}
