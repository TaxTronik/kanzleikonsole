// @vitest-environment jsdom
// Ergebnis und Ende des Wartezustands erscheinen gemeinsam (CI-Lauf 3880):
// ConfirmModal und InputModal setzten Fehler bzw. Schließen nach dem `await`
// außerhalb der Transition. React übernahm dann den Fehler in einem eigenen
// Commit, während der Button noch „Bitte warten…“ zeigte und gesperrt war; unter
// Last fanden Tests den Alert, aber nicht den Button zum erneuten Versuch.
// Ein MutationObserver hält jeden DOM-Stand fest; kein Stand darf Alert und
// Wartezustand zugleich zeigen.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmModal, InputModal } from '../modal';

type Ergebnis = { ok: boolean; error?: string };

function aufgeschoben() {
  let erfuellen!: (wert: Ergebnis) => void;
  const versprechen = new Promise<Ergebnis>((fertig) => (erfuellen = fertig));
  return { versprechen, erfuellen };
}

// Protokolliert nach jeder DOM-Änderung: Alert sichtbar UND Bestätigen noch im
// Wartezustand (Busy-Label oder gesperrt bei vorhandenem Alert).
function beobachteZwischenstaende(busyLabel: string) {
  const widersprueche: string[] = [];
  const pruefe = () => {
    const alert = document.querySelector('[role="alert"]');
    if (!alert) return;
    const busy = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === busyLabel,
    );
    if (busy) widersprueche.push(`Alert „${alert.textContent}“ neben „${busyLabel}“`);
  };
  const observer = new MutationObserver(pruefe);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  return {
    widersprueche,
    beenden: () => {
      pruefe();
      observer.disconnect();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Wie im Browser: ohne act() plant React Commits über den Scheduler, und der
// MutationObserver sieht jeden Commit einzeln (act() fasst sie zusammen und
// verdeckt Zwischenstände). RTL setzt die Umgebung für eigene Aufrufe selbst.
async function ohneAct<T>(schritt: () => Promise<T>): Promise<T> {
  const umgebung = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const vorher = umgebung.IS_REACT_ACT_ENVIRONMENT;
  umgebung.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    return await schritt();
  } finally {
    umgebung.IS_REACT_ACT_ENVIRONMENT = vorher;
  }
}

async function bis(bedingung: () => boolean) {
  for (let versuch = 0; versuch < 200; versuch++) {
    if (bedingung()) return;
    await new Promise((weiter) => setTimeout(weiter, 5));
  }
  throw new Error('Zustand nicht erreicht');
}

describe.each([
  { name: 'ConfirmModal', busy: 'Lösche…', idle: 'Verbindlich löschen' },
  { name: 'InputModal', busy: 'Speichert…', idle: 'Speichern' },
])('$name ohne act (Scheduler wie im Browser)', ({ name, busy, idle }) => {
  it('zeigt in keinem Commit Ergebnis und Wartezustand zugleich', async () => {
    const lauf = aufgeschoben();
    const aktion = vi.fn(() => lauf.versprechen);
    render(
      name === 'ConfirmModal' ? (
        <ConfirmModal
          title="Löschen"
          message="Wirklich löschen?"
          confirmLabel={idle}
          busyLabel={busy}
          onConfirm={aktion}
          onClose={vi.fn()}
        />
      ) : (
        <InputModal title="Umbenennen" initialValue="Alt" onSubmit={aktion} onClose={vi.fn()} />
      ),
    );
    const beobachtung = beobachteZwischenstaende(busy);
    await ohneAct(async () => {
      fireEvent.click(screen.getByRole('button', { name: idle }));
      await bis(() => screen.queryByRole('button', { name: busy }) !== null);
      lauf.erfuellen({ ok: false, error: 'Abgelehnt.' });
      await bis(
        () =>
          screen.queryByRole('alert') !== null &&
          screen.queryByRole('button', { name: idle }) !== null,
      );
    });
    beobachtung.beenden();
    expect(beobachtung.widersprueche).toEqual([]);
  });
});

describe('ConfirmModal', () => {
  it('zeigt einen Fehler erst zusammen mit dem wieder bedienbaren Bestätigen', async () => {
    const lauf = aufgeschoben();
    const onConfirm = vi.fn(() => lauf.versprechen);
    const onClose = vi.fn();
    render(
      <ConfirmModal
        title="Löschen"
        message="Wirklich löschen?"
        confirmLabel="Verbindlich löschen"
        busyLabel="Lösche…"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    const beobachtung = beobachteZwischenstaende('Lösche…');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Verbindlich löschen' }));
    });
    expect((screen.getByRole('button', { name: 'Lösche…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => lauf.erfuellen({ ok: false, error: 'Gesperrt.' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Gesperrt.');
    // Sofort nach dem Alert: erneuter Versuch möglich (kein Warten auf einen
    // zweiten Commit).
    const erneut = screen.getByRole('button', { name: 'Verbindlich löschen' }) as HTMLButtonElement;
    expect(erneut.disabled).toBe(false);
    beobachtung.beenden();
    expect(beobachtung.widersprueche).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();

    // Erneuter Versuch mit Erfolg schließt; kein Zwischenstand mit altem Alert.
    const zweiter = aufgeschoben();
    onConfirm.mockImplementationOnce(() => zweiter.versprechen);
    await act(async () => {
      fireEvent.click(erneut);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => zweiter.erfuellen({ ok: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('InputModal', () => {
  it('zeigt einen Fehler erst zusammen mit dem wieder bedienbaren Speichern', async () => {
    const lauf = aufgeschoben();
    const onSubmit = vi.fn(() => lauf.versprechen);
    render(
      <InputModal
        title="Umbenennen"
        inputLabel="Name"
        initialValue="Alt"
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    const beobachtung = beobachteZwischenstaende('Speichert…');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    });
    expect(onSubmit).toHaveBeenCalledWith('Alt');
    await act(async () => lauf.erfuellen({ ok: false, error: 'Name vergeben.' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Name vergeben.');
    const erneut = screen.getByRole('button', { name: 'Speichern' }) as HTMLButtonElement;
    expect(erneut.disabled).toBe(false);
    beobachtung.beenden();
    expect(beobachtung.widersprueche).toEqual([]);

    // Erneuter Versuch: der alte Fehler verschwindet sofort.
    const zweiter = aufgeschoben();
    onSubmit.mockImplementationOnce(() => zweiter.versprechen);
    await act(async () => {
      fireEvent.click(erneut);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => zweiter.erfuellen({ ok: false, error: 'Wieder vergeben.' }));
    expect(screen.getByRole('alert').textContent).toBe('Wieder vergeben.');
  });
});
