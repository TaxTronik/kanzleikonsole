// @vitest-environment jsdom
// Theme-fähige Overlays als Render- und Verhaltenstests (B-08, Welle 15):
// DateTimePicker-Popover mit eigenen Klassen, Platzierung und Pflichtfeld-
// Semantik; Profilwechsel im Portal mit semantischer Markierung und Sperre
// gegen Doppelwechsel. Das zugehörige CSS prüft
// app/__tests__/stylesheet-contracts.test.ts.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const switchProfile = vi.hoisted(() =>
  vi.fn((_data: FormData) => new Promise<void>(() => undefined)),
);
vi.mock('@/app/portal/(protected)/profile-actions', () => ({
  switchPortalProfileAction: switchProfile,
}));

import { DateTimePicker } from '../datetime-picker';
import { PortalProfileSwitcher } from '@/app/portal/(protected)/profile-switcher';

describe('DateTimePicker', () => {
  it('öffnet das Popover mit eigenen Theme-Klassen unten rechtsbündig', async () => {
    render(<DateTimePicker id="due" name="dueAt" />);
    fireEvent.click(screen.getByPlaceholderText('Datum + Uhrzeit auswählen'));

    const popper = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('.taxtronik-datetime-popper');
      expect(element).not.toBeNull();
      return element!;
    });
    expect(popper.closest('#taxtronik-datetime-portal')).not.toBeNull();
    expect(popper.getAttribute('data-placement')).toBe('bottom-end');
    expect(popper.querySelector('.taxtronik-datetime-calendar.react-datepicker')).not.toBeNull();
  });

  it('markiert das sichtbare Feld als Pflichtfeld, nicht den versteckten Formularwert', () => {
    const { container } = render(<DateTimePicker id="due" name="dueAt" required />);
    const visible = screen.getByPlaceholderText('Datum + Uhrzeit auswählen');
    expect(visible.hasAttribute('required')).toBe(true);
    expect(visible.getAttribute('aria-required')).toBe('true');
    const hidden = container.querySelector<HTMLInputElement>('input[type="hidden"][name="dueAt"]')!;
    expect(hidden.hasAttribute('required')).toBe(false);
  });

  it('ist ohne required auch nicht als Pflichtfeld markiert', () => {
    render(<DateTimePicker id="due" name="dueAt" />);
    const visible = screen.getByPlaceholderText('Datum + Uhrzeit auswählen');
    expect(visible.hasAttribute('required')).toBe(false);
    expect(visible.hasAttribute('aria-required')).toBe(false);
  });
});

describe('Portal-Profilwechsel', () => {
  const profile = (contactId: string, clientName: string) => ({
    contactId,
    clientId: `client-${contactId}`,
    clientName,
    contactName: 'Max Muster',
    email: 'max@mandant.example',
  });
  const profiles = [
    profile('c1', 'Muster GmbH'),
    profile('c2', 'Beispiel KG'),
    profile('c3', 'Dritte OHG'),
  ];

  function setup() {
    render(<PortalProfileSwitcher currentContactId="c1" profiles={profiles} />);
    const button = (name: string) => screen.getByRole('button', { name: new RegExp(name) });
    return {
      current: button('Muster GmbH'),
      other: button('Beispiel KG'),
      third: button('Dritte OHG'),
    };
  }

  it('markiert das aktuelle Profil semantisch und mit einer Fläche für beide Themes', () => {
    const { current, other } = setup();
    expect(current.getAttribute('aria-current')).toBe('page');
    expect((current as HTMLButtonElement).disabled).toBe(true);
    expect(current.classList.contains('bg-surface-raised')).toBe(true);
    expect(other.hasAttribute('aria-current')).toBe(false);
    for (const button of [current, other]) {
      expect(button.className).not.toMatch(/disabled:bg-brand-50|dark:disabled:bg-brand-950/);
    }
  });

  it('sperrt nach dem ersten Wechsel jeden weiteren, bis die Seite neu lädt', async () => {
    const { other, third } = setup();
    fireEvent.submit(other.closest('form')!);
    await waitFor(() => expect(switchProfile).toHaveBeenCalledOnce());
    expect(switchProfile.mock.calls[0]![0].get('contactId')).toBe('c2');
    await waitFor(() => expect((third as HTMLButtonElement).disabled).toBe(true));
    // Auch ein bereits ausgelöster zweiter Submit wird verworfen.
    expect(fireEvent.submit(third.closest('form')!)).toBe(false);
    expect(switchProfile).toHaveBeenCalledOnce();
  });
});
