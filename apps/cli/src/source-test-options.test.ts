import { describe, expect, test } from 'vitest';
import { parseCompilationOptions } from './prototype-options.js';
import { parseSourceTestOptions } from './source-test-options.js';

describe('source test options', () => {
  test('delegates common options with interspersed source/test and overrides', () => {
    expect(
      parseSourceTestOptions([
        'source.ts',
        '--prototypes',
        'db.json',
        '--overrides',
        'values.json',
        '--prototype-identity',
        'pin',
        'tests.js',
        '--json',
        '--json',
      ]),
    ).toEqual({
      files: ['source.ts', 'tests.js'],
      json: true,
      prototypePath: 'db.json',
      prototypeIdentity: 'pin',
      overridesFile: 'values.json',
    });
    expect(parseSourceTestOptions(['source.ts', 'tests.js'])).toEqual(
      parseCompilationOptions(['source.ts', 'tests.js']),
    );
  });

  test.each([[], ['source.ts', 'tests.js']].map((files) => ({ files })))(
    'accepts project path roles %j',
    ({ files }) => {
      expect(parseSourceTestOptions(['--project', 'project.json', ...files])).toEqual({
        projectPath: 'project.json',
        json: false,
        files,
      });
    },
  );

  test('keeps filenames after the delimiter literal', () => {
    expect(
      parseSourceTestOptions(['--overrides', 'values.json', '--', '--overrides', '--json']),
    ).toEqual({ overridesFile: 'values.json', json: false, files: ['--overrides', '--json'] });
    expect(
      parseSourceTestOptions(['--project', 'p.json', '--', '--source.ts', '-tests.js']).files,
    ).toEqual(['--source.ts', '-tests.js']);
  });

  test.each(
    [
      [],
      ['source.ts'],
      ['a', 'b', 'c'],
      ['', 'tests.js'],
      ['source.ts', '  '],
      ['--project', 'p.json', 'source.ts'],
      ['--project', 'p.json', 'a', 'b', 'c'],
      ['a', 'b', '--overrides'],
      ['a', 'b', '--overrides', ''],
      ['a', 'b', '--overrides', '  '],
      ['a', 'b', '--overrides', '--json'],
      ['a', 'b', '--overrides', '-x'],
      ['a', 'b', '--overrides', '--'],
      ['a', 'b', '--overrides', 'one', '--overrides', 'two'],
      ['a', 'b', '--parameters'],
      ['a', 'b', '--label', 'x'],
      ['a', 'b', '--output', 'out'],
      ['a', 'b', '--unknown'],
      ['a', 'b', '--project'],
      ['a', 'b', '--prototypes'],
      ['a', 'b', '--prototype-identity', '--json'],
      ['a', 'b', '--project', 'p', '--project', 'q'],
      ['a', 'b', '--prototypes', 'p', '--prototypes', 'q'],
      ['a', 'b', '--prototype-identity', 'p', '--prototype-identity', 'q'],
      ['--project', 'p', '--prototypes', 'db'],
      ['--project', '--overrides', 'values.json', 'a', 'b', 'c'],
      ['--prototypes', '--overrides', 'values.json', 'a', 'b', 'c'],
      ['--prototype-identity', '--overrides', 'values.json', 'a', 'b', 'c'],
    ].map((args) => ({ args })),
  )('rejects invalid syntax before I/O: %j', ({ args }) => {
    expect(() => parseSourceTestOptions(args)).toThrowError(
      expect.objectContaining({ code: 'CLI1001' }),
    );
  });

  test('does not extend check or the shared parser', () => {
    expect(() => parseCompilationOptions(['--overrides', 'values.json', 'source.ts'])).toThrowError(
      expect.objectContaining({ code: 'CLI1001' }),
    );
  });
});
