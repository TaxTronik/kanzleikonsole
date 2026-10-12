// @vitest-environment jsdom
// IBM-Quantum-Token und gespeicherte Login-Zugangsdaten (Credential-Autofill):
// Das Tokenfeld ist ein eigenes Formular mit Neu-Passwort-Semantik, damit
// Passwortmanager dort keine Staff-Anmeldedaten eintragen; Enter speichert
// (Verhaltenstest statt Quelltextprüfung, B-08, Welle 15).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/components/theme-sync', () => ({ ThemeSync: () => null }));
vi.mock('../actions', () => ({
  ibmTokenEntfernenAction: vi.fn(),
  ibmTokenSpeichernAction: m.save,
  losAbholenAction: vi.fn(),
  losPruefenAction: vi.fn(),
  losStartFreigebenAction: vi.fn(),
  losStartWiederaufnehmenAction: vi.fn(),
  losZiehenAction: vi.fn(),
  rahmenVorschauAction: vi.fn(),
}));

import { QuantenlosPanel } from '../quantenlos-panel';

describe('IBM-Quantum-Token', () => {
  it('grenzt das Tokenfeld von gespeicherten Login-Zugangsdaten ab und speichert per Formular', async () => {
    m.save.mockResolvedValue({
      ok: true,
      status: { hinterlegt: true, suffix: 'cdef', gesetztAm: '2026-10-01T08:00:00.000Z' },
    });
    render(
      <QuantenlosPanel
        initialZeitraum={{ von: '2026-09-01', bis: '2026-09-30' }}
        initialN={0}
        initialPending={null}
        initialStart={null}
        initialZiehungen={[]}
        initialIbmToken={{ hinterlegt: false, suffix: null, gesetztAm: null }}
      />,
    );
    const input = screen.getByLabelText('Token hinterlegen') as HTMLInputElement;
    expect(input.name).toBe('ibm-quantum-api-token');
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('new-password');
    expect(input.getAttribute('data-lpignore')).toBe('true');
    expect(input.hasAttribute('data-1p-ignore')).toBe(true);

    const form = input.closest('form')!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'ibm-token-abcdef' } });
    expect(submit.disabled).toBe(false);
    // Enter im Feld sendet das eigene Formular, kein Login-Formular.
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => expect(m.save).toHaveBeenCalledWith({ token: 'ibm-token-abcdef' }));
  });
});
