import { describe, expect, test } from 'vitest';

import { parseCompilationOptions } from './prototype-options.js';

describe('compilation options', () => {
  test('accepts options around positional paths and a literal separator', () => {
    expect(
      parseCompilationOptions([
        'first.ts',
        '--prototypes',
        'profile with spaces.json',
        '--json',
        '--prototype-identity',
        'pinned',
        '--',
        '--literal.ts',
      ]),
    ).toEqual({
      files: ['first.ts', '--literal.ts'],
      json: true,
      prototypePath: 'profile with spaces.json',
      prototypeIdentity: 'pinned',
    });
    expect(parseCompilationOptions(['--', '--json'])).toEqual({ files: ['--json'], json: false });
  });

  test.each([
    ['--prototypes'],
    ['--project'],
    ['--project', 'a', '--project', 'b'],
    ['--prototype-identity'],
    ['--prototypes', '--json'],
    ['--prototypes', ''],
    ['--unknown'],
    ['--prototypes', 'a', '--prototypes', 'b'],
    ['--prototype-identity', 'a', '--prototype-identity', 'b'],
  ])('rejects malformed options %j', (...args) => {
    expect(() => parseCompilationOptions(args)).toThrowError(
      expect.objectContaining({ code: 'CLI1001' }),
    );
  });
});
