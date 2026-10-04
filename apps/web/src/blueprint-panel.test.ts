import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { sourceFileId, sourceSpan } from '@comblang/shared';
import { formatSourceDiagnostic } from './source-diagnostics.js';
import { signal } from '@comblang/factorio';
import { CompilerWorkerRuntime } from './compiler-worker-request.js';
import { CompilerWorkerScheduler } from './compiler-worker-scheduler.js';
import { createSourceCircuitArtifact } from './source-circuit-artifact.js';
import { SourceSimulationController } from './source-demo.js';
import { runWebTests } from './web-test-runner.js';
import type { CompilerWorkerRequest } from './worker-protocol.js';
import {
  blueprintExportRequest,
  selectBlueprintPanel,
  blueprintCopyIsCurrent,
} from './blueprint-panel.js';

const document = {
  blueprint: {
    item: 'blueprint' as const,
    label: 'Concrete',
    version: 1,
    icons: [{ signal: { type: 'item' as const, name: 'blueprint' as const }, index: 1 as const }],
    entities: [],
    wires: [],
  },
};
const parameterDocument = {
  blueprint: {
    ...document.blueprint,
    label: 'Exact Worker',
    parameters: [
      { type: 'number' as const, number: '5', name: 'Amount', formula: 'x * 2', dependent: false },
    ],
  },
};

describe('blueprint panel selection', () => {
  test('default OFF omits export request and preserves exact ordinary JSON bytes', () => {
    expect(blueprintExportRequest(false)).toEqual({});
    expect(blueprintExportRequest(true)).toEqual({ blueprintExport: { parameters: true } });
    const panel = selectBlueprintPanel({
      parameters: false,
      concrete: document,
      exported: { ok: true, document: parameterDocument },
    });
    expect(panel.state).toBe('valid');
    expect(panel.copyPayload).toBe(JSON.stringify(document, null, 2));
    expect(panel.text).toBe(panel.copyPayload);
  });

  test('ON selects exact Worker document and never replaces failed or missing export with concrete JSON', () => {
    const success = selectBlueprintPanel({
      parameters: true,
      concrete: document,
      exported: { ok: true, document: parameterDocument },
    });
    expect(success.text).toBe(JSON.stringify(parameterDocument, null, 2));
    expect(success.copyPayload).toBe(success.text);
    for (const exported of [
      undefined,
      {
        ok: false as const,
        diagnostics: [
          {
            code: 'CP1002',
            severity: 'error' as const,
            message: '$.parameters[0]: unsupported Signal',
          },
        ],
      },
    ]) {
      const failure = selectBlueprintPanel({
        parameters: true,
        concrete: document,
        ...(exported === undefined ? {} : { exported }),
      });
      expect(failure.state).toBe('invalid');
      expect(failure.copyPayload).toBeUndefined();
      expect(failure.text).not.toContain('Concrete');
      expect(failure.text).toContain(exported === undefined ? 'unavailable' : 'CP1002');
    }
    // A no-declaration Worker result may legitimately be the ordinary document.
    expect(
      selectBlueprintPanel({ parameters: true, exported: { ok: true, document } }).copyPayload,
    ).toBe(JSON.stringify(document, null, 2));
  });

  test('pending or compile/profile error clears display and copy even with previously successful data', () => {
    const pending = selectBlueprintPanel({
      parameters: true,
      pending: true,
      exported: { ok: true, document: parameterDocument },
    });
    expect(pending).toMatchObject({ state: 'pending', text: '{}' });
    expect(pending.copyPayload).toBeUndefined();
    const failure = selectBlueprintPanel({
      parameters: true,
      error: 'Invalid source',
      exported: { ok: true, document: parameterDocument },
    });
    expect(failure.copyPayload).toBeUndefined();
    expect(failure.text).toBe(JSON.stringify({ error: 'Invalid source' }, null, 2));
  });

  test('located export diagnostics include source/related information without changing compile diagnostics', () => {
    const fileId = sourceFileId('main.factorio.ts');
    const source = 'first\nsecond\n';
    const diagnostic = {
      code: 'CP1002',
      severity: 'error' as const,
      message: '$.parameters[1]: conflict',
      span: sourceSpan(fileId, 6, 12),
      related: [{ message: 'Original', span: sourceSpan(fileId, 0, 5) }],
    };
    const panel = selectBlueprintPanel(
      { parameters: true, exported: { ok: false, diagnostics: [diagnostic] } },
      (item) => formatSourceDiagnostic(item, source),
    );
    expect(panel.text).toContain('CP1002 error at 2:1');
    expect(panel.text).toContain('at 1:1');
    expect(panel.text).toContain('Original');
    expect(diagnostic.related).toHaveLength(1);
  });

  test('copy completion is valid only for matching revision, mode and live payload', () => {
    const captured = { revision: 3, parameters: true, json: 'document' };
    expect(blueprintCopyIsCurrent(captured, captured)).toBe(true);
    expect(blueprintCopyIsCurrent(captured, { ...captured, revision: 4 })).toBe(false);
    expect(blueprintCopyIsCurrent(captured, { ...captured, parameters: false })).toBe(false);
    expect(blueprintCopyIsCurrent(captured, { ...captured, json: undefined })).toBe(false);
    expect(blueprintCopyIsCurrent(captured, { ...captured, json: 'new document' })).toBe(false);
  });
});

