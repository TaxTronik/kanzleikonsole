// Fachkatalog: ACCESS-SEARCH-SCOPE-001
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ClientCombobox } from '../client-combobox';
import {
  ClientPickerFetchError,
  clientComboboxStatus,
  clientComboboxValidity,
  clientOptionDetail,
  clientPickerErrorMessage,
  comboboxKeyAction,
  fetchClientPickerResult,
  handleComboboxKeyDown,
  isClientOptionSelectable,
  parseClientPickerResult,
} from '../client-combobox-model';
import type { ClientPickerOption } from '@/lib/client-picker';

const option = (patch: Partial<ClientPickerOption> = {}): ClientPickerOption => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Muster GmbH',
  datevNo: '1001',
  addisonNo: null,
  allowActive: true,
  mandateEnded: false,
  ...patch,
});

function tag(html: string, pattern: RegExp): string {
  const match = html.match(pattern)?.[0];
  expect(match, `kein Treffer für ${pattern}`).toBeDefined();
  return match!;
}

describe('ClientCombobox — Tastaturmodell (WAI-ARIA Combobox mit Listbox)', () => {
  const state = (open: boolean, active: number, selectable: boolean[]) => ({
    open,
    active,
    selectable,
  });

  it('öffnet die geschlossene Liste mit Pfeil ab/auf, ignoriert sonst Tasten', () => {
    expect(comboboxKeyAction('ArrowDown', state(false, -1, []))).toEqual({ type: 'open' });
    expect(comboboxKeyAction('ArrowUp', state(false, -1, []))).toEqual({ type: 'open' });
    expect(comboboxKeyAction('Enter', state(false, -1, [true]))).toEqual({ type: 'none' });
    expect(comboboxKeyAction('Escape', state(false, -1, [true]))).toEqual({ type: 'none' });
    expect(comboboxKeyAction('a', state(false, -1, [true]))).toEqual({ type: 'none' });
  });

  it('bewegt die aktive Option begrenzt und springt mit Pos1/Ende', () => {
    const three = [true, false, true];
    expect(comboboxKeyAction('ArrowDown', state(true, -1, three))).toEqual({
      type: 'move',
      index: 0,
    });
    expect(comboboxKeyAction('ArrowDown', state(true, 0, three))).toEqual({
      type: 'move',
      index: 1,
    });
    expect(comboboxKeyAction('ArrowDown', state(true, 2, three))).toEqual({
      type: 'move',
      index: 2,
    });
    expect(comboboxKeyAction('ArrowUp', state(true, -1, three))).toEqual({
      type: 'move',
      index: 2,
    });
    expect(comboboxKeyAction('ArrowUp', state(true, 0, three))).toEqual({ type: 'move', index: 0 });
    expect(comboboxKeyAction('Home', state(true, 2, three))).toEqual({ type: 'move', index: 0 });
    expect(comboboxKeyAction('End', state(true, 0, three))).toEqual({ type: 'move', index: 2 });
    expect(comboboxKeyAction('ArrowDown', state(true, -1, []))).toEqual({ type: 'none' });
  });

  it('wählt mit Enter nur eine aktive, auswählbare Option', () => {
    expect(comboboxKeyAction('Enter', state(true, 0, [true]))).toEqual({
      type: 'select',
      index: 0,
    });
    // GwG-offener Mandant ist navigierbar (aria-disabled), aber nicht wählbar.
    expect(comboboxKeyAction('Enter', state(true, 1, [true, false]))).toEqual({ type: 'none' });
    expect(comboboxKeyAction('Enter', state(true, -1, [true]))).toEqual({ type: 'none' });
  });

  it('schließt die Liste mit Escape und Tab', () => {
    expect(comboboxKeyAction('Escape', state(true, 0, [true]))).toEqual({ type: 'close' });
    expect(comboboxKeyAction('Tab', state(true, 0, [true]))).toEqual({ type: 'close' });
  });

  it('macht nicht freigegebene Mandanten je nach Auswahlregel wählbar oder nur sichtbar', () => {
    expect(isClientOptionSelectable(option({ allowActive: false }), 'selectable')).toBe(true);
    expect(isClientOptionSelectable(option({ allowActive: false }), 'disabled')).toBe(false);
    expect(isClientOptionSelectable(option(), 'disabled')).toBe(true);
    expect(clientOptionDetail(option({ addisonNo: 'A7' }))).toBe('DATEV 1001 · Addison A7');
    expect(clientOptionDetail({ id: 'x', name: 'Ohne Nummern' })).toBe('');
  });
});

