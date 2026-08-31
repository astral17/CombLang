import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan';
import { offsetToPosition, sourceFileId, sourceSpan, type Diagnostic } from '@comblang/shared';

import { blueprintJsonForPlan } from './blueprint-demo.js';
import { createSourceEditor, type SourceEditorKind } from './code-editor.js';
import { registerOfflineSupport, warmOfflineCache } from './offline.js';
import { loadSourceDraft, saveSourceDraft, type SourceDraftStorage } from './source-draft.js';
import { runSourcePlanDemo, type SourcePlanDemo } from './source-demo.js';
import { loadTestDraft, saveTestDraft } from './test-draft.js';
import type { TestWorkerRequest, TestWorkerResponse } from './test-worker-protocol.js';
import { buildDetailTimeline, buildOverviewTimeline, signalLabel } from './timeline-view.js';
import type { CompilerWorkerRequest, CompilerWorkerResponse } from './worker-protocol.js';
import './styles.css';

const sampleSource = `const SIGNAL_A = Signal("virtual", "signal-A");

function Scale(input: Readonly<Network>): Network {
  const factor = 2 + 3;
  const scaled = input * factor;
  return scaled + 1;
}

function Bias(input: Readonly<Network>): Network {
  const bias = 10 / 2;
  return input + bias;
}

function Gate(input: Readonly<Network>, threshold: Readonly<Network>): Network {
  return IF(input[SIGNAL_A] > threshold[SIGNAL_A], input[SIGNAL_A]).as(SIGNAL_A);
}

const input = new Network<R>();
const middle = Scale(input);
const biased = Bias(middle);
const threshold = new Network();
threshold += CC(40 * SIGNAL_A).at(0.5, 2.5, 4);
let [output, mirror]: [Network, Network] = Gate(biased, threshold);
`;

const sampleTests = `const SIGNAL_A = Signal("virtual", "signal-A");

test("gate opens above the threshold", ({ network, drive, tick, expectSignal }) => {
  drive(network("input"), [[SIGNAL_A, 7]]);
  tick(5);
  expectSignal(network("output"), SIGNAL_A).toBe(41);
});

test("gate stays closed below the threshold", ({ network, drive, tick, expectSignal }) => {
  drive(network("input"), [[SIGNAL_A, 2]]);
  tick(5);
  expectSignal(network("output"), SIGNAL_A).toBe(0);
});
`;

function tabDraftStorage(): SourceDraftStorage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

const draftStorage = tabDraftStorage();
const initialSource = loadSourceDraft(draftStorage) ?? sampleSource;
const initialTests = loadTestDraft(draftStorage) ?? sampleTests;

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (element === null) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

const sourceHost = requiredElement<HTMLElement>('#source-editor');
const editorMode = requiredElement<HTMLButtonElement>('#editor-mode');
const editorLabel = requiredElement<HTMLElement>('#editor-label');
const status = requiredElement<HTMLOutputElement>('#status');
const result = requiredElement<HTMLPreElement>('#result');
const proof = requiredElement<HTMLElement>('.proof');
const proofTitle = requiredElement<HTMLHeadingElement>('#proof-title');
const proofDescription = requiredElement<HTMLParagraphElement>('#proof-description');
const proofCombinators = requiredElement<HTMLElement>('#proof-combinators');
const proofAttachments = requiredElement<HTMLElement>('#proof-attachments');
const proofStages = requiredElement<HTMLElement>('#proof-stages');
const proofFolds = requiredElement<HTMLElement>('#proof-folds');
const waveform = requiredElement<HTMLElement>('#waveform');
const waveformNetwork = requiredElement<HTMLSelectElement>('#waveform-network');
const waveformViewLabel = requiredElement<HTMLElement>('#waveform-view-label');
const instancePaths = requiredElement<HTMLElement>('#instance-paths');
const networkColors = requiredElement<HTMLElement>('#network-colors');
const blueprintStatus = requiredElement<HTMLOutputElement>('#blueprint-status');
const blueprintResult = requiredElement<HTMLPreElement>('#blueprint-result');
const copyBlueprint = requiredElement<HTMLButtonElement>('#copy-blueprint');
const testHost = requiredElement<HTMLElement>('#test-editor');
const testEditorMode = requiredElement<HTMLButtonElement>('#test-editor-mode');
const testEditorLabel = requiredElement<HTMLElement>('#test-editor-label');
const testStatus = requiredElement<HTMLOutputElement>('#test-status');
const testResults = requiredElement<HTMLElement>('#test-results');
const addTest = requiredElement<HTMLButtonElement>('#add-test');
let parserWorker: Worker | undefined;
let workerTimeout: ReturnType<typeof setTimeout> | undefined;
let activeWorkerRevision: number | undefined;
let queuedCompilerRequest: CompilerWorkerRequest | undefined;
let currentRevision = 0;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
let currentBlueprintJson: string | undefined;
let currentPlan: DirectElaborationPlan | undefined;
let currentDemo: SourcePlanDemo | undefined;
let testWorker: Worker | undefined;
let testWorkerTimeout: ReturnType<typeof setTimeout> | undefined;
let testRenderTimer: ReturnType<typeof setTimeout> | undefined;
let testRevision = 0;
let addedTestNumber = 1;
let sourceEditor = createSourceEditor(sourceHost, initialSource, scheduleRender);
let testEditor = createSourceEditor(
  testHost,
  initialTests,
  scheduleTestRender,
  'auto',
  'CombLang test editor, circuit.test.js',
);

