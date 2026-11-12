import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Card, SwipeDirection } from '@yumanimous/shared';
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

/** Stands in for the session: owns the index the way SessionRoom does. */
function Harness({ onSwipe }: { onSwipe: (id: string, d: SwipeDirection) => void }) {
  const [index, setIndex] = useState(0);
  return (
    <SwipeDeck
      cards={cards}
      index={index}
      onSwipe={(id, d) => {
        onSwipe(id, d);
        setIndex((i) => i + 1);
      }}
    />
  );
}

const topCardTitle = () =>
  within(screen.getByTestId('top-card')).getByRole('heading', { level: 2 }).textContent;

describe('SwipeDeck', () => {
  it('shows the card at the given index on top, with progress', () => {
    render(<SwipeDeck cards={cards} index={1} onSwipe={() => {}} />);
    expect(topCardTitle()).toBe('Green Salad');
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
  });

  it('reports Yum and Skip taps with the card id', async () => {
    const user = userEvent.setup();
    const onSwipe = vi.fn();
    render(<Harness onSwipe={onSwipe} />);

    await user.click(screen.getByRole('button', { name: /^yum/i }));
    expect(await screen.findByText('2 / 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /skip this recipe/i }));
    expect(await screen.findByText('3 / 3')).toBeInTheDocument();

    expect(onSwipe.mock.calls).toEqual([
      ['soup', 'like'],
      ['salad', 'skip'],
    ]);
  });

  it('labels the like button "Yum" for sighted, screen-reader and voice users', () => {
    render(<SwipeDeck cards={cards} index={0} onSwipe={() => {}} />);
    const yum = screen.getByRole('button', { name: 'Yum, like this recipe' });
    expect(yum).toHaveTextContent('Yum');
  });

  it('supports arrow keys', async () => {
    const user = userEvent.setup();
    const onSwipe = vi.fn();
    render(<Harness onSwipe={onSwipe} />);
    await user.keyboard('{ArrowRight}');
    await screen.findByText('2 / 3');
    await user.keyboard('{ArrowLeft}');
    await screen.findByText('3 / 3');
    expect(onSwipe.mock.calls).toEqual([
      ['soup', 'like'],
      ['salad', 'skip'],
    ]);
  });

  it('renders nothing once the index passes the last card', () => {
    const { container } = render(<SwipeDeck cards={cards} index={3} onSwipe={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a placeholder with the recipe name when a card has no image', () => {
    render(<SwipeDeck cards={[cards[1]!]} index={0} onSwipe={() => {}} />);
    expect(screen.getByTestId('card-image-placeholder')).toHaveTextContent('Green Salad');
  });

  it('falls back to the placeholder when an image fails to load', async () => {
    render(<SwipeDeck cards={[cards[0]!]} index={0} onSwipe={() => {}} />);
    fireEvent.error(screen.getByRole('img', { name: 'Tomato Soup' }));
    expect(await screen.findByTestId('card-image-placeholder')).toHaveTextContent('Tomato Soup');
  });
});
