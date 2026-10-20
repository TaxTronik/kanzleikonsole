// @vitest-environment jsdom
// kk-tcms-s10nach (TCMS s10, TCMS-NACHWEIS-001): Idempotenzschlüssel des
// Meldeformulars im Portal. Schutzregeln:
//   - je Einhängen des Formulars ein eigener Schlüssel, nie der vom Server
//     mitgegebene einer früheren Darstellung (Seite aus dem Verlauf, „Zurück“):
//     sonst würde eine neue Meldung mit dem Schlüssel einer angenommenen
//     gesendet (dasselbe Ereignis bzw. IDEMPOTENZ_ABWEICHUNG);
//   - innerhalb desselben Formulars bleibt er stehen, auch wenn die Seite nach
//     einem offenen Ausgang mit neuen Props neu gerendert wird – das erneute
//     Absenden ist dann eine Wiederholung derselben Meldung.
// Fachkatalog: TCMS-NACHWEIS-001
import { render } from '@testing-library/react';
import { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PORTAL_KACHELN } from '../ereignisse/texte';
import { MeldungFormular } from '../portal/meldung-formular';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SERVER_1 = '3f2b8c1d-6e4a-4b7f-9a0c-1d2e3f4a5b6c';
const SERVER_2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

function formular(schluessel: string) {
  return (
    <MeldungFormular
      aktion={vi.fn()}
      schluessel={schluessel}
      kacheln={PORTAL_KACHELN}
      heute="2026-10-21"
      darf
      sperrHinweis={null}
      upload
      grenzen={{
        maxDateien: 5,
        maxBytes: 10_000_000,
        maxGesamt: 25_000_000,
        minTitel: 5,
        minBeschreibung: 20,
      }}
      accept=".pdf,.csv"
      uploadHinweis="Bis zu 5 Dateien."
    />
  );
}

function schluesselVon(container: HTMLElement): string | null {
  const form = container.querySelector('form[aria-label="Ereignis melden"]') as HTMLFormElement;
  const feld = form.querySelector<HTMLInputElement>('input[name="idempotenzSchluessel"]');
  expect(feld?.type).toBe('hidden');
  // Genau dieser Wert geht mit den Formulardaten an die Aktion.
  expect(new FormData(form).get('idempotenzSchluessel')).toBe(feld!.value);
  return feld!.value;
}

describe('Idempotenzschlüssel des Meldeformulars (kk-tcms-s10nach)', () => {
  it('je Einhängen ein eigener Schlüssel, nie der vom Server mitgegebene', () => {
    const erst = render(formular(SERVER_1));
    const k1 = schluesselVon(erst.container);
    expect(k1).toMatch(UUID);
    expect(k1).not.toBe(SERVER_1);
    erst.unmount();
    // Dieselben (alten) Props, neu eingehängt – etwa „Zurück“ aus dem Verlauf.
    const wieder = render(formular(SERVER_1));
    const k2 = schluesselVon(wieder.container);
    expect(k2).toMatch(UUID);
    expect(k2).not.toBe(k1);
    expect(k2).not.toBe(SERVER_1);
  });

  it('Server-Markup mit dem Schlüssel des Servers, nach der Hydrierung ein eigener – ohne Abweichung', async () => {
    const html = renderToString(formular(SERVER_1));
    expect(html).toContain(`value="${SERVER_1}"`);
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const fehler = vi.spyOn(console, 'error').mockImplementation(() => {});
    const abweichungen: unknown[] = [];
    let root: Root | null = null;
    try {
      await act(async () => {
        root = hydrateRoot(container, formular(SERVER_1), {
          onRecoverableError: (e) => abweichungen.push(e),
        });
      });
      const k = schluesselVon(container);
      expect(k).toMatch(UUID);
      expect(k).not.toBe(SERVER_1);
      expect(abweichungen).toEqual([]);
      expect(fehler.mock.calls.map((c) => String(c[0]).slice(0, 300))).toEqual([]);
    } finally {
      fehler.mockRestore();
      act(() => (root as Root | null)?.unmount());
      container.remove();
    }
  });

  it('bleibt im selben Formular stehen, auch bei neuen Props (Revalidierung)', () => {
    const r = render(formular(SERVER_1));
    const k1 = schluesselVon(r.container);
    r.rerender(formular(SERVER_2));
    expect(schluesselVon(r.container)).toBe(k1);
  });

  it('ohne crypto.randomUUID (unsicherer Kontext): der Schlüssel des Servers', () => {
    const original = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
    });
    try {
      const r = render(formular(SERVER_1));
      expect(schluesselVon(r.container)).toBe(SERVER_1);
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        value: original,
        configurable: true,
      });
    }
  });
});