function updateEditorModeUi(): void {
  const native = sourceEditor.kind === 'native';
  editorLabel.textContent = `main.factorio.ts · ${native ? 'native mobile editor' : 'CodeMirror 6'}`;
  editorMode.textContent = native ? 'CodeMirror' : 'Native editor';
}

function replaceSourceEditor(kind: SourceEditorKind): void {
  const value = sourceEditor.getValue();
  sourceEditor.destroy();
  sourceEditor = createSourceEditor(sourceHost, value, scheduleRender, kind);
  updateEditorModeUi();
  scheduleRender();
}

editorMode.addEventListener('click', () => {
  replaceSourceEditor(sourceEditor.kind === 'native' ? 'codemirror' : 'native');
});
updateEditorModeUi();

function updateTestEditorModeUi(): void {
  const native = testEditor.kind === 'native';
  testEditorLabel.textContent = `circuit.test.js · ${native ? 'native mobile editor' : 'CodeMirror 6'}`;
  testEditorMode.textContent = native ? 'CodeMirror' : 'Native editor';
}

function replaceTestEditor(kind: SourceEditorKind): void {
  const value = testEditor.getValue();
  testEditor.destroy();
  testEditor = createSourceEditor(
    testHost,
    value,
    scheduleTestRender,
    kind,
    'CombLang test editor, circuit.test.js',
  );
  updateTestEditorModeUi();
  scheduleTestRender();
}

testEditorMode.addEventListener('click', () => {
  replaceTestEditor(testEditor.kind === 'native' ? 'codemirror' : 'native');
});
updateTestEditorModeUi();

addTest.addEventListener('click', () => {
  const number = addedTestNumber;
  addedTestNumber += 1;
  testEditor.insertText(`test("new circuit test ${number}", ({ network, tick, expectSignal }) => {
  const SIGNAL_A = Signal("virtual", "signal-A");
  tick(1);
  expectSignal(network("output"), SIGNAL_A).toBe(0);
});
`);
});

function resetCopyButton(): void {
  if (copyResetTimer !== undefined) clearTimeout(copyResetTimer);
  copyResetTimer = undefined;
  copyBlueprint.textContent = 'Copy blueprint';
  delete copyBlueprint.dataset.state;
}

async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard !== undefined) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const fallback = document.createElement('textarea');
  fallback.value = text;
  fallback.setAttribute('readonly', '');
  fallback.style.position = 'fixed';
  fallback.style.opacity = '0';
  document.body.append(fallback);
  fallback.select();
  const copied = document.execCommand('copy');
  fallback.remove();
  if (!copied) throw new Error('The browser rejected clipboard access.');
}

function displayNetworkName(name: string): string {
  return name.startsWith('$local:') ? name.split(':').slice(2).join(':') : name;
}

