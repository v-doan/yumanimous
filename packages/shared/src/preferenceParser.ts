import type { Craving, Cuisine, Diet, Intolerance, UnsupportedRule } from './food.js';
import { MemberPreferencesSchema, type MemberPreferences } from './preferences.js';

/**
 * Keyword parser: plain-language food rules -> MemberPreferences. No AI, no network,
 * deterministic, and it runs in the browser so chips appear as you type. The member
 * always confirms the chips before anything is saved.
 *
 * How it reads text:
 * 1. Split into clauses on punctuation and "but" ("pescatarian, but no shellfish").
 * 2. Split clauses into segments on "and" / "or" / "&". A segment takes its polarity
 *    from its own cue word, or inherits the previous segment's, so "no peanuts and
 *    shellfish" excludes both while "love thai and no mexican" splits correctly.
 * 3. Match vocabularies per segment.
 *
 * Bias: when in doubt about an allergen, treat it as hard. A wrongly excluded dish
 * costs a little variety; a missed allergy costs a lot more.
 */

type Polarity = 'cannot-eat' | 'negative' | 'positive' | 'neutral';

const MAX_INPUT = 500;

// ---- cue words ----
const CANNOT_EAT_CUES =
  /\ballerg|\bintoleran|\banaphyla|\bceliac|\bcoeliac|\bsensitiv|\bcan'?t (eat|have|do|touch)|\bcannot (eat|have)|\bdon'?t eat\b|\bnever eat\b|\bavoid|\bstrictly\b|\bfree\b/;
const NEGATIVE_CUES =
  /\bno\b|\bnot\b|\bwithout\b|\bhate|\bdislike|\bdon'?t (like|want|love|fancy)|\bnot a fan|\banything but\b|\bnothing\b|\bnone\b|\bskip\b|\bgross\b/;
const POSITIVE_CUES =
  /\blove|\blike\b|\bcraving|\bcrave|\bwant\b|\bin the mood|\bprefer|\bfancy\b|\bplease\b|\benjoy|\byes\b|\bfeeling\b/;

/** Diets are matched per clause; "not vegan" / "not a vegetarian" cancel them. */
const DIET_PATTERNS: [Diet, RegExp][] = [
  ['vegan', /\bvegan\b|\bplant[- ]based\b/],
  ['lacto-vegetarian', /\blacto[- ]?vegetarian\b/],
  ['ovo-vegetarian', /\bovo[- ]?vegetarian\b/],
  [
    'vegetarian',
    /\bvegetarian\b|\bveggie\b|\bmeatless\b|\bno meat\b|\bdon'?t eat (any )?meat\b|\bmeat[- ]free\b/,
  ],
  ['pescetarian', /\bpesc[ae]tarian\b|\bfish but no meat\b|\bonly (eat )?fish\b/],
  ['gluten free', /\bgluten[- ]?free\b|\bceliac\b|\bcoeliac\b|\bno gluten\b|\bgluten intoleran/],
  ['ketogenic', /\bketo(genic)?\b/],
  ['paleo', /\bpaleo\b/],
  ['primal', /\bprimal\b/],
  ['whole30', /\bwhole ?30\b/],
  ['low fodmap', /\bfodmap\b/],
];

/** Allergens Spoonacular can exclude. Negated in any way -> hard intolerance. */
const ALLERGENS: [RegExp, Intolerance[]][] = [
  [/\bpeanuts?\b/, ['peanut']],
  // Bare "nuts" means both kinds; people rarely mean only one.
  [/(?<!pea)(?<!tree )\bnuts?\b/, ['peanut', 'tree nut']],
  [
    /\btree ?nuts?\b|\balmonds?\b|\bcashews?\b|\bwalnuts?\b|\bpecans?\b|\bhazelnuts?\b|\bpistachios?\b/,
    ['tree nut'],
  ],
  [
    /\bshellfish\b|\bshrimps?\b|\bprawns?\b|\bcrabs?\b|\blobsters?\b|\bclams?\b|\bmussels?\b|\boysters?\b|\bscallops?\b/,
    ['shellfish'],
  ],
  [/\bseafood\b|\bfish\b/, ['seafood']],
  [/\beggs?\b/, ['egg']],
  [/\bsoy\b|\bsoya\b/, ['soy']],
  [/\bsesame\b/, ['sesame']],
  [/\bdairy\b|\blactose\b|\bmilk\b/, ['dairy']],
  [/\bwheat\b/, ['wheat']],
  [/\bgluten\b/, ['gluten']],
  [/\bsulfites?\b|\bsulphites?\b/, ['sulfite']],
  [/\bgrains?\b/, ['grain']],
];

