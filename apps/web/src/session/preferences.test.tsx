import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyPreferences, type MemberPreferences } from '@yumanimous/shared';
import { member, sessionView } from '../test/fixtures';
import { GroupRules, UncoveredWarning } from './GroupRules';
import { removeChip, toChips } from './preferenceChips';
import { PreferencesPanel } from './PreferencesPanel';

const prefs = (p: Partial<MemberPreferences>): MemberPreferences => ({
  ...emptyPreferences(),
  ...p,
});

describe('preference chips', () => {
  const p = prefs({
    diets: ['vegan'],
    intolerances: ['peanut'],
    avoidIngredients: [
      { name: 'kiwi', reason: 'cannot-eat' },
      { name: 'mushroom', reason: 'dislike' },
    ],
    maxReadyMinutes: 30,
    cuisinesLiked: ['Thai'],
    unsupported: ['halal'],
  });

  it('labels hard rules as must, soft as prefer', () => {
    expect(toChips(p).map((c) => [c.label, c.kind])).toEqual([
      ['vegan', 'must'],
      ['no peanut', 'must'],
      ['no kiwi', 'must'],
      ['not keen on mushroom', 'prefer'],
      ['under 30 min', 'must'],
      ['likes Thai', 'prefer'],
      ['halal', 'unsupported'],
    ]);
  });

  it('removes exactly one rule per chip', () => {
    for (const chip of toChips(p)) {
      const after = removeChip(p, chip.id);
      expect(toChips(after).map((c) => c.id)).toEqual(
        toChips(p)
          .map((c) => c.id)
          .filter((id) => id !== chip.id),
      );
    }
  });
});

describe('PreferencesPanel', () => {
  it('shows chips as you type and saves only the ones you keep', async () => {
    const onSave = vi.fn(async () => true);
    render(<PreferencesPanel saved={null} onSave={onSave} />);

    await userEvent.type(
      screen.getByLabelText('Anything we should know?'),
      'vegetarian, allergic to peanuts, love thai',
    );
    const must = screen.getByRole('list', { name: 'Must' });
    expect(within(must).getByText('vegetarian')).toBeInTheDocument();
    expect(within(must).getByText('no peanut')).toBeInTheDocument();

    // The parser read "love thai" as a preference; this person changes their mind.
    await userEvent.click(screen.getByRole('button', { name: 'Remove likes Thai' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save my rules' }));

    expect(onSave).toHaveBeenCalledWith(prefs({ diets: ['vegetarian'], intolerances: ['peanut'] }));
    // Saved: shows the summary with a way to change it.
    expect(await screen.findByRole('button', { name: 'Change' })).toBeInTheDocument();
  });

  it('says so when the text has no rules it recognises', async () => {
    render(<PreferencesPanel saved={null} onSave={async () => true} />);
    await userEvent.type(screen.getByLabelText('Anything we should know?'), 'hello there');
    expect(screen.getByText(/didn’t spot any food rules/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No rules for me' })).toBeInTheDocument();
  });

  it('offers Skip to late joiners', async () => {
    const onSkip = vi.fn();
    render(<PreferencesPanel saved={null} onSave={async () => true} onSkip={onSkip} />);
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('stays in edit mode if saving fails', async () => {
    render(<PreferencesPanel saved={null} onSave={async () => false} />);
    await userEvent.type(screen.getByLabelText('Anything we should know?'), 'vegan');
    await userEvent.click(screen.getByRole('button', { name: 'Save my rules' }));
    expect(screen.getByLabelText('Anything we should know?')).toBeInTheDocument();
  });
});

describe('GroupRules', () => {
  it('combines everyone’s hard rules and names who asked for unfilterable ones', () => {
    const view = sessionView({
      status: 'lobby',
      members: [
        member('vy', { preferences: prefs({ diets: ['vegetarian'] }) }),
        member('sam', { preferences: prefs({ intolerances: ['peanut'], unsupported: ['halal'] }) }),
      ],
    });
    render(<GroupRules view={view} />);
    expect(screen.getByText('vegetarian · no peanut')).toBeInTheDocument();
    expect(screen.getByText(/Sam:/)).toHaveTextContent('Sam: halal. We can’t filter for this');
  });
});

describe('UncoveredWarning', () => {
  const view = sessionView({ uncovered: [{ rule: 'no shellfish', members: ['Kim'] }] });

  it('lets the host rebuild after confirming', async () => {
    const onRebuild = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<UncoveredWarning view={view} isHost onRebuild={onRebuild} />);
    expect(screen.getByRole('alert')).toHaveTextContent('no shellfish (Kim)');
    await userEvent.click(screen.getByRole('button', { name: 'Rebuild deck' }));
    expect(onRebuild).toHaveBeenCalledOnce();
  });

  it('tells guests the host can rebuild', () => {
    render(<UncoveredWarning view={view} isHost={false} onRebuild={() => {}} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The host can rebuild the deck');
  });

  it('renders nothing when the deck covers everyone', () => {
    const { container } = render(
      <UncoveredWarning view={sessionView()} isHost onRebuild={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