function timelineTable(headers: readonly (string | HTMLElement)[]): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'timeline-table';
  const row = document.createElement('tr');
  for (const header of headers) {
    const cell = document.createElement('th');
    if (typeof header === 'string') cell.textContent = header;
    else cell.append(header);
    row.append(cell);
  }
  const head = document.createElement('thead');
  head.append(row);
  table.append(head, document.createElement('tbody'));
  return table;
}

function renderTimeline(): void {
  const demo = currentDemo;
  if (demo === undefined || demo.timeline.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'proof-empty';
    empty.textContent = 'Compile a circuit to inspect its Network timeline.';
    waveform.replaceChildren(empty);
    return;
  }

  const selected = waveformNetwork.value;
  if (selected === '') {
    waveformViewLabel.textContent = 'Networks overview';
    const model = buildOverviewTimeline(demo.timeline);
    const headers: (string | HTMLElement)[] = ['Tick'];
    for (const network of model.networks) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.color = network.color;
      button.textContent = displayNetworkName(network.name);
      button.title = `Show signals for ${network.name}`;
      button.addEventListener('click', () => {
        waveformNetwork.value = network.id;
        renderTimeline();
      });
      headers.push(button);
    }
    const table = timelineTable(headers);
    table.classList.add('timeline-overview');
    const body = table.tBodies[0]!;
    for (const row of model.rows) {
      const element = document.createElement('tr');
      const tick = document.createElement('th');
      tick.scope = 'row';
      tick.textContent = `T${row.tick}`;
      element.append(tick);
      for (const cell of row.cells) {
        const value = document.createElement('td');
        if (cell.lines.length === 0) {
          value.className = 'timeline-empty';
          value.textContent = '—';
        } else {
          for (const line of cell.lines) {
            const item = document.createElement('span');
            item.textContent = line;
            value.append(item);
          }
          if (cell.hidden > 0) {
            const more = document.createElement('em');
            more.textContent = `… +${cell.hidden}`;
            value.append(more);
          }
        }
        element.append(value);
      }
      body.append(element);
    }
    waveform.replaceChildren(table);
    return;
  }

  const detail = buildDetailTimeline(demo.timeline, selected);
  if (detail === undefined) {
    waveformNetwork.value = '';
    renderTimeline();
    return;
  }
  waveformViewLabel.textContent = displayNetworkName(detail.network.name);
  const table = timelineTable(['Tick', ...detail.signals.map(signalLabel)]);
  table.classList.add('timeline-detail');
  const body = table.tBodies[0]!;
  for (const row of detail.rows) {
    const element = document.createElement('tr');
    const tick = document.createElement('th');
    tick.scope = 'row';
    tick.textContent = `T${row.tick}`;
    element.append(tick);
    for (const value of row.values) {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      if (value === 0) cell.className = 'timeline-zero';
      element.append(cell);
    }
    body.append(element);
  }
  if (detail.signals.length === 0) {
    const row = document.createElement('tr');
    const empty = document.createElement('td');
    empty.colSpan = 2;
    empty.className = 'timeline-empty';
    empty.textContent = 'This Network is empty for every captured tick.';
    row.append(empty);
    body.replaceChildren(row);
  }
  waveform.replaceChildren(table);
}

function updateTimelineTargets(demo: SourcePlanDemo): void {
  const previous = waveformNetwork.value;
  const networks = demo.timeline[0]?.networks ?? [];
  waveformNetwork.replaceChildren(
    Object.assign(document.createElement('option'), { value: '', textContent: 'All Networks' }),
    ...networks.map((network) =>
      Object.assign(document.createElement('option'), {
        value: network.id,
        textContent: displayNetworkName(network.name),
      }),
    ),
  );
  waveformNetwork.value = networks.some(({ id }) => id === previous) ? previous : '';
  renderTimeline();
}

waveformNetwork.addEventListener('change', renderTimeline);

