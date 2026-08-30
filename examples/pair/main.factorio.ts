const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');

const red: Network<R> = CC(2 * A, 1 * B);
const green: Network<G> = CC(3 * A, 4 * B);
const inputs = pair(red, green);

const sumA: Network = inputs[A] + 0;
const doubled: Network = Each(inputs) * 2;
const copied: Network = IF(Anything(inputs) > 0, Everything(inputs));
