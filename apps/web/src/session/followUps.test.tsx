import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ShoppingList } from '@yumanimous/shared';
import { member, sessionView } from '../test/fixtures';
import { Results } from './Results';
import { ServingsDialog } from './ServingsDialog';
import { ShoppingListView } from './ShoppingList';
import { SuggestionPanel } from './SuggestionPanel';

const list = (overrides: Partial<ShoppingList> = {}): ShoppingList => ({
  cardId: 'spoonacular:1',
  title: 'Garlic Noodles',
  servings: 2,
  recipeServings: 2,
  status: 'ready',
  source: 'ai',
  createdBy: 'vy',
  ingredients: [],
  lines: [
    {
      id: 'l1',
      name: 'Garlic',
      aisle: 'Produce',
      quantity: '3 cloves',
      covers: [0],
      likelyAtHome: false,
      have: false,
    },
    {
      id: 'l2',
      name: 'Noodles',
      aisle: 'Pantry',
      quantity: '200 g',
      covers: [1],
      likelyAtHome: false,
      have: true,
    },
    {
      id: 'l3',
      name: 'Salt',
      aisle: 'Spices',
      quantity: '',
      covers: [2],
      likelyAtHome: true,
      have: true,
    },
  ],
  error: null,
  ...overrides,
});

const handlers = () => ({
  onToggle: vi.fn(),
  onServings: vi.fn(),
  onRetry: vi.fn(),
  onBack: vi.fn(),
});

