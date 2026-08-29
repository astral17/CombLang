const SIGNAL_A = Signal('virtual', 'signal-A');

const input: Network = CC(5 * SIGNAL_A);
const staging: Network = input + 1;
const bus = new Network();

bus.take(staging);

const output: Network = bus * 2;
