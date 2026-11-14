import type { Card, RecipeIngredient, ShoppingLine } from '@yumanimous/shared';
import type { AiRunner } from '../ai/aiRunner.js';
import type { FollowUpAgent, ScaledIngredient } from '../ai/followUpAgents.js';
import { checkPick, fallbackPick, type Contender } from './mediator.js';
import { RecipeLookupError, type RecipeDetailsLookup } from './recipeDetails.js';
import { lineQuantity, scaleFactor } from './scale.js';
import { buildLines, checkCoverage, fallbackPlan, type LinePlan } from './shoppingList.js';

export interface ShoppingRequest {
  sessionCode: string;
  card: Card;
  servings: number;
}

export interface ShoppingResult {
  recipeServings: number | null;
  ingredients: RecipeIngredient[];
  lines: ShoppingLine[];
  source: 'ai' | 'fallback';
}

export interface MediationRequest {
  sessionCode: string;
  /** Every card with its yums, most first (see `contenders`). */
  contenders: Contender[];
  memberCount: number;
}

export interface Mediation {
  cardId: string;
  reason: string;
  source: 'ai' | 'fallback';
}

/** What SessionService needs after a decision. Tests inject a fake. */
export interface FollowUps {
  /** Throws FollowUpError with a message safe for the group. */
  shoppingList: (req: ShoppingRequest) => Promise<ShoppingResult>;
  /** null only for an empty deck. */
  mediate: (req: MediationRequest) => Promise<Mediation | null>;
}

/** A list can't be made. The message is shown to the group as-is. */
export class FollowUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FollowUpError';
  }
}

export interface FollowUpServiceOptions {
  recipeDetails: RecipeDetailsLookup;
  /** Without it (no key, no Postgres), lists and compromises are made by code alone. */
  ai?: { agent: FollowUpAgent; runner: AiRunner } | undefined;
  shoppingTimeoutMs?: number;
  mediatorTimeoutMs?: number;
}

const MAX_INGREDIENTS = 60;

/**
 * Phase 7, "AI suggests, code enforces", like the deck:
 * - Shopping list: the recipe comes from mcp-recipes; code scales every amount; the
 *   sous-chef only groups and names lines, and a list that drops, repeats or invents
 *   an ingredient is refused. Quantities are computed by code from what each line
 *   covers.
 * - Mediator: the pick must be within one yum of the top card, with a clean reason.
 * Over budget, failed, or refused: the code-only version is used, so neither
 * feature ever depends on the AI. Every run is logged with its cost.
 */
export class FollowUpService implements FollowUps {
  private readonly shoppingTimeoutMs: number;
  private readonly mediatorTimeoutMs: number;

  constructor(private readonly opts: FollowUpServiceOptions) {
    this.shoppingTimeoutMs = opts.shoppingTimeoutMs ?? 45_000;
    this.mediatorTimeoutMs = opts.mediatorTimeoutMs ?? 30_000;
  }

  async shoppingList({ sessionCode, card, servings }: ShoppingRequest): Promise<ShoppingResult> {
    const recipeId = Number(/^spoonacular:(\d+)$/.exec(card.id)?.[1]);
    if (!recipeId) throw new FollowUpError('This card has no recipe to make a list from');

    let details;
    try {
      details = await this.opts.recipeDetails(recipeId);
    } catch (err) {
      if (err instanceof RecipeLookupError) throw new FollowUpError(err.message);
      throw err;
    }
    const ingredients: RecipeIngredient[] = details.ingredients
      .slice(0, MAX_INGREDIENTS)
      .map((i) => ({
        name: i.name.slice(0, 120),
        amount: Math.max(0, i.amount),
        unit: i.unit.slice(0, 40),
        aisle: i.aisle?.slice(0, 80) ?? null,
      }));
    if (ingredients.length === 0) throw new FollowUpError('This recipe has no ingredient list');
    const recipeServings = details.servings;

    const plan = await this.aiPlan(sessionCode, card.title, ingredients, servings, recipeServings);
    return {
      recipeServings,
      ingredients,
      lines: buildLines(plan ?? fallbackPlan(ingredients), ingredients, servings, recipeServings),
      source: plan ? 'ai' : 'fallback',
    };
  }

  private async aiPlan(
    sessionCode: string,
    title: string,
    ingredients: RecipeIngredient[],
    servings: number,
    recipeServings: number | null,
  ): Promise<LinePlan[] | null> {
    const ai = this.opts.ai;
    if (!ai || !(await ai.runner.withinBudget(sessionCode, 'shopping'))) return null;

    // The model sees amounts already scaled by code, so it never does arithmetic.
    const factor = scaleFactor(servings, recipeServings);
    const scaled: ScaledIngredient[] = ingredients.map((i, index) => ({
      index,
      name: i.name,
      quantity: lineQuantity([i], factor),
      aisle: i.aisle,
    }));
    const outcome = await ai.runner.run(sessionCode, 'shopping', this.shoppingTimeoutMs, (signal) =>
      ai.agent.planShoppingList({ sessionCode, title, ingredients: scaled, signal }),
    );
    if (!outcome) return null;

    // The tool already refused bad lists; checked again here so this rule doesn't
    // depend on how the agent was wired.
    const plan = outcome.result.plan;
    const ok = plan !== null && checkCoverage(plan, ingredients.length).length === 0;
    await ai.runner.record(sessionCode, 'shopping', ok ? 'ok' : 'fallback', outcome.usage, null);
    if (!ok) ai.runner.warn(`[ai] ${sessionCode}: no valid shopping list, using the plain one`);
    return ok ? plan : null;
  }

  async mediate({
    sessionCode,
    contenders,
    memberCount,
  }: MediationRequest): Promise<Mediation | null> {
    const fallback = () => {
      const pick = fallbackPick(contenders, memberCount);
      return pick && { ...pick, source: 'fallback' as const };
    };
    const ai = this.opts.ai;
    if (contenders.length === 0) return null;
    if (!ai || !(await ai.runner.withinBudget(sessionCode, 'mediator'))) return fallback();

    const outcome = await ai.runner.run(sessionCode, 'mediator', this.mediatorTimeoutMs, (signal) =>
      ai.agent.pickCompromise({ sessionCode, signal }),
    );
    if (!outcome) return fallback();

    const pick = checkPick(outcome.result.pick, contenders);
    await ai.runner.record(sessionCode, 'mediator', pick ? 'ok' : 'fallback', outcome.usage, null);
    if (!pick) ai.runner.warn(`[ai] ${sessionCode}: mediator pick refused, using the top card`);
    return pick ? { ...pick, source: 'ai' } : fallback();
  }
}
