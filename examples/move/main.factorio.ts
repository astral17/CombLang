function Advance(input: Move<Network<R>>): Network {
  input += input + 1;
  return input;
}

const seed: Network = CC(5 * Signal('virtual', 'signal-A'));
const advanced = Advance(seed);
const output: Network = advanced * 2;
