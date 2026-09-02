import { TraceReader } from '@comblang/simulator';

import { buildTestTraceTable, traceTargetLabel } from './test-trace-view.js';
import type { WebTestRun } from './web-test-runner.js';

export class TestTracePanel {
  readonly #host: HTMLElement;
  readonly #case: HTMLSelectElement;
  readonly #target: HTMLSelectElement;
  readonly #start: HTMLInputElement;
  readonly #window: HTMLInputElement;
  readonly #previous: HTMLButtonElement;
  readonly #next: HTMLButtonElement;
  readonly #status: HTMLOutputElement;
  readonly #table: HTMLElement;
  #run: WebTestRun | undefined;
  #reader: TraceReader | undefined;

  constructor(host: HTMLElement) {
    this.#host = host;
    const element = <T extends HTMLElement>(selector: string): T => {
      const value = host.querySelector<T>(selector);
      if (value === null) throw new Error(`Missing trace control: ${selector}`);
      return value;
    };
    this.#case = element('#trace-case');
    this.#target = element('#trace-target');
    this.#start = element('#trace-start');
    this.#window = element('#trace-window');
    this.#previous = element('#trace-previous');
    this.#next = element('#trace-next');
    this.#status = element('#trace-status');
    this.#table = element('#test-trace-table');
    this.#case.addEventListener('change', () => this.#selectCase());
    this.#target.addEventListener('change', () => this.#render());
    this.#start.addEventListener('input', () => this.#render());
    this.#window.addEventListener('input', () => this.#render());
    this.#previous.addEventListener('click', () => this.#page(-1));
    this.#next.addEventListener('click', () => this.#page(1));
    this.clear('Waiting for tests…');
  }

  clear(message: string): void {
    this.#run = undefined;
    this.#reader = undefined;
    this.#case.replaceChildren();
    this.#target.replaceChildren();
    this.#case.disabled = true;
    this.#enableRange(false);
    this.#message(message);
    this.#status.textContent = 'No current trace';
  }

  setRun(run: WebTestRun): void {
    this.#run = run;
    this.#case.replaceChildren(
      ...run.results.map(
        (result, index) =>
          new Option(`${index + 1}. ${result.name} · ${result.status}`, String(index)),
      ),
    );
    this.#case.disabled = run.results.length === 0;
    this.#selectCase();
  }

  show(index: number): void {
    if (this.#run?.results[index] === undefined) return;
    this.#case.value = String(index);
    this.#selectCase();
    this.#host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  #enableRange(enabled: boolean): void {
    for (const element of [this.#target, this.#start, this.#window, this.#previous, this.#next])
      element.disabled = !enabled;
  }

  #message(message: string): void {
    const paragraph = document.createElement('p');
    paragraph.className = 'test-empty';
    paragraph.textContent = message;
    this.#table.replaceChildren(paragraph);
  }

  #selectCase(): void {
    this.#reader = undefined;
    this.#enableRange(false);
    this.#target.replaceChildren();
    const result = this.#run?.results[Number(this.#case.value)];
    if (result?.trace === undefined) {
      this.#status.textContent = 'No recorded history';
      this.#message('This test has no trace document.');
      return;
    }
    try {
      const reader = new TraceReader(result.trace);
      this.#reader = reader;
      this.#target.replaceChildren(
        new Option('All recorded targets', ''),
        ...reader.targets.map(
          (target) => new Option(traceTargetLabel(target, result.traceNetworkNames), target.id),
        ),
      );
      this.#start.max = String(reader.endTick);
      const count = this.#window.valueAsNumber;
      if (!Number.isSafeInteger(count) || count < 1 || count > 256) this.#window.value = '32';
      this.#start.value = String(Math.max(0, reader.endTick - this.#window.valueAsNumber + 1));
      this.#enableRange(true);
      this.#render();
    } catch (error) {
      this.#status.textContent = 'Trace unavailable';
      this.#message(error instanceof Error ? error.message : 'Could not read the trace.');
    }
  }

  #page(direction: number): void {
    if (this.#reader === undefined) return;
    this.#start.value = String(
      Math.max(
        0,
        Math.min(
          this.#reader.endTick,
          this.#start.valueAsNumber + direction * this.#window.valueAsNumber,
        ),
      ),
    );
    this.#render();
  }

  #render(): void {
    const reader = this.#reader;
    if (reader === undefined) return;
    const result = this.#run!.results[Number(this.#case.value)]!;
    try {
      const from = this.#start.valueAsNumber;
      const count = this.#window.valueAsNumber;
      const model = buildTestTraceTable(
        reader,
        from,
        count,
        this.#target.value || undefined,
        result.traceNetworkNames,
      );
      const lastTick = model.rows.at(-1)?.tick ?? from;
      this.#status.textContent = `Read-only · T${from}–T${lastTick} of T${reader.endTick}${reader.hasExplicitEndTick ? '' : ' · legacy end inferred'} · ${result.status}`;
      this.#previous.disabled = from === 0;
      this.#next.disabled = lastTick === reader.endTick;
      if (reader.targets.length === 0) {
        this.#message(
          'No targets recorded. Add session.trace(network("output")) at tick zero inside this test.',
        );
        return;
      }
      const table = document.createElement('table');
      table.className = 'timeline-table';
      table.setAttribute('aria-label', `Recorded trace for ${result.name}`);
      const head = table.createTHead().insertRow();
      for (const column of [{ label: 'Tick', targetId: undefined }, ...model.columns]) {
        const th = document.createElement('th');
        th.scope = 'col';
        if (column.targetId === undefined) th.textContent = column.label;
        else {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = column.label;
          button.title = 'Show signal columns for this recorded target';
          button.addEventListener('click', () => {
            this.#target.value = column.targetId!;
            this.#render();
          });
          th.append(button);
        }
        head.append(th);
      }
      const body = table.createTBody();
      for (const row of model.rows) {
        const tr = body.insertRow();
        const tick = document.createElement('th');
        tick.scope = 'row';
        tick.textContent = `T${row.tick}`;
        tr.append(tick);
        for (const cell of row.cells) {
          const td = tr.insertCell();
          if (cell.origins !== undefined) {
            td.className = 'trace-unknown';
            const details = document.createElement('details');
            const summary = document.createElement('summary');
            summary.textContent = 'Unknown';
            const origins = document.createElement('pre');
            origins.textContent = cell.origins
              .map((origin) => `${origin.description} (${origin.id})\n${origin.path.join(' → ')}`)
              .join('\n\n');
            details.append(summary, origins);
            td.append(details);
          } else {
            td.textContent = [
              ...cell.lines,
              ...(cell.hidden === 0 ? [] : [`… +${cell.hidden}`]),
            ].join('\n');
          }
        }
      }
      this.#table.replaceChildren(table);
    } catch (error) {
      this.#previous.disabled = true;
      this.#next.disabled = true;
      this.#status.textContent = 'Invalid trace range';
      this.#message(error instanceof Error ? error.message : 'Could not display this range.');
    }
  }
}
