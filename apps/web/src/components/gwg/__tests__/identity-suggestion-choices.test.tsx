// @vitest-environment jsdom
// Fachkatalog: GWG-OCR-ASSIST-001
// Vorschläge der Ausweishilfe: übliche Schreibweise mit sichtbarer
// Ausweisfassung; was der bisherigen Angabe bis auf Groß-/Kleinschreibung oder
// Umlaute entspricht, wird nicht zum Ersetzen angeboten.
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { IdentityField, IdentitySuggestions } from '@/lib/gwg/identity-ocr';
import type { IdentityAudience } from '@/lib/gwg/identity-hints';
import { SuggestionChoices } from '../identity-capture';

function Harness(props: {
  audience: IdentityAudience;
  current: IdentitySuggestions;
  onApply: (values: IdentitySuggestions) => void;
}) {
  const [selected, setSelected] = useState<IdentityField[]>([]);
  return (
    <SuggestionChoices
      fields={{ fullName: 'ERIKA MUSTERMANN', city: 'KOLN', idIssuedBy: 'STADT KOLN' }}
      current={props.current}
      audience={props.audience}
      selected={selected}
      onSelect={(field, checked) =>
        setSelected((previous) =>
          checked ? [...previous, field] : previous.filter((key) => key !== field),
        )
      }
      onApply={props.onApply}
    />
  );
}

describe('GWG-OCR-ASSIST-001 Vorschlagsliste der Ausweishilfe', () => {
  it('zeigt Mandanten Übereinstimmungen als Hinweis und übernimmt die übliche Schreibweise', () => {
    const onApply = vi.fn();
    render(
      <Harness
        audience="client"
        current={{ fullName: 'Erika Mustermann', city: 'Köln' }}
        onApply={onApply}
      />,
    );
    expect(
      screen.getByText(
        'Passt bereits zu Ihrer Eingabe: Vollständiger Name, Ort. Ihre Schreibweise bleibt erhalten.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Vollständiger Name/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /^Ort/ })).toBeNull();

    const authority = screen.getByRole('checkbox', { name: 'Ausstellende Behörde: Stadt Koln' });
    expect(authority.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(authority.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Auf dem Ausweis steht STADT KOLN. Bitte prüfen Sie die Schreibweise, besonders ä, ö, ü und ß.',
    );

    fireEvent.click(authority);
    fireEvent.click(screen.getByRole('button', { name: 'Angehakte Angaben übernehmen' }));
    expect(onApply).toHaveBeenCalledWith({ idIssuedBy: 'Stadt Koln' });
  });

  it('beschreibt der Kanzlei Ausweisfassung und bisherige Angabe, ohne den Namen zu verlängern', () => {
    render(
      <Harness audience="staff" current={{ fullName: 'Vorhandener Name' }} onApply={vi.fn()} />,
    );
    const name = screen.getByRole('checkbox', { name: 'Vollständiger Name: Erika Mustermann' });
    const notes = name
      .getAttribute('aria-describedby')!
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent);
    expect(notes).toEqual([
      'Ausweis: ERIKA MUSTERMANN — Groß-/Kleinschreibung angepasst; Umlaute und ß am Original prüfen.',
      'Bisher: Vorhandener Name — wird nur nach Auswahl ersetzt.',
    ]);
  });

  it('blendet Auswahl und Übernehmen aus, wenn alles bereits passt', () => {
    render(
      <Harness
        audience="client"
        current={{ fullName: 'Erika Mustermann', city: 'Köln', idIssuedBy: 'Stadt Köln' }}
        onApply={vi.fn()}
      />,
    );
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
