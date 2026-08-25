export interface CircuitNetworkSelection {
  readonly red?: boolean;
  readonly green?: boolean;
}

export function readsRed(selection?: CircuitNetworkSelection): boolean {
  return selection?.red ?? true;
}

export function readsGreen(selection?: CircuitNetworkSelection): boolean {
  return selection?.green ?? true;
}