function renderProofPending(): void {
  currentPlan = undefined;
  testRevision += 1;
  terminateTestWorker();
  proof.dataset.state = 'pending';
  proof.setAttribute('aria-busy', 'true');
  blueprintStatus.textContent = 'Waiting for compiler…';
  blueprintStatus.dataset.state = 'pending';
  currentBlueprintJson = undefined;
  copyBlueprint.disabled = true;
  resetCopyButton();
}

function renderProofError(message: string): void {
  currentPlan = undefined;
  currentDemo = undefined;
  proof.dataset.state = 'invalid';
  proof.setAttribute('aria-busy', 'false');
  proofTitle.textContent = 'Current source is not simulatable yet';
  proofDescription.textContent = message;
  proofCombinators.textContent = '—';
  proofAttachments.textContent = '—';
  proofStages.textContent = '—';
  proofFolds.textContent = '—';
  const empty = document.createElement('p');
  empty.className = 'proof-empty';
  empty.textContent =
    'Fix the source or return to the supported arithmetic Network subset to resume the live proof.';
  waveform.replaceChildren(empty);
  waveformNetwork.replaceChildren(
    Object.assign(document.createElement('option'), { value: '', textContent: 'All Networks' }),
  );
  waveformViewLabel.textContent = 'Networks overview';
  instancePaths.replaceChildren();
  networkColors.replaceChildren();
  blueprintStatus.textContent = 'No blueprint JSON';
  blueprintStatus.dataset.state = 'invalid';
  blueprintResult.textContent = JSON.stringify({ error: message }, null, 2);
  currentBlueprintJson = undefined;
  copyBlueprint.disabled = true;
  resetCopyButton();
}

function renderSourceProof(
  plan: NonNullable<CompilerWorkerResponse['result']['plan']>,
  foldedOperations: number,
): void {
  const demo = runSourcePlanDemo(plan);
  currentDemo = demo;
  proof.dataset.state = 'valid';
  proof.setAttribute('aria-busy', 'false');
  if (demo.outputValue === undefined) {
    proofTitle.textContent = `${demo.colors.length} Networks colored`;
    proofDescription.textContent =
      'No producers constrain these Networks yet; unconstrained components receive the deterministic red default.';
  } else {
    proofTitle.replaceChildren(
      document.createTextNode('Current source produced '),
      Object.assign(document.createElement('code'), {
        textContent: `signal-A = ${demo.outputValue}`,
      }),
    );
    proofDescription.textContent =
      demo.inputNetwork === undefined
        ? `${demo.outputNetwork} is driven by a source device after ${demo.stages} synchronous circuit ${demo.stages === 1 ? 'tick' : 'ticks'}.`
        : `${demo.inputNetwork} receives signal-A = ${demo.inputValue} at T0; ${demo.outputNetwork} is read after ${demo.stages} synchronous circuit ${demo.stages === 1 ? 'tick' : 'ticks'}.`;
  }
  proofCombinators.textContent = String(demo.combinators);
  proofAttachments.textContent = String(demo.attachments);
  proofStages.textContent = String(demo.stages);
  proofFolds.textContent = String(foldedOperations);
  const callPaths = new Map<string, Set<string>>();
  for (const producer of plan.producers) {
    for (const path of producer.instancePath) {
      const displayPath = path.startsWith('direct:$unused:') ? 'unused producer' : path;
      const kinds = callPaths.get(displayPath) ?? new Set<string>();
      kinds.add(producer.kind);
      callPaths.set(displayPath, kinds);
    }
  }
  instancePaths.replaceChildren(
    ...[...callPaths].map(([path, kinds], index) => {
      const item = document.createElement('span');
      item.dataset.step = String(index + 1);
      const name = document.createTextNode(path);
      const kind = document.createElement('b');
      kind.textContent = [...kinds].join('+');
      item.replaceChildren(name, kind);
      return item;
    }),
  );
  updateTimelineTargets(demo);
  networkColors.replaceChildren(
    ...demo.colors.map((network) => {
      const item = document.createElement('span');
      item.dataset.color = network.color;
      const displayName = displayNetworkName(network.name);
      item.textContent = `${displayName} · ${network.color}`;
      item.title = network.name;
      return item;
    }),
  );
  const generated = blueprintJsonForPlan(plan);
  blueprintStatus.textContent = `${generated.blueprint.entities.length} entities · ${generated.blueprint.wires.length} wires`;
  blueprintStatus.dataset.state = 'valid';
  currentBlueprintJson = JSON.stringify(generated, null, 2);
  blueprintResult.textContent = currentBlueprintJson;
  copyBlueprint.disabled = false;
  resetCopyButton();
}

