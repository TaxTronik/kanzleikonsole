// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ActionResult } from '@/server/actions/types';
import { ActionForm, ActionFormError } from '../action-form';

const noop = async () => ({ ok: true });

describe('ActionForm', () => {
  it('rendert Formularattribute und Felder ohne Fehlerblock', () => {
    const html = renderToStaticMarkup(
      <ActionForm action={noop} id="notice-form" className="card p-6">
        <input name="period" defaultValue="2025" />
      </ActionForm>,
    );

    expect(html).toContain('id="notice-form"');
    expect(html).toContain('class="card p-6"');
    expect(html).toContain('name="period"');
    expect(html).not.toContain('role="alert"');
  });

  it('zeigt Fehler als Zusammenfassung mit Feldverknüpfung', () => {
    const html = renderToStaticMarkup(
      <ActionFormError
        state={{
          ok: false,
          error: 'Bitte prüfen Sie die markierten Angaben.',
          fieldErrors: { period: ['Pflichtfeld'] },
        }}
        errorDisplay="summary"
        fieldIds={{ period: 'notice-period' }}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('Bitte prüfen Sie Ihre Angaben.');
    expect(html).toContain('href="#notice-period"');
    expect(html).toContain('Pflichtfeld');
  });

  it('zeigt Fachfehler ohne Feldbezug und kompakte Button-Fehler', () => {
    const summary = renderToStaticMarkup(
      <ActionFormError
        state={{ ok: false, error: 'Ausgangsdatum darf nicht in der Zukunft liegen.' }}
        errorDisplay="summary"
      />,
    );
    const inline = renderToStaticMarkup(
      <ActionFormError
        state={{ ok: false, error: 'Termin nicht gefunden.' }}
        errorDisplay="inline"
      />,
    );

    expect(summary).toContain('Ausgangsdatum darf nicht in der Zukunft liegen.');
    expect(inline).toMatch(/<p role="alert"[^>]*>Termin nicht gefunden\.<\/p>/);
    expect(
      renderToStaticMarkup(<ActionFormError state={{ ok: true }} errorDisplay="inline" />),
    ).toBe('');
    expect(renderToStaticMarkup(<ActionFormError state={null} errorDisplay="summary" />)).toBe('');
  });

  // React 19 setzt nach `<form action={fn}>` jedes unkontrollierte Feld zurück,
  // auch wenn die Action einen Fehler liefert. Der Submit-Handler verhindert
  // das native Absenden und dispatcht in einer Transition; zurückgesetzt wird
  // nur nach Erfolg.
  function deferred() {
    let resolve!: (result: ActionResult) => void;
    const promise = new Promise<ActionResult>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function renderForm(
    action: (prev: ActionResult | null, data: FormData) => Promise<ActionResult>,
  ) {
    render(
      <ActionForm action={action} aria-label="Bescheid">
        <label htmlFor="period">Zeitraum</label>
        <input id="period" name="period" defaultValue="2025" />
        <button type="submit">Speichern</button>
      </ActionForm>,
    );
    return {
      form: screen.getByRole('form', { name: 'Bescheid' }),
      field: screen.getByLabelText<HTMLInputElement>('Zeitraum'),
    };
  }

  it('verhindert das native Absenden und übergibt die Eingaben in einer Transition', async () => {
    const pending = deferred();
    const action = vi.fn((_prev: ActionResult | null, _data: FormData) => pending.promise);
    const { form, field } = renderForm(action);
    fireEvent.change(field, { target: { value: '2026' } });

    // fireEvent liefert false, wenn der Handler preventDefault() aufgerufen hat.
    expect(fireEvent.submit(form)).toBe(false);
    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(action.mock.calls[0]![1].get('period')).toBe('2026');
    // Transition läuft: Formular meldet aria-busy, bis die Action antwortet.
    await waitFor(() => expect(form.getAttribute('aria-busy')).toBe('true'));
    await act(async () => pending.resolve({ ok: true }));
    await waitFor(() => expect(form.hasAttribute('aria-busy')).toBe(false));
  });

  it('behält die Eingaben bei einem Fehler und setzt sie erst nach Erfolg zurück', async () => {
    const action = vi
      .fn<(prev: ActionResult | null, data: FormData) => Promise<ActionResult>>()
      .mockResolvedValueOnce({ ok: false, error: 'Zeitraum liegt in der Zukunft.' })
      .mockResolvedValueOnce({ ok: true });
    const { form, field } = renderForm(action);

    fireEvent.change(field, { target: { value: '2030' } });
    fireEvent.submit(form);
    expect(await screen.findByText('Zeitraum liegt in der Zukunft.')).toBeTruthy();
    expect(field.value).toBe('2030');

    fireEvent.submit(form);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(field.value).toBe('2025'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('wiederholt eine laufende Übermittlung nicht (Doppelklick)', async () => {
    const pending = deferred();
    const action = vi.fn((_prev: ActionResult | null, _data: FormData) => pending.promise);
    const { form } = renderForm(action);

    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(form.getAttribute('aria-busy')).toBe('true'));
    fireEvent.submit(form);
    expect(action).toHaveBeenCalledOnce();

    await act(async () => pending.resolve({ ok: true }));
    await waitFor(() => expect(form.hasAttribute('aria-busy')).toBe(false));
    fireEvent.submit(form);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
  });
});