describe('blueprint panel revision and Worker integration', () => {
  const profile = {
    kind: 'builtin' as const,
    source: readFileSync(
      new URL('../../../packages/prototypes/generated/space-age-2.1.17.json', import.meta.url),
      'utf8',
    ),
    assetManifest: readFileSync(
      new URL(
        '../../../packages/prototypes/generated/space-age-2.1.17.json.manifest.json',
        import.meta.url,
      ),
      'utf8',
    ),
  };
  const A = signal('virtual', 'signal-A');
  const source = `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { formula: 'unknown(x) * 2', dependent: false });
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: A, value: amount }] }] });`;

  test('actual Worker numeric/formula document is copied verbatim while OFF and simulation retain defaults', async () => {
    const runtime = new CompilerWorkerRuntime();
    const off = await runtime.handle({
      kind: 'parse',
      revision: 1,
      file: { path: 'main.factorio.ts', text: source },
      prototypeProfile: profile,
      ...blueprintExportRequest(false),
    });
    expect(off.result).not.toHaveProperty('blueprintExport');
    const on = await runtime.handle({
      kind: 'parse',
      revision: 2,
      file: { path: 'main.factorio.ts', text: source },
      prototypeProfile: { kind: 'builtin', identity: off.prototypeEnvironment!.identity },
      ...blueprintExportRequest(true),
    });
    expect(on.result.pipelineDiagnostics).toEqual([]);
    expect(on.result.plan).toEqual(off.result.plan);
    expect(on.result.resolvedCircuit).toEqual(off.result.resolvedCircuit);
    if (!on.result.blueprintExport?.ok) throw new Error('Expected numeric export');
    expect(on.result.blueprintExport.document.blueprint.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', formula: 'unknown(x) * 2', dependent: false },
    ]);
    const artifact = createSourceCircuitArtifact(on.result.plan!, on.result.resolvedCircuit!);
    const controller = new SourceSimulationController(artifact);
    controller.stepFrom(0);
    expect(controller.signalValueAt(1, 'output', A)).toBe(5);
    const onPanel = selectBlueprintPanel({
      parameters: true,
      concrete: artifact.blueprint,
      exported: on.result.blueprintExport,
    });
    expect(onPanel.copyPayload).toBe(JSON.stringify(on.result.blueprintExport.document, null, 2));
    const offArtifact = createSourceCircuitArtifact(off.result.plan!, off.result.resolvedCircuit!);
    expect(
      selectBlueprintPanel({ parameters: false, concrete: offArtifact.blueprint }).copyPayload,
    ).toBe(JSON.stringify(offArtifact.blueprint, null, 2));
    expect(JSON.parse(onPanel.copyPayload!)).not.toHaveProperty('diagnostics');
  });

  test('Constant multiplier compiles and simulates defaults while native export fails independently without copy fallback', async () => {
    const text = `const A = Signal('virtual', 'signal-A');
const scale = Param.number('Scale', 1);
const output = new Network();
output += Constant({ sections: [{ multiplier: scale, filters: [{ signal: A, value: 5 }] }] });`;
    const runtime = new CompilerWorkerRuntime();
    const on = await runtime.handle({
      kind: 'parse',
      revision: 1,
      file: { path: 'main.factorio.ts', text },
      prototypeProfile: profile,
      ...blueprintExportRequest(true),
    });
    expect(on.result.pipelineDiagnostics).toEqual([]);
    expect(on.result.blueprintExport).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: 'CP1002',
          message: expect.stringContaining('$.constantTemplates[0].sections[0].multiplier'),
          span: { start: text.indexOf('Constant('), end: text.lastIndexOf(';') },
        },
      ],
    });
    const artifact = createSourceCircuitArtifact(on.result.plan!, on.result.resolvedCircuit!);
    expect(artifact.blueprint.blueprint.entities[0]).toMatchObject({
      control_behavior: { sections: { sections: [{ multiplier: 1, filters: [{ count: 5 }] }] } },
    });
    const controller = new SourceSimulationController(artifact);
    controller.stepFrom(0);
    expect(controller.signalValueAt(1, 'output', A)).toBe(5);
    const panel = selectBlueprintPanel({
      parameters: true,
      concrete: artifact.blueprint,
      exported: on.result.blueprintExport,
    });
    expect(panel.state).toBe('invalid');
    expect(panel.copyPayload).toBeUndefined();
    const off = await runtime.handle({
      kind: 'parse',
      revision: 2,
      file: { path: 'main.factorio.ts', text },
      prototypeProfile: { kind: 'builtin', identity: on.prototypeEnvironment!.identity },
      ...blueprintExportRequest(false),
    });
    expect(off.result).not.toHaveProperty('blueprintExport');
    expect(off.result.plan).toEqual(on.result.plan);
    expect(off.result.resolvedCircuit).toEqual(on.result.resolvedCircuit);
    expect(
      selectBlueprintPanel({ parameters: false, concrete: artifact.blueprint }).copyPayload,
    ).toBe(JSON.stringify(artifact.blueprint, null, 2));
    expect(structuredClone(on)).toEqual(on);
  });

  test.each([
    [
      'Constant filter',
      '',
      'Constant({ sections: [{ filters: [{ signal: channel, value: 5 }] }] })',
      5,
    ],
    [
      'Arithmetic output',
      '',
      "Arithmetic({ left: 2, operation: 'add', right: 5, output: channel })",
      7,
    ],
    [
      'mixed Arithmetic output',
      "const amount = Param.number('Amount', 5);",
      "Arithmetic({ left: 2, operation: 'add', right: amount, output: channel })",
      7,
    ],
  ] as const)(
    'unsupported Signal export at %s stays located and unavailable for copy, with working concrete simulation/tests',
    async (_name, declaration, device, count) => {
      const text = `const A = Signal('virtual', 'signal-A');
const channel = Param.signal('Channel', A);
${declaration}
const output = new Network();
output += ${device};`;
      const runtime = new CompilerWorkerRuntime();
      const response = await runtime.handle({
        kind: 'parse',
        revision: 1,
        file: { path: 'main.factorio.ts', text },
        prototypeProfile: profile,
        ...blueprintExportRequest(true),
      });
      expect(response.result.pipelineDiagnostics).toEqual([]);
      const artifact = createSourceCircuitArtifact(
        response.result.plan!,
        response.result.resolvedCircuit!,
      );
      const panel = selectBlueprintPanel(
        {
          parameters: true,
          concrete: artifact.blueprint,
          exported: response.result.blueprintExport,
        },
        (diagnostic) => formatSourceDiagnostic(diagnostic, text),
      );
      expect(panel.copyPayload).toBeUndefined();
      expect(panel.text).toContain('CP1002 error at 2:');
      const controller = new SourceSimulationController(artifact);
      controller.stepFrom(0);
      expect(controller.signalValueAt(1, 'output', A)).toBe(count);
      const off = await runtime.handle({
        kind: 'parse',
        revision: 2,
        file: { path: 'main.factorio.ts', text },
        prototypeProfile: { kind: 'builtin', identity: response.prototypeEnvironment!.identity },
        ...blueprintExportRequest(false),
      });
      expect(off.result).not.toHaveProperty('blueprintExport');
      expect(off.result.plan).toEqual(response.result.plan);
      expect(off.result.resolvedCircuit).toEqual(response.result.resolvedCircuit);
      expect(
        selectBlueprintPanel({ parameters: false, concrete: artifact.blueprint }).copyPayload,
      ).toBe(JSON.stringify(artifact.blueprint, null, 2));
      expect(
        runWebTests(
          response.result.plan!,
          `test('default', ({ network, tick, expectSignal }) => {
      tick(1); expectSignal(network('output'), Signal('virtual', 'signal-A')).toBe(${count});
    });`,
          response.result.resolvedCircuit!,
        ),
      ).toMatchObject({ passed: 1, failed: 0 });
    },
  );

  test('no declarations and warning-only source allow copy; bad source/profile clears it', async () => {
    const runtime = new CompilerWorkerRuntime();
    const response = await runtime.handle({
      kind: 'parse',
      revision: 1,
      file: { path: 'main.factorio.ts', text: 'const output = CC();' },
      ...blueprintExportRequest(true),
    });
    expect(response.result.pipelineDiagnostics).toContainEqual(
      expect.objectContaining({ severity: 'warning' }),
    );
    expect(response.result.pipelineDiagnostics.some(({ severity }) => severity === 'error')).toBe(
      false,
    );
    if (!response.result.blueprintExport?.ok) throw new Error('Expected ordinary export');
    expect(response.result.blueprintExport.document.blueprint).not.toHaveProperty('parameters');
    expect(
      selectBlueprintPanel({ parameters: true, exported: response.result.blueprintExport })
        .copyPayload,
    ).toBe(JSON.stringify(response.result.blueprintExport.document, null, 2));
    for (const extra of [
      { file: { path: 'main.factorio.ts', text: 'const broken = ;' } },
      { prototypeProfile: { identity: 'missing' } },
    ]) {
      const invalid = await runtime.handle({
        kind: 'parse',
        revision: 2,
        file: { path: 'main.factorio.ts', text: 'const output = CC();' },
        ...blueprintExportRequest(true),
        ...extra,
      });
      const error = invalid.result.pipelineDiagnostics.find(({ severity }) => severity === 'error');
      expect(error).toBeDefined();
      expect(
        selectBlueprintPanel({
          parameters: true,
          error: error!.message,
          exported: invalid.result.blueprintExport,
        }).copyPayload,
      ).toBeUndefined();
    }
  });

  test('existing scheduler collapses rapid toggles/edits; accepted revision guard rejects old mode replies', () => {
    const scheduler = new CompilerWorkerScheduler();
    const worker = scheduler.createWorker();
    scheduler.markReady(worker);
    const request = (
      revision: number,
      parameters: boolean,
      text: string,
    ): CompilerWorkerRequest => ({
      kind: 'parse',
      revision,
      file: { path: 'main.factorio.ts', text },
      ...blueprintExportRequest(parameters),
    });
    scheduler.enqueue(request(1, false, 'old source'));
    scheduler.takeForDispatch();
    scheduler.enqueue(request(2, true, 'old source'));
    scheduler.enqueue(request(3, false, 'edited source'));
    scheduler.enqueue(request(4, true, 'edited source'));
    const currentRevision = 4;
    let panel = selectBlueprintPanel({ parameters: true, pending: true });
    const accept = (revision: number) => {
      if (!scheduler.complete(worker, revision) || revision !== currentRevision) return;
      panel = selectBlueprintPanel({
        parameters: true,
        exported: { ok: true, document: parameterDocument },
      });
    };
    accept(1);
    expect(panel.copyPayload).toBeUndefined();
    expect(panel.text).toBe('{}');
    expect(scheduler.takeForDispatch()?.request).toEqual(request(4, true, 'edited source'));
    accept(2);
    accept(3);
    expect(panel.copyPayload).toBeUndefined();
    accept(4);
    expect(panel.copyPayload).toBe(JSON.stringify(parameterDocument, null, 2));
  });

  test.each(['success', 'failure'] as const)(
    'late clipboard %s cannot mark a new mode/revision copied or failed',
    async (outcome) => {
      let finish!: () => void;
      let fail!: (error: Error) => void;
      const clipboard = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      const captured = { revision: 1, parameters: false, json: 'old JSON' };
      let current: { revision: number; parameters: boolean; json: string | undefined } = captured;
      let label = 'Copy blueprint';
      let resetScheduled = false;
      const completion = clipboard
        .then(() => {
          if (blueprintCopyIsCurrent(captured, current)) label = 'Copied';
        })
        .catch(() => {
          if (blueprintCopyIsCurrent(captured, current)) label = 'Copy failed';
        })
        .finally(() => {
          if (blueprintCopyIsCurrent(captured, current)) resetScheduled = true;
        });
      current = { revision: 2, parameters: true, json: undefined };
      expect(blueprintCopyIsCurrent(captured, current)).toBe(false);
      // Returning to identical bytes and mode still cannot revive the older revision.
      current = { revision: 4, parameters: false, json: 'old JSON' };
      if (outcome === 'success') finish();
      else fail(new Error('clipboard denied'));
      await completion;
      expect(label).toBe('Copy blueprint');
      expect(resetScheduled).toBe(false);
    },
  );
});

