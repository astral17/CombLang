const A = Signal('virtual', 'signal-A');
const command = new Network();
const sensor = new Network();
const stage: Network = sensor[A] + 1;
const output: Network = stage[A] * 2;
const gated: Network = IF(command[A] > 0, sensor[A], 0 * A);
