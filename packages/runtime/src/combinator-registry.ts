import { sameSignal, type ConstantConfiguration, type SignalId } from '@comblang/factorio';
import type {
  DirectPlanProducer,
  PlanArithmeticOperand,
  PlanAttachment,
  PlanNetworkRef,
} from '@comblang/compiler/direct-plan-schema';
import type { LogicalArithmeticOutput, SelectorProducerConfig } from '../../compiler/src/ir.js';
import type { ArithmeticTemplateOperand } from '../../compiler/src/arithmetic-configuration-template.js';
import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import { bindCombinatorOutputSignal } from './combinator-output-policy.js';
import type {
  CombinatorDescriptor,
  CombinatorValue,
  NetworkValue,
  PendingArithmeticOperand,
} from './elaboration-values.js';

type ArithmeticInstallationConfiguration = Pick<
  Extract<DirectPlanProducer, { readonly kind: 'arithmetic' }>,
  'left' | 'operation' | 'right' | 'output'
>;

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
  readonly captureOrdinal: number;
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
      captureOrdinal: this.#captureOrdinal,
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
    this.#captureOrdinal = snapshot.captureOrdinal;
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
    const currentPending = isPendingCombinatorDescriptor(state.descriptor)
      ? state.descriptor
      : undefined;
    const nextPending = isPendingCombinatorDescriptor(descriptor) ? descriptor : undefined;
    if ((currentPending === undefined) !== (nextPending === undefined)) {
      throw new Error('A pending combinator can only become concrete through installation.');
    }
    if (currentPending !== undefined && nextPending !== undefined) {
      if (
        currentPending.kind !== nextPending.kind ||
        nextPending.pendingConfiguration !== currentPending.pendingConfiguration
      ) {
        throw new Error('A pending combinator cannot replace its prepared configuration template.');
      }
      if (
        currentPending.kind === 'selector' &&
        (hasConcreteSelectorConfiguration(currentPending) ||
          hasConcreteSelectorConfiguration(nextPending))
      ) {
        throw new Error(
          'A pending Selector cannot contain a concrete index or output before installation.',
        );
      }
      if (currentPending.kind === 'arithmetic') {
        if (
          nextPending.kind !== 'arithmetic' ||
          hasConcreteArithmeticOperands(currentPending) ||
          hasConcreteArithmeticOperands(nextPending)
        ) {
          throw new Error('A pending Arithmetic cannot contain concrete Arithmetic operands.');
        }
        if (
          currentPending.operation !== nextPending.operation ||
          !sameArithmeticOperandTopology(currentPending.left, nextPending.left) ||
          !sameArithmeticOperandTopology(currentPending.right, nextPending.right)
        ) {
          throw new Error('A pending Arithmetic cannot change its operation or operand topology.');
        }
        if (!sameArithmeticOutput(currentPending.output, nextPending.output)) {
          throw new Error(
            'A pending Arithmetic output can change only through its output binding.',
          );
        }
      }
      if (
        currentPending.kind === 'selector' &&
        (nextPending.kind !== 'selector' ||
          nextPending.operation !== currentPending.operation ||
          !sameNetworkRef(nextPending.input, currentPending.input) ||
          (currentPending.operation === 'select' &&
            (nextPending.operation !== 'select' ||
              nextPending.selectMax !== currentPending.selectMax)))
      ) {
        throw new Error(
          'A pending Selector cannot change its operation or registered input topology.',
        );
      }
    }
    const rebound =
      state.outputBinding === undefined
        ? descriptor
        : bindCombinatorOutputSignal(descriptor, state.outputBinding.signal, source);
    state.descriptor = rebound;
  }

  installPendingConstant(value: CombinatorValue, configuration: ConstantConfiguration): void {
    const state = this.stateFor(value);
    if (state.descriptor.kind !== 'constant') {
      throw new Error('Only a pending Constant can receive a Constant configuration.');
    }
    if (!isPendingCombinatorDescriptor(state.descriptor)) {
      throw new Error('The Constant configuration was already installed.');
    }
    const {
      pendingConfiguration: _pendingConfiguration,
      configuration: _configuration,
      ...descriptor
    } = state.descriptor;
    state.descriptor = { ...descriptor, configuration };
  }

  installPendingSelector(value: CombinatorValue, configuration: SelectorProducerConfig): void {
    const state = this.stateFor(value);
    if (state.descriptor.kind !== 'selector') {
      throw new Error('Only a pending Selector can receive a Selector configuration.');
    }
    if (!isPendingCombinatorDescriptor(state.descriptor)) {
      throw new Error('The Selector configuration was already installed.');
    }
    const pending = state.descriptor;
    if (hasConcreteSelectorConfiguration(pending)) {
      throw new Error(
        'A pending Selector cannot contain a concrete index or output before installation.',
      );
    }
    const template = pending.pendingConfiguration;
    if (
      pending.operation !== configuration.operation ||
      template.operation !== pending.operation ||
      !sameNetworkRef(pending.input, configuration.input) ||
      !sameNetworkRef(template.input, pending.input)
    ) {
      throw new Error(
        'The Selector configuration does not match its pending operation or input topology.',
      );
    }

    if (pending.operation === 'select') {
      if (
        configuration.operation !== 'select' ||
        template.operation !== 'select' ||
        configuration.selectMax !== pending.selectMax ||
        template.selectMax !== pending.selectMax
      ) {
        throw new Error('The Selector configuration does not match its pending select mode.');
      }
      const { pendingConfiguration: _pendingConfiguration, index: _index, ...descriptor } = pending;
      state.descriptor = { ...descriptor, index: configuration.index };
      return;
    }

    if (configuration.operation !== 'count' || template.operation !== 'count') {
      throw new Error('The Selector configuration does not match its pending count operation.');
    }
    const { pendingConfiguration: _pendingConfiguration, output: _output, ...descriptor } = pending;
    state.descriptor = { ...descriptor, output: configuration.output };
  }

  installPendingArithmetic(
    value: CombinatorValue,
    configuration: ArithmeticInstallationConfiguration,
  ): void {
    const state = this.stateFor(value);
    if (state.descriptor.kind !== 'arithmetic') {
      throw new Error('Only a pending Arithmetic can receive an Arithmetic configuration.');
    }
    if (!isPendingCombinatorDescriptor(state.descriptor)) {
      throw new Error('The Arithmetic configuration was already installed.');
    }
    const pending = state.descriptor;
    if (hasConcreteArithmeticOperands(pending)) {
      throw new Error('A pending Arithmetic cannot contain concrete Arithmetic operands.');
    }

    const template = pending.pendingConfiguration;
    if (
      pending.operation !== configuration.operation ||
      template.operation !== pending.operation ||
      !sameArithmeticOperandTopology(pending.left, configuration.left) ||
      !sameArithmeticOperandTopology(pending.right, configuration.right) ||
      !sameTemplateArithmeticOperand(template.left, configuration.left) ||
      !sameTemplateArithmeticOperand(template.right, configuration.right) ||
      template.output.kind !== configuration.output.kind
    ) {
      throw new Error(
        'The Arithmetic configuration does not match its pending operation or operand topology.',
      );
    }
    if (state.outputBinding === undefined) {
      if (!sameArithmeticOutput(pending.output, configuration.output)) {
        throw new Error(
          'The Arithmetic configuration does not match its pending output selection.',
        );
      }
    } else if (
      pending.output.kind !== 'signal' ||
      !sameSignal(pending.output.signal, state.outputBinding.signal)
    ) {
      throw new Error('The pending Arithmetic output no longer matches its output binding.');
    }

    const {
      pendingConfiguration: _pendingConfiguration,
      left: _left,
      right: _right,
      ...descriptor
    } = pending;
    state.descriptor = {
      ...descriptor,
      left: configuration.left,
      right: configuration.right,
      output: pending.output,
    };
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
    if (isPendingCombinatorDescriptor(state.descriptor)) {
      throw new ElaborationExecutionError(
        'Pending combinator configuration must be installed before plan serialization.',
        state.descriptor.source,
        'RT2027',
      );
    }
    const descriptor =
      state.descriptor.kind === 'decider'
        ? (({ outputOrigins: _outputOrigins, elseOutputOrigins: _elseOutputOrigins, ...rest }) =>
            rest)(state.descriptor)
        : state.descriptor;
    const destinations = [state.outputPort.primary, state.outputPort.secondary]
      .filter((lane): lane is OutputLaneState => lane !== undefined)
      .map(({ attachment }) => attachment);
    return {
      ...descriptor,
      ...(state.debugCaptureIds.length === 0
        ? {}
        : { debugCaptureIds: Object.freeze([...state.debugCaptureIds]) }),
      destinations: Object.freeze(destinations),
    } as DirectPlanProducer;
  }
}

