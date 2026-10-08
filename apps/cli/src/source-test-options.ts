import {
  CliInputError,
  parseCompilationOptions,
  type CompilationOptions,
} from './prototype-options.js';

export interface SourceTestOptions extends CompilationOptions {
  readonly overridesFile?: string;
}

/** Extract test-only ingress; the shared parser still owns all common options. */
export function parseSourceTestOptions(args: readonly string[]): SourceTestOptions {
  const common: string[] = [];
  let overridesFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]!;
    if (argument === '--') {
      common.push(...args.slice(i));
      break;
    }
    if (argument !== '--overrides') {
      common.push(argument);
      // Do not strip a malformed common option's value before its owner sees it.
      if (
        argument === '--project' ||
        argument === '--prototypes' ||
        argument === '--prototype-identity'
      ) {
        const value = args[++i];
        if (value !== undefined) common.push(value);
      }
      continue;
    }
    if (overridesFile !== undefined)
      throw new CliInputError('CLI1001', 'Duplicate option: --overrides.');
    const value = args[++i];
    if (value === undefined || value.trim().length === 0 || value.startsWith('-')) {
      throw new CliInputError('CLI1001', '--overrides requires a file path.');
    }
    overridesFile = value;
  }
  const options = parseCompilationOptions(common);
  if (options.projectPath !== undefined && options.prototypePath !== undefined) {
    throw new CliInputError('CLI1001', 'Choose either --project or --prototypes, not both.');
  }
  if (
    (options.files.length !== 2 &&
      !(options.files.length === 0 && options.projectPath !== undefined)) ||
    options.files.some((file) => file.trim().length === 0)
  ) {
    throw new CliInputError(
      'CLI1001',
      'test requires one source file and one test file (or neither with --project).',
    );
  }
  return { ...options, ...(overridesFile === undefined ? {} : { overridesFile }) };
}
