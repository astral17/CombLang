import {
  inspectDebugNetwork,
  type DebugDocument,
  type DebugDocumentProducer,
  type DebugNetworkEntry,
} from '@comblang/runtime';
import type { SourceSpan } from '@comblang/shared';
import type { TraceTarget } from '@comblang/simulator';

import type { WebTestResult } from './web-test-runner.js';

function scopeLabel(path: readonly string[]): string {
  return path.length === 0 ? '<root>' : path.join(' / ');
}

/** A view over the selected test's data, never over the live circuit execution. */
export class TestDebugPanel {
  readonly #host: HTMLElement;
  readonly #reveal: (span: SourceSpan) => void;
  #document: DebugDocument | undefined;
  #scope: HTMLSelectElement | undefined;
  #content: HTMLElement | undefined;
  #details: HTMLDetailsElement | undefined;

  constructor(host: HTMLElement, reveal: (span: SourceSpan) => void) {
    this.#host = host;
    this.#reveal = reveal;
  }

  setResult(result: WebTestResult | undefined): void {
    this.#document = result?.debug;
    this.#host.replaceChildren();
    this.#scope = undefined;
    this.#content = undefined;
    this.#details = undefined;
    if (this.#document === undefined) return;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Inspect source scopes and combinators';
    const label = document.createElement('label');
    label.textContent = 'Debug scope';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Debug scope');
    for (const [index, scope] of this.#document.scopes.entries())
      select.add(new Option(scopeLabel(scope.path), String(index)));
    const requested = JSON.stringify(result?.debugScopePath ?? []);
    const index = this.#document.scopes.findIndex(({ path }) => JSON.stringify(path) === requested);
    select.value = String(Math.max(0, index));
    label.append(select);
    const content = document.createElement('div');
    select.addEventListener('change', () => this.#renderScope());
    details.append(summary, label, content);
    this.#host.append(details);
    this.#scope = select;
    this.#content = content;
    this.#details = details;
    details.open = result?.debugScopePath !== undefined;
    this.#renderScope();
  }

  selectTarget(target: TraceTarget | undefined): void {
    if (this.#document === undefined || this.#content === undefined) return;
    if (target === undefined) {
      this.#renderScope();
      return;
    }
    this.#details!.open = true;
    this.#content.replaceChildren();
    if (target.kind !== 'network' && target.kind !== 'signal') {
      this.#note(
        'This test-created adapter has no source Network mapping in the trace. Browse source scopes above; no Producer identity is inferred from its object ID.',
      );
      return;
    }
    const inspected = inspectDebugNetwork(this.#document, target.networkId);
    this.#note(
      `Physical bus ${target.networkId} · all bindings and connected combinators across scopes`,
    );
    for (const binding of inspected.bindings) this.#network(binding);
    for (const producer of inspected.producers) {
      const roles = [
        ...(producer.inputs.includes(target.networkId) ? ['reads bus'] : []),
        ...(producer.outputs.includes(target.networkId) ? ['writes bus'] : []),
      ];
      this.#producer(producer, roles.join(' · '));
    }
    if (inspected.bindings.length === 0 && inspected.producers.length === 0)
      this.#note('No source entries for this bus in this test execution.');
  }

  #note(text: string): void {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    this.#content!.append(paragraph);
  }

  #sourceButton(label: string, source: SourceSpan): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = 'Select the exact source span in main.factorio.ts';
    button.addEventListener('click', () => this.#reveal(source));
    return button;
  }

  #network(entry: DebugNetworkEntry): void {
    const row = document.createElement('div');
    row.className = 'debug-entry';
    row.append(
      this.#sourceButton(
        `Network ${entry.name}${entry.moved ? ' · moved alias' : ''}${entry.internal ? ' · internal' : ''} · ${scopeLabel(entry.instancePath)}`,
        entry.source,
      ),
    );
    this.#content!.append(row);
  }

  #producer(entry: DebugDocumentProducer, role = ''): void {
    const row = document.createElement('div');
    row.className = 'debug-entry';
    row.append(
      this.#sourceButton(
        `${entry.producerKind} #${entry.ordinal}${entry.name === undefined ? '' : ` ${entry.name}`} · ${scopeLabel(entry.instancePath)}${role === '' ? '' : ` · ${role}`}`,
        entry.source,
      ),
    );
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `Configuration · ${entry.id}`;
    const config = document.createElement('pre');
    config.textContent = JSON.stringify(
      {
        inputs: entry.inputs,
        outputs: entry.outputs,
        placement: entry.placement,
        config: entry.config,
      },
      null,
      2,
    );
    details.append(summary, config);
    row.append(details);
    this.#content!.append(row);
  }

  #renderScope(): void {
    const scope = this.#document?.scopes[Number(this.#scope?.value)];
    this.#content?.replaceChildren();
    if (scope === undefined) return;
    this.#note(
      `Exact scope ${scopeLabel(scope.path)} · ${scope.networks.length} Network bindings · ${scope.producers.length} physical combinators`,
    );
    for (const network of scope.networks) this.#network(network);
    for (const producer of scope.producers) this.#producer(producer);
  }
}
