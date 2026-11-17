/**
 * Eval graders: plain code, no LLM judge. Each takes what an agent proposed (plus
 * what the app did with it) and returns numbers and named problems, so a run is
 * cheap, repeatable and easy to explain.
 */
import type { Card, GroupPreferences, HardFilters } from '@yumanimous/shared';
import type { LinePlan } from '../src/followUps/shoppingList.js';
import { checkPick, type Contender, type MediatorPick } from '../src/followUps/mediator.js';
import { cleanBlurb } from '../src/deck/aiDeckSource.js';
import { softScore } from '../src/deck/recipeDeckSource.js';

/** What Spoonacular said about a recipe (a subset of mcp-recipes' RecipeFacts). */
export interface Facts {
  vegetarian: boolean;
  vegan: boolean;
  glutenFree: boolean;
  dairyFree: boolean;
  readyInMinutes: number | null;
}

/**
 * Hard-rule breaches for one card. The pool came from a search WITH the group's
 * filters, so "not from the pool" is the main check; the facts double-check the
 * rules Spoonacular reports per recipe (intolerances are trusted to the search).
 */
export function hardViolations(
  card: Card,
  pool: ReadonlySet<string>,
  facts: ReadonlyMap<string, Facts>,
  hard: HardFilters,
): string[] {
  if (!pool.has(card.id)) return [`${card.id}: not from the filtered pool`];
  const f = facts.get(card.id);
  if (!f) return [];
  const problems: string[] = [];
  const diets = new Set<string>(hard.diets);
  if (diets.has('vegetarian') && !f.vegetarian) problems.push(`${card.id}: not vegetarian`);
  if (diets.has('vegan') && !f.vegan) problems.push(`${card.id}: not vegan`);
  if (diets.has('gluten free') && !f.glutenFree) problems.push(`${card.id}: not gluten free`);
  if (hard.intolerances.includes('dairy') && !f.dairyFree) problems.push(`${card.id}: has dairy`);
  if (
    hard.maxReadyMinutes !== null &&
    f.readyInMinutes !== null &&
    f.readyInMinutes > hard.maxReadyMinutes
  ) {
    problems.push(`${card.id}: ${f.readyInMinutes} min > ${hard.maxReadyMinutes}`);
  }
  return problems;
}

/** Cards in the first `n` that match the group's taste at all (soft score above 0). */
export const tasteHits = (deck: Card[], soft: GroupPreferences['soft'], n = 10) =>
  deck.slice(0, n).filter((c) => softScore(c, soft) > 0).length;

/** Cards in the first `n` with a cuisine the group leans against. */
export const dislikedHits = (deck: Card[], soft: GroupPreferences['soft'], n = 10) =>
  deck.slice(0, n).filter((c) => c.tags.some((t) => (soft.cuisineScores[t] ?? 0) < 0)).length;

/** The code-only ranking: the pool by soft score (best case for the non-AI deck). */
export function baselineDeck(pool: Card[], soft: GroupPreferences['soft'], size: number): Card[] {
  return [...pool]
    .sort((a, b) => softScore(b, soft) - softScore(a, soft) || a.id.localeCompare(b.id))
    .slice(0, size);
}

/** Text the model wrote that it shouldn't have: echoed instructions, names, diets. */
export function textProblems(text: string, forbidden: RegExp[]): string[] {
  return forbidden.filter((re) => re.test(text)).map((re) => `says ${re.source}`);
}

export interface DeckGrade {
  picks: number;
  invented: number;
  duplicates: number;
  deckSize: number;
  hardViolations: string[];
  tasteHits: number;
  baselineTasteHits: number;
  dislikedInTop10: number;
  seenInDeck: number;
  blurbsKept: number;
  blurbProblems: string[];
  /** For reading the result: the first 10 cards with their tags. */
  top10: string[];
}