describe('blueprint panel browser wiring contract', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

  test('adds a native labelled checkbox default OFF with responsive action wrapping', () => {
    const checkbox = html.match(/<input\b[^>]*id="blueprint-parameters"[^>]*>/)?.[0];
    expect(checkbox).toContain('type="checkbox"');
    expect(checkbox).not.toContain('checked');
    expect(html).toContain('for="blueprint-parameters"');
    expect(html).toContain('Include numeric parameters');
    expect(css.match(/\.blueprint-actions\s*\{([^}]+)\}/)?.[1]).toContain('flex-wrap: wrap');
    expect(css).toContain('.blueprint-parameter-option');
  });

  test('mode uses the existing scheduler, clears pending immediately and has no draft/storage mutation handler', () => {
    const handler = main.match(
      /includeNumericParameters\.addEventListener\('change', \(\) => \{([\s\S]*?)\n\}\);/,
    )?.[1];
    expect(handler).toContain('scheduleRender(false)');
    expect(handler).not.toMatch(/setValue|save.*Draft|localStorage|sessionStorage|reload/);
    expect(main).toContain('...blueprintExportRequest(includeNumericParameters.checked)');
    expect(main).toContain('event.data.revision !== currentRevision');
    const schedule = main.slice(
      main.indexOf('function scheduleRender('),
      main.indexOf('function handleWorkerMessage('),
    );
    expect(schedule.indexOf('renderProofPending()')).toBeLessThan(schedule.indexOf('setTimeout('));
    expect(main).not.toContain('compileSource(');
  });

  test('export errors stay outside editor/compile state and clipboard callbacks guard the captured payload', () => {
    expect(main).toContain('exported: parsed.blueprintExport');
    expect(main).toContain('sourceEditor.setDiagnostics(parsed.pipelineDiagnostics)');
    expect(main).not.toContain('setDiagnostics(parsed.blueprintExport');
    const copy = main.slice(
      main.indexOf("copyBlueprint.addEventListener('click'"),
      main.indexOf('function setTestsWaiting('),
    );
    expect(copy).toContain('blueprintCopyIsCurrent');
    expect(copy.match(/if \(!isCurrentCopy\(\)\) return;/g)).toHaveLength(3);
    expect(copy).toContain('copyText(captured.json)');
  });
});
