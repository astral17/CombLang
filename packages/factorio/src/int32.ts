export type CircuitValue = number;

export function int32(value: number): CircuitValue {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError('Circuit values must be safe integers before int32 normalization.');
  }
  return value | 0;
}

export function addInt32(left: CircuitValue, right: CircuitValue): CircuitValue {
  return (left + right) | 0;
}

export function multiplyInt32(left: CircuitValue, right: CircuitValue): CircuitValue {
  return Math.imul(left, right);
}

export function subtractInt32(left: CircuitValue, right: CircuitValue): CircuitValue {
  return (left - right) | 0;
}

export function divideInt32(left: CircuitValue, right: CircuitValue): CircuitValue {
  // Kept explicit so an in-game conformance fixture can lock this edge case independently.
  if (right === 0) {
    return 0;
  }
  return Math.trunc(left / right) | 0;
}

export function moduloInt32(left: CircuitValue, right: CircuitValue): CircuitValue {
  // Kept explicit so an in-game conformance fixture can lock this edge case independently.
  if (right === 0) {
    return 0;
  }
  return (left % right) | 0;
}

export function powerInt32(base: CircuitValue, exponent: CircuitValue): CircuitValue {
  // Negative exponents are provisional until captured by the Factorio conformance harness.
  if (exponent < 0) {
    if (base === 1) return 1;
    if (base === -1) return (exponent & 1) === 0 ? 1 : -1;
    return 0;
  }

  let factor = base;
  let remaining = exponent;
  let result = 1;
  while (remaining > 0) {
    if ((remaining & 1) !== 0) {
      result = Math.imul(result, factor);
    }
    remaining = Math.floor(remaining / 2);
    if (remaining > 0) {
      factor = Math.imul(factor, factor);
    }
  }
  return result | 0;
}
