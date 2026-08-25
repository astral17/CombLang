import { offsetToPosition } from '@comblang/shared';

import { blueprintJsonForPlan } from './blueprint-demo.js';
import { createSourceEditor, type SourceEditorKind } from './code-editor.js';
import { registerOfflineSupport, warmOfflineCache } from './offline.js';
import { loadSourceDraft, saveSourceDraft, type SourceDraftStorage } from './source-draft.js';
import { runSourcePlanDemo } from './source-demo.js';
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
  return IF(input[SIGNAL_A] > threshold[SIGNAL_A], input[SIGNAL_A]);
}

const input = new Network<R>();
const middle = Scale(input);
const biased = Bias(middle);
const threshold = new Network();
threshold += CC(40 * SIGNAL_A).at(0.5, 2.5, 4);
let [output, mirror]: [Network, Network] = Gate(biased, threshold).as(SIGNAL_A);
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
const instancePaths = requiredElement<HTMLElement>('#instance-paths');
const networkColors = requiredElement<HTMLElement>('#network-colors');
const blueprintStatus = requiredElement<HTMLOutputElement>('#blueprint-status');
const blueprintResult = requiredElement<HTMLPreElement>('#blueprint-result');
const copyBlueprint = requiredElement<HTMLButtonElement>('#copy-blueprint');
let parserWorker: Worker | undefined;
let workerTimeout: ReturnType<typeof setTimeout> | undefined;
let activeWorkerRevision: number | undefined;
let queuedCompilerRequest: CompilerWorkerRequest | undefined;
let currentRevision = 0;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
let currentBlueprintJson: string | undefined;
let sourceEditor = createSourceEditor(sourceHost, initialSource, scheduleRender);

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

function renderProofPending(): void {
  proof.dataset.state = 'pending';
  proof.setAttribute('aria-busy', 'true');
  blueprintStatus.textContent = 'Waiting for compiler…';
  blueprintStatus.dataset.state = 'pending';
  currentBlueprintJson = undefined;
  copyBlueprint.disabled = true;
  resetCopyButton();
}

function renderProofError(message: string): void {
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
  const peak = Math.max(1, ...demo.waveform.map((sample) => Math.abs(sample.output)));
  const waveformRows = demo.waveform.map((sample) => {
    const row = document.createElement('div');
    row.className = 'wave-row';
    const tick = document.createElement('span');
    tick.textContent = `T${sample.tick}`;
    const bar = document.createElement('i');
    bar.style.setProperty('--level', String(Math.abs(sample.output) / peak));
    const output = document.createElement('b');
    output.textContent = String(sample.output);
    const input = document.createElement('small');
    input.textContent = `in ${sample.input}`;
    row.replaceChildren(tick, bar, output, input);
    return row;
  });
  if (waveformRows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'proof-empty';
    empty.textContent = 'Add a producer to start the synchronous waveform.';
    waveform.replaceChildren(empty);
  } else {
    waveform.replaceChildren(...waveformRows);
  }
  networkColors.replaceChildren(
    ...demo.colors.map((network) => {
      const item = document.createElement('span');
      item.dataset.color = network.color;
      const displayName = network.name.startsWith('$local:')
        ? network.name.split(':').slice(2).join(':')
        : network.name;
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
  } else {
    try {
      renderSourceProof(parsed.plan, foldedOperations);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Runtime proof failed.';
      status.textContent = 'runtime color/topology diagnostic';
      status.dataset.state = 'invalid';
      renderProofError(message);
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
      result.textContent =
        'EX1002 error: Compile-time execution exceeded the 1000 ms worker budget.';
    }
    pumpCompilerWorker();
  }, 1000);
}

registerOfflineSupport();
render();