/**
 * Other ingredients people avoid, with a canonical name. `strict` ones (meats people
 * skip for religion or ethics) are hard for any negation; the rest are hard only with
 * a cannot-eat cue ("allergic", "can't eat"), otherwise a soft dislike.
 */
const INGREDIENTS: [RegExp, string[], { strict?: boolean }?][] = [
  [/\bpork\b|\bbacon\b|\bham\b/, ['pork'], { strict: true }],
  [/\bbeef\b|\bsteak\b/, ['beef'], { strict: true }],
  [/\blamb\b/, ['lamb'], { strict: true }],
  [/\bred meat\b/, ['beef', 'lamb', 'pork'], { strict: true }],
  [/\bchicken\b/, ['chicken'], { strict: true }],
  [/\bmushrooms?\b/, ['mushroom']],
  [/\bcilantro\b|\bcoriander\b/, ['cilantro']],
  [/\bonions?\b/, ['onion']],
  [/\bgarlic\b/, ['garlic']],
  [/\bolives?\b/, ['olive']],
  [/\btomato(es)?\b/, ['tomato']],
  [/\beggplants?\b|\baubergines?\b/, ['eggplant']],
  [/\bavocados?\b/, ['avocado']],
  [/\bcoconut\b/, ['coconut']],
  [/\bkiwis?\b/, ['kiwi']],
  [/\bcelery\b/, ['celery']],
  [/\bmustard\b/, ['mustard']],
  [/\bmayo(nnaise)?\b/, ['mayonnaise']],
  [/\banchov(y|ies)\b/, ['anchovy']],
  [/\bcapers?\b/, ['caper']],
  [/\braisins?\b/, ['raisin']],
  [/\bspinach\b/, ['spinach']],
  [/\bbroccoli\b/, ['broccoli']],
  [/\bcauliflower\b/, ['cauliflower']],
  [/\bcheese\b/, ['cheese']],
  [/\bliver\b/, ['liver']],
  [/\btofu\b/, ['tofu']],
  [/\bbell peppers?\b|\bpeppers\b/, ['bell pepper']],
  [/\bcorn\b/, ['corn']],
  [/\bbeans\b/, ['beans']],
];

/** Dish or cuisine words -> cuisine. Liked by default, disliked when negated. */
const CUISINE_WORDS: [RegExp, Cuisine][] = [
  [/\bthai\b/, 'Thai'],
  [/\bitalian\b|\bpasta\b|\bpizza\b|\brisotto\b/, 'Italian'],
  [/\bmexican\b|\btacos?\b|\bburritos?\b|\bquesadillas?\b/, 'Mexican'],
  [/\bindian\b|\bcurry\b|\bcurries\b/, 'Indian'],
  [/\bchinese\b|\bdumplings?\b/, 'Chinese'],
  [/\bjapanese\b|\bsushi\b|\bramen\b/, 'Japanese'],
  [/\bkorean\b|\bkimchi\b/, 'Korean'],
  [/\bfrench\b/, 'French'],
  [/\bgreek\b/, 'Greek'],
  [/\bspanish\b|\btapas\b|\bpaella\b/, 'Spanish'],
  [/\bvietnamese\b|\bpho\b|\bbanh mi\b/, 'Vietnamese'],
  [/\bamerican\b|\bburgers?\b/, 'American'],
  [/\bmediterranean\b/, 'Mediterranean'],
  [/\bmiddle eastern\b|\blebanese\b|\bfalafel\b/, 'Middle Eastern'],
  [/\bbritish\b|\benglish\b/, 'British'],
  [/\bgerman\b/, 'German'],
  [/\bcajun\b/, 'Cajun'],
  [/\bcaribbean\b|\bjamaican\b/, 'Caribbean'],
  [/\birish\b/, 'Irish'],
  [/\bnordic\b|\bscandinavian\b/, 'Nordic'],
  [/\bsouthern\b|\bsoul food\b/, 'Southern'],
  [/\bjewish\b/, 'Jewish'],
  [/\bafrican\b|\bethiopian\b/, 'African'],
  [/\beastern european\b/, 'Eastern European'],
  [/\blatin american\b/, 'Latin American'],
  [/\beuropean\b/, 'European'],
  [/\basian\b/, 'Asian'],
];

