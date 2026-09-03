import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadPrototypeDatabaseJson, type PrototypeProvider } from '@comblang/prototypes';

export class CliInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CliInputError';
  }
}

export interface CompilationOptions {
  readonly files: readonly string[];
  readonly json: boolean;
  readonly prototypePath?: string;
  readonly prototypeIdentity?: string;
}

/** Options may precede or follow files; `--` ends option parsing. */
export function parseCompilationOptions(args: readonly string[]): CompilationOptions {
  const files: string[] = [];
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]!;
    if (argument === '--') {
      files.push(...args.slice(i + 1));
      break;
    }
    if (argument === '--json') {
      json = true;
    } else if (argument === '--prototypes' || argument === '--prototype-identity') {
      if (values.has(argument))
        throw new CliInputError('CLI1001', `Duplicate option: ${argument}.`);
      const value = args[++i];
      if (value === undefined || value.length === 0 || value.startsWith('--')) {
        throw new CliInputError('CLI1001', `${argument} requires a value.`);
      }
      values.set(argument, value);
    } else if (argument.startsWith('-')) {
      throw new CliInputError('CLI1001', `Unknown option: ${argument}.`);
    } else {
      files.push(argument);
    }
  }
  const prototypePath = values.get('--prototypes');
  const prototypeIdentity = values.get('--prototype-identity');
  return {
    files,
    json,
    ...(prototypePath === undefined ? {} : { prototypePath }),
    ...(prototypeIdentity === undefined ? {} : { prototypeIdentity }),
  };
}

export async function selectPrototypeProvider(
  options: CompilationOptions,
  injected: PrototypeProvider | undefined,
): Promise<PrototypeProvider | undefined> {
  if (options.prototypePath !== undefined && injected !== undefined) {
    throw new CliInputError(
      'CLI1001',
      'Choose either --prototypes or an injected provider, not both.',
    );
  }
  let provider = injected;
  if (options.prototypePath !== undefined) {
    let source: string;
    try {
      source = await readFile(resolve(options.prototypePath), 'utf8');
    } catch (error) {
      throw new CliInputError(
        'CLI1002',
        `Cannot read prototype database ${JSON.stringify(options.prototypePath)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    provider = (await loadPrototypeDatabaseJson(source)).prototypes;
  }
  if (options.prototypeIdentity !== undefined && provider?.identity !== options.prototypeIdentity) {
    throw new CliInputError(
      'CLI1003',
      provider === undefined
        ? 'A pinned prototype identity requires --prototypes or an injected provider; no fallback is selected.'
        : `Prototype identity mismatch: expected ${options.prototypeIdentity}, loaded ${provider.identity}.`,
    );
  }
  return provider;
}