copyBlueprint.addEventListener('click', () => {
  if (currentBlueprintJson === undefined) return;
  void copyText(currentBlueprintJson)
    .then(() => {
      copyBlueprint.textContent = 'Copied';
      copyBlueprint.dataset.state = 'copied';
    })
    .catch(() => {
      copyBlueprint.textContent = 'Copy failed';
      copyBlueprint.dataset.state = 'failed';
    })
    .finally(() => {
      copyResetTimer = setTimeout(resetCopyButton, 1800);
    });
});

function setTestsWaiting(message: string): void {
  testStatus.textContent = message;
  testStatus.dataset.state = 'pending';
}

function renderTestsBlocked(message: string): void {
  testEditor.setDiagnostics([]);
  testStatus.textContent = 'Tests not run';
  testStatus.dataset.state = 'invalid';
  const empty = document.createElement('p');
  empty.className = 'test-empty';
  empty.textContent = message;
  testResults.replaceChildren(empty);
}

function offsetForTestLine(source: string, line: number): { start: number; end: number } {
  const lines = source.split('\n');
  const safeLine = Math.min(Math.max(1, line), lines.length);
  let start = 0;
  for (let index = 0; index < safeLine - 1; index += 1) start += (lines[index]?.length ?? 0) + 1;
  return { start, end: start + (lines[safeLine - 1]?.length ?? 0) };
}

function renderTestRun(run: TestWorkerResponse['run']): void {
  testStatus.textContent = `${run.passed} passed · ${run.failed} failed`;
  testStatus.dataset.state = run.failed === 0 ? 'valid' : 'invalid';
  const source = testEditor.getValue();
  const fileId = sourceFileId('circuit.test.js');
  const diagnostics: Diagnostic[] = [];
  const items = run.results.map((testResult) => {
    const item = document.createElement('article');
    item.className = 'test-result';
    item.dataset.state = testResult.status;
    const heading = document.createElement('div');
    const marker = document.createElement('span');
    marker.className = 'test-result-marker';
    marker.textContent = testResult.status === 'passed' ? 'PASS' : 'FAIL';
    const name = document.createElement('strong');
    name.textContent = testResult.name;
    heading.append(marker, name);
    if (testResult.line !== undefined) {
      const location = document.createElement('button');
      location.type = 'button';
      location.textContent = `line ${testResult.line}${testResult.column === undefined ? '' : `:${testResult.column}`}`;
      location.title = 'Failure location in circuit.test.js';
      heading.append(location);
      const span = offsetForTestLine(source, testResult.line);
      diagnostics.push({
        code: 'WT1001',
        severity: 'error',
        message: testResult.message ?? 'Test failed.',
        span: sourceSpan(fileId, span.start, span.end),
      });
    }
    item.append(heading);
    if (testResult.message !== undefined) {
      const message = document.createElement('pre');
      message.textContent = testResult.message;
      item.append(message);
    }
    return item;
  });
  testEditor.setDiagnostics(diagnostics);
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'test-empty';
    empty.textContent = 'No test(...) blocks are registered yet.';
    testResults.replaceChildren(empty);
  } else {
    testResults.replaceChildren(...items);
  }
}

function terminateTestWorker(): void {
  if (testWorkerTimeout !== undefined) clearTimeout(testWorkerTimeout);
  testWorkerTimeout = undefined;
  testWorker?.terminate();
  testWorker = undefined;
}

