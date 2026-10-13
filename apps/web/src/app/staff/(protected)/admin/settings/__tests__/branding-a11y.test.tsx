// @vitest-environment jsdom
// Barrierefreiheit der Branding-Einstellungen als Render- und Verhaltenstest
// (B-08, Welle 15) statt Quelltextprüfung.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BRANDING } from '@/server/settings/branding';

const h = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock('../actions', () => ({ saveBrandingAction: h.save }));

import { BrandingForm } from '../branding-form';

function setup() {
  render(<BrandingForm initial={{ ...DEFAULT_BRANDING, accentColor: '#2563eb' }} />);
  const group = screen.getByRole('group', { name: 'Akzent-Farbe' });
  const hex = within(group).getByLabelText('Akzent-Farbe als Hex-Wert') as HTMLInputElement;
  const picker = within(group).getByLabelText('Akzent-Farbe auswählen') as HTMLInputElement;
  const contrast = within(group).getByRole('status');
  return { group, hex, picker, contrast };
}

function describedBy(element: HTMLElement): string[] {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .map((id) => document.getElementById(id)!.textContent ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Barrierefreiheit der Branding-Einstellungen', () => {
  it('beschriftet beide Farbeingaben und erläutert die automatische Kontrastwahl', () => {
    const { hex, picker, contrast } = setup();
    expect(contrast.getAttribute('aria-live')).toBe('polite');
    for (const input of [hex, picker]) {
      expect(describedBy(input)).toEqual([
        'Hex-Format, z. B. #2563eb (Standard)',
        contrast.textContent,
      ]);
    }
    expect(hex.getAttribute('aria-invalid')).toBe('false');
    expect(contrast.textContent).toMatch(/automatisch weiße Beschriftung/);

    fireEvent.change(hex, { target: { value: '#ffd7' } });
    expect(hex.getAttribute('aria-invalid')).toBe('true');
    expect(contrast.textContent).toBe(
      'Sobald der Hex-Wert vollständig ist, wird der Kontrast automatisch geprüft.',
    );

    fireEvent.change(hex, { target: { value: '#ffd700' } });
    expect(hex.getAttribute('aria-invalid')).toBe('false');
    expect(contrast.textContent).toMatch(/automatisch schwarze Beschriftung/);
    expect(contrast.textContent).toContain('die Markenfarbe bleibt unverändert');
  });

  it('kündigt Dateifehler unmittelbar an', () => {
    setup();
    const input = document.getElementById('logoFile') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['gif'], 'logo.gif', { type: 'image/gif' })] },
    });
    expect(screen.getByRole('alert').textContent).toBe('Nur PNG, JPG oder WebP erlaubt.');
  });

  it('kündigt Speicherfehler und -erfolg an', async () => {
    setup();
    h.save.mockResolvedValueOnce({ ok: false, error: 'Speichern fehlgeschlagen.' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Branding speichern' }));
    });
    expect((await screen.findByRole('alert')).textContent).toBe('Speichern fehlgeschlagen.');

    h.save.mockResolvedValueOnce({ ok: true });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Branding speichern' }));
    });
    const saved = await screen.findByText(/^Gespeichert\./);
    expect(saved.getAttribute('role')).toBe('status');
    expect(saved.getAttribute('aria-live')).toBe('polite');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
