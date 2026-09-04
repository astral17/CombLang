import type { SourceSpan } from '@comblang/shared';

import type { ProducerValue } from './elaboration-values.js';

interface ProducerLifecycleEntry {
  value: ProducerValue;
  attachment?: SourceSpan;
  planIndex?: number;
  readonly captureIds: string[];
}

export interface ProducerCapture {
  readonly captureId: string;
  readonly attachedPlanIndex?: number;
}

/** Identity-based lifecycle state for Producers recorded during one module execution. */
export class ProducerLifecycle {
  readonly #entries = new Map<object, ProducerLifecycleEntry>();
  #captureOrdinal = 0;
  #finalized = false;

  register(value: ProducerValue): void {
    const entry = this.#entries.get(value.identity);
    if (entry === undefined) {
      this.#entries.set(value.identity, { value, captureIds: [] });
    } else {
      entry.value = value;
    }
  }

  capture(value: ProducerValue): ProducerCapture {
    this.register(value);
    const entry = this.#entries.get(value.identity)!;
    const captureId = `producer:${++this.#captureOrdinal}`;
    entry.captureIds.push(captureId);
    return {
      captureId,
      ...(entry.planIndex === undefined ? {} : { attachedPlanIndex: entry.planIndex }),
    };
  }

  captureIds(value: ProducerValue): readonly string[] | undefined {
    const captures = this.#entries.get(value.identity)?.captureIds;
    return captures === undefined || captures.length === 0 ? undefined : captures;
  }

  attachmentSource(value: ProducerValue): SourceSpan | undefined {
    return this.#entries.get(value.identity)?.attachment;
  }

  markAttached(value: ProducerValue, source: SourceSpan, planIndex: number): void {
    this.register(value);
    const entry = this.#entries.get(value.identity)!;
    entry.attachment = source;
    entry.planIndex = planIndex;
  }

  finalizeUnused(discard: (producer: ProducerValue, ordinal: number) => void): void {
    if (this.#finalized) return;
    this.#finalized = true;
    let ordinal = 0;
    for (const entry of this.#entries.values()) {
      if (entry.attachment === undefined) discard(entry.value, ++ordinal);
    }
  }
}
