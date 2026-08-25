function Scale(input: Readonly<Network>): Network {
  return input * 10;
}

const input = new Network<R>();
const output: Network = Scale(input);
