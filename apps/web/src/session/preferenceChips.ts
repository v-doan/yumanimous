import type { MemberPreferences } from '@yumanimous/shared';

export type ChipKind = 'must' | 'prefer' | 'unsupported';

export interface Chip {
  /** Stable id, used to remove exactly this rule. */
  id: string;
  label: string;
  kind: ChipKind;
}

/**
 * One chip per rule, so a member can see exactly what the parser understood and
 * remove anything it got wrong before saving. "must" chips filter the group's deck.
 */
export function toChips(p: MemberPreferences): Chip[] {
  return [
    ...p.diets.map((d) => ({ id: `diet:${d}`, label: d, kind: 'must' as const })),
    ...p.intolerances.map((i) => ({ id: `intol:${i}`, label: `no ${i}`, kind: 'must' as const })),
    ...p.avoidIngredients.map((a) =>
      a.reason === 'cannot-eat'
        ? { id: `avoid:${a.name}`, label: `no ${a.name}`, kind: 'must' as const }
        : { id: `avoid:${a.name}`, label: `not keen on ${a.name}`, kind: 'prefer' as const },
    ),
    ...(p.maxReadyMinutes !== null
      ? [{ id: 'time', label: `under ${p.maxReadyMinutes} min`, kind: 'must' as const }]
      : []),
    ...p.cuisinesLiked.map((c) => ({
      id: `like:${c}`,
      label: `likes ${c}`,
      kind: 'prefer' as const,
    })),
    ...p.cuisinesDisliked.map((c) => ({
      id: `dislike:${c}`,
      label: `not ${c}`,
      kind: 'prefer' as const,
    })),
    ...p.cravings.map((c) => ({ id: `crave:${c}`, label: c, kind: 'prefer' as const })),
    ...p.unsupported.map((u) => ({ id: `unsup:${u}`, label: u, kind: 'unsupported' as const })),
  ];
}

/** The preferences without the chip `id`. */
export function removeChip(p: MemberPreferences, id: string): MemberPreferences {
  const [kind, value] = id.split(/:(.*)/s) as [string, string | undefined];
  switch (kind) {
    case 'diet':
      return { ...p, diets: p.diets.filter((d) => d !== value) };
    case 'intol':
      return { ...p, intolerances: p.intolerances.filter((i) => i !== value) };
    case 'avoid':
      return { ...p, avoidIngredients: p.avoidIngredients.filter((a) => a.name !== value) };
    case 'time':
      return { ...p, maxReadyMinutes: null };
    case 'like':
      return { ...p, cuisinesLiked: p.cuisinesLiked.filter((c) => c !== value) };
    case 'dislike':
      return { ...p, cuisinesDisliked: p.cuisinesDisliked.filter((c) => c !== value) };
    case 'crave':
      return { ...p, cravings: p.cravings.filter((c) => c !== value) };
    case 'unsup':
      return { ...p, unsupported: p.unsupported.filter((u) => u !== value) };
    default:
      return p;
  }
}
