import { describe, expect, test } from 'vitest';

import { CompilerWorkerProgressTracker } from './compiler-worker-progress.js';

describe('compiler Worker progress tracking', () => {
  test('accepts only the current Worker generation and revision', () => {
    const tracker = new CompilerWorkerProgressTracker();
    tracker.begin(1, 7);

    expect(tracker.report(1, 7, 'execute')).toBe(true);
    expect(tracker.lastStage(1, 7)).toBe('execute');
    expect(tracker.report(2, 7, 'transport')).toBe(false);
    expect(tracker.report(1, 8, 'lower')).toBe(false);
    expect(tracker.lastStage(1, 7)).toBe('execute');
  });

  test('resets the last phase for a new request or explicit teardown', () => {
    const tracker = new CompilerWorkerProgressTracker();
    tracker.begin(3, 9);
    tracker.report(3, 9, 'parse');

    tracker.begin(3, 10);
    expect(tracker.lastStage(3, 10)).toBeUndefined();
    tracker.report(3, 10, 'transport');
    expect(tracker.lastStage(3, 10)).toBe('transport');

    tracker.clear();
    expect(tracker.lastStage(3, 10)).toBeUndefined();
    expect(tracker.report(3, 10, 'lower')).toBe(false);
  });

  test('records progress without creating or extending a timer', () => {
    const tracker = new CompilerWorkerProgressTracker();
    tracker.begin(4, 11);

    expect(tracker.report(4, 11, 'semantic')).toBe(true);
    expect(tracker.lastStage(4, 11)).toBe('semantic');
  });
});
