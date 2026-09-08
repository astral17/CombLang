import { sameSignal, type SignalId } from '@comblang/factorio';
import type { DirectPlanProducer, PlanAttachment } from '@comblang/compiler/direct-plan-schema';
import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import { bindCombinatorOutputSignal } from './combinator-output-policy.js';
import type { CombinatorDescriptor, CombinatorValue, NetworkValue } from './elaboration-values.js';

export interface OutputLaneState {
  network: NetworkValue;
  readonly attachment: PlanAttachment;
}

export interface OutputPortState {
  readonly primary: OutputLaneState;
  secondary?: OutputLaneState;
}

export interface CombinatorOutputBinding {
  readonly signal: SignalId;
  readonly source: SourceSpan;
}

/** Mutable execution state for one physical combinator. */
export interface CombinatorRuntimeState {
  readonly identity: object;
  descriptor: CombinatorDescriptor;
  readonly outputPort: OutputPortState;
  readonly debugCaptureIds: string[];
  outputBinding?: CombinatorOutputBinding;
  outputUsed: boolean;
}

export interface CombinatorCapture {
  readonly captureId: string;
}

export interface CombinatorRegistrySnapshot {
  readonly states: ReadonlyMap<
    object,
    {
      readonly descriptor: CombinatorDescriptor;
      readonly primary: OutputLaneState;
      readonly secondary?: OutputLaneState;
      readonly outputBinding?: CombinatorOutputBinding;
      readonly debugCaptureIds: readonly string[];
      readonly outputUsed: boolean;
    }
  >;
}

/** Owns physical combinator identity independently from either output Network lane. */
export class CombinatorRegistry {
  readonly #states = new Map<object, CombinatorRuntimeState>();
  #captureOrdinal = 0;

  register(
    value: CombinatorValue,
    descriptor: CombinatorDescriptor,
    primary: NetworkValue,
    attachment: PlanAttachment,
  ): CombinatorRuntimeState {
    if (this.#states.has(value.identity)) {
      throw new Error('Physical combinator identity was registered twice.');
    }
    const state: CombinatorRuntimeState = {
      identity: value.identity,
      descriptor,
      outputPort: { primary: { network: primary, attachment } },
      debugCaptureIds: [],
      outputUsed: false,
    };
    this.#states.set(value.identity, state);
    return state;
  }

  stateFor(value: CombinatorValue): CombinatorRuntimeState {
    const state = this.#states.get(value.identity);
    if (state === undefined) throw new Error('Unknown physical combinator handle.');
    return state;
  }

  states(): readonly CombinatorRuntimeState[] {
    return [...this.#states.values()];
  }

  snapshot(): CombinatorRegistrySnapshot {
    return {
      states: new Map(
        [...this.#states.entries()].map(([identity, state]) => [
          identity,
          {
            descriptor: state.descriptor,
            primary: { ...state.outputPort.primary },
            ...(state.outputPort.secondary === undefined
              ? {}
              : { secondary: { ...state.outputPort.secondary } }),
            ...(state.outputBinding === undefined ? {} : { outputBinding: state.outputBinding }),
            debugCaptureIds: [...state.debugCaptureIds],
            outputUsed: state.outputUsed,
          },
        ]),
      ),
    };
  }

  restore(snapshot: CombinatorRegistrySnapshot): void {
    this.#states.clear();
    for (const [identity, saved] of snapshot.states) {
      this.#states.set(identity, {
        identity,
        descriptor: saved.descriptor,
        outputPort: {
          primary: { ...saved.primary },
          ...(saved.secondary === undefined ? {} : { secondary: { ...saved.secondary } }),
        },
        debugCaptureIds: [...saved.debugCaptureIds],
        ...(saved.outputBinding === undefined ? {} : { outputBinding: saved.outputBinding }),
        outputUsed: saved.outputUsed,
      });
    }
  }

  primary(value: CombinatorValue): NetworkValue {
    return this.stateFor(value).outputPort.primary.network;
  }

  secondary(value: CombinatorValue): NetworkValue | undefined {
    return this.stateFor(value).outputPort.secondary?.network;
  }

  setPrimary(value: CombinatorValue, network: NetworkValue): void {
    this.stateFor(value).outputPort.primary.network = network;
  }

  setSecondary(value: CombinatorValue, network: NetworkValue): void {
    const lane = this.stateFor(value).outputPort.secondary;
    if (lane === undefined) throw new Error('Cannot update a missing secondary output lane.');
    lane.network = network;
  }

  addSecondary(
    value: CombinatorValue,
    network: NetworkValue,
    attachment: PlanAttachment,
  ): NetworkValue {
    const state = this.stateFor(value);
    state.outputPort.secondary ??= { network, attachment };
    return state.outputPort.secondary.network;
  }

  update(
    value: CombinatorValue,
    descriptor: CombinatorDescriptor,
    source = descriptor.source,
  ): void {
    const state = this.stateFor(value);
    if (descriptor.kind !== state.descriptor.kind) {
      throw new Error('A physical combinator cannot change its native kind.');
    }
    const rebound =
      state.outputBinding === undefined
        ? descriptor
        : bindCombinatorOutputSignal(descriptor, state.outputBinding.signal, source);
    state.descriptor = rebound;
  }

  bindOutput(value: CombinatorValue, signal: SignalId, source: SourceSpan): void {
    const state = this.stateFor(value);
    const binding = state.outputBinding;
    if (binding !== undefined && !sameSignal(binding.signal, signal)) {
      throw new ElaborationExecutionError(
        'Combinator output Signal conflicts with its first destination binding.',
        source,
        'RT2023',
        [
          { message: 'Combinator output Signal was first bound here.', span: binding.source },
          { message: 'Physical combinator was created here.', span: state.descriptor.source },
        ],
      );
    }
    const rebound = bindCombinatorOutputSignal(state.descriptor, signal, source);
    state.descriptor = rebound;
    if (binding === undefined) state.outputBinding = { signal, source };
  }

  validateOutput(value: CombinatorValue, signal: SignalId, source: SourceSpan): void {
    const state = this.stateFor(value);
    const binding = state.outputBinding;
    if (binding !== undefined && !sameSignal(binding.signal, signal)) {
      throw new ElaborationExecutionError(
        'Combinator output Signal conflicts with its first destination binding.',
        source,
        'RT2023',
        [
          { message: 'Combinator output Signal was first bound here.', span: binding.source },
          { message: 'Physical combinator was created here.', span: state.descriptor.source },
        ],
      );
    }
    bindCombinatorOutputSignal(state.descriptor, signal, source);
  }

  bindName(value: CombinatorValue, bindingName: string): void {
    this.update(value, { ...this.stateFor(value).descriptor, bindingName });
  }

  markOutputUsed(value: CombinatorValue): void {
    this.stateFor(value).outputUsed = true;
  }

  capture(value: CombinatorValue): CombinatorCapture {
    const state = this.stateFor(value);
    const captureId = `producer:${++this.#captureOrdinal}`;
    state.debugCaptureIds.push(captureId);
    return { captureId };
  }

  toPlan(state: CombinatorRuntimeState): DirectPlanProducer {
    const destinations = [state.outputPort.primary, state.outputPort.secondary]
      .filter((lane): lane is OutputLaneState => lane !== undefined)
      .map(({ attachment }) => attachment);
    return {
      ...state.descriptor,
      ...(state.debugCaptureIds.length === 0
        ? {}
        : { debugCaptureIds: Object.freeze([...state.debugCaptureIds]) }),
      destinations: Object.freeze(destinations),
    } as DirectPlanProducer;
  }
}
