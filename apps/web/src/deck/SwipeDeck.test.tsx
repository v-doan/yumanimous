import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Card } from '@yumanimous/shared';
import { SwipeDeck } from './SwipeDeck';

const cards: Card[] = [
  {
    id: 'soup',
    title: 'Tomato Soup',
    imageUrl: 'https://images.example.com/soup.jpg',
    tags: ['vegan'],
    blurb: 'Cosy.',
  },
  { id: 'salad', title: 'Green Salad', tags: ['quick'], blurb: 'Crunchy.' },
  { id: 'stew', title: 'Bean Stew', tags: [], blurb: 'Hearty.' },
];

const topCardTitle = () =>
  within(screen.getByTestId('top-card')).getByRole('heading', { level: 2 }).textContent;

describe('SwipeDeck', () => {
  it('shows the first card on top with progress', () => {
    render(<SwipeDeck cards={cards} />);
    expect(topCardTitle()).toBe('Tomato Soup');
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
  });

  it('advances when Like and Skip are tapped', async () => {
    const user = userEvent.setup();
    render(<SwipeDeck cards={cards} />);

    await user.click(screen.getByRole('button', { name: /like this recipe/i }));
    expect(await screen.findByText('2 / 3')).toBeInTheDocument();
    expect(topCardTitle()).toBe('Green Salad');

    await user.click(screen.getByRole('button', { name: /skip this recipe/i }));
    expect(await screen.findByText('3 / 3')).toBeInTheDocument();
    expect(topCardTitle()).toBe('Bean Stew');
  });

  it('supports arrow keys', async () => {
    const user = userEvent.setup();
    render(<SwipeDeck cards={cards} />);
    await user.keyboard('{ArrowRight}');
    expect(await screen.findByText('2 / 3')).toBeInTheDocument();
  });

  it('shows liked cards on the end screen and can restart', async () => {
    const user = userEvent.setup();
    render(<SwipeDeck cards={cards} />);

    await user.click(screen.getByRole('button', { name: /like this recipe/i }));
    await screen.findByText('2 / 3');
    await user.click(screen.getByRole('button', { name: /skip this recipe/i }));
    await screen.findByText('3 / 3');
    await user.click(screen.getByRole('button', { name: /like this recipe/i }));

    expect(await screen.findByRole('heading', { name: /deck!/i })).toBeInTheDocument();
    expect(screen.getByText('You liked 2 of 3.')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: /recipes you liked/i });
    expect(within(list).getByText('Tomato Soup')).toBeInTheDocument();
    expect(within(list).getByText('Bean Stew')).toBeInTheDocument();
    expect(within(list).queryByText('Green Salad')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /swipe again/i }));
    expect(topCardTitle()).toBe('Tomato Soup');
  });

  it('renders a placeholder with the recipe name when a card has no image', () => {
    render(<SwipeDeck cards={[cards[1]!]} />);
    expect(screen.getByTestId('card-image-placeholder')).toHaveTextContent('Green Salad');
  });

  it('falls back to the placeholder when an image fails to load', async () => {
    render(<SwipeDeck cards={[cards[0]!]} />);
    fireEvent.error(screen.getByRole('img', { name: 'Tomato Soup' }));
    expect(await screen.findByTestId('card-image-placeholder')).toHaveTextContent('Tomato Soup');
  });
});
