/**
 * Food vocabularies shared by the preference parser, the merge rules, the recipe
 * search and the MCP tools. Diets, intolerances and cuisines mirror Spoonacular's
 * accepted values exactly, so anything a member picks can actually be filtered on.
 */

export const DIETS = [
  'gluten free',
  'ketogenic',
  'vegetarian',
  'lacto-vegetarian',
  'ovo-vegetarian',
  'vegan',
  'pescetarian',
  'paleo',
  'primal',
  'low fodmap',
  'whole30',
] as const;
export type Diet = (typeof DIETS)[number];

export const INTOLERANCES = [
  'dairy',
  'egg',
  'gluten',
  'grain',
  'peanut',
  'seafood',
  'sesame',
  'shellfish',
  'soy',
  'sulfite',
  'tree nut',
  'wheat',
] as const;
export type Intolerance = (typeof INTOLERANCES)[number];

export const CUISINES = [
  'African',
  'American',
  'Asian',
  'British',
  'Cajun',
  'Caribbean',
  'Chinese',
  'Eastern European',
  'European',
  'French',
  'German',
  'Greek',
  'Indian',
  'Irish',
  'Italian',
  'Japanese',
  'Jewish',
  'Korean',
  'Latin American',
  'Mediterranean',
  'Mexican',
  'Middle Eastern',
  'Nordic',
  'Southern',
  'Spanish',
  'Thai',
  'Vietnamese',
] as const;
export type Cuisine = (typeof CUISINES)[number];

/** Soft "in the mood for" tags. A fixed list, so free text never becomes a tag. */
export const CRAVINGS = [
  'spicy',
  'comfort food',
  'healthy',
  'light',
  'cheesy',
  'hearty',
  'sweet',
  'quick',
  'fresh',
] as const;
export type Craving = (typeof CRAVINGS)[number];

/**
 * Rules people state that the recipe API has no filter for. They're shown to the
 * whole group ("we can't filter for halal") instead of being silently dropped.
 */
export const UNSUPPORTED_RULES = [
  'halal',
  'kosher',
  'low sodium',
  'low carb',
  'diabetic',
  'alcohol-free',
  'nightshade-free',
] as const;
export type UnsupportedRule = (typeof UNSUPPORTED_RULES)[number];