const CRAVING_WORDS: [RegExp, Craving][] = [
  [/\bspicy\b|\bhot\b|\bheat\b/, 'spicy'],
  [/\bcomfort\b|\bcozy\b|\bcosy\b/, 'comfort food'],
  [/\bhealthy\b|\bnutritious\b|\bclean eating\b/, 'healthy'],
  [/\blight\b/, 'light'],
  [/\bcheesy\b/, 'cheesy'],
  [/\bhearty\b|\bfilling\b/, 'hearty'],
  [/\bsweet\b|\bdessert\b/, 'sweet'],
  [/\bquick\b|\bfast\b|\beasy\b/, 'quick'],
  [/\bfresh\b|\bsalad\b/, 'fresh'],
];

const UNSUPPORTED_WORDS: [RegExp, UnsupportedRule][] = [
  [/\bhalal\b/, 'halal'],
  [/\bkosher\b/, 'kosher'],
  [/\blow[- ]?(sodium|salt)\b|\bno salt\b|\bsalt[- ]free\b/, 'low sodium'],
  [/\blow[- ]?carbs?\b|\bno carbs?\b/, 'low carb'],
  [/\bdiabet|\bsugar[- ]free\b|\bno sugar\b/, 'diabetic'],
  [/\bnightshades?\b/, 'nightshade-free'],
];

const ALCOHOL = /\balcohol\b|\bwine\b|\bbeer\b|\bsober\b/;

// "allergic to kiwi" for an ingredient that isn't in our vocabulary: keep the word.
const ALLERGIC_TO = /\ballergic to ([a-z]{3,20})\b/g;
const STOPWORDS = new Set([
  'any',
  'anything',
  'all',
  'some',
  'most',
  'many',
  'the',
  'nothing',
  'food',
  'foods',
  'stuff',
  'things',
]);

