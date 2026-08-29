function Connect(output: Ref<Network<G>>, input: Readonly<Network<R>>): void {
  output += input + 1;
}

const input: Network = CC(5 * Signal('virtual', 'signal-A'));
const output = new Network();

Connect(output, input);
