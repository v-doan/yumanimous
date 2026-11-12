import { z } from 'zod';

/**
 * A single swipeable card. Every deck source (recipes now, places later) maps its
 * results into this shape, so the swipe UI never needs to know which mode it is in.
 */
export const CardSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(80),
  // Optional on purpose: if a photo can't be verified (or a source has none), the UI
  // renders a styled placeholder instead of a broken image.
  imageUrl: z.url({ protocol: /^https$/ }).optional(),
  imageAlt: z.string().max(160).optional(),
  imageCredit: z
    .object({
      name: z.string().min(1).max(80),
      url: z.url({ protocol: /^https$/ }),
    })
    .optional(),
  tags: z.array(z.string().min(1).max(24)).max(6),
  // Blurbs are short by design: they must fit on a phone card without scrolling.
  blurb: z.string().min(1).max(160),
});

export type Card = z.infer<typeof CardSchema>;
