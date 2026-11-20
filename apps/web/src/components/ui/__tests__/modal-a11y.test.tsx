// @vitest-environment jsdom
// Gemeinsame Dialog-Infrastruktur als Verhaltenstest (B-08, Welle 15):
// Dialogrolle und -name, Hintergrund-Isolation, Fokusführung (Initialfokus,
// Tab-Falle, Rückgabe), Escape, beschriftete Eingabe mit Fehlerzustand und der
// bestätigte Formular-Submit. Ersetzt die Quelltextprüfungen aus
// modal-consolidation und accessibility-foundations; der repo-weite Guard
// gegen eigene Portale und Browserdialoge bleibt in modal-consolidation.test.ts.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type FormEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputModal, Modal, confirmFormSubmission } from '../modal';

beforeEach(() => {
  // jsdom hat kein Layout: sichtbare Elemente bekommen eine Box, `hidden` keine.
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (this.closest('[hidden]') ? [] : [{}]) as unknown as DOMRectList;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function Harness({ autoFocusSecond = false }: { autoFocusSecond?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Dialog öffnen
      </button>
      {open && (
        <Modal title="Termin bearbeiten" onClose={() => setOpen(false)}>
          <button type="button">Erste Aktion</button>
          <button type="button" hidden>
            Versteckt
          </button>
          <input aria-label="Notiz" autoFocus={autoFocusSecond} />
          <button type="button">Letzte Aktion</button>
        </Modal>
      )}
    </>
  );
}

function open(autoFocusSecond = false) {
  const view = render(<Harness autoFocusSecond={autoFocusSecond} />);
  const trigger = screen.getByRole('button', { name: 'Dialog öffnen' });
  trigger.focus();
  fireEvent.click(trigger);
  return { ...view, trigger, dialog: screen.getByRole('dialog', { name: 'Termin bearbeiten' }) };
}

describe('Modal', () => {
  it('ist ein benannter modaler Dialog mit fokussierbarem Container', () => {
    const { dialog } = open();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('tabindex')).toBe('-1');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Termin bearbeiten',
    );
  });

  it('isoliert den Hintergrund und stellt ihn beim Schließen wieder her', () => {
    const { container, dialog } = open();
    expect(container.hasAttribute('inert')).toBe(true);
    expect(container.getAttribute('aria-hidden')).toBe('true');
    expect(dialog.closest('[inert]')).toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.hasAttribute('inert')).toBe(false);
    expect(container.hasAttribute('aria-hidden')).toBe(false);
  });

  it('fokussiert das erste sichtbare Element, sonst [autofocus], und gibt den Fokus zurück', async () => {
    const { trigger } = open();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Schließen' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  // React fokussiert autoFocus-Kinder schon im Commit und setzt kein
  // autofocus-Attribut. Der Dialog darf diesen Fokus weder überschreiben noch
  // als Rückgabeziel missverstehen.
  it('lässt ein Element mit autoFocus fokussiert und gibt den Fokus danach zurück', async () => {
    const { trigger } = open(true);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Notiz' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('hält Tab und Shift+Tab im Dialog gefangen und überspringt Unsichtbares', () => {
    open();
    const close = screen.getByRole('button', { name: 'Schließen' });
    const last = screen.getByRole('button', { name: 'Letzte Aktion' });

    last.focus();
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(close);

    expect(fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);

    // Mitten im Dialog bleibt Tab nativ.
    screen.getByRole('button', { name: 'Erste Aktion' }).focus();
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(true);
  });

  it('schließt mit Escape nur den oberen Dialog und gibt den Fokus schrittweise zurück', () => {
    const lower = open();
    const opener = screen.getByRole('button', { name: 'Erste Aktion' });
    opener.focus();
    const closeUpper = vi.fn();
    const upper = render(
      <Modal title="Weitere Auswahl" onClose={closeUpper}>
        Inhalt
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closeUpper).toHaveBeenCalledOnce();
    upper.unmount();
    expect(document.activeElement).toBe(opener);
    expect(lower.container.hasAttribute('inert')).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(lower.trigger);
    expect(lower.container.hasAttribute('inert')).toBe(false);
  });

  it('gibt den Hintergrund auch dann frei, wenn der untere Dialog zuerst verschwindet', () => {
    const lower = open();
    const upper = render(
      <Modal title="Weitere Auswahl" onClose={() => {}}>
        Inhalt
      </Modal>,
    );
    lower.rerender(<button type="button">Neue Ansicht</button>);
    expect(lower.container.hasAttribute('inert')).toBe(true);
    upper.unmount();
    expect(lower.container.hasAttribute('inert')).toBe(false);
    expect(lower.container.getAttribute('aria-hidden')).toBeNull();
  });

  it('isoliert während des Dialogs neu gemountete Seitenelemente und gibt sie wieder frei', async () => {
    const { dialog } = open();
    const extra = document.createElement('button');
    document.body.append(extra);
    try {
      await waitFor(() => expect(extra.hasAttribute('inert')).toBe(true));
      expect(extra.getAttribute('aria-hidden')).toBe('true');
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(extra.hasAttribute('inert')).toBe(false);
    } finally {
      extra.remove();
    }
  });

  it('umläuft nur erreichbare Steuerelemente, auch nach einem deaktivierten Formular', () => {
    render(
      <Modal title="Auswahl" onClose={() => {}} showCloseButton={false}>
        <button type="button" tabIndex={-1}>
          Programmfokus
        </button>
        <button type="button">Erreichbar</button>
        <fieldset disabled>
          <button type="button">Gespeichert</button>
        </fieldset>
      </Modal>,
    );
    const active = screen.getByRole('button', { name: 'Erreichbar' });
    expect(document.activeElement).toBe(active);
    expect(fireEvent.keyDown(active, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(active);
    screen.getByRole('dialog').focus();
    expect(fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(active);
  });

  it('misst beim Tab-Umlauf nur die Ränder einer langen Ordnerliste', () => {
    render(
      <Modal title="Lange Liste" onClose={() => {}} showCloseButton={false}>
        {Array.from({ length: 150 }, (_, i) => (
          <button key={i} type="button">
            Ordner {i}
          </button>
        ))}
      </Modal>,
    );
    const buttons = screen.getAllByRole('button');
    buttons.at(-1)!.focus();
    const measure = vi.mocked(Element.prototype.getClientRects);
    measure.mockClear();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);
    expect(measure.mock.calls.length).toBeLessThan(5);
  });
});

describe('InputModal', () => {
  it('beschriftet die Eingabe und meldet Fehler am Feld und als Alert', async () => {
    const onSubmit = vi.fn(async () => ({ ok: false, error: 'Name bereits vergeben.' }));
    render(
      <InputModal
        title="Ordner umbenennen"
        inputLabel="Ordnername"
        initialValue="Belege"
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText('Ordnername');
    expect(document.activeElement).toBe(input);
    expect(input.hasAttribute('aria-invalid')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Name bereits vergeben.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain(alert.id);
    expect(onSubmit).toHaveBeenCalledWith('Belege');
  });
});

describe('confirmFormSubmission', () => {
  it('fragt zuerst nach und sendet danach genau einmal mit dem ursprünglichen Submitter', async () => {
    const requestSubmit = vi
      .spyOn(HTMLFormElement.prototype, 'requestSubmit')
      .mockImplementation(function (this: HTMLFormElement, submitter?: HTMLElement | null) {
        this.dispatchEvent(
          Object.assign(new Event('submit', { bubbles: true, cancelable: true }), { submitter }),
        );
      });
    const submitted = vi.fn();
    function onSubmit(event: FormEvent<HTMLFormElement>) {
      confirmFormSubmission(event, 'Wirklich löschen?', { danger: true });
      if (!event.defaultPrevented) {
        event.preventDefault();
        submitted((event.nativeEvent as SubmitEvent).submitter?.getAttribute('value'));
      }
    }
    render(
      <form aria-label="Löschen" onSubmit={onSubmit}>
        <button type="submit" name="mode" value="hard">
          Endgültig löschen
        </button>
      </form>,
    );
    const button = screen.getByRole('button', { name: 'Endgültig löschen' });

    // Klick auf den Submit-Button: jsdom löst das submit-Ereignis samt Submitter aus.
    fireEvent.click(button);
    expect(submitted).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('dialog', { name: 'Bitte bestätigen' });
    expect(confirm.textContent).toContain('Wirklich löschen?');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }));
    });
    await waitFor(() => expect(requestSubmit).toHaveBeenCalledWith(button));
    expect(submitted).toHaveBeenCalledOnce();
    expect(submitted).toHaveBeenCalledWith('hard');
  });

  it('sendet bei Abbruch nichts', async () => {
    const requestSubmit = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit');
    render(
      <form aria-label="Löschen" onSubmit={(event) => confirmFormSubmission(event, 'Löschen?')}>
        <button type="submit">Löschen</button>
      </form>,
    );
    fireEvent.submit(screen.getByRole('form'));
    await screen.findByRole('dialog', { name: 'Bitte bestätigen' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it('fordert nach einem durch Validierung verhinderten Submit erneut die Bestätigung an', async () => {
    // Ein natives requestSubmit führt bei ungültigen Feldern keinen Submit-Handler aus.
    vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(() => {});
    render(
      <form aria-label="Änderung" onSubmit={(event) => confirmFormSubmission(event, 'Übernehmen?')}>
        <button type="submit">Ausführen</button>
      </form>,
    );
    const form = screen.getByRole('form');
    expect(fireEvent.submit(form)).toBe(false);
    await screen.findByRole('dialog');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fireEvent.submit(form)).toBe(false);
    await screen.findByRole('dialog');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' })));
  });
});
