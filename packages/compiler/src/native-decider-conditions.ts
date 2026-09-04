import type { LogicalDeciderCondition } from './ir.js';

type Comparison = Extract<LogicalDeciderCondition, { kind: 'compare' }>;

/** OR of AND groups for the native flat condition list (AND binds before OR). */
export function nativeDeciderConditionGroups(
  condition: LogicalDeciderCondition,
  maxRows: number,
): readonly (readonly Comparison[])[] {
  const checked = (rows: number) => {
    if (rows > maxRows) {
      throw new RangeError(
        `Decider condition expansion exceeds the blueprint preview limit of ${maxRows} rows.`,
      );
    }
  };
  const lower = (node: LogicalDeciderCondition): { groups: Comparison[][]; rows: number } => {
    if (node.kind === 'compare') return { groups: [[node]], rows: 1 };
    if (node.conditions.length === 0)
      throw new Error('Cannot export an empty Decider condition group.');
    if (node.kind === 'or') {
      const groups: Comparison[][] = [];
      let rows = 0;
      for (const child of node.conditions) {
        const next = lower(child);
        rows += next.rows;
        checked(rows);
        groups.push(...next.groups);
      }
      return { groups, rows };
    }
    let groups: Comparison[][] = [[]];
    let rows = 0;
    for (const child of node.conditions) {
      const next = lower(child);
      // Check BEFORE allocating the Cartesian product: DNF can grow exponentially.
      rows = rows * next.groups.length + next.rows * groups.length;
      checked(rows);
      groups = groups.flatMap((left) => next.groups.map((right) => [...left, ...right]));
    }
    return { groups, rows };
  };
  return lower(condition).groups;
}
