import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type { FunctionOwnershipFrame, NetworkBorrow, NetworkValue } from './elaboration-values.js';

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

function assertReadable(network: NetworkValue, source: SourceSpan, role = 'Network'): void {
  const consumedAt = network.ownership.consumedAt;
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
  if (network.generation !== network.ownership.generation) {
    const move = network.ownership.lastMove;
    throw new ElaborationExecutionError(
      network.ownership.owner === 'lost'
        ? `Cannot use Network ${network.name}; its moved ownership was not returned.`
        : `Cannot use moved ${role} ${network.name}.`,
      source,
      network.ownership.owner === 'lost' ? 'RT2019' : 'RT2012',
      [
        ...(move === undefined ? [] : [{ message: 'Ownership moved here.', span: move.source }]),
        { message: 'Network declared here.', span: network.declaration },
      ],
    );
  }
  if (network.borrow !== undefined && !network.borrow.active) {
    throw new ElaborationExecutionError(
      `Cannot use expired ${network.capability === 'readonly' ? 'Readonly<Network>' : 'Ref<Network>'} parameter ${network.borrow.parameter}.`,
      source,
      'RT2017',
      [
        { message: 'Borrow created here.', span: network.borrow.source },
        ...(network.borrow.releasedAt === undefined
          ? []
          : [{ message: 'Borrow ended here.', span: network.borrow.releasedAt }]),
      ],
    );
  }
  const mutableBorrow = network.ownership.mutableBorrow;
  if (mutableBorrow !== undefined && network.borrow !== mutableBorrow) {
    throw new ElaborationExecutionError(
      `Cannot read Network ${network.name} while it is mutably borrowed.`,
      source,
      'RT2016',
      [{ message: 'Mutable borrow created here.', span: mutableBorrow.source }],
    );
  }
}

function assertWritable(network: NetworkValue, source: SourceSpan, role = 'Network'): void {
  assertReadable(network, source, role);
  if (network.capability === 'readonly') {
    throw new ElaborationExecutionError(
      `Cannot attach a producer through Readonly<Network> parameter ${network.borrow?.parameter ?? network.name}.`,
      source,
      'RT2015',
      network.borrow === undefined
        ? undefined
        : [{ message: 'Readonly borrow created here.', span: network.borrow.source }],
    );
  }
  const readonlyBorrow = network.ownership.readonlyBorrows.values().next().value;
  if (readonlyBorrow !== undefined) {
    throw new ElaborationExecutionError(
      `Cannot write Network ${network.name} while it is read-only borrowed.`,
      source,
      'RT2016',
      [{ message: 'Readonly borrow created here.', span: readonlyBorrow.source }],
    );
  }
}

function assertConsumable(network: NetworkValue, source: SourceSpan, role: string): void {
  assertReadable(network, source, role);
  if (network.capability !== 'owned' && network.capability !== 'move') {
    throw new ElaborationExecutionError(
      `Cannot consume ${network.capability === 'readonly' ? 'Readonly<Network>' : 'Ref<Network>'} ${role} ${network.name}.`,
      source,
      'RT2015',
      network.borrow === undefined
        ? undefined
        : [{ message: 'Borrow created here.', span: network.borrow.source }],
    );
  }
  const activeBorrow =
    network.ownership.mutableBorrow ?? network.ownership.readonlyBorrows.values().next().value;
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

const defaultOwnershipPolicy: ElaborationOwnershipPolicy = {
  releaseFrame,
  assertReadable,
  assertWritable,
  assertConsumable,
  requireColor: (network, capability, color, source) => {
    const existing = network.ownership.colorRequirement;
    if (existing?.color === color) return false;
    if (existing !== undefined) {
      throw new ElaborationExecutionError(
        `${capability === 'ref' ? 'Ref' : capability === 'move' ? 'Move' : 'Readonly'}<Network<${color === 'red' ? 'R' : 'G'}>> conflicts with the existing ${existing.color} requirement for Network ${network.name}.`,
        source,
        'RT2018',
        [{ message: 'Existing color requirement originates here.', span: existing.source }],
      );
    }
    network.ownership.colorRequirement = { color, source };
    return true;
  },
  borrow: (network, capability, parameter, source, frame) => {
    assertReadable(network, source);
    const ownership = network.ownership;
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
    assertConsumable(network, source, 'source');
    const ownership = network.ownership;
    ownership.generation += 1;
    ownership.owner = frame.owner;
    ownership.lastMove = { source, generation: ownership.generation };
    frame.moves.push({ ownership, source, returned: false });
  },
  returnToCaller: (network, source, frame, caller) => {
    assertReadable(network, source);
    if (network.capability === 'readonly' || network.capability === 'ref') {
      throw new ElaborationExecutionError(
        `A ${network.capability === 'readonly' ? 'Readonly<Network>' : 'Ref<Network>'} borrow cannot escape its function.`,
        source,
        'RT2017',
        network.borrow === undefined
          ? undefined
          : [{ message: 'Borrow created here.', span: network.borrow.source }],
      );
    }
    if (network.ownership.owner !== frame.owner) {
      throw new ElaborationExecutionError(
        `Function cannot return Network ${network.name} because it does not own that value; accept it as Move<Network> first.`,
        source,
        'RT2019',
        [{ message: 'Network declared here.', span: network.declaration }],
      );
    }
    const move = frame.moves.findLast(({ ownership }) => ownership === network.ownership);
    if (move !== undefined) move.returned = true;
    network.ownership.generation += 1;
    network.ownership.owner = caller?.owner ?? 'top-level';
    network.ownership.lastMove = { source, generation: network.ownership.generation };
  },
  consume: (network, source) => {
    network.ownership.consumedAt = source;
  },
};

export const elaborationOwnershipPolicy = Object.freeze(defaultOwnershipPolicy);
