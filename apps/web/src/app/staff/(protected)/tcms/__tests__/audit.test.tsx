// @vitest-environment jsdom
// TCMS Stufe 3, Bereich D: Audit-Protokoll des Tax-CMS (/staff/tcms/audit).
// Schutzregeln:
//   - Nur Admins und Partner: Seite über tcmsAdminSeite, Kettenprüfung mit
//     `nurAdmin` und festem Text bei 403 des Dienstes (VERWALTUNG).
//   - Die Kette prüft nur der Dienst; die Aktion setzt eine abgebrochene
//     Prüfung mit `weiterAb` fort und rechnet nichts nach.
//   - Personen mit dem im Protokoll festgehaltenen Namen; Filter nur in
//     gültiger Form (sonst ohne Filter).
//   - kk-tcms-s11 Punkt 7 (TCMS s11): maskierte Einträge nur mit den Feldern
//     ihrer Variante – Akteursart als fester Text und „vertraulich“, kein Name,
//     kein Detail, kein Hash; Hashes `null` als „nicht angezeigt“ mit festem
//     Hinweis auf die Kettenprüfung.
// Fachkatalog: TCMS-DIENST-001
import { screen, within } from '@testing-library/react';
import { ENDPUNKTE, MAX_AUDIT_POS } from '@taxtronik/tcms-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  seite: vi.fn(),
  lesen: vi.fn(),
  mandanten: vi.fn(),
  spec: null as null | Record<string, unknown>,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/tcms/seite', () => ({
  tcmsAdminSeite: h.seite,
  tcmsLesen: h.lesen,
  tcmsTenantLesen: (_seite: unknown, f: (tx: unknown) => unknown) =>
    f({ client: { findMany: h.mandanten } }),
}));
vi.mock('@/server/tcms/aktion', () => ({
  tcmsKanzleiAktion: vi.fn(async (spec: Record<string, unknown>) => {
    h.spec = spec;
    return { ok: true };
  }),
}));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { renderServer } from '@/__tests__/render-helpers';
import {
  AUDIT_HASH_VERBORGEN,
  AUDIT_PRUEFUNG_BUDGET_MS,
  AUDIT_VERTRAULICH_HINWEIS,
} from '@/server/tcms/audit';
import { erwarteIsoliert, markiert } from '@/__tests__/tcms-isolation';
import { auditPruefenAction } from '../audit/actions';
import TcmsAuditPage from '../audit/page';

const SEITE = {
  ok: true,
  art: 'ADMIN',
  session: { user: { tenantId: DEMO.tenant, staffId: DEMO.anna } },
  akteur: {},
};

