import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type {
  FunctionOwnershipFrame,
  NetworkBorrow,
  NetworkRuntimeState,
  NetworkValue,
} from './elaboration-values.js';

export type NetworkRuntimeStateLookup = (network: NetworkValue) => NetworkRuntimeState;

export interface ElaborationOwnershipPolicy {
  releaseFrame(frame: FunctionOwnershipFrame, releasedAt?: SourceSpan): void;
  assertReadable(network: NetworkValue, source: SourceSpan, role?: string): void;
  assertWritable(network: NetworkValue, source: SourceSpan, role?: string): void;
  assertConsumable(network: NetworkValue, source: SourceSpan, role: string): void;
  requireColor(
    network: NetworkValue,
    capability: 'readonly' | 'ref' | 'move',
    color: 'red' | 'green',
    source: SourceSpan,
  ): boolean;
  borrow(
    network: NetworkValue,
    capability: 'readonly' | 'ref',
    parameter: string,
    source: SourceSpan,
    frame: FunctionOwnershipFrame,
  ): NetworkBorrow;
  moveToFrame(network: NetworkValue, source: SourceSpan, frame: FunctionOwnershipFrame): void;
  returnToCaller(
    network: NetworkValue,
    source: SourceSpan,
    frame: FunctionOwnershipFrame,
    caller: FunctionOwnershipFrame | undefined,
  ): void;
  consume(network: NetworkValue, source: SourceSpan): void;
}

function assertReadable(
  stateFor: NetworkRuntimeStateLookup,
  network: NetworkValue,
  source: SourceSpan,
  role = 'Network',
): void {
  const state = stateFor(network);
  const consumedAt = state.ownership.consumedAt;
  if (consumedAt !== undefined) {
    throw new ElaborationExecutionError(
      `Cannot use moved ${role} ${network.name}.`,
      source,
      'RT2012',
      [
        { message: 'Network was consumed here.', span: consumedAt },
        { message: 'Network was declared here.', span: network.declaration },
      ],
    );
  }
  if (network.generation !== state.ownership.generation) {
    const move = state.ownership.lastMove;
    throw new ElaborationExecutionError(
      state.ownership.owner === 'lost'
        ? `Cannot use Network ${network.name}; its moved ownership was not returned.`
        : `Cannot use moved ${role} ${network.name}.`,
      source,
      state.ownership.owner === 'lost' ? 'RT2019' : 'RT2012',
      [
        ...(move === undefined ? [] : [{ message: 'Ownership moved here.', span: move.source }]),
        { message: 'Network declared here.', span: network.declaration },
      ],
    );
  }
  if (state.borrow !== undefined && !state.borrow.active) {
    throw new ElaborationExecutionError(
      `Cannot use expired ${network.capability === 'readonly' ? 'Readonly<Network>' : 'Ref<Network>'} parameter ${state.borrow.parameter}.`,
      source,
      'RT2017',
      [
        { message: 'Borrow created here.', span: state.borrow.source },
        ...(state.borrow.releasedAt === undefined
          ? []
          : [{ message: 'Borrow ended here.', span: state.borrow.releasedAt }]),
      ],
    );
  }
  const mutableBorrow = state.ownership.mutableBorrow;
  if (mutableBorrow !== undefined && state.borrow !== mutableBorrow) {
    throw new ElaborationExecutionError(
      `Cannot read Network ${network.name} while it is mutably borrowed.`,
      source,
      'RT2016',
      [{ message: 'Mutable borrow created here.', span: mutableBorrow.source }],
    );
  }
}

function assertWritable(
  stateFor: NetworkRuntimeStateLookup,
  network: NetworkValue,
  source: SourceSpan,
  role = 'Network',
): void {
  assertReadable(stateFor, network, source, role);
  const state = stateFor(network);
  if (network.capability === 'readonly') {
    throw new ElaborationExecutionError(
      `Cannot attach a producer through Readonly<Network> parameter ${state.borrow?.parameter ?? network.name}.`,
      source,
      'RT2015',
      state.borrow === undefined
        ? undefined
        : [{ message: 'Readonly borrow created here.', span: state.borrow.source }],
    );
  }
  const readonlyBorrow = state.ownership.readonlyBorrows.values().next().value;
  if (readonlyBorrow !== undefined) {
    throw new ElaborationExecutionError(
      `Cannot write Network ${network.name} while it is read-only borrowed.`,
      source,
      'RT2016',
      [{ message: 'Readonly borrow created here.', span: readonlyBorrow.source }],
    );
  }
}

function assertConsumable(
  stateFor: NetworkRuntimeStateLookup,
  network: NetworkValue,
  source: SourceSpan,
  role: string,
): void {
  assertReadable(stateFor, network, source, role);
  const state = stateFor(network);
  if (network.capability !== 'owned' && network.capability !== 'move') {
    throw new ElaborationExecutionError(
      `Cannot consume ${network.capability === 'readonly' ? 'Readonly<Network>' : 'Ref<Network>'} ${role} ${network.name}.`,
      source,
      'RT2015',
      state.borrow === undefined
        ? undefined
        : [{ message: 'Borrow created here.', span: state.borrow.source }],
    );
  }
  const activeBorrow =
    state.ownership.mutableBorrow ?? state.ownership.readonlyBorrows.values().next().value;
  if (activeBorrow !== undefined) {
    throw new ElaborationExecutionError(
      `Cannot consume Network ${network.name} while it is borrowed.`,
      source,
      'RT2016',
      [{ message: 'Borrow created here.', span: activeBorrow.source }],
    );
  }
}

