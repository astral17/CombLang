function MemoCell(input: Readonly<Network>): Network {
  const out = new Network();
  const mem = new Network();
  to(out, mem) += input + 0;
  to(out, mem) += when(input == 0 && mem != 0).then(mem);
  return out;
}

const input = new Network();
const output: Network = MemoCell(input);
const secondInput = new Network();
const secondOutput: Network = MemoCell(secondInput);
