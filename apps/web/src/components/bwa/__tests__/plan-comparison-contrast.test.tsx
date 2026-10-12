// @vitest-environment jsdom
// BWA-Planungsvergleich im Dark Mode: die gerenderten Elemente tragen die
// semantischen, kontrastreichen Klassen (Render-Test statt Quelltextprüfung,
// B-08, Welle 15). Die Werte der Tokens prüft dark-mode-tokens.test.ts.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PlanListWithCompare, type PlanForCompare } from '../plan-comparison';

const plan: PlanForCompare = {
  id: 'plan-1',
  name: 'Plan 2026',
  year: 2026,
  status: 'DRAFT',
  updatedAt: new Date('2026-10-01T08:00:00.000Z'),
  lines: [
    { axis: 'REVENUE', amount: 100_000 },
    { axis: 'PERSONNEL', amount: 40_000 },
  ],
};

function classesOf(element: Element | null): string[] {
  return element?.className.split(/\s+/) ?? [];
}

describe('BWA-Planungsvergleich im Dark Mode', () => {
  it('verwendet kontrastreiche semantische Farben für Kopfzeile, Metadaten und Aktion', () => {
    render(<PlanListWithCompare plans={[plan]} projection={null} />);

    const header = screen.getByText('1 Planung').closest('div');
    expect(classesOf(header)).toEqual(
      expect.arrayContaining(['bg-surface-raised', 'text-xs', 'font-medium', 'text-secondary']),
    );
    expect(classesOf(screen.getByText('· 2026'))).toEqual(
      expect.arrayContaining(['text-xs', 'text-secondary', 'font-normal']),
    );
    expect(classesOf(screen.getByText(/Erg\. nach Steuern:/))).toEqual([
      'text-xs',
      'text-secondary',
    ]);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Plan 2026 zum Vergleich auswählen' }));
    expect(classesOf(screen.getByRole('button', { name: 'Auswahl löschen' }))).toEqual(
      expect.arrayContaining(['text-brand-700', 'hover:underline', 'dark:text-brand-300']),
    );
  });
});