export function parsePreferences(text: string): MemberPreferences {
  const diets = new Set<Diet>();
  const intolerances = new Set<Intolerance>();
  const avoid = new Map<string, 'cannot-eat' | 'dislike'>();
  const liked = new Set<Cuisine>();
  const disliked = new Set<Cuisine>();
  const cravings = new Set<Craving>();
  const unsupported = new Set<UnsupportedRule>();
  const limits: number[] = [];

  const normalized = text
    .slice(0, MAX_INPUT)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // Strip accents: "jalapeño" -> "jalapeno".
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    // Rewrite phrases whose "but"/"except" must not split the sentence.
    .replace(/\b(i )?(eat )?fish but no meat\b/g, 'pescetarian')
    .replace(
      /\b(anything|everything) but\b|\bexcept( for)?\b|\bapart from\b|\bother than\b/g,
      ' no ',
    );

  // Time limits read the whole text: "nothing over 45 min", "under an hour".
  limits.push(...readTimeLimits(normalized));

  const clauses = normalized.split(/[.,;!?\n()]+|\bbut\b|\bhowever\b/);
  for (const clause of clauses) {
    for (const [diet, pattern] of DIET_PATTERNS) {
      const match = pattern.exec(clause);
      if (match && !isNegated(clause, match.index)) diets.add(diet);
    }
    for (const [pattern, rule] of UNSUPPORTED_WORDS)
      if (pattern.test(clause)) unsupported.add(rule);

    let inherited: Polarity = 'neutral';
    for (const segment of clause.split(/\band\b|\bor\b|&|\//)) {
      const own = polarityOf(segment);
      const polarity: Polarity = own === 'neutral' ? inherited : own;
      inherited = polarity;
      const negated = polarity === 'cannot-eat' || polarity === 'negative';

      // Remove diet phrases first so "gluten free" doesn't also read as "gluten" + "free".
      const rest = DIET_PATTERNS.reduce((s, [, p]) => s.replace(p, ' '), segment);

      for (const [pattern, kinds] of ALLERGENS) {
        if (negated && pattern.test(rest)) for (const k of kinds) intolerances.add(k);
      }
      for (const [pattern, names, opts] of INGREDIENTS) {
        if (!negated || !pattern.test(rest)) continue;
        const reason = polarity === 'cannot-eat' || opts?.strict ? 'cannot-eat' : 'dislike';
        for (const name of names) {
          // Never downgrade: if someone already can't eat it, a dislike changes nothing.
          if (avoid.get(name) !== 'cannot-eat') avoid.set(name, reason);
        }
      }
      for (const [pattern, cuisine] of CUISINE_WORDS) {
        if (!pattern.test(rest)) continue;
        (negated ? disliked : liked).add(cuisine);
      }
      for (const [pattern, craving] of CRAVING_WORDS) {
        if (!negated && pattern.test(rest)) cravings.add(craving);
      }
      if (negated && ALCOHOL.test(rest)) unsupported.add('alcohol-free');

      // "allergic to kiwi and strawberries": a bare unknown word that continues an
      // allergy list is part of it. Only one short word, so "and we love pasta" is safe.
      const bare = rest.trim();
      const isKnown =
        ALLERGENS.some(([p]) => p.test(bare)) ||
        INGREDIENTS.some(([p]) => p.test(bare)) ||
        CUISINE_WORDS.some(([p]) => p.test(bare)) ||
        CRAVING_WORDS.some(([p]) => p.test(bare));
      if (
        own === 'neutral' &&
        polarity === 'cannot-eat' &&
        /^[a-z]{3,20}$/.test(bare) &&
        !isKnown &&
        !STOPWORDS.has(bare)
      ) {
        avoid.set(singular(bare), 'cannot-eat');
      }
    }

    for (const match of clause.matchAll(ALLERGIC_TO)) {
      const word = match[1]!;
      const known =
        ALLERGENS.some(([p]) => p.test(word)) || INGREDIENTS.some(([p]) => p.test(word));
      if (!known && !STOPWORDS.has(word)) avoid.set(singular(word), 'cannot-eat');
    }
  }

  // Liking and disliking the same cuisine in one breath: the dislike wins.
  for (const c of disliked) liked.delete(c);

  return MemberPreferencesSchema.parse({
    diets: [...diets],
    intolerances: [...intolerances],
    avoidIngredients: [...avoid].map(([name, reason]) => ({ name, reason })).slice(0, 10),
    maxReadyMinutes: limits.length ? Math.min(...limits) : null,
    cuisinesLiked: [...liked],
    cuisinesDisliked: [...disliked],
    cravings: [...cravings],
    unsupported: [...unsupported],
  });
}

/** Good enough for food words: "strawberries" -> "strawberry", "mangoes" -> "mango". */
function singular(word: string): string {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('oes')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function polarityOf(segment: string): Polarity {
  if (CANNOT_EAT_CUES.test(segment)) return 'cannot-eat';
  if (NEGATIVE_CUES.test(segment)) return 'negative';
  if (POSITIVE_CUES.test(segment)) return 'positive';
  return 'neutral';
}

/** "not vegan", "not a vegetarian", "isn't keto" just before a diet word. */
function isNegated(clause: string, index: number): boolean {
  const before = clause.slice(Math.max(0, index - 14), index);
  return /\b(not|n't|never)( an?)? *$/.test(before);
}

const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  'forty five': 45,
  'forty-five': 45,
  fifty: 50,
  sixty: 60,
  ninety: 90,
};

function readTimeLimits(text: string): number[] {
  const limits: number[] = [];
  const num = (s: string) => WORD_NUMBERS[s] ?? Number.parseInt(s, 10);

  if (/\bhalf (an )?hour\b/.test(text)) limits.push(30);
  if (/\b(an|one) hour and a half\b|\b1\.5 ?h(ou)?rs?\b/.test(text)) limits.push(90);

  for (const m of text.matchAll(
    /\b(\d{1,3}|ten|fifteen|twenty|thirty|forty[ -]five|forty|fifty|sixty|ninety)\s*(?:-\s*)?(?:min|mins|minutes|m)\b/g,
  )) {
    limits.push(num(m[1]!));
  }
  for (const m of text.matchAll(
    /\b(\d{1,2}|a|an|one|two|three)\s*(?:hours?|hrs?|h)\b(?! and a half)/g,
  )) {
    limits.push(num(m[1]!) * 60);
  }
  return limits.filter((n) => Number.isFinite(n) && n >= 5 && n <= 600);
}