function runTests(): void {
  const plan = currentPlan;
  if (plan === undefined) {
    setTestsWaiting('Waiting for valid source…');
    return;
  }
  testRevision += 1;
  const revision = testRevision;
  terminateTestWorker();
  const worker = new Worker(new URL('./test.worker.ts', import.meta.url), { type: 'module' });
  testWorker = worker;
  const request: TestWorkerRequest = {
    kind: 'test',
    revision,
    plan,
    source: testEditor.getValue(),
  };
  setTestsWaiting('Running tests…');
  worker.addEventListener('message', (event: MessageEvent<TestWorkerResponse>) => {
    if (testWorker !== worker || event.data.revision !== testRevision) return;
    terminateTestWorker();
    renderTestRun(event.data.run);
  });
  worker.addEventListener('error', (event) => {
    if (testWorker !== worker) return;
    terminateTestWorker();
    renderTestsBlocked(event.message || 'The test worker crashed.');
  });
  worker.postMessage(request);
  testWorkerTimeout = setTimeout(() => {
    if (testWorker !== worker || revision !== testRevision) return;
    terminateTestWorker();
    renderTestsBlocked('Test execution exceeded the 1200 ms worker budget.');
  }, 1200);
}

function scheduleTestRender(): void {
  saveTestDraft(draftStorage, testEditor.getValue());
  testRevision += 1;
  terminateTestWorker();
  if (testRenderTimer !== undefined) clearTimeout(testRenderTimer);
  testEditor.setDiagnostics([]);
  setTestsWaiting(currentPlan === undefined ? 'Waiting for valid source…' : 'Waiting for input…');
  testRenderTimer = setTimeout(() => {
    testRenderTimer = undefined;
    runTests();
  }, 220);
}

function render(): void {
  currentRevision += 1;
  const request: CompilerWorkerRequest = {
    kind: 'parse',
    revision: currentRevision,
    file: { path: 'main.factorio.ts', text: sourceEditor.getValue() },
  };
  status.textContent = 'Parsing…';
  status.dataset.state = 'pending';
  renderProofPending();
  startCompilerWorker(request);
}

function scheduleRender(): void {
  saveSourceDraft(draftStorage, sourceEditor.getValue());
  currentRevision += 1;
  if (renderTimer !== undefined) clearTimeout(renderTimer);
  sourceEditor.setDiagnostics([]);
  status.textContent = 'Waiting for input…';
  status.dataset.state = 'pending';
  renderProofPending();
  setTestsWaiting('Waiting for valid source…');
  renderTimer = setTimeout(() => {
    renderTimer = undefined;
    render();
  }, 180);
}

function handleWorkerMessage(event: MessageEvent<CompilerWorkerResponse>, worker: Worker): void {
  if (
    parserWorker !== worker ||
    event.data.kind !== 'parsed' ||
    event.data.revision !== activeWorkerRevision
  ) {
    return;
  }
  if (workerTimeout !== undefined) clearTimeout(workerTimeout);
  workerTimeout = undefined;
  activeWorkerRevision = undefined;
  pumpCompilerWorker();
  warmOfflineCache();
  if (event.data.revision !== currentRevision) return;

  const parsed = event.data.result;
  const diagnostics = parsed.diagnostics.map((diagnostic) => {
    const position =
      diagnostic.span === undefined
        ? undefined
        : offsetToPosition(sourceEditor.getValue(), diagnostic.span.start);
    return {
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
      line: position === undefined ? undefined : position.line + 1,
      column: position === undefined ? undefined : position.column + 1,
    };
  });

  const compilerDiagnostics = parsed.compilerDiagnostics.map((diagnostic) => {
    const position =
      diagnostic.span === undefined
        ? undefined
        : offsetToPosition(sourceEditor.getValue(), diagnostic.span.start);
    return {
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
      line: position === undefined ? undefined : position.line + 1,
      column: position === undefined ? undefined : position.column + 1,
    };
  });
  sourceEditor.setDiagnostics([...parsed.diagnostics, ...parsed.compilerDiagnostics]);
  const foldedOperations = parsed.semantics.filter(
    (summary) => summary.operatorDomain === 'compile-time',
  ).length;
  const sourceFunctions = parsed.semantics.filter((summary) => summary.kind === 'function').length;
  const syntaxErrors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const compilerErrors = compilerDiagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error',
  );
  const warnings = [...diagnostics, ...compilerDiagnostics].filter(
    (diagnostic) => diagnostic.severity === 'warning',
  );
  const valid = syntaxErrors.length === 0 && compilerErrors.length === 0;
  status.textContent =
    syntaxErrors.length > 0
      ? `${syntaxErrors.length} syntax error(s)`
      : compilerErrors.length > 0
        ? `${compilerErrors.length} compiler error(s)`
        : warnings.length > 0
          ? `${warnings.length} warning(s) · ${parsed.plan?.producers.length ?? 0} producers checked`
          : `executed JS · ${sourceFunctions} functions · ${parsed.plan?.producers.length ?? 0} producers · ${foldedOperations} folds ready`;
  status.dataset.state = valid ? (warnings.length > 0 ? 'warning' : 'valid') : 'invalid';
  if (!valid || parsed.plan === undefined) {
    const firstMessage = syntaxErrors[0]?.message ?? compilerErrors[0]?.message;
    renderProofError(firstMessage ?? 'The source produced no executable direct plan.');
    renderTestsBlocked('Fix the circuit source before running its tests.');
  } else {
    try {
      currentPlan = parsed.plan;
      renderSourceProof(parsed.plan, foldedOperations);
      scheduleTestRender();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Runtime proof failed.';
      status.textContent = 'runtime color/topology diagnostic';
      status.dataset.state = 'invalid';
      renderProofError(message);
      renderTestsBlocked('Fix the runtime topology diagnostic before running tests.');
    }
  }
  result.textContent =
    parsed.elaborationJavaScript ??
    [...diagnostics, ...compilerDiagnostics]
      .map(
        (diagnostic) =>
          `${diagnostic.code} ${diagnostic.severity}${diagnostic.line === undefined ? '' : ` at ${diagnostic.line}:${diagnostic.column ?? 1}`}: ${diagnostic.message}`,
      )
      .join('\n');
}

