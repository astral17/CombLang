import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import { signal, type SignalId, type SignalType } from '@comblang/factorio';
import type { ResolvedCircuit } from '@comblang/compiler/resolved-circuit';
import { offsetToPosition, sourceFileId, sourceSpan, type Diagnostic } from '@comblang/shared';

import { blueprintJsonForArtifact } from './blueprint-demo.js';
import './blueprint-schema-catalog.js';
import { builtinPrototypeAsset, fetchBuiltinPrototypeAsset } from './builtin-prototype-asset.js';
import { createSourceEditor, type SourceEditorKind } from './code-editor.js';
import {
  compilerWorkerRequestTimeoutMs,
  compilerWorkerRequestTimeoutReason,
} from './compiler-worker-budget.js';
import { CompilerWorkerProgressTracker } from './compiler-worker-progress.js';
import {
  COMPILER_WORKER_BOOTSTRAP_TIMEOUT_MS,
  CompilerWorkerScheduler,
  compilerWorkerBootstrapTimeoutReason,
} from './compiler-worker-scheduler.js';
import { registerOfflineSupport, warmOfflineCache } from './offline.js';
import {
  browserPrototypeProfileStore,
  type StoredPrototypeProfile,
} from './prototype-profile-store.js';
import { rollbackPrototypeProfile } from './prototype-profile-transition.js';
import {
  PROFILE_SELECTION_KEY,
  resolvePrototypeProfileSelection,
} from './prototype-profile-selection.js';
import { loadSourceDraft, saveSourceDraft, type SourceDraftStorage } from './source-draft.js';
import { formatSourceDiagnostic, sourcePreviewDiagnostic } from './source-diagnostics.js';
import { sourceNavigationRange, testFailureRange } from './source-navigation.js';
import {
  runSourceCircuitDemo,
  SourceSimulationController,
  type CircuitTimelineSample,
  type SourcePlanDemo,
} from './source-demo.js';
import { createSourceCircuitArtifact } from './source-circuit-artifact.js';
import { loadTestDraft, saveTestDraft } from './test-draft.js';
import { TestTracePanel } from './test-trace-panel.js';
import type { TestWorkerRequest, TestWorkerResponse } from './test-worker-protocol.js';
import { buildDetailTimeline, buildOverviewTimeline, signalLabel } from './timeline-view.js';
import type {
  CompilerWorkerParsedResponse,
  CompilerWorkerRequest,
  CompilerWorkerResponse,
} from './worker-protocol.js';
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

function Gate(input: Readonly<Network>, threshold: Readonly<Network>): DeciderCombinator {
  return IF(input[SIGNAL_A] > threshold[SIGNAL_A], input[SIGNAL_A]);
}

const input = new Network<R>();
const middle = Scale(input);
const biased = Bias(middle);
const threshold = new Network();
threshold += CC(40 * SIGNAL_A).at(0.5, 2.5, 4);
const output = new Network();
const mirror = new Network();
Gate(biased, threshold).to(output, mirror);
`;

const sampleTests = `const SIGNAL_A = Signal("virtual", "signal-A");

test("gate opens above the threshold", ({ network, drive, tick, expectSignal, session }) => {
  session.trace(network("input"), network("output"));
  drive(network("input"), [[SIGNAL_A, 7]]);
  tick(5);
  expectSignal(network("output"), SIGNAL_A).toBe(41);
});