function releaseFrame(frame: FunctionOwnershipFrame, releasedAt?: SourceSpan): void {
  for (const borrow of frame.borrows.toReversed()) {
    borrow.active = false;
    if (releasedAt !== undefined) borrow.releasedAt = releasedAt;
    const ownership = borrow.ownership;
    if (borrow.capability === 'readonly') ownership.readonlyBorrows.delete(borrow);
    else if (ownership.mutableBorrow === borrow) delete ownership.mutableBorrow;
  }
  for (const move of frame.moves.toReversed()) {
    if (
      !move.returned &&
      move.ownership.consumedAt === undefined &&
      move.ownership.owner === frame.owner
    ) {
      move.ownership.generation += 1;
      move.ownership.owner = 'lost';
      move.ownership.lastMove = {
        source: releasedAt ?? frame.source,
        generation: move.ownership.generation,
      };
    }
  }
}

export function createElaborationOwnershipPolicy(
  stateFor: NetworkRuntimeStateLookup,
): ElaborationOwnershipPolicy {
  const policy: ElaborationOwnershipPolicy = {
    releaseFrame,
    assertReadable: (network, source, role) => assertReadable(stateFor, network, source, role),
    assertWritable: (network, source, role) => assertWritable(stateFor, network, source, role),
    assertConsumable: (network, source, role) => assertConsumable(stateFor, network, source, role),
    requireColor: (network, capability, color, source) => {
      const ownership = stateFor(network).ownership;
      const existing = ownership.colorRequirement;
      if (existing?.color === color) return false;
      if (existing !== undefined) {
        throw new ElaborationExecutionError(
          `${capability === 'ref' ? 'Ref' : capability === 'move' ? 'Move' : 'Readonly'}<Network<${color === 'red' ? 'R' : 'G'}>> conflicts with the existing ${existing.color} requirement for Network ${network.name}.`,
          source,
          'RT2018',
          [{ message: 'Existing color requirement originates here.', span: existing.source }],
        );
      }
      ownership.colorRequirement = { color, source };
      return true;
    },
    borrow: (network, capability, parameter, source, frame) => {
      assertReadable(stateFor, network, source);
      const ownership = stateFor(network).ownership;
      const conflicting =
        capability === 'readonly'
          ? ownership.mutableBorrow
          : (ownership.mutableBorrow ?? ownership.readonlyBorrows.values().next().value);
      if (conflicting !== undefined) {
        throw new ElaborationExecutionError(
          `Cannot create ${capability === 'readonly' ? 'Readonly<Network>' : 'Ref<Network>'} parameter ${parameter} while Network ${network.name} is already borrowed.`,
          source,
          'RT2016',
          [{ message: 'Conflicting borrow created here.', span: conflicting.source }],
        );
      }
      const borrow: NetworkBorrow = {
        capability,
        parameter,
        source,
        ownership,
        active: true,
      };
      if (capability === 'readonly') ownership.readonlyBorrows.add(borrow);
      else ownership.mutableBorrow = borrow;
      frame.borrows.push(borrow);
      return borrow;
    },
    moveToFrame: (network, source, frame) => {
      assertConsumable(stateFor, network, source, 'source');
      const ownership = stateFor(network).ownership;
      ownership.generation += 1;
      ownership.owner = frame.owner;
      ownership.lastMove = { source, generation: ownership.generation };
      frame.moves.push({ ownership, source, returned: false });
    },
    returnToCaller: (network, source, frame, caller) => {
      assertReadable(stateFor, network, source);
      const state = stateFor(network);
      if (network.capability === 'readonly' || network.capability === 'ref') {
        throw new ElaborationExecutionError(
          `A ${network.capability === 'readonly' ? 'Readonly<Network>' : 'Ref<Network>'} borrow cannot escape its function.`,
          source,
          'RT2017',
          state.borrow === undefined
            ? undefined
            : [{ message: 'Borrow created here.', span: state.borrow.source }],
        );
      }
      if (state.ownership.owner !== frame.owner) {
        throw new ElaborationExecutionError(
          `Function cannot return Network ${network.name} because it does not own that value; accept it as Move<Network> first.`,
          source,
          'RT2019',
          [{ message: 'Network declared here.', span: network.declaration }],
        );
      }
      const move = frame.moves.findLast(({ ownership }) => ownership === state.ownership);
      if (move !== undefined) move.returned = true;
      state.ownership.generation += 1;
      state.ownership.owner = caller?.owner ?? 'top-level';
      state.ownership.lastMove = { source, generation: state.ownership.generation };
    },
    consume: (network, source) => {
      stateFor(network).ownership.consumedAt = source;
    },
  };
  return Object.freeze(policy);
}
