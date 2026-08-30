function Advance(input: Move<Network>): Network {
  input += input + 1;
  return input;
}

let current = new Network();
const stages: Network[] = [new Network(), new Network()];
const state = { current: new Network() };

current = Advance(current);
for (let i = 0; i < stages.length; i++) {
  stages[i] = Advance(stages[i]);
}
state.current = Advance(state.current);

const output: Network = current + stages[0] + stages[1] + state.current;