function isPendingCombinatorDescriptor(
  descriptor: CombinatorDescriptor,
): descriptor is Extract<CombinatorDescriptor, { readonly pendingConfiguration: unknown }> {
  return (
    (descriptor.kind === 'constant' ||
      descriptor.kind === 'selector' ||
      descriptor.kind === 'arithmetic') &&
    'pendingConfiguration' in descriptor
  );
}

function hasConcreteSelectorConfiguration(descriptor: CombinatorDescriptor): boolean {
  return (
    descriptor.kind === 'selector' &&
    'pendingConfiguration' in descriptor &&
    (Object.hasOwn(descriptor, 'index') || Object.hasOwn(descriptor, 'output'))
  );
}

function hasConcreteArithmeticOperands(descriptor: CombinatorDescriptor): boolean {
  return (
    descriptor.kind === 'arithmetic' &&
    'pendingConfiguration' in descriptor &&
    ((descriptor.left.kind === 'constant' && Object.hasOwn(descriptor.left, 'value')) ||
      (descriptor.right.kind === 'constant' && Object.hasOwn(descriptor.right, 'value')))
  );
}

function sameArithmeticOperandTopology(
  left: PendingArithmeticOperand,
  right: PendingArithmeticOperand | PlanArithmeticOperand,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'constant' && right.kind === 'constant') return true;
  if (left.kind === 'signal' && right.kind === 'signal') {
    return sameNetworkRef(left, right) && sameSignal(left.signal, right.signal);
  }
  return left.kind === 'each' && right.kind === 'each' && sameNetworkRef(left, right);
}

function sameTemplateArithmeticOperand(
  left: ArithmeticTemplateOperand,
  right: PlanArithmeticOperand,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'constant' && right.kind === 'constant') return true;
  return left.kind !== 'constant' && right.kind !== 'constant' && sameNetworkRef(left, right);
}

function sameArithmeticOutput(
  left: LogicalArithmeticOutput,
  right: LogicalArithmeticOutput,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'each' || (right.kind === 'signal' && sameSignal(left.signal, right.signal));
}

function sameNetworkRef(left: PlanNetworkRef, right: PlanNetworkRef): boolean {
  if (left.refKind !== right.refKind) return false;
  return left.refKind === 'single'
    ? right.refKind === 'single' && left.network === right.network
    : right.refKind === 'pair' &&
        left.networks[0] === right.networks[0] &&
        left.networks[1] === right.networks[1];
}
