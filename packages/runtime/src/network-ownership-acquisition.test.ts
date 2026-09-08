import { transformElaborationModule } from '@comblang/compiler';
import { parseFile } from '@comblang/language';
import { describe, expect, test } from 'vitest';

import { elaborateDirectPlan } from './direct-plan.js';
import { ElaborationOperationLimitError } from './elaboration-errors.js';
import { executeElaborationProgram } from './elaboration-program.js';

function execute(text: string, options?: { readonly dslCallBudget?: number }) {
  return executeElaborationProgram(
    transformElaborationModule(
      parseFile({ path: 'network-ownership-acquisition.factorio.ts', text }),
    ),
    options,
  );
}

function normalizeSourceOffsets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSourceOffsets);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key === 'start' || key === 'end' ? key : key,
        key === 'start' || key === 'end' ? '<source-offset>' : normalizeSourceOffsets(nested),
      ]),
    );
  }
  return value;
}

describe('ownership acquisition and atomic join', () => {
  test('explicit Network assertion is a real Network view, not a Combinator handle', () => {
    const source = `const producer = CC();
const narrowed = producer as Network;
const destination = new Network();
narrowed.to(destination);`;

    expect(() => execute(source)).toThrow();
  });

  test('Move<Network> acquires the primary and then the lazy secondary output lane', () => {
    const source = `function Consume(input: Move<Network>) {}
const producer = CC();
Consume(producer);
Consume(producer);
producer.at(1, 2);`;

    expect(() => execute(source)).not.toThrow();
  });

  test('reports RT2028 on a third Combinator Move and keeps the failed call atomic', () => {
    const source = `function Consume(input: Move<Network>) {}
const producer = CC();
Consume(producer);
Consume(producer);
let code = '';
try { Consume(producer); } catch (error) { code = error.code; }
producer.at(1, 2);
if (code !== 'RT2028') throw new Error('wrong exhausted-lane code: ' + code);`;

    expect(() => execute(source)).not.toThrow();
  });

  test('a narrowed Network never falls back to a Combinator secondary lane', () => {
    const source = `function Consume(input: Move<Network>) {}
const producer = CC();
const narrowed = producer as Network;
Consume(narrowed);
Consume(narrowed);`;

    expect(() => execute(source)).toThrowError(expect.objectContaining({ code: 'RT2019' }));
  });

  test.each([
    'const producer = CC(); const holder = { value: producer as Network }; holder.value.to(new Network());',
    'const producer = CC(); const values = [producer as Network]; values[0].to(new Network());',
    'const producer = CC(); const narrowed = producer as Network; const output = new Network(); output += narrowed;',
  ])('does not recover Combinator authority through %s', (source) => {
    expect(() => execute(source)).toThrow();
  });

  test('typed arrow Network returns and typed bindings remain exact primary views', () => {
    const source = `const producer = CC();
const bound: Network = producer;
const make = (): Network => producer;
const returned = make();
bound.to(new Network());`;

    expect(() => execute(source)).toThrow();
  });

  test('Move unions use the same next-lane acquisition policy', () => {
    const source = `function Consume(input: Move<Network> | number) {
  if (typeof input === 'number') return;
}
const producer = CC();
Consume(producer);
Consume(producer);`;

    expect(() => execute(source)).not.toThrow();
  });

  test('rolls back duplicate and contradictory output attachments before a later valid call', () => {
    const duplicate = execute(`const input = new Network();
const first = new Network();
const second = new Network();
const producer = input + 1;
try { producer.to(first, first); } catch {}
producer.to(first, second);`);
    expect(duplicate.producers[0]?.destinations).toHaveLength(2);

    const contradictory = execute(`const input = new Network();
const red = new Network<R>();
const redAgain = new Network<R>();
const producer = input + 1;
try { producer.to(red, redAgain); } catch {}
producer.to(red);`);
    expect(contradictory.producers[0]?.destinations).toHaveLength(1);
  });

  test('rolls back output Signal conflicts without retaining a binding or secondary lane', () => {
    const source = `const input = new Network();
const destination = new Network();
const producer = input + 1;
const A = Signal('virtual', 'A');
const B = Signal('virtual', 'B');
producer.to(destination, A);
try { producer.to(destination, B); } catch {}`;

    const plan = execute(source);
    expect(plan.producers[0]?.destinations).toHaveLength(1);
  });

  test('caught attachment category failures do not poison later valid attachments', () => {
    const source = `const producer = CC();
const destination = new Network();
const first = new Network();
const second = new Network();
const pairInput = pair(first, second);
let fluentCode = '';
let pairCode = '';
let freeCode = '';
let assignmentCode = '';
try { producer.to(5); } catch (error) { fluentCode = error.code; }
try { producer.to(pairInput); } catch (error) { pairCode = error.code; }
try { to(pairInput) += producer; } catch (error) { freeCode = error.code; }
try { destination += 5; } catch (error) { assignmentCode = error.code; }
producer.to(destination);
if (fluentCode !== 'RT2015' || pairCode !== 'RT2020' || freeCode !== 'RT2020' || assignmentCode !== 'RT2015') {
  throw new Error('attachment recovery codes were not stable');
}`;

    const plan = execute(source);
    expect(plan.producers).toHaveLength(1);
    expect(plan.producers[0]?.destinations).toHaveLength(1);
    expect(plan.networkPairs).toHaveLength(1);
  });

  test('repeated caught joins consume the monotonic DSL budget', () => {
    const source = `const producer = CC();
for (let attempt = 0; attempt < 10; attempt += 1) {
  try { join(producer, producer); } catch {}
}`;

    expect(() => execute(source, { dslCallBudget: 15 })).toThrowError(
      ElaborationOperationLimitError,
    );
  });

  test('caught failed acquisition is topology-identical after Direct Plan, EG, and NCIR lowering', () => {
    const failedSource = `const producer = CC();
const existing = new Network();
try { join(producer, producer, producer); } catch {}
const merged = join(producer, existing);`;
    const cleanSource = `const producer = CC();
const existing = new Network();
const merged = join(producer, existing);`;

    const failedPlan = execute(failedSource);
    const cleanPlan = execute(cleanSource);
    const failedExecution = elaborateDirectPlan(failedPlan);
    const cleanExecution = elaborateDirectPlan(cleanPlan);

    expect(normalizeSourceOffsets(failedPlan)).toEqual(normalizeSourceOffsets(cleanPlan));
    expect(normalizeSourceOffsets(failedExecution.circuit.graph)).toEqual(
      normalizeSourceOffsets(cleanExecution.circuit.graph),
    );
    expect(normalizeSourceOffsets(failedExecution.circuit.ir)).toEqual(
      normalizeSourceOffsets(cleanExecution.circuit.ir),
    );
  });

  test('join failure leaves every input available for a later zero-tick union', () => {
    const source = `const first = new Network();
const second = new Network();
try { join(first, first); } catch {}
const merged = join(first, second);
if (merged.kind !== 'network') throw new Error('join did not return a Network');`;

    const plan = execute(source);
    expect(plan.networks).toHaveLength(3);
    expect(plan.networkTransfers).toHaveLength(2);
  });

  test('join validates fixed colors and preserves inputs after a caught conflict', () => {
    const source = `const red = new Network<R>();
const green = new Network<G>();
const redAgain = new Network<R>();
let code = '';
try { join(red, green); } catch (error) { code = error.code; }
const merged = join(red, redAgain);
if (code !== 'RT2014' || merged.kind !== 'network') throw new Error('join color policy failed');`;

    const plan = execute(source);
    expect(plan.networkTransfers).toHaveLength(2);
  });

  test('join accepts spread arrays and loop-produced inputs without adding Producers', () => {
    const source = `const first = new Network();
const second = new Network();
const values = [first, second];
let merged = join(...values);
for (const input of [new Network(), new Network()]) merged = join(merged, input);`;

    const plan = execute(source);
    expect(plan.producers).toHaveLength(0);
    expect(plan.networkTransfers).toHaveLength(6);
  });

  test('repeated Combinator join uses primary then secondary, while a third occurrence is atomic', () => {
    const source = `const producer = CC();
let code = '';
try { join(producer, producer, producer); } catch (error) { code = error.code; }
const existing = new Network();
const merged = join(producer, existing);
if (code !== 'RT2028' || merged.kind !== 'network') throw new Error('join lane policy failed');`;

    const plan = execute(source);
    expect(plan.networkTransfers).toHaveLength(2);
    expect(plan.producers[0]?.destinations).toHaveLength(1);
  });

  test('join is an atomic zero-tick union of acquired inputs', () => {
    const source = `const producer = CC();
const existing = new Network();
const merged = join(producer, existing);
if (merged.kind !== 'network') throw new Error('join did not return a Network');`;

    const plan = execute(source);
    expect(plan.producers).toHaveLength(1);
    expect(plan.networkTransfers).toHaveLength(2);
  });
});
