test('emits a full stack from the selected prototype environment', ({
  network,
  tick,
  expectSignal,
}) => {
  tick();
  expectSignal(network('output'), Signal('iron-plate')).toBe(100);
});