function handleWorkerError(event: ErrorEvent, worker: Worker): void {
  if (parserWorker !== worker) return;
  const failedRevision = activeWorkerRevision;
  if (workerTimeout !== undefined) clearTimeout(workerTimeout);
  workerTimeout = undefined;
  activeWorkerRevision = undefined;
  worker.terminate();
  parserWorker = undefined;
  if (failedRevision === currentRevision) {
    status.textContent = 'Worker failed';
    status.dataset.state = 'invalid';
    renderProofError(event.message || 'The compiler worker crashed.');
    renderTestsBlocked('The circuit compiler worker failed.');
    result.textContent = event.message;
  }
  pumpCompilerWorker();
}

function startCompilerWorker(request: CompilerWorkerRequest): void {
  queuedCompilerRequest = request;
  pumpCompilerWorker();
}

function ensureCompilerWorker(): Worker {
  if (parserWorker !== undefined) return parserWorker;
  const worker = new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' });
  parserWorker = worker;
  worker.addEventListener('message', (event: MessageEvent<CompilerWorkerResponse>) =>
    handleWorkerMessage(event, worker),
  );
  worker.addEventListener('error', (event) => handleWorkerError(event, worker));
  return worker;
}

function pumpCompilerWorker(): void {
  if (activeWorkerRevision !== undefined || queuedCompilerRequest === undefined) return;
  const request = queuedCompilerRequest;
  queuedCompilerRequest = undefined;
  const worker = ensureCompilerWorker();
  activeWorkerRevision = request.revision;
  worker.postMessage(request);
  workerTimeout = setTimeout(() => {
    if (parserWorker !== worker || activeWorkerRevision !== request.revision) return;
    worker.terminate();
    parserWorker = undefined;
    activeWorkerRevision = undefined;
    workerTimeout = undefined;
    if (request.revision === currentRevision) {
      status.textContent = 'Elaboration timed out';
      status.dataset.state = 'invalid';
      renderProofError('Compile-time execution exceeded the 1000 ms worker budget.');
      renderTestsBlocked('Circuit elaboration timed out, so tests were not run.');
      result.textContent =
        'EX1002 error: Compile-time execution exceeded the 1000 ms worker budget.';
    }
    pumpCompilerWorker();
  }, 1000);
}

registerOfflineSupport();
render();