function seite(sp: Record<string, string> = {}) {
  return renderServer(TcmsAuditPage({ searchParams: Promise.resolve(sp) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.spec = null;
  h.seite.mockResolvedValue(SEITE);
  h.lesen.mockResolvedValue({ ok: true, daten: tcmsFixtures.auditAnna(), requestId: null });
  h.mandanten.mockResolvedValue([
    { id: DEMO.pixelhafen, name: 'Pixelhafen GmbH' },
    { id: DEMO.kleinwerk, name: 'Kleinwerk Manufaktur GmbH' },
  ]);
});

describe('Audit-Seite', () => {
  it('ohne Admin-Seite (Zustand): keine Liste, kein Dienstaufruf', async () => {
    h.seite.mockResolvedValue({ ok: false, zustand: { art: 'KEIN_ZUGRIFF', neuAnmelden: false } });
    await seite();
    expect(screen.getByRole('heading', { name: 'Kein Zugriff' })).toBeTruthy();
    expect(h.lesen).not.toHaveBeenCalled();
  });

  it('neueste zuerst, Name laut Protokoll, Mandant aus der kanzleikonsole, Blättern über `vor`', async () => {
    const daten = tcmsFixtures.auditAnna();
    await seite();
    expect(h.lesen).toHaveBeenCalledWith(SEITE, ENDPUNKTE.auditLesen, {
      query: { vor: String(MAX_AUDIT_POS), limit: '50' },
    });
    const zeilen = screen.getAllByRole('row').slice(1);
    expect(zeilen).toHaveLength(daten.eintraege.length);
    const erste = within(zeilen[0]!);
    const neuester = daten.eintraege[0]!;
    if (neuester.maskiert) throw new Error('Fixture: neuester Eintrag offen');
    expect(erste.getByText(neuester.actorName)).toBeTruthy();
    expect(erste.getByText('Pixelhafen GmbH')).toBeTruthy();
    expect(screen.getByRole('link', { name: /ältere/ }).getAttribute('href')).toBe(
      `/staff/tcms/audit?vor=${daten.weiter}`,
    );
    expect(screen.getByRole('button', { name: /Hashkette prüfen/ })).toBeTruthy();
  });

  it('Filter nur in gültiger Form an den Dienst', async () => {
    await seite({ mandant: 'kein-uuid', aktion: 'tcms.ereignis', vor: '27' });
    expect(h.lesen).toHaveBeenCalledWith(SEITE, ENDPUNKTE.auditLesen, {
      query: { aktion: 'tcms.ereignis', vor: '27', limit: '50' },
    });
    await seite({ mandant: DEMO.talwind.toUpperCase(), vor: '99999999999' });
    expect(h.lesen).toHaveBeenLastCalledWith(SEITE, ENDPUNKTE.auditLesen, {
      query: { mandantId: DEMO.talwind, vor: String(MAX_AUDIT_POS), limit: '50' },
    });
  });
});

describe('Audit-Seite – vertrauliche Feststellungen (TCMS s11)', () => {
  const vertraulich = () => tcmsFixtures.auditAnnaVertraulich();

  it('ohne maskierte Einträge und mit allen Hashes: kein Hinweis, Hash des Kettenendes', async () => {
    const daten = tcmsFixtures.auditAnna();
    await seite();
    expect(screen.queryByText(AUDIT_VERTRAULICH_HINWEIS)).toBeNull();
    expect(screen.queryByText(AUDIT_HASH_VERBORGEN)).toBeNull();
    expect(screen.getAllByText(daten.kopf!.hash!).length).toBeGreaterThan(0);
  });

  it('maskierter Eintrag: Akteursart und „vertraulich“, kein Name, kein Detail, kein Hash', async () => {
    const daten = vertraulich();
    const maskiert = daten.eintraege[0]!;
    expect(maskiert.maskiert).toBe(true);
    expect(maskiert.mandantId).toBe(DEMO.talwind);
    h.mandanten.mockResolvedValue([{ id: DEMO.talwind, name: 'Talwind Logistik GmbH' }]);
    h.lesen.mockResolvedValue({ ok: true, daten, requestId: null });
    const { container } = await seite();
    const zeilen = screen.getAllByRole('row').slice(1);
    expect(zeilen).toHaveLength(daten.eintraege.length);
    const erste = within(zeilen[0]!);
    expect(erste.getByText('Kanzleiperson')).toBeTruthy();
    expect(erste.getByText('vertraulich')).toBeTruthy();
    expect(erste.getByText(AUDIT_HASH_VERBORGEN)).toBeTruthy();
    expect(erste.getByText(maskiert.aktion)).toBeTruthy();
    expect(erste.getByText('Talwind Logistik GmbH')).toBeTruthy();
    // Kein Detail-Block in der maskierten Zeile, nur die Felder ihrer Variante.
    expect(zeilen[0]!.querySelector('[title^="{"]')).toBeNull();
    expect(zeilen[0]!.querySelectorAll('[title*="Vorgänger"]')).toHaveLength(0);
    // Offene Einträge nach der ersten maskierten Position: Name und Detail ja,
    // Hash „nicht angezeigt“.
    const zweite = within(zeilen[1]!);
    const offen = daten.eintraege[1]!;
    if (offen.maskiert) throw new Error('Fixture: zweiter Eintrag offen');
    expect(zweite.getByText(offen.actorName)).toBeTruthy();
    expect(zweite.getByText(AUDIT_HASH_VERBORGEN)).toBeTruthy();
    // Kettenende ohne Hash, Hinweis auf die Kettenprüfung.
    expect(screen.getByText(AUDIT_VERTRAULICH_HINWEIS)).toBeTruthy();
    expect(screen.getByText(/Kettenende #32/).textContent).toContain(AUDIT_HASH_VERBORGEN);
    expect(container.textContent).not.toMatch(/[0-9a-f]{64}/);
  });

  it('Akteursart MANDANT, SYSTEM und ohne Akteur als feste Texte', async () => {
    const daten = vertraulich();
    const m = daten.eintraege[0]!;
    if (!m.maskiert) throw new Error('Fixture: erster Eintrag maskiert');
    daten.eintraege = [
      { ...m, pos: 40, akteurArt: 'MANDANT' },
      { ...m, pos: 39, akteurArt: 'SYSTEM' },
      { ...m, pos: 38, akteurArt: null },
    ];
    h.lesen.mockResolvedValue({ ok: true, daten, requestId: null });
    await seite();
    const zeilen = screen.getAllByRole('row').slice(1);
    expect(within(zeilen[0]!).getByText('Mandantenkontakt')).toBeTruthy();
    expect(within(zeilen[1]!).getByText('System')).toBeTruthy();
    expect(within(zeilen[2]!).getByText('ohne Akteur')).toBeTruthy();
  });

  it('nur ein Hash des Kettenendes verborgen: Hinweis trotzdem', async () => {
    const daten = tcmsFixtures.auditAnna();
    daten.kopf = { ...daten.kopf!, hash: null };
    h.lesen.mockResolvedValue({ ok: true, daten, requestId: null });
    await seite();
    expect(screen.getByText(AUDIT_VERTRAULICH_HINWEIS)).toBeTruthy();
    expect(screen.getByText(/Kettenende #31/).textContent).toContain(AUDIT_HASH_VERBORGEN);
  });

  it('Vertrag (vendort): maskierter Eintrag mit Name, Detail oder Hash und Eintrag ohne `maskiert` werden abgewiesen', () => {
    const schema = ENDPUNKTE.auditLesen.antwortSchema;
    const daten = vertraulich();
    const m = daten.eintraege[0]!;
    for (const zusatz of [
      { actorName: 'StB Dr. Anna Roth' },
      { actorId: DEMO.anna },
      { detail: { vertraulich: true } },
      { hash: 'a'.repeat(64) },
    ]) {
      expect(schema.safeParse({ ...daten, eintraege: [{ ...m, ...zusatz }] }).success).toBe(false);
    }
    const { maskiert: _weg, ...ohne } = tcmsFixtures.auditAnna().eintraege[0]!;
    expect(schema.safeParse({ ...daten, eintraege: [ohne] }).success).toBe(false);
  });
});

describe('auditPruefenAction', () => {
  interface Spec {
    mandantId: string | null;
    nurAdmin?: boolean;
    keinRecht?: string;
    aufruf: (dienst: unknown) => Promise<unknown>;
  }
  function spec(): Spec {
    expect(h.spec).not.toBeNull();
    return h.spec as unknown as Spec;
  }

  it('nur Admin/Partner, kanzleiweit, fester Text bei fehlendem Verwaltungsrecht', async () => {
    await auditPruefenAction(null, new FormData());
    expect(spec().nurAdmin).toBe(true);
    expect(spec().mandantId).toBeNull();
    expect(spec().keinRecht).toBe('VERWALTUNG');
  });

  it('setzt eine abgebrochene Prüfung mit `weiterAb` fort, bis der Dienst ein Ergebnis meldet', async () => {
    await auditPruefenAction(null, new FormData());
    const antworten = [
      { status: 'ABGEBROCHEN', geprueft: 20, bruchBei: null, grund: null, weiterAb: 20 },
      { status: 'INTAKT', geprueft: 11, bruchBei: null, grund: null, weiterAb: null },
    ];
    const rufe = vi.fn(async () => ({ daten: antworten.shift(), requestId: 'r' }));
    const r = await spec().aufruf({ rufe });
    expect(rufe.mock.calls).toEqual([
      [ENDPUNKTE.auditPruefen, { body: {} }],
      [ENDPUNKTE.auditPruefen, { body: { ab: 20 } }],
    ]);
    expect(r).toEqual({ meldung: expect.stringContaining('31 Einträge geprüft') });
  });

  it('Hinweis RT3B: Gesamtzeitbudget – kein weiterer Aufruf, der das Budget überschreiten könnte', async () => {
    await auditPruefenAction(null, new FormData());
    let jetzt = Date.parse('2026-10-20T10:00:00Z');
    const uhr = vi.spyOn(Date, 'now').mockImplementation(() => jetzt);
    try {
      // Der Dienst bricht jede Prüfung „ab“ und braucht je Aufruf 9 s.
      const rufe = vi.fn(async () => {
        jetzt += 9_000;
        return {
          daten: { status: 'ABGEBROCHEN', geprueft: 1, bruchBei: null, grund: null, weiterAb: 1 },
          requestId: 'r',
        };
      });
      const r = (await spec().aufruf({ rufe })) as { warnung: string };
      // Start bei 0, 9, 18, 27, 36 s; ab 45 s passte ein weiterer Aufruf (10 s) nicht
      // mehr in 50 s.
      expect(rufe).toHaveBeenCalledTimes(5);
      expect(jetzt - Date.parse('2026-10-20T10:00:00Z')).toBeLessThanOrEqual(
        AUDIT_PRUEFUNG_BUDGET_MS,
      );
      expect(r.warnung).toBe('Prüfung nach 5 Einträgen nicht abgeschlossen. Bitte erneut starten.');
    } finally {
      uhr.mockRestore();
    }
  });

  it('gebrochene Kette (RT3): Position laut Dienst, Grund nur als fester Text, nie der Rohtext', async () => {
    const lauf = async (grund: string | null) => {
      h.spec = null;
      await auditPruefenAction(null, new FormData());
      const rufe = vi.fn(async () => ({
        daten: { status: 'GEBROCHEN', geprueft: 7, bruchBei: 8, grund, weiterAb: null },
        requestId: 'r',
      }));
      return (await spec().aufruf({ rufe })) as { warnung: string };
    };
    expect((await lauf('Inhalt wurde verändert')).warnung).toBe(
      'Hashkette gebrochen bei Eintrag #8: Der Inhalt des Eintrags wurde verändert. Einträge davor sind konsistent. Bitte den Betrieb informieren.',
    );
    expect((await lauf('Lücke in den Positionen')).warnung).toContain(
      'In der Nummerierung der Einträge fehlt ein Eintrag.',
    );
    // Unbekannter Text des Dienstes, Prototyp-Schlüssel und kein Grund: Rückfall.
    for (const grund of ['<b>Bitte rufen Sie 0800 … an</b>', 'constructor', '__proto__', null]) {
      const w = (await lauf(grund)).warnung;
      expect(w).toContain('#8: Prüfung fehlgeschlagen.');
      if (grund) expect(w).not.toContain(grund);
    }
  });
});

// kk-tcms-qual (s9-Rest): Einträge des Audit-Logs (Akteure, Objekte, Texte) mit
// Richtungsmarken bleiben isoliert.
describe('Audit-Seite – Richtungsisolation', () => {
  it('Einträge isoliert', async () => {
    h.lesen.mockResolvedValue({
      ok: true,
      daten: markiert(tcmsFixtures.auditAnna(), ENDPUNKTE.auditLesen.antwortSchema),
      requestId: null,
    });
    const { container } = await seite();
    erwarteIsoliert(container, 2);
  });

  it('maskierte Einträge isoliert', async () => {
    h.lesen.mockResolvedValue({
      ok: true,
      daten: markiert(tcmsFixtures.auditAnnaVertraulich(), ENDPUNKTE.auditLesen.antwortSchema),
      requestId: null,
    });
    const { container } = await seite();
    erwarteIsoliert(container, 2);
  });
});
