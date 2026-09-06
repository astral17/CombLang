export type RecipeComponentRole = 'ingredient' | 'product';
export type RecipeComponentKind = 'item' | 'fluid';

export type RecipeComponentField =
  | 'amount'
  | 'amountMin'
  | 'amountMax'
  | 'extraCountFraction'
  | 'probability'
  | 'independentProbability'
  | 'sharedProbability'
  | 'ignoredByStats'
  | 'ignoredByProductivity'
  | 'affectedByQuality'
  | 'qualityChange'
  | 'qualityMin'
  | 'qualityMax'
  | 'percentSpoiled'
  | 'alwaysFresh'
  | 'resetFreshnessOnCraft'
  | 'spoilWeight'
  | 'fluidboxIndex'
  | 'fluidboxMultiplier'
  | 'optionalFluidboxIndexes'
  | 'temperature'
  | 'temperatureMin'
  | 'temperatureMax';

export interface RecipeComponentApplicabilityIssue {
  readonly field: RecipeComponentField;
  readonly message: string;
}

type ApplicabilityRule =
  | 'all'
  | 'product'
  | 'item-product'
  | 'item-any-role'
  | 'item-ingredient'
  | 'fluid-any-role'
  | 'fluid-ingredient';

const fields = [
  'amount',
  'amountMin',
  'amountMax',
  'extraCountFraction',
  'probability',
  'independentProbability',
  'sharedProbability',
  'ignoredByStats',
  'ignoredByProductivity',
  'affectedByQuality',
  'qualityChange',
  'qualityMin',
  'qualityMax',
  'percentSpoiled',
  'alwaysFresh',
  'resetFreshnessOnCraft',
  'spoilWeight',
  'fluidboxIndex',
  'fluidboxMultiplier',
  'optionalFluidboxIndexes',
  'temperature',
  'temperatureMin',
  'temperatureMax',
] as const satisfies readonly RecipeComponentField[];

const rules = {
  amount: 'all',
  amountMin: 'product',
  amountMax: 'product',
  extraCountFraction: 'item-product',
  probability: 'product',
  independentProbability: 'product',
  sharedProbability: 'product',
  ignoredByStats: 'all',
  ignoredByProductivity: 'product',
  affectedByQuality: 'item-product',
  qualityChange: 'item-any-role',
  qualityMin: 'item-any-role',
  qualityMax: 'item-any-role',
  percentSpoiled: 'item-product',
  alwaysFresh: 'item-product',
  resetFreshnessOnCraft: 'item-product',
  spoilWeight: 'item-ingredient',
  fluidboxIndex: 'fluid-any-role',
  fluidboxMultiplier: 'fluid-any-role',
  optionalFluidboxIndexes: 'fluid-any-role',
  temperature: 'fluid-any-role',
  temperatureMin: 'fluid-ingredient',
  temperatureMax: 'fluid-ingredient',
} as const satisfies Readonly<Record<RecipeComponentField, ApplicabilityRule>>;

const ruleLabels: Readonly<Record<Exclude<ApplicabilityRule, 'all'>, string>> = {
  product: 'product components',
  'item-product': 'item products',
  'item-any-role': 'item ingredients or products',
  'item-ingredient': 'item ingredients',
  'fluid-any-role': 'fluid ingredients or products',
  'fluid-ingredient': 'fluid ingredients',
};

function applies(
  rule: ApplicabilityRule,
  role: RecipeComponentRole,
  kind: RecipeComponentKind,
): boolean {
  switch (rule) {
    case 'all':
      return true;
    case 'product':
      return role === 'product';
    case 'item-product':
      return kind === 'item' && role === 'product';
    case 'item-any-role':
      return kind === 'item';
    case 'item-ingredient':
      return kind === 'item' && role === 'ingredient';
    case 'fluid-any-role':
      return kind === 'fluid';
    case 'fluid-ingredient':
      return kind === 'fluid' && role === 'ingredient';
  }
}

export function isRecipeComponentFieldApplicable(
  field: RecipeComponentField,
  role: RecipeComponentRole,
  kind: RecipeComponentKind,
): boolean {
  return applies(rules[field], role, kind);
}

/** Returns applicability issues without validating field values or mutating the source. */
export function recipeComponentApplicabilityIssues(
  component: object,
  role: RecipeComponentRole,
  kind: RecipeComponentKind,
): readonly RecipeComponentApplicabilityIssue[] {
  const issues = fields.flatMap((field) => {
    if (
      !Object.prototype.hasOwnProperty.call(component, field) ||
      isRecipeComponentFieldApplicable(field, role, kind)
    ) {
      return [];
    }
    const rule = rules[field];
    if (rule === 'all') return [];
    return [
      Object.freeze({
        field,
        message: `${field} is valid only on ${ruleLabels[rule]}.`,
      }),
    ];
  });
  return Object.freeze(issues);
}
