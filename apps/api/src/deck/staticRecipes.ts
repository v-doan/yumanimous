import type { Card } from '@yumanimous/shared';

/**
 * Hard-coded deck (Phase 1-2). Phase 3 replaces this with a real recipe source.
 *
 * Every imageUrl below was checked before committing: HTTP 200 with an image/*
 * content type, and the photo was viewed to confirm it shows the dish. Unsplash
 * blocks automated lookups of photographer names, so credits point to Unsplash
 * rather than guessing a name.
 */
const unsplash = (photoId: string) =>
  `https://images.unsplash.com/photo-${photoId}?w=800&q=75&auto=format&fit=crop`;

const credit = { name: 'Unsplash', url: 'https://unsplash.com' };

export const staticRecipes: Card[] = [
  {
    id: 'rainbow-chickpea-bowl',
    title: 'Rainbow Chickpea Bowl',
    imageUrl: unsplash('1512621776951-a57141f2eefd'),
    imageAlt: 'A bowl of chickpeas, avocado, roasted sweet potato, cherry tomatoes and greens',
    imageCredit: credit,
    tags: ['vegan', '20 min', 'no-cook'],
    blurb: 'Every colour on one plate. Crunchy, creamy and done before the rice cooker beeps.',
  },
  {
    id: 'bbq-chicken-pizza',
    title: 'BBQ Chicken Pizza',
    imageUrl: unsplash('1565299624946-b28f40a0ae38'),
    imageAlt: 'Sliced pizza topped with chicken, pineapple, red onion and cilantro',
    imageCredit: credit,
    tags: ['crowd-pleaser', '35 min'],
    blurb: 'Smoky, sweet, a little tangy. The pizza that ends the pineapple debate.',
  },
  {
    id: 'crispy-tofu-bowl',
    title: 'Crispy Tofu Salad Bowl',
    imageUrl: unsplash('1546069901-ba9599a7e63c'),
    imageAlt: 'Salad bowl with seared tofu, corn, edamame, red cabbage and eggs',
    imageCredit: credit,
    tags: ['vegetarian', 'high-protein', '25 min'],
    blurb: 'Golden tofu, sweet corn and a pile of crunch. Lunch-box approved.',
  },
  {
    id: 'banana-maple-pancakes',
    title: 'Banana Maple Pancakes',
    imageUrl: unsplash('1567620905732-2d1ec7ab7445'),
    imageAlt: 'A tall stack of pancakes topped with banana slices and maple syrup being poured',
    imageCredit: credit,
    tags: ['brunch', 'sweet', '20 min'],
    blurb: 'A fluffy tower with a maple waterfall. Breakfast for dinner counts.',
  },
  {
    id: 'egg-avocado-toast',
    title: 'Egg & Avocado Toast',
    imageUrl: unsplash('1482049016688-2d3e1b311543'),
    imageAlt: 'Toast with spinach, avocado slices and halved soft-boiled eggs',
    imageCredit: credit,
    tags: ['vegetarian', '10 min', 'brunch'],
    blurb: 'Jammy eggs, ripe avocado, crisp toast. Ten minutes, zero regrets.',
  },
  {
    id: 'pesto-farfalle',
    title: 'Pesto Farfalle',
    imageUrl: unsplash('1473093295043-cdd812d0e601'),
    imageAlt: 'Bow-tie pasta tossed in green pesto with cherry tomatoes',
    imageCredit: credit,
    tags: ['vegetarian', '15 min', 'pasta'],
    blurb: 'Bright basil pesto clinging to every bow tie. Summer in a bowl.',
  },
  {
    id: 'shrimp-ramen',
    title: 'Shrimp Ramen',
    imageUrl: unsplash('1569718212165-3a8278d5f624'),
    imageAlt: 'Ramen with shrimp, snap peas and soft-boiled eggs, chopsticks resting on the bowl',
    imageCredit: credit,
    tags: ['seafood', 'noodles', '30 min'],
    blurb: 'Slurpable noodles, sweet shrimp and jammy eggs in a cosy broth.',
  },
  {
    id: 'spaghetti-carbonara',
    title: 'Spaghetti Carbonara',
    imageUrl: unsplash('1588013273468-315fd88ea34c'),
    imageAlt: 'Spaghetti carbonara with pancetta, topped with grated parmesan',
    imageCredit: credit,
    tags: ['pasta', 'classic', '20 min'],
    blurb: 'Eggs, cheese, pepper and crispy pancetta. Silky, never scrambled.',
  },
  {
    id: 'street-tacos',
    title: 'Street Tacos',
    imageUrl: unsplash('1551504734-5ee1c4a1479b'),
    imageAlt: 'Three corn tortilla tacos with grilled meat, salsa and avocado on a plate',
    imageCredit: credit,
    tags: ['build-your-own', '30 min', 'spicy'],
    blurb: 'Charred tortillas, juicy fillings and salsa. Everyone builds their own.',
  },
  {
    id: 'lamb-curry-naan',
    title: 'Lamb Curry & Naan',
    imageUrl: unsplash('1565557623262-b51c2513a641'),
    imageAlt: 'Rich lamb curry garnished with coriander, served with naan bread',
    imageCredit: credit,
    tags: ['spicy', 'slow-cooked', '90 min'],
    blurb: 'Slow-simmered, deeply spiced and made for tearing naan. Worth the wait.',
  },
];
