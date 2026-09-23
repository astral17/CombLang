import { describe, expect, test } from 'vitest';

import { BlueprintDocumentError, BlueprintExchangeError } from './errors.js';

describe('blueprint codec errors', () => {
  test('retains stable exchange code and cause metadata', () => {
    const cause = new Error('bad compressed input');
    const error = new BlueprintExchangeError('BEX1004', 'Invalid compressed stream.', { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('BlueprintExchangeError');
    expect(error.code).toBe('BEX1004');
    expect(error.path).toBeUndefined();
    expect(error.cause).toBe(cause);
  });

  test('retains a stable document code and source path', () => {
    const error = new BlueprintDocumentError('BPD1002', 'Duplicate object key.', {
      path: '$.blueprint.entities[0].name',
    });

    expect(error).toMatchObject({
      name: 'BlueprintDocumentError',
      code: 'BPD1002',
      path: '$.blueprint.entities[0].name',
      message: 'Duplicate object key.',
    });
  });
});