describe('ClientCombobox — Tastatur-Handler am Eingabefeld', () => {
  function press(
    key: string,
    state: { open: boolean; active: number; selectable: boolean[] },
    blockEnterSubmit = false,
  ) {
    const event = { key, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    const effects = { open: vi.fn(), close: vi.fn(), move: vi.fn(), choose: vi.fn() };
    handleComboboxKeyDown(event, state, effects, blockEnterSubmit);
    return { event, effects };
  }

  it('öffnet mit Pfeil ab ohne Cursorsprung und navigiert in der offenen Liste', () => {
    const opened = press('ArrowDown', { open: false, active: -1, selectable: [] });
    expect(opened.effects.open).toHaveBeenCalledOnce();
    expect(opened.event.preventDefault).toHaveBeenCalledOnce();
    const moved = press('ArrowDown', { open: true, active: 0, selectable: [true, true] });
    expect(moved.effects.move).toHaveBeenCalledWith(1);
    expect(moved.event.preventDefault).toHaveBeenCalledOnce();
  });

  it('übernimmt mit Enter die aktive Option statt das Formular abzusenden', () => {
    const { event, effects } = press('Enter', { open: true, active: 1, selectable: [true, true] });
    expect(effects.choose).toHaveBeenCalledWith(1);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('lässt Enter ohne aktive Option zum Formular durch, außer bei Hilfsauswahlen', () => {
    const normal = press('Enter', { open: false, active: -1, selectable: [] });
    expect(normal.event.preventDefault).not.toHaveBeenCalled();
    expect(normal.effects.choose).not.toHaveBeenCalled();
    const helper = press('Enter', { open: false, active: -1, selectable: [] }, true);
    expect(helper.event.preventDefault).toHaveBeenCalledOnce();
  });

  it('schließt mit Escape nur die Liste, nicht den umgebenden Dialog', () => {
    const { event, effects } = press('Escape', { open: true, active: 0, selectable: [true] });
    expect(effects.close).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    // Geschlossene Liste: Escape gehört dem Dialog.
    const closed = press('Escape', { open: false, active: -1, selectable: [] });
    expect(closed.event.stopPropagation).not.toHaveBeenCalled();
    expect(closed.effects.close).not.toHaveBeenCalled();
  });

  it('schließt mit Tab ohne den Fokuswechsel zu blockieren', () => {
    const { event, effects } = press('Tab', { open: true, active: 0, selectable: [true] });
    expect(effects.close).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe('ClientCombobox — Formularvalidierung und Statusansage', () => {
  it('blockiert getippten Text ohne Auswahl und verlangt bei Pflicht eine Auswahl', () => {
    expect(clientComboboxValidity({ required: false, selected: null, query: '' })).toBe('');
    expect(clientComboboxValidity({ required: false, selected: null, query: 'Mül' })).toBe(
      'Bitte einen Mandanten aus der Liste auswählen.',
    );
    expect(clientComboboxValidity({ required: true, selected: null, query: '' })).toBe(
      'Bitte einen Mandanten auswählen.',
    );
    expect(
      clientComboboxValidity({ required: true, selected: option(), query: 'Muster GmbH' }),
    ).toBe('');
  });

  it('kündigt Laden, Treffer, Begrenzung, leere Zuordnungen und Fehler an', () => {
    const base = { open: true, loading: false, error: null };
    expect(clientComboboxStatus({ ...base, open: false, result: null })).toBe('');
    expect(clientComboboxStatus({ ...base, loading: true, result: null })).toBe(
      'Mandanten werden gesucht.',
    );
    expect(
      clientComboboxStatus({
        ...base,
        result: { clients: [option()], limited: true, mode: 'search' },
      }),
    ).toBe('1 Mandant gefunden. Weitere Treffer – Suchbegriff bitte genauer eingeben.');
    expect(
      clientComboboxStatus({ ...base, result: { clients: [], limited: false, mode: 'search' } }),
    ).toBe('Kein zugänglicher Mandant gefunden.');
    expect(
      clientComboboxStatus({ ...base, result: { clients: [], limited: false, mode: 'assigned' } }),
    ).toBe('Keine zugeordneten Mandanten. Bitte Name, DATEV- oder Addison-Nr. eingeben.');
    expect(clientComboboxStatus({ ...base, error: 'kaputt', result: null })).toBe('kaputt');
  });
});

describe('ClientCombobox — Serveranfrage', () => {
  const ok = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  it('fragt ohne Cache mit Abbruchsignal ab und prüft die Antwortform', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () =>
      ok({ clients: [option()], limited: false, mode: 'assigned' }),
    );
    const result = await fetchClientPickerResult(
      '/api/staff/clients/search?filter=active',
      controller.signal,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ clients: [option()], limited: false, mode: 'assigned' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/staff/clients/search?filter=active', {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  });

  it('meldet Drosselung, Serverfehler und ungültige Antworten verständlich', async () => {
    const signal = new AbortController().signal;
    const respond = (status: number) =>
      vi.fn(async () => ({ ok: false, status }) as Response) as unknown as typeof fetch;
    await expect(fetchClientPickerResult('/x', signal, respond(429))).rejects.toThrow(
      'Zu viele Suchanfragen. Bitte kurz warten.',
    );
    await expect(fetchClientPickerResult('/x', signal, respond(500))).rejects.toThrow(
      'Mandantensuche fehlgeschlagen. Bitte erneut versuchen.',
    );
    expect(() => parseClientPickerResult({ clients: [{ id: 1 }] })).toThrow(ClientPickerFetchError);
    expect(clientPickerErrorMessage(new TypeError('Failed to fetch'))).toBe(
      'Mandantensuche nicht erreichbar. Bitte Verbindung prüfen.',
    );
  });
});

describe('ClientCombobox — Formularvertrag (Server-Rendering)', () => {
  it('schreibt die Auswahl in ein verstecktes Feld mit dem bisherigen Namen', () => {
    const html = renderToStaticMarkup(
      <form>
        <label htmlFor="appointment-client">Mandant</label>
        <ClientCombobox id="appointment-client" name="clientId" />
      </form>,
    );
    const hidden = tag(html, /<input[^>]*type="hidden"[^>]*>/);
    expect(hidden).toContain('name="clientId"');
    expect(hidden).toContain('value=""');
    const input = tag(html, /<input[^>]*role="combobox"[^>]*>/);
    expect(input).toContain('id="appointment-client"');
    expect(input).not.toContain('name=');
    expect(input).toContain('aria-autocomplete="list"');
    expect(input).toContain('aria-expanded="false"');
    expect(input).not.toContain('aria-controls=');
    expect(input).not.toContain('aria-activedescendant=');
    expect(html).not.toContain('role="listbox"');
    expect(html).toContain('role="status"');
  });

  it('zeigt eine Vorauswahl (ID + Name) für Bearbeiten- und Filterformulare', () => {
    const preselected = { id: '22222222-2222-4222-8222-222222222222', name: 'Vorauswahl KG' };
    for (const props of [{ defaultValue: preselected }, { value: preselected }]) {
      const html = renderToStaticMarkup(<ClientCombobox name="clientId" {...props} />);
      expect(tag(html, /<input[^>]*type="hidden"[^>]*>/)).toContain(`value="${preselected.id}"`);
      expect(tag(html, /<input[^>]*role="combobox"[^>]*>/)).toContain('value="Vorauswahl KG"');
      expect(html).toContain('aria-label="Auswahl Vorauswahl KG entfernen"');
    }
  });

  it('sperrt sichtbares und verstecktes Feld gemeinsam und reicht Pflicht/Fehler durch', () => {
    const html = renderToStaticMarkup(
      <ClientCombobox
        name="clientId"
        defaultValue={{ id: '33333333-3333-4333-8333-333333333333', name: 'Fest GmbH' }}
        disabled
        required
        aria-invalid
        aria-describedby="client-error"
      />,
    );
    expect(tag(html, /<input[^>]*type="hidden"[^>]*>/)).toContain('disabled=""');
    const input = tag(html, /<input[^>]*role="combobox"[^>]*>/);
    expect(input).toContain('disabled=""');
    expect(input).toContain('required=""');
    expect(input).toContain('aria-invalid="true"');
    expect(input).toMatch(/aria-describedby="[^"]*-status client-error"/);
    // Gesperrt: keine Entfernen-Schaltfläche.
    expect(html).not.toContain('entfernen');
  });

  it('rendert ohne `name` kein verstecktes Feld (kontrollierte Formulare)', () => {
    const html = renderToStaticMarkup(
      <ClientCombobox aria-label="Bestehenden Mandanten verknüpfen" value={null} />,
    );
    expect(html).not.toContain('type="hidden"');
    expect(tag(html, /<input[^>]*role="combobox"[^>]*>/)).toContain(
      'aria-label="Bestehenden Mandanten verknüpfen"',
    );
  });
});