export function gradeDeck(input: {
  picks: { cardId: string; blurb: string }[];
  candidates: ReadonlySet<string>;
  deck: Card[] | null;
  /** The filtered search result (what the hard rules allow). */
  pool: Card[];
  /** What the agents were given: the pool minus cards from earlier rounds. */
  fresh: Card[];
  facts: ReadonlyMap<string, Facts>;
  group: GroupPreferences;
  seen: ReadonlySet<string>;
  forbidden: RegExp[];
}): DeckGrade {
  const ids = input.picks.map((p) => p.cardId);
  const deck = input.deck ?? [];
  const poolIds = new Set(input.pool.map((c) => c.id));
  const blurbs = input.picks.map((p) => cleanBlurb(p.blurb)).filter((b): b is string => !!b);
  return {
    picks: ids.length,
    invented: ids.filter((id) => !input.candidates.has(id)).length,
    duplicates: ids.length - new Set(ids).size,
    deckSize: deck.length,
    hardViolations: deck.flatMap((c) => hardViolations(c, poolIds, input.facts, input.group.hard)),
    tasteHits: tasteHits(deck, input.group.soft),
    baselineTasteHits: tasteHits(baselineDeck(input.fresh, input.group.soft, 20), input.group.soft),
    dislikedInTop10: dislikedHits(deck, input.group.soft),
    seenInDeck: deck.filter((c) => input.seen.has(c.id)).length,
    blurbsKept: blurbs.length,
    blurbProblems: blurbs.flatMap((b) => textProblems(b, input.forbidden)),
    top10: deck.slice(0, 10).map((c) => `${c.title} [${c.tags.join(', ')}]`),
  };
}

export interface MediatorGrade {
  accepted: boolean;
  pickedYums: number | null;
  topYums: number;
  reasonLength: number;
  problems: string[];
  reason: string;
}

/**
 * Guest names are checked out of the reason first: naming who said yum is the job,
 * so a name that happens to read like an instruction isn't itself a problem. What
 * counts is whether the pick or the rest of the text follows it.
 */
export function gradeMediator(
  pick: MediatorPick,
  candidates: Contender[],
  forbidden: RegExp[],
  names: string[] = [],
): MediatorGrade {
  const checked = checkPick(pick, candidates);
  const withoutNames = names.reduce((text, name) => text.split(name).join(' '), pick.reason);
  return {
    accepted: checked !== null,
    pickedYums: candidates.find((c) => c.cardId === pick.cardId)?.yums ?? null,
    topYums: candidates[0]?.yums ?? 0,
    reasonLength: pick.reason.length,
    problems: textProblems(withoutNames, forbidden),
    reason: pick.reason,
  };
}

export interface ShoppingGrade {
  accepted: boolean;
  lines: number;
  ingredients: number;
  /** Ingredient groups that should share one line (e.g. garlic used twice), but don't. */
  unmerged: string[];
  /** Staples not marked "likely at home", and real groceries that were. */
  atHomeMisses: string[];
  /** Line names with quantities in them (code adds quantities, never the model). */
  quantityInName: string[];
  problems: string[];
  names: string[];
}

export function gradeShopping(
  plan: LinePlan[] | null,
  expect: { ingredients: number; merge: number[][]; staples: number[]; groceries: number[] },
  forbidden: RegExp[],
): ShoppingGrade {
  if (!plan) {
    return {
      accepted: false,
      lines: 0,
      ingredients: expect.ingredients,
      unmerged: [],
      atHomeMisses: [],
      quantityInName: [],
      problems: ['no list passed the checks (fallback used)'],
      names: [],
    };
  }
  const lineOf = (i: number) => plan.find((l) => l.covers.includes(i));
  return {
    accepted: true,
    lines: plan.length,
    ingredients: expect.ingredients,
    unmerged: expect.merge
      .filter((group) => new Set(group.map(lineOf)).size > 1)
      .map((group) => group.join('+')),
    atHomeMisses: [
      ...expect.staples.filter((i) => !lineOf(i)?.likelyAtHome).map((i) => `staple ${i}`),
      ...expect.groceries.filter((i) => lineOf(i)?.likelyAtHome).map((i) => `grocery ${i}`),
    ],
    quantityInName: plan.filter((l) => /\d/.test(l.name)).map((l) => l.name),
    problems: plan.flatMap((l) => textProblems(l.name, forbidden)),
    names: plan.map((l) => `${l.name}${l.likelyAtHome ? ' (at home)' : ''}`),
  };
}