test("gate stays closed below the threshold", ({ network, drive, tick, expectSignal, session }) => {
  session.trace(network("input"), network("output"));
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
const proofFeedback = requiredElement<HTMLElement>('#proof-feedback');
const proofLatency = requiredElement<HTMLElement>('#proof-latency');
const proofFolds = requiredElement<HTMLElement>('#proof-folds');
const waveform = requiredElement<HTMLElement>('#waveform');
const waveformNetwork = requiredElement<HTMLSelectElement>('#waveform-network');
const waveformViewLabel = requiredElement<HTMLElement>('#waveform-view-label');
const simulationStatus = requiredElement<HTMLOutputElement>('#simulation-status');
const simulationReset = requiredElement<HTMLButtonElement>('#simulation-reset');
const simulationPlay = requiredElement<HTMLButtonElement>('#simulation-play');
const simulationStep = requiredElement<HTMLButtonElement>('#simulation-step');
const simulationTick = requiredElement<HTMLInputElement>('#simulation-tick');
const simulationSelectTick = requiredElement<HTMLButtonElement>('#simulation-select-tick');
const simulationStepCount = requiredElement<HTMLInputElement>('#simulation-step-count');
const simulationRun = requiredElement<HTMLButtonElement>('#simulation-run');
const timelineWindow = requiredElement<HTMLInputElement>('#timeline-window');
const stateEditor = requiredElement<HTMLFormElement>('#state-editor');
const stateNetwork = requiredElement<HTMLSelectElement>('#state-network');
const stateSignalType = requiredElement<HTMLSelectElement>('#state-signal-type');
const stateSignalName = requiredElement<HTMLInputElement>('#state-signal-name');
const stateSignalQuality = requiredElement<HTMLInputElement>('#state-signal-quality');
const stateSignalValue = requiredElement<HTMLInputElement>('#state-signal-value');
const stateRemoveSignal = requiredElement<HTMLButtonElement>('#state-remove-signal');
const stateClearNetwork = requiredElement<HTMLButtonElement>('#state-clear-network');
const stateStatus = requiredElement<HTMLOutputElement>('#state-status');
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
const testTracePanel = new TestTracePanel(requiredElement<HTMLElement>('#test-trace'), (span) => {
  const range = sourceNavigationRange(
    sourceEditor.getValue(),
    sourceFileId('main.factorio.ts'),
    span,
  );
  if (range !== undefined) sourceEditor.revealRange(range.start, range.end);
});
const addTest = requiredElement<HTMLButtonElement>('#add-test');
const prototypeProfileFile = requiredElement<HTMLInputElement>('#prototype-profile-file');
const prototypeProfileClear = requiredElement<HTMLButtonElement>('#prototype-profile-clear');
const prototypeProfileStatus = requiredElement<HTMLOutputElement>('#prototype-profile-status');
let parserWorker: Worker | undefined;
const compilerWorkerScheduler = new CompilerWorkerScheduler();
const compilerWorkerProgress = new CompilerWorkerProgressTracker();
let parserWorkerId: number | undefined;
let workerBootstrapTimeout: ReturnType<typeof setTimeout> | undefined;
let workerTimeout: ReturnType<typeof setTimeout> | undefined;
let currentRevision = 0;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
let currentBlueprintJson: string | undefined;
let currentPlan: DirectElaborationPlan | undefined;
let currentDemo: SourcePlanDemo | undefined;
let sourceSimulation: SourceSimulationController | undefined;
let selectedSimulationTick = 0;
let simulationTimer: ReturnType<typeof setInterval> | undefined;
let testWorker: Worker | undefined;
let testWorkerTimeout: ReturnType<typeof setTimeout> | undefined;
let testRenderTimer: ReturnType<typeof setTimeout> | undefined;
let testRevision = 0;
let addedTestNumber = 1;
let activePrototypeProfile: StoredPrototypeProfile | undefined;
let activePrototypeProfileIsBuiltin = false;
let profileBeforeSelection: StoredPrototypeProfile | undefined;
let profileBeforeSelectionIsBuiltin = false;
let workerIdentityBeforeSelection: string | undefined;
let pendingProfileSelection = false;
let workerPrototypeIdentity: string | undefined;
let profileSelectionRevision = 0;
let profileReady = false;
let profileRestoreError: string | undefined;
let profileNotice: string | undefined;
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
  testEditor.insertText(`test("new circuit test ${number}", ({ network, tick, expectSignal, session }) => {
  const SIGNAL_A = Signal("virtual", "signal-A");
  session.trace(network("output"));
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

function pauseSimulation(): void {
  if (simulationTimer !== undefined) clearInterval(simulationTimer);
  simulationTimer = undefined;
  simulationPlay.textContent = 'Play';
}

function setSimulationEnabled(enabled: boolean): void {
  for (const control of [
    simulationReset,
    simulationPlay,
    simulationStep,
    simulationTick,
    simulationSelectTick,
    simulationStepCount,
    simulationRun,
    timelineWindow,
    stateNetwork,
    stateSignalType,
    stateSignalName,
    stateSignalQuality,
    stateSignalValue,
    stateRemoveSignal,
    stateClearNetwork,
    ...stateEditor.querySelectorAll<HTMLButtonElement>('button'),
  ]) {
    control.disabled = !enabled;
  }
}

function boundedInputValue(input: HTMLInputElement, fallback: number, maximum: number): number {
  const value = Number(input.value);
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : fallback;
}

function visibleTimeline(): readonly CircuitTimelineSample[] {
  const timeline = sourceSimulation?.timeline ?? currentDemo?.timeline ?? [];
  const windowSize = boundedInputValue(timelineWindow, 32, 512);
  if (timeline.length <= windowSize) return timeline;
  const selectedIndex = Math.max(
    0,
    timeline.findIndex(({ tick }) => tick === selectedSimulationTick),
  );
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor((windowSize - 1) / 2)),
    timeline.length - windowSize,
  );
  return timeline.slice(start, start + windowSize);
}

function syncSimulationDemo(): void {
  if (currentDemo === undefined || sourceSimulation === undefined) return;
  currentDemo = { ...currentDemo, timeline: sourceSimulation.timeline };
}

function refreshSimulationSummary(): void {
  const controller = sourceSimulation;
  if (controller === undefined || currentDemo === undefined) {
    simulationStatus.textContent = 'No simulation';
    setSimulationEnabled(false);
    return;
  }
  setSimulationEnabled(true);
  const latest = controller.currentTick;
  simulationTick.max = String(latest);
  simulationTick.value = String(selectedSimulationTick);
  simulationStatus.textContent = `T${selectedSimulationTick} selected · latest T${latest} · ${simulationTimer === undefined ? 'paused' : 'playing'}`;
  const output =
    currentDemo.outputNetwork === undefined
      ? undefined
      : controller.signalValueAt(
          selectedSimulationTick,
          currentDemo.outputNetwork,
          signal('virtual', 'signal-A'),
        );
  proofTitle.textContent =
    output === undefined
      ? `T${selectedSimulationTick} selected`
      : `T${selectedSimulationTick} · output signal-A = ${output}`;
  proofDescription.textContent =
    selectedSimulationTick === 0
      ? 'Simulation starts paused at T0 with every Network empty; every absent signal reads as zero. Edit this snapshot or advance time.'
      : 'Select any captured row to inspect it. Editing or stepping from an older tick creates a new branch and discards its computed future.';
}

function renderSimulation(): void {
  syncSimulationDemo();
  refreshSimulationSummary();
  renderTimeline();
}

function selectSimulationTick(tick: number): void {
  if (!sourceSimulation?.timeline.some((sample) => sample.tick === tick)) return;
  pauseSimulation();
  selectedSimulationTick = tick;
  stateStatus.textContent = '';
  renderSimulation();
}

function advanceSimulation(count: number): void {
  const controller = sourceSimulation;
  if (controller === undefined) return;
  controller.stepFrom(selectedSimulationTick, count);
  selectedSimulationTick = controller.currentTick;
  stateStatus.textContent = '';
  renderSimulation();
}

function selectedStateSignal(): SignalId {
  const name = stateSignalName.value.trim();
  const quality = stateSignalQuality.value.trim();
  if (name.length === 0) throw new TypeError('Signal name cannot be empty.');
  return signal(
    stateSignalType.value as SignalType,
    name,
    quality.length === 0 ? undefined : quality,
  );
}

function editSelectedSignal(value: number): void {
  const controller = sourceSimulation;
  if (controller === undefined) return;
  if (!Number.isSafeInteger(value)) throw new RangeError('Signal value must be a safe integer.');
  controller.setSignalAt(
    selectedSimulationTick,
    stateNetwork.value as CircuitTimelineSample['networks'][number]['id'],
    selectedStateSignal(),
    value,
  );
  pauseSimulation();
  stateStatus.textContent =
    value === 0
      ? `Signal removed at T${selectedSimulationTick}.`
      : `Snapshot T${selectedSimulationTick} updated.`;
  renderSimulation();
}

function reportStateEdit(error: unknown): void {
  stateStatus.textContent = error instanceof Error ? error.message : String(error);
}

function openStateEditor(
  tick: number,
  networkId: string,
  entry?: { readonly signal: SignalId; readonly value: number },
): void {
  selectSimulationTick(tick);
  stateNetwork.value = networkId;
  if (entry === undefined) {
    stateStatus.textContent = `Editing Network at T${tick}; enter a Signal that is currently absent.`;
    stateSignalName.focus();
    stateSignalName.select();
    return;
  }
  stateSignalType.value = entry.signal.type;
  stateSignalName.value = entry.signal.name;
  stateSignalQuality.value = entry.signal.quality ?? '';
  stateSignalValue.value = String(entry.value);
  stateStatus.textContent = `Loaded ${signalLabel(entry.signal)} from T${tick}.`;
  stateSignalValue.focus();
  stateSignalValue.select();
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

  const timeline = visibleTimeline();
  const selected = waveformNetwork.value;
  if (selected === '') {
    waveformViewLabel.textContent = 'Networks overview';
    const model = buildOverviewTimeline(timeline);
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
      element.dataset.selected = String(row.tick === selectedSimulationTick);
      element.title = `Select T${row.tick}`;
      element.addEventListener('click', () => selectSimulationTick(row.tick));
      const tick = document.createElement('th');
      tick.scope = 'row';
      tick.textContent = `T${row.tick}`;
      element.append(tick);
      row.cells.forEach((cell, networkIndex) => {
        const value = document.createElement('td');
        const network = model.networks[networkIndex]!;
        const sourceEntry = timeline
          .find(({ tick }) => tick === row.tick)
          ?.networks.find(({ id }) => id === network.id)?.signals[0];
        value.title = 'Double-click to edit this Network snapshot';
        value.addEventListener('dblclick', (event) => {
          event.stopPropagation();
          openStateEditor(row.tick, network.id, cell.lines.length === 1 ? sourceEntry : undefined);
        });
        if (cell.lines.length === 0) {
          value.className = 'timeline-empty';
          value.textContent = '0';
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
      });
      body.append(element);
    }
    waveform.replaceChildren(table);
    return;
  }

  const detail = buildDetailTimeline(timeline, selected);
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
    element.dataset.selected = String(row.tick === selectedSimulationTick);
    element.title = `Select T${row.tick}`;
    element.addEventListener('click', () => selectSimulationTick(row.tick));
    const tick = document.createElement('th');
    tick.scope = 'row';
    tick.textContent = `T${row.tick}`;
    element.append(tick);
    row.values.forEach((value, signalIndex) => {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      if (value === 0) cell.className = 'timeline-zero';
      const signalId = detail.signals[signalIndex]!;
      cell.title = `Double-click to edit ${signalLabel(signalId)}`;
      cell.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        openStateEditor(row.tick, detail.network.id, { signal: signalId, value });
      });
      element.append(cell);
    });
    body.append(element);
  }
  if (detail.signals.length === 0) {
    const row = document.createElement('tr');
    const empty = document.createElement('td');
    empty.colSpan = 2;
    empty.className = 'timeline-empty';
    empty.textContent = 'No non-zero signals in this window; every signal reads as 0.';
    row.append(empty);
    body.replaceChildren(row);
  }
  waveform.replaceChildren(table);
}

function updateTimelineTargets(demo: SourcePlanDemo): void {
  const previous = waveformNetwork.value;
  const previousStateNetwork = stateNetwork.value;
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
  stateNetwork.replaceChildren(
    ...networks.map((network) =>
      Object.assign(document.createElement('option'), {
        value: network.id,
        textContent: displayNetworkName(network.name),
      }),
    ),
  );
  const stateDefault = networks.find(({ name }) => name === demo.inputNetwork) ?? networks[0];
  stateNetwork.value = networks.some(({ id }) => id === previousStateNetwork)
    ? previousStateNetwork
    : (stateDefault?.id ?? '');
  renderTimeline();
}

waveformNetwork.addEventListener('change', renderTimeline);
timelineWindow.addEventListener('input', renderTimeline);
simulationReset.addEventListener('click', () => {
  pauseSimulation();
  sourceSimulation?.reset();
  selectedSimulationTick = 0;
  stateStatus.textContent = 'Reset to all-zero T0.';
  renderSimulation();
});
simulationPlay.addEventListener('click', () => {
  if (simulationTimer !== undefined) {
    pauseSimulation();
    refreshSimulationSummary();
    return;
  }
  if (sourceSimulation === undefined) return;
  simulationPlay.textContent = 'Pause';
  simulationTimer = setInterval(() => advanceSimulation(1), 350);
  refreshSimulationSummary();
});
simulationStep.addEventListener('click', () => {
  pauseSimulation();
  advanceSimulation(1);
});
simulationSelectTick.addEventListener('click', () => {
  const tick = Number(simulationTick.value);
  if (
    !Number.isSafeInteger(tick) ||
    tick < 0 ||
    !sourceSimulation?.timeline.some((sample) => sample.tick === tick)
  ) {
    stateStatus.textContent = `Tick must be an integer from 0 to ${sourceSimulation?.currentTick ?? 0}.`;
    return;
  }
  selectSimulationTick(tick);
});
simulationRun.addEventListener('click', () => {
  pauseSimulation();
  advanceSimulation(boundedInputValue(simulationStepCount, 10, 10_000));
});
stateEditor.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    editSelectedSignal(Number(stateSignalValue.value));
  } catch (error) {
    reportStateEdit(error);
  }
});
stateRemoveSignal.addEventListener('click', () => {
  try {
    editSelectedSignal(0);
  } catch (error) {
    reportStateEdit(error);
  }
});
stateClearNetwork.addEventListener('click', () => {
  try {
    const controller = sourceSimulation;
    if (controller === undefined) return;
    pauseSimulation();
    controller.clearNetworkAt(
      selectedSimulationTick,
      stateNetwork.value as CircuitTimelineSample['networks'][number]['id'],
    );
    stateStatus.textContent = `Network cleared at T${selectedSimulationTick}.`;
    renderSimulation();
  } catch (error) {
    reportStateEdit(error);
  }
});

function renderProofPending(): void {
  pauseSimulation();
  setSimulationEnabled(false);
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

function renderProofError(message: string, compiledPlan?: DirectElaborationPlan): void {
  pauseSimulation();
  currentPlan = compiledPlan;
  currentDemo = undefined;
  sourceSimulation = undefined;
  selectedSimulationTick = 0;
  setSimulationEnabled(false);
  simulationStatus.textContent = 'No simulation';
  stateStatus.textContent = '';
  proof.dataset.state = 'invalid';
  proof.setAttribute('aria-busy', 'false');
  proofTitle.textContent =
    compiledPlan === undefined
      ? 'Current source is not simulatable yet'
      : 'Circuit compiled; preview failed';
  proofDescription.textContent = message;
  proofCombinators.textContent = '—';
  proofAttachments.textContent = '—';
  proofStages.textContent = '—';
  proofFeedback.textContent = '—';
  proofLatency.textContent = '—';
  proofFolds.textContent = '—';
  const empty = document.createElement('p');
  empty.className = 'proof-empty';
  empty.textContent =
    compiledPlan === undefined
      ? 'Fix the source diagnostic to resume the live proof.'
      : 'The source compiled successfully, but the preview failed. Circuit tests remain available.';
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
  plan: DirectElaborationPlan,
  foldedOperations: number,
  resolvedCircuit?: ResolvedCircuit,
): void {
  pauseSimulation();
  const artifact =
    resolvedCircuit === undefined
      ? createSourceCircuitArtifact(plan)
      : createSourceCircuitArtifact(plan, resolvedCircuit);
  const controller = new SourceSimulationController(artifact);
  sourceSimulation = controller;
  selectedSimulationTick = 0;
  const demo = { ...runSourceCircuitDemo(artifact, 0, 0), timeline: controller.timeline };
  currentDemo = demo;
  proof.dataset.state = 'valid';
  proof.setAttribute('aria-busy', 'false');
  stateStatus.textContent = '';
  proofCombinators.textContent = String(demo.combinators);
  proofAttachments.textContent = String(demo.attachments);
  proofStages.textContent = demo.graphMetrics.depth?.toString() ?? 'unknown';
  proofFeedback.textContent = String(demo.graphMetrics.feedbackComponents.length);
  proofLatency.textContent = demo.graphMetrics.unknownLatency ? 'unknown' : 'known';
  proofFolds.textContent = String(foldedOperations);
  const callPaths = new Map<string, Set<string>>();
  for (const producer of plan.producers) {
    for (const path of producer.instancePath) {
      const kinds = callPaths.get(path) ?? new Set<string>();
      kinds.add(producer.kind);
      callPaths.set(path, kinds);
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
  refreshSimulationSummary();
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
  const generated = blueprintJsonForArtifact(artifact);
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
  testTracePanel.clear(message);
  for (const button of testResults.querySelectorAll('button')) button.disabled = true;
  testStatus.textContent = message;
  testStatus.dataset.state = 'pending';
}

function renderTestsBlocked(message: string): void {
  testTracePanel.clear(message);
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
  testTracePanel.setRun(run);
  testStatus.textContent = `${run.passed} passed · ${run.failed} failed`;
  testStatus.dataset.state = run.failed === 0 ? 'valid' : 'invalid';
  const source = testEditor.getValue();
  const fileId = sourceFileId('circuit.test.js');
  const diagnostics: Diagnostic[] = [];
  const items = run.results.map((testResult, index) => {
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
    if (testResult.trace !== undefined) {
      const trace = document.createElement('button');
      trace.type = 'button';
      trace.className = 'view-test-trace';
      trace.textContent = 'View trace';
      trace.addEventListener('click', () => testTracePanel.show(index));
      heading.append(trace);
    }
    if (testResult.code !== undefined) {
      const code = document.createElement('code');
      code.textContent = testResult.code;
      heading.append(code);
    }
    if (testResult.line !== undefined) {
      const location = document.createElement('button');
      location.type = 'button';
      location.textContent = `line ${testResult.line}${testResult.column === undefined ? '' : `:${testResult.column}`}`;
      location.title = 'Failure location in circuit.test.js';
      const selection = testFailureRange(source, testResult.line, testResult.column);
      location.disabled = selection === undefined;
      location.addEventListener('click', () => {
        if (selection !== undefined) testEditor.revealRange(selection.start, selection.end);
      });
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
    if (testResult.message !== undefined || testResult.candidates !== undefined) {
      const message = document.createElement('pre');
      message.textContent = [
        ...(testResult.message === undefined ? [] : [testResult.message]),
        ...(testResult.candidates === undefined || testResult.candidates.length === 0
          ? []
          : [
              `Candidates:\n${testResult.candidates.map((candidate) => `  - ${candidate}`).join('\n')}`,
            ]),
      ].join('\n');
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
  if (!profileReady) return;
  if (profileRestoreError !== undefined) {
    status.textContent = 'Profile unavailable';
    status.dataset.state = 'invalid';
    renderProofError(profileRestoreError);
    renderTestsBlocked('Load or disable the unavailable prototype profile.');
    return;
  }
  currentRevision += 1;
  const request: CompilerWorkerRequest = {
    kind: 'parse',
    revision: currentRevision,
    file: { path: 'main.factorio.ts', text: sourceEditor.getValue() },
    ...(activePrototypeProfile === undefined
      ? {}
      : {
          prototypeProfile:
            workerPrototypeIdentity !== undefined &&
            workerPrototypeIdentity === activePrototypeProfile.identity
              ? {
                  identity: workerPrototypeIdentity,
                  kind: activePrototypeProfileIsBuiltin ? 'builtin' : 'custom',
                }
              : {
                  source: activePrototypeProfile.source,
                  kind: activePrototypeProfileIsBuiltin ? 'builtin' : 'custom',
                  ...(activePrototypeProfile.factorioDumpMetadata === undefined
                    ? {}
                    : { factorioDumpMetadata: activePrototypeProfile.factorioDumpMetadata }),
                  ...(activePrototypeProfile.assetManifest === undefined
                    ? {}
                    : { assetManifest: activePrototypeProfile.assetManifest }),
                  ...(activePrototypeProfile.identity === undefined
                    ? {}
                    : { expectedIdentity: activePrototypeProfile.identity }),
                },
        }),
  };
  status.textContent = 'Parsing…';
  status.dataset.state = 'pending';
  renderProofPending();
  startCompilerWorker(request);
}

function scheduleRender(): void {
  saveSourceDraft(draftStorage, sourceEditor.getValue());
  currentRevision += 1;
  testRevision += 1;
  terminateTestWorker();
  if (testRenderTimer !== undefined) clearTimeout(testRenderTimer);
  testRenderTimer = undefined;
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

function handleWorkerMessage(
  event: MessageEvent<CompilerWorkerResponse>,
  worker: Worker,
  workerId: number,
): void {
  if (parserWorker !== worker || !compilerWorkerScheduler.isCurrent(workerId)) return;
  if (event.data.kind === 'ready') {
    if (!compilerWorkerScheduler.markReady(workerId)) return;
    if (workerBootstrapTimeout !== undefined) clearTimeout(workerBootstrapTimeout);
    workerBootstrapTimeout = undefined;
    pumpCompilerWorker();
    return;
  }
  if (event.data.kind === 'progress') {
    if (compilerWorkerScheduler.activeRevision !== event.data.revision) return;
    compilerWorkerProgress.report(workerId, event.data.revision, event.data.stage);
    return;
  }
  if (
    compilerWorkerScheduler.activeRevision !== event.data.revision ||
    !compilerWorkerScheduler.complete(workerId, event.data.revision)
  ) {
    return;
  }
  compilerWorkerProgress.clear();
  if (workerTimeout !== undefined) clearTimeout(workerTimeout);
  workerTimeout = undefined;
  warmOfflineCache();
  if (event.data.revision !== currentRevision) {
    pumpCompilerWorker();
    return;
  }

  const parsed = event.data.result;
  if (event.data.prototypeEnvironment !== undefined && activePrototypeProfile !== undefined) {
    workerPrototypeIdentity = event.data.prototypeEnvironment.identity;
    const needsSave =
      !activePrototypeProfileIsBuiltin && activePrototypeProfile.identity === undefined;
    activePrototypeProfile = {
      ...activePrototypeProfile,
      identity: event.data.prototypeEnvironment.identity,
    };
    pendingProfileSelection = false;
    profileBeforeSelection = undefined;
    profileBeforeSelectionIsBuiltin = false;
    workerIdentityBeforeSelection = undefined;
    const formatLabel =
      event.data.prototypeEnvironment.format === 'factorio-data-raw' ? 'raw dump' : 'normalized';
    const warningLabel =
      event.data.prototypeEnvironment.warnings.length === 0
        ? ''
        : ` · ${event.data.prototypeEnvironment.warnings.length} warning(s)`;
    const profileStatus = `${activePrototypeProfile.name} · ${formatLabel} · Factorio ${event.data.prototypeEnvironment.factorioVersion}${warningLabel} · ${event.data.prototypeEnvironment.identity}`;
    prototypeProfileStatus.textContent = profileNotice ?? profileStatus;
    profileNotice = undefined;
    prototypeProfileStatus.dataset.state = 'valid';
    prototypeProfileClear.disabled = false;
    if (needsSave) {
      const selected = activePrototypeProfile;
      const selectionRevision = profileSelectionRevision;
      void browserPrototypeProfileStore(event.data.prototypeEnvironment.identity)
        .save(selected)
        .then((saved) => {
          if (selectionRevision !== profileSelectionRevision) return;
          try {
            if (!saved || draftStorage === undefined) throw new Error('Storage unavailable');
            draftStorage.setItem(PROFILE_SELECTION_KEY, selected.identity!);
          } catch {
            prototypeProfileStatus.textContent += ' · not saved: browser storage unavailable';
          }
        });
    }
  } else if (activePrototypeProfile !== undefined) {
    workerPrototypeIdentity = undefined;
    const profileError = parsed.compilerDiagnostics.find(({ code }) => /^(PA|PT|WP)/.test(code));
    const importError = parsed.compilerDiagnostics.find(({ code }) =>
      /^(PA|PI|PD|PT|WP)/.test(code),
    );
    if (activePrototypeProfileIsBuiltin && importError !== undefined) {
      activePrototypeProfile = undefined;
      activePrototypeProfileIsBuiltin = false;
      workerPrototypeIdentity = undefined;
      pendingProfileSelection = false;
      const notice = `Built-in prototype profile unavailable (${importError.code}): ${importError.message}; ordinary circuits remain available.`;
      profileNotice = undefined;
      prototypeProfileStatus.textContent = notice;
      prototypeProfileStatus.dataset.state = 'warning';
      prototypeProfileClear.disabled = true;
      scheduleRender();
      return;
    }
    if (pendingProfileSelection && importError !== undefined) {
      if (
        rollbackPendingPrototypeProfile(
          `import failed (${importError.code}): ${importError.message}`,
        )
      ) {
        scheduleRender();
      }
      return;
    }
    prototypeProfileStatus.textContent =
      profileError === undefined
        ? `${activePrototypeProfile.name} · loading…`
        : `${activePrototypeProfile.name} · ${profileError.code}: ${profileError.message}`;
    prototypeProfileStatus.dataset.state = profileError === undefined ? 'pending' : 'invalid';
    prototypeProfileClear.disabled = false;
  }
  const syntaxDiagnostics = parsed.diagnostics.map((diagnostic) => {
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

  const diagnostics = parsed.pipelineDiagnostics.map((diagnostic) => {
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
  sourceEditor.setDiagnostics(parsed.pipelineDiagnostics);
  const foldedOperations = parsed.semantics.filter(
    (summary) => summary.operatorDomain === 'compile-time',
  ).length;
  const sourceFunctions = parsed.semantics.filter((summary) => summary.kind === 'function').length;
  const syntaxErrors = syntaxDiagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const compilerErrors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
  const notes = diagnostics.filter((diagnostic) => diagnostic.severity === 'note');
  const hints = diagnostics.filter((diagnostic) => diagnostic.severity === 'hint');
  const advisories = warnings.length + notes.length + hints.length;
  const advisorySummary = [
    warnings.length === 0 ? '' : `${warnings.length} warning(s)`,
    notes.length === 0 ? '' : `${notes.length} note(s)`,
    hints.length === 0 ? '' : `${hints.length} hint(s)`,
  ]
    .filter(Boolean)
    .join(' · ');
  const valid = syntaxErrors.length === 0 && compilerErrors.length === 0;
  status.textContent =
    syntaxErrors.length > 0
      ? `${syntaxErrors.length} syntax error(s)`
      : compilerErrors.length > 0
        ? `${compilerErrors.length} compiler error(s)`
        : advisories > 0
          ? `${advisorySummary} · ${parsed.plan?.producers.length ?? 0} producers checked`
          : `executed JS · ${sourceFunctions} functions · ${parsed.plan?.producers.length ?? 0} producers · ${foldedOperations} folds ready`;
  status.dataset.state = valid ? (advisories > 0 ? 'warning' : 'valid') : 'invalid';
  if (!valid || parsed.plan === undefined) {
    const firstError = parsed.pipelineDiagnostics.find(({ severity }) => severity === 'error');
    renderProofError(
      firstError === undefined
        ? 'The source produced no executable direct plan.'
        : formatSourceDiagnostic(firstError, sourceEditor.getValue()),
    );
    renderTestsBlocked('Fix the circuit source before running its tests.');
  } else {
    const previewPlan = parsed.plan;
    try {
      currentPlan = previewPlan;
      renderSourceProof(previewPlan, foldedOperations, parsed.resolvedCircuit);
      scheduleTestRender();
    } catch (error) {
      const diagnostic = sourcePreviewDiagnostic(error);
      status.textContent = diagnostic.code === 'WEB1001' ? 'preview error' : 'runtime diagnostic';
      status.dataset.state = 'invalid';
      sourceEditor.setDiagnostics([...parsed.pipelineDiagnostics, diagnostic]);
      renderProofError(formatSourceDiagnostic(diagnostic, sourceEditor.getValue()), previewPlan);
      // Preview failures do not turn a successfully compiled circuit into invalid source.
      scheduleTestRender();
    }
  }
  result.textContent =
    parsed.elaborationJavaScript ??
    parsed.pipelineDiagnostics
      .map((diagnostic) => formatSourceDiagnostic(diagnostic, sourceEditor.getValue()))
      .join('\n');
  pumpCompilerWorker();
}

function handleWorkerBootstrapTimeout(worker: Worker, workerId: number): void {
  if (
    parserWorker !== worker ||
    !compilerWorkerScheduler.isCurrent(workerId) ||
    compilerWorkerScheduler.phase !== 'booting'
  ) {
    return;
  }
  workerBootstrapTimeout = undefined;
  compilerWorkerProgress.clear();
  worker.terminate();
  parserWorker = undefined;
  parserWorkerId = undefined;
  workerPrototypeIdentity = undefined;
  compilerWorkerScheduler.fail(workerId);
  const bootstrapFailure = compilerWorkerBootstrapTimeoutReason();
  const rolledBack = rollbackPendingPrototypeProfile(
    `Worker bootstrap timeout: ${bootstrapFailure}`,
  );
  status.textContent = 'Compiler Worker did not become ready';
  status.dataset.state = 'invalid';
  renderProofError(bootstrapFailure);
  renderTestsBlocked('The compiler Worker did not become ready.');
  result.textContent = bootstrapFailure;
  if (rolledBack) scheduleRender();
  else pumpCompilerWorker();
}

function handleWorkerError(event: ErrorEvent, worker: Worker, workerId: number): void {
  if (parserWorker !== worker || !compilerWorkerScheduler.isCurrent(workerId)) return;
  const failedRevision = compilerWorkerScheduler.activeRevision;
  const wasBooting = compilerWorkerScheduler.phase === 'booting';
  if (workerTimeout !== undefined) clearTimeout(workerTimeout);
  workerTimeout = undefined;
  if (workerBootstrapTimeout !== undefined) clearTimeout(workerBootstrapTimeout);
  workerBootstrapTimeout = undefined;
  compilerWorkerProgress.clear();
  worker.terminate();
  parserWorker = undefined;
  parserWorkerId = undefined;
  workerPrototypeIdentity = undefined;
  compilerWorkerScheduler.fail(workerId);
  const failureMessage = event.message || 'the compiler Worker crashed.';
  const rolledBack = rollbackPendingPrototypeProfile(`Worker failed: ${failureMessage}`);
  if (wasBooting) {
    const bootstrapFailure = `Compiler Worker failed before readiness: ${failureMessage}`;
    status.textContent = 'Compiler Worker failed to start';
    status.dataset.state = 'invalid';
    renderProofError(bootstrapFailure);
    renderTestsBlocked('The compiler Worker failed before it became ready.');
    result.textContent = bootstrapFailure;
  } else if (failedRevision === currentRevision) {
    status.textContent = 'Worker failed';
    status.dataset.state = 'invalid';
    renderProofError(failureMessage);
    renderTestsBlocked('The compiler circuit Worker failed.');
    result.textContent = failureMessage;
  }
  if (rolledBack) scheduleRender();
  else pumpCompilerWorker();
}

function rollbackPendingPrototypeProfile(failureMessage: string): boolean {
  if (!pendingProfileSelection || activePrototypeProfile === undefined) return false;
  const result = rollbackPrototypeProfile(
    activePrototypeProfile.name,
    profileBeforeSelection,
    workerIdentityBeforeSelection,
    failureMessage,
  );
  pendingProfileSelection = false;
  activePrototypeProfile = result.activeProfile;
  activePrototypeProfileIsBuiltin = result.restored && profileBeforeSelectionIsBuiltin;
  workerPrototypeIdentity = result.workerIdentity;
  profileBeforeSelection = undefined;
  profileBeforeSelectionIsBuiltin = false;
  workerIdentityBeforeSelection = undefined;
  profileReady = true;
  profileRestoreError = undefined;
  profileNotice = result.restored ? result.message : undefined;
  prototypeProfileStatus.textContent = result.message;
  prototypeProfileStatus.dataset.state = result.restored ? 'valid' : 'invalid';
  prototypeProfileClear.disabled = !result.restored;
  return true;
}

function startCompilerWorker(request: CompilerWorkerRequest): void {
  compilerWorkerScheduler.enqueue(request);
  pumpCompilerWorker();
}

function ensureCompilerWorker(): Worker {
  if (parserWorker !== undefined) return parserWorker;
  workerPrototypeIdentity = undefined;
  const worker = new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' });
  parserWorker = worker;
  const workerId = compilerWorkerScheduler.createWorker();
  parserWorkerId = workerId;
  worker.addEventListener('message', (event: MessageEvent<CompilerWorkerResponse>) =>
    handleWorkerMessage(event, worker, workerId),
  );
  worker.addEventListener('error', (event) => handleWorkerError(event, worker, workerId));
  workerBootstrapTimeout = setTimeout(() => {
    handleWorkerBootstrapTimeout(worker, workerId);
  }, COMPILER_WORKER_BOOTSTRAP_TIMEOUT_MS);
  return worker;
}

function pumpCompilerWorker(): void {
  if (!compilerWorkerScheduler.hasQueuedRequest || compilerWorkerScheduler.phase === 'busy') {
    return;
  }
  const worker = ensureCompilerWorker();
  if (compilerWorkerScheduler.phase !== 'ready') return;
  const dispatch = compilerWorkerScheduler.takeForDispatch();
  if (dispatch === undefined) return;
  let request = dispatch.request;
  if (
    request.prototypeProfile !== undefined &&
    'identity' in request.prototypeProfile &&
    request.prototypeProfile.identity !== workerPrototypeIdentity &&
    activePrototypeProfile?.identity === request.prototypeProfile.identity
  ) {
    request = {
      ...request,
      prototypeProfile: {
        source: activePrototypeProfile.source,
        ...(request.prototypeProfile.kind === undefined
          ? {}
          : { kind: request.prototypeProfile.kind }),
        ...(activePrototypeProfile.factorioDumpMetadata === undefined
          ? {}
          : { factorioDumpMetadata: activePrototypeProfile.factorioDumpMetadata }),
        ...(activePrototypeProfile.assetManifest === undefined
          ? {}
          : { assetManifest: activePrototypeProfile.assetManifest }),
        expectedIdentity: request.prototypeProfile.identity,
      },
    };
  }
  const workerId = parserWorkerId;
  if (workerId === undefined)
    throw new Error('Compiler Worker scheduler lost its Worker identity.');
  compilerWorkerProgress.begin(workerId, request.revision);
  worker.postMessage(request);
  const timeoutMs = compilerWorkerRequestTimeoutMs(request, dispatch.isCold);
  workerTimeout = setTimeout(() => {
    if (
      parserWorker !== worker ||
      !compilerWorkerScheduler.isCurrent(workerId) ||
      compilerWorkerScheduler.activeRevision !== request.revision
    ) {
      return;
    }
    const lastStage = compilerWorkerProgress.lastStage(workerId, request.revision);
    worker.terminate();
    parserWorker = undefined;
    parserWorkerId = undefined;
    workerPrototypeIdentity = undefined;
    workerTimeout = undefined;
    compilerWorkerProgress.clear();
    compilerWorkerScheduler.fail(workerId);
    const timeoutReason = compilerWorkerRequestTimeoutReason(request, timeoutMs, lastStage);
    const testsBlockedReason =
      lastStage === undefined
        ? 'Circuit elaboration timed out, so tests were not run.'
        : `Circuit elaboration timed out, so tests were not run (last reported phase: ${lastStage}).`;
    const rolledBack = rollbackPendingPrototypeProfile(
      `request timeout (EX1002): ${timeoutReason}`,
    );
    if (request.revision === currentRevision) {
      status.textContent = 'Elaboration timed out';
      status.dataset.state = 'invalid';
      renderProofError(timeoutReason);
      renderTestsBlocked(testsBlockedReason);
      result.textContent = `EX1002 error: ${timeoutReason}`;
    }
    if (rolledBack) scheduleRender();
    else pumpCompilerWorker();
  }, timeoutMs);
}

registerOfflineSupport();

prototypeProfileFile.addEventListener('change', () => {
  const files = [...(prototypeProfileFile.files ?? [])];
  if (files.length === 0) return;
  const selectionRevision = ++profileSelectionRevision;
  profileBeforeSelection = activePrototypeProfile;
  profileBeforeSelectionIsBuiltin = activePrototypeProfileIsBuiltin;
  workerIdentityBeforeSelection = workerPrototypeIdentity;
  pendingProfileSelection = false;
  profileNotice = undefined;
  workerPrototypeIdentity = undefined;
  profileReady = false;
  prototypeProfileStatus.textContent = `${files.map(({ name }) => name).join(' + ')} · reading…`;
  prototypeProfileClear.disabled = false;
  scheduleRender();
  const metadataName = (file: File): boolean =>
    /(^|[._-])(metadata|environment|profile)([._-]|$)/i.test(file.name);
  let sourceFile: File;
  let metadataFile: File | undefined;
  try {
    if (files.length === 1) {
      sourceFile = files[0]!;
    } else if (files.length === 2 && files.filter(metadataName).length === 1) {
      metadataFile = files.find(metadataName)!;
      sourceFile = files.find((file) => file !== metadataFile)!;
    } else {
      throw new Error(
        'Select one normalized prototype JSON, or exactly two files: a raw dump and a metadata JSON named metadata/environment/profile.',
      );
    }
  } catch (error) {
    const previous = profileBeforeSelection;
    profileReady = true;
    activePrototypeProfile = previous;
    activePrototypeProfileIsBuiltin = profileBeforeSelectionIsBuiltin;
    workerPrototypeIdentity = workerIdentityBeforeSelection;
    profileBeforeSelection = undefined;
    profileBeforeSelectionIsBuiltin = false;
    workerIdentityBeforeSelection = undefined;
    const message = error instanceof Error ? error.message : String(error);
    profileRestoreError = previous === undefined ? message : undefined;
    prototypeProfileStatus.textContent =
      previous === undefined
        ? message
        : `${previous.name} · selection failed; previous profile kept`;
    prototypeProfileStatus.dataset.state = previous === undefined ? 'invalid' : 'valid';
    prototypeProfileClear.disabled = previous === undefined;
    if (previous === undefined) scheduleRender();
    return;
  }
  void Promise.all([sourceFile.text(), metadataFile?.text()])
    .then(([source, factorioDumpMetadata]) => {
      if (selectionRevision !== profileSelectionRevision) return;
      profileReady = true;
      profileRestoreError = undefined;
      pendingProfileSelection = true;
      activePrototypeProfile = {
        name: metadataFile === undefined ? sourceFile.name : `${sourceFile.name} + metadata`,
        source,
        ...(factorioDumpMetadata === undefined ? {} : { factorioDumpMetadata }),
      };
      activePrototypeProfileIsBuiltin = false;
      workerPrototypeIdentity = undefined;
      prototypeProfileStatus.textContent = `${activePrototypeProfile.name} · validating…`;
      prototypeProfileStatus.dataset.state = 'pending';
      prototypeProfileClear.disabled = false;
      prototypeProfileFile.value = '';
      scheduleRender();
    })
    .catch((error: unknown) => {
      if (selectionRevision !== profileSelectionRevision) return;
      profileReady = true;
      pendingProfileSelection = false;
      const previous = profileBeforeSelection;
      activePrototypeProfile = profileBeforeSelection;
      activePrototypeProfileIsBuiltin = profileBeforeSelectionIsBuiltin;
      workerPrototypeIdentity = workerIdentityBeforeSelection;
      profileBeforeSelection = undefined;
      profileBeforeSelectionIsBuiltin = false;
      workerIdentityBeforeSelection = undefined;
      const message = `Cannot read profile: ${error instanceof Error ? error.message : String(error)}`;
      profileRestoreError = previous === undefined ? message : undefined;
      prototypeProfileStatus.textContent =
        previous === undefined
          ? message
          : `${previous.name} · new import failed; previous profile kept`;
      prototypeProfileStatus.dataset.state = previous === undefined ? 'invalid' : 'valid';
      prototypeProfileClear.disabled = previous === undefined;
      scheduleRender();
    });
});

prototypeProfileClear.addEventListener('click', () => {
  profileSelectionRevision += 1;
  profileReady = true;
  profileRestoreError = undefined;
  profileNotice = undefined;
  pendingProfileSelection = false;
  profileBeforeSelection = undefined;
  profileBeforeSelectionIsBuiltin = false;
  workerIdentityBeforeSelection = undefined;
  activePrototypeProfile = undefined;
  activePrototypeProfileIsBuiltin = false;
  workerPrototypeIdentity = undefined;
  prototypeProfileStatus.textContent = 'None · ordinary circuits remain available';
  prototypeProfileStatus.dataset.state = 'none';
  prototypeProfileClear.disabled = true;
  try {
    draftStorage?.setItem(PROFILE_SELECTION_KEY, '');
  } catch {
    prototypeProfileStatus.textContent += ' · could not save selection';
  }
  scheduleRender();
});

async function restorePrototypeProfile(): Promise<void> {
  const selectionRevision = profileSelectionRevision;
  let selection: string | null;
  try {
    selection = draftStorage?.getItem(PROFILE_SELECTION_KEY) ?? null;
  } catch {
    selection = null;
  }
  try {
    const savedProfile =
      selection !== null && selection !== ''
        ? await browserPrototypeProfileStore(selection).load()
        : undefined;
    const builtinProfile =
      selection === null
        ? await fetchBuiltinPrototypeAsset().then(({ source, assetManifest }) => ({
            name: builtinPrototypeAsset.name,
            source,
            assetManifest,
          }))
        : undefined;
    if (selectionRevision !== profileSelectionRevision) return;
    const resolved = resolvePrototypeProfileSelection(selection, savedProfile, builtinProfile);
    if (resolved.kind === 'builtin' || resolved.kind === 'custom') {
      activePrototypeProfile = resolved.profile;
      activePrototypeProfileIsBuiltin = resolved.kind === 'builtin';
      profileRestoreError = undefined;
      prototypeProfileStatus.textContent = `${resolved.profile.name} · restoring…`;
      prototypeProfileStatus.dataset.state = 'pending';
      prototypeProfileClear.disabled = false;
    } else if (resolved.kind === 'disabled') {
      activePrototypeProfile = undefined;
      activePrototypeProfileIsBuiltin = false;
      prototypeProfileStatus.textContent = 'None · ordinary circuits remain available';
      prototypeProfileStatus.dataset.state = 'none';
      prototypeProfileClear.disabled = true;
    } else if (resolved.kind === 'builtin-unavailable') {
      activePrototypeProfile = undefined;
      activePrototypeProfileIsBuiltin = false;
      profileRestoreError = undefined;
      prototypeProfileStatus.textContent = resolved.message;
      prototypeProfileStatus.dataset.state = 'warning';
      prototypeProfileClear.disabled = true;
    } else {
      activePrototypeProfile = undefined;
      activePrototypeProfileIsBuiltin = false;
      throw new Error(resolved.message);
    }
  } catch (error) {
    if (selectionRevision !== profileSelectionRevision) return;
    if (selection === null) {
      activePrototypeProfile = undefined;
      activePrototypeProfileIsBuiltin = false;
      profileRestoreError = undefined;
      const message =
        error instanceof Error ? error.message : 'The built-in prototype profile could not load.';
      prototypeProfileStatus.textContent = `${message} Ordinary circuits remain available.`;
      prototypeProfileStatus.dataset.state = 'warning';
      prototypeProfileClear.disabled = true;
      profileReady = true;
      render();
      return;
    }
    profileRestoreError =
      error instanceof Error ? error.message : 'Prototype profile restoration failed.';
    prototypeProfileStatus.textContent = profileRestoreError;
    prototypeProfileStatus.dataset.state = 'invalid';
    prototypeProfileClear.disabled = false;
  }
  if (selectionRevision !== profileSelectionRevision) return;
  profileReady = true;
  render();
}
void restorePrototypeProfile();
