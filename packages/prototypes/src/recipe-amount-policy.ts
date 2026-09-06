export type RecipeAmountRole = 'ingredient' | 'product';
export type RecipeAmountKind = 'item' | 'fluid';

export type RecipeAmountField = 'amount' | 'amountMin' | 'amountMax';

export interface RecipeAmountInput {
  readonly amount?: number;
  readonly amountMin?: number;
  readonly amountMax?: number;
  /** Presence is observed only to make clear that it cannot replace an amount. */
  readonly extraCountFraction?: number;
}

export interface RecipeAmountIssue {
  readonly field: RecipeAmountField;
  readonly message: string;
}

export interface EffectiveRecipeAmount {
  readonly amount?: number;
  readonly amountMin?: number;
  readonly amountMax?: number;
}

export interface RecipeAmountPolicyOptions {
  /** Allows the raw Factorio product-range fallback amountMax = amountMin. */
  readonly allowDescendingProductRange?: boolean;
}

export interface RecipeAmountPolicyResult {
  readonly issues: readonly RecipeAmountIssue[];
  readonly effective: EffectiveRecipeAmount;
}

function issue(field: RecipeAmountField, message: string): RecipeAmountIssue {
  return { field, message };
}

function checkDomain(
  value: number,
  field: RecipeAmountField,
  kind: RecipeAmountKind,
  role: RecipeAmountRole,
): RecipeAmountIssue | undefined {
  const domain =
    kind === 'item' ? 'an integer from 0 through 65535' : 'a finite non-negative number';
  if (!Number.isFinite(value)) return issue(field, 'must be finite.');
  if (kind === 'item' && (!Number.isInteger(value) || value < 0 || value > 65535)) {
    return issue(field, `must be ${domain}.`);
  }
  if (kind === 'fluid' && value < 0) return issue(field, `must be ${domain}.`);
  if (role === 'ingredient' && value <= 0)
    return issue(field, 'must be strictly positive for ingredients.');
  return undefined;
}

/** Applies canonical amount shape and domain rules without source paths or PT/PD codes. */
export function evaluateRecipeAmount(
  input: RecipeAmountInput,
  role: RecipeAmountRole,
  kind: RecipeAmountKind,
  options: RecipeAmountPolicyOptions = {},
): RecipeAmountPolicyResult {
  const issues: RecipeAmountIssue[] = [];
  const hasAmount = input.amount !== undefined;
  const hasAmountMin = input.amountMin !== undefined;
  const hasAmountMax = input.amountMax !== undefined;
  const hasRange = hasAmountMin || hasAmountMax;

  if (role === 'ingredient') {
    if (!hasAmount) {
      issues.push(
        issue(
          hasAmountMin ? 'amountMin' : 'amount',
          'ingredients require an exact amount; amount ranges are product-only.',
        ),
      );
    }
    if (hasRange) {
      issues.push(
        issue(
          hasAmountMin ? 'amountMin' : 'amountMax',
          'ingredient components cannot use an amount range.',
        ),
      );
    }
  } else if (!hasAmount && !hasRange) {
    issues.push(
      issue(
        'amount',
        input.extraCountFraction === undefined
          ? 'products require an exact amount or both amountMin and amountMax.'
          : 'extraCountFraction does not replace an exact amount or complete amount range.',
      ),
    );
  } else if (hasAmount && hasRange) {
    issues.push(issue('amount', 'product amount cannot be combined with an amount range.'));
  } else if (hasAmountMin !== hasAmountMax) {
    issues.push(
      issue(
        hasAmountMin ? 'amountMax' : 'amountMin',
        'product amountMin and amountMax must be provided together.',
      ),
    );
  }

  if (hasAmount) {
    const amountIssue = checkDomain(input.amount!, 'amount', kind, role);
    if (amountIssue !== undefined) issues.push(amountIssue);
  }
  if (hasAmountMin) {
    const amountIssue = checkDomain(input.amountMin!, 'amountMin', kind, role);
    if (amountIssue !== undefined) issues.push(amountIssue);
  }
  if (hasAmountMax) {
    const amountIssue = checkDomain(input.amountMax!, 'amountMax', kind, role);
    if (amountIssue !== undefined) issues.push(amountIssue);
  }

  let amountMax = input.amountMax;
  if (hasAmountMin && hasAmountMax && input.amountMin! > input.amountMax!) {
    if (role === 'product' && options.allowDescendingProductRange === true) {
      amountMax = input.amountMin;
    } else {
      issues.push(issue('amountMax', 'canonical amount ranges require amountMin <= amountMax.'));
    }
  }

  return {
    issues: Object.freeze(issues),
    effective: Object.freeze({
      ...(input.amount === undefined ? {} : { amount: input.amount }),
      ...(input.amountMin === undefined ? {} : { amountMin: input.amountMin }),
      ...(amountMax === undefined ? {} : { amountMax }),
    }),
  };
}