describe('ShoppingListView', () => {
  it('groups lines by aisle, with staples tucked under "Probably at home"', () => {
    render(<ShoppingListView list={list()} {...handlers()} />);
    const produce = screen.getByRole('group', { name: 'Produce' });
    expect(within(produce).getByRole('checkbox', { name: 'Garlic · 3 cloves' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Noodles · 200 g' })).toBeChecked();
    expect(screen.getByText('Probably at home (1)')).toBeInTheDocument();
    expect(screen.getByText(/1 to buy/)).toBeInTheDocument();
    expect(screen.getByText(/Sorted by our sous-chef/)).toBeInTheDocument();
  });

  it('ticks a line for everyone', async () => {
    const h = handlers();
    render(<ShoppingListView list={list()} {...h} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Garlic · 3 cloves' }));
    expect(h.onToggle).toHaveBeenCalledWith('l1', true);
  });

  it('changes servings with the stepper', async () => {
    const h = handlers();
    render(<ShoppingListView list={list()} {...h} />);
    await userEvent.click(screen.getByRole('button', { name: 'More servings' }));
    expect(h.onServings).toHaveBeenCalledWith(3);
  });

  it('copies only what still needs buying', async () => {
    const user = userEvent.setup();
    render(<ShoppingListView list={list()} {...handlers()} />);
    await user.click(screen.getByRole('button', { name: 'Copy list' }));
    expect(await navigator.clipboard.readText()).toBe(
      'Garlic Noodles (serves 2)\n\nProduce\n- 3 cloves Garlic',
    );
    expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  it('counts every quick tap on the stepper, before the server catches up', async () => {
    const h = handlers();
    render(<ShoppingListView list={list()} {...h} />);
    const more = screen.getByRole('button', { name: 'More servings' });
    await userEvent.click(more);
    await userEvent.click(more);
    expect(h.onServings.mock.calls).toEqual([[3], [4]]);
    expect(screen.getByText('4 servings')).toBeInTheDocument();
  });

  it('copies over plain http too, where there is no Clipboard API', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;
    render(<ShoppingListView list={list()} {...handlers()} />);
    await user.click(screen.getByRole('button', { name: 'Copy list' }));
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  it('shows the text to copy by hand when the browser refuses both ways', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.execCommand = vi.fn(() => false);
    render(<ShoppingListView list={list()} {...handlers()} />);
    await user.click(screen.getByRole('button', { name: 'Copy list' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Long-press to copy');
    expect(screen.getByRole('textbox')).toHaveValue(
      'Garlic Noodles (serves 2)\n\nProduce\n- 3 cloves Garlic',
    );
  });

  it('shows progress, then a failure with a retry', async () => {
    const h = handlers();
    const { rerender } = render(
      <ShoppingListView list={list({ status: 'building', lines: [] })} {...h} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Making the list…');

    rerender(
      <ShoppingListView
        list={list({ status: 'failed', lines: [], error: 'Recipe API daily quota is used up' })}
        {...h}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Recipe API daily quota is used up');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(h.onRetry).toHaveBeenCalledOnce();
  });
});

describe('ServingsDialog', () => {
  it('starts at the group size and confirms the chosen servings', async () => {
    const onConfirm = vi.fn();
    render(
      <ServingsDialog
        title="Garlic Noodles"
        initial={3}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'How many are eating?' })).toBeInTheDocument();
    expect(screen.getByText('3 servings')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Fewer servings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Make list' }));
    expect(onConfirm).toHaveBeenCalledWith(2);
  });
});

describe('no match: the mediator’s suggestion', () => {
  const recipeDeck = [
    { id: 'spoonacular:1', title: 'Garlic Noodles', tags: [], blurb: 'Yum.' },
    { id: 'spoonacular:2', title: 'Bean Stew', tags: [], blurb: 'Hearty.' },
  ];
  const finished = {
    deck: recipeDeck,
    members: [member('vy', { swipedCount: 2 }), member('sam', { swipedCount: 2 })],
    finished: true,
  };

  it('says a compromise is on its way', () => {
    render(
      <SuggestionPanel
        view={sessionView({ ...finished, mediating: true })}
        onAccept={() => {}}
        onOpenList={() => {}}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Finding a compromise…' })).toBeInTheDocument();
  });

  it('shows the pick and its reason, and anyone can go with it', async () => {
    const onAccept = vi.fn();
    const view = sessionView({
      ...finished,
      suggestion: {
        cardId: 'spoonacular:2',
        reason: 'Sam said yum and Vy nearly did.',
        source: 'ai',
        acceptedBy: null,
      },
    });
    render(<Results view={view} myId="sam" onOpenList={() => {}} onAcceptSuggestion={onAccept} />);
    expect(screen.getByRole('heading', { name: 'How about this?' })).toBeInTheDocument();
    expect(screen.getByText('Sam said yum and Vy nearly did.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Go with it' }));
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it('once accepted, offers the shopping list', async () => {
    const onOpenList = vi.fn();
    const view = sessionView({
      ...finished,
      suggestion: {
        cardId: 'spoonacular:2',
        reason: 'Sam said yum and Vy nearly did.',
        source: 'ai',
        acceptedBy: 'vy',
      },
    });
    render(<SuggestionPanel view={view} onAccept={() => {}} onOpenList={onOpenList} />);
    expect(screen.getByText('Vy said let’s go with it.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Shopping list' }));
    expect(onOpenList).toHaveBeenCalledWith('spoonacular:2');
  });
});

describe('Results', () => {
  it('offers a shopping list on matched recipe cards only', async () => {
    const onOpenList = vi.fn();
    const view = sessionView({
      deck: [
        { id: 'spoonacular:1', title: 'Garlic Noodles', tags: [], blurb: 'Yum.' },
        { id: 'soup', title: 'Tomato Soup', tags: [], blurb: 'Cosy.' },
      ],
      matches: [
        { cardId: 'spoonacular:1', matchedAt: 1 },
        { cardId: 'soup', matchedAt: 2 },
      ],
    });
    render(<Results view={view} myId="vy" onOpenList={onOpenList} onAcceptSuggestion={() => {}} />);
    const buttons = screen.getAllByRole('button', { name: 'Make shopping list' });
    expect(buttons).toHaveLength(1); // The hard-coded soup has no ingredients.
    await userEvent.click(buttons[0]!);
    expect(onOpenList).toHaveBeenCalledWith('spoonacular:1');
  });
});
