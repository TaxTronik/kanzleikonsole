import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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

  it('löst die Action selbst aus, damit React die Eingaben bei Fehlern nicht zurücksetzt', () => {
    // React 19 setzt nach `<form action={fn}>` jedes unkontrollierte Feld zurück,
    // auch wenn die Action einen Fehler liefert. Der Submit-Handler verhindert
    // das native Absenden und dispatcht in einer Transition; zurückgesetzt wird
    // nur nach Erfolg.
    const source = readFileSync(new URL('../action-form.tsx', import.meta.url), 'utf8');

    expect(source).toContain('event.preventDefault();');
    expect(source).toContain('startTransition(() => formAction(formData));');
    expect(source).toContain('if (state?.ok) formRef.current?.reset();');
    expect(source).toContain('if (inFlight.current) return;');
  });
});
