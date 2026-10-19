// @vitest-environment jsdom
// TCMS Stufe 3, Bereich A: Einrichtungsassistent als Render-Test mit der
// Antwort des Dienstes (Entwurf nach Schritt 4, Demo-Mandant Bergkamm). Die
// Seiten-Helfer sind gemockt; ihre Prüfkette testet
// server/tcms/__tests__/seite.test.ts. Geprüft wird, was die Seite aus der
// Antwort macht: Plan und offene Punkte nur aus dem Dienst, Personen nur aus
// der kanzleikonsole bzw. den Rollen des Mandanten, Schreibrecht laut Dienst.
// Fachkatalog: TCMS-DIENST-001
import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  seite: vi.fn(),
  lesen: vi.fn(),
  lesenOptional: vi.fn(),
  namen: vi.fn(),
  tenantLesen: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: () => {
    throw new Error('NEXT_REDIRECT');
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/server/tcms/seite', () => ({
  tcmsMandantSeite: h.seite,
  tcmsLesen: h.lesen,
  tcmsLesenOptional: h.lesenOptional,
  tcmsNamenLesen: h.namen,
  tcmsTenantLesen: h.tenantLesen,
}));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { renderServer } from '@/__tests__/render-helpers';
import { KEINE_PERSON, UNBEKANNTE_PERSON } from '@/server/tcms/namen';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import TcmsEinrichtungPage from '../page';

const LEA = 'b1000000-0000-4000-8000-000000000051';
const NILS = 'b1000000-0000-4000-8000-000000000052';
const FREMD = 'b1000000-0000-4000-8000-0000000000ff';
const BASIS = `/staff/clients/${DEMO.bergkamm}/tcms`;
const seiteMit = (roles: string[] = ['EMPLOYEE']) => ({
  ok: true,
  art: 'MANDANT',
  session: { user: { tenantId: DEMO.tenant, staffId: DEMO.anna, roles } },
  akteur: {},
  mandantId: DEMO.bergkamm,
  mandant: { id: DEMO.bergkamm, name: 'Bergkamm Sport GmbH', datevNo: null },
  basis: BASIS,
});
const NAMEN: Record<string, string> = {
  [DEMO.anna]: 'StB Dr. Anna Roth',
  [LEA]: 'Lea Berg',
  [NILS]: 'Nils Ohm',
};
const ZUST = {
  berufstraeger: { id: DEMO.anna, name: 'StB Dr. Anna Roth' },
  bearbeitung: { id: DEMO.leon, name: 'Leon Brandt' },
  kanzlei: [
    { id: DEMO.leon, name: 'Leon Brandt' },
    { id: DEMO.anna, name: 'StB Dr. Anna Roth' },
    { id: DEMO.thomas, name: 'Thomas Kühn' },
  ],
  vertretung: { id: DEMO.thomas, name: 'Thomas Kühn' },
};

function antwort(e = tcmsFixtures.einrichtungBergkamm()) {
  h.lesenOptional.mockResolvedValue({ ok: true, daten: e, requestId: 'r' });
  return e;
}

async function rendern(sp: Record<string, string> = {}) {
  return renderServer(
    TcmsEinrichtungPage({
      params: Promise.resolve({ id: DEMO.bergkamm }),
      searchParams: Promise.resolve(sp),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.seite.mockResolvedValue(seiteMit());
  h.tenantLesen.mockResolvedValue(ZUST);
  h.lesen.mockResolvedValue({ ok: true, daten: tcmsFixtures.kontakteBergkamm(), requestId: 'r' });
  h.namen.mockImplementation(async () => ({
    name: (id: string | null) => (id ? (NAMEN[id] ?? UNBEKANNTE_PERSON) : KEINE_PERSON),
    bekannt: (id: string | null) => !!id && id in NAMEN,
  }));
});

describe('Einrichtungsassistent', () => {
  it('liest mit der Zuständigkeit der kanzleikonsole und öffnet den nächsten offenen Schritt', async () => {
    antwort();
    const { container } = await rendern();
    expect(h.lesenOptional).toHaveBeenCalledWith(
      expect.objectContaining({ mandantId: DEMO.bergkamm }),
      expect.objectContaining({ name: 'einrichtungLesen' }),
      {
        query: {
          berufstraegerId: DEMO.anna,
          bearbeitungId: DEMO.leon,
          vertretungId: DEMO.thomas,
        },
      },
    );
    const leiste = screen.getByRole('navigation', { name: 'Schritte des Einrichtungsassistenten' });
    expect(within(leiste).getAllByRole('link')).toHaveLength(4);
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(
      '5 Kontrollvorschlag',
    );
    const offen = screen.getByRole('region', { name: 'Kontrollvorschlag' });
    expect(within(offen).getByText('Schritt 5 von 5')).toBeTruthy();
    // Zuständigkeiten: Kanzleipersonen aus der kanzleikonsole, Mandant nur Kontakte mit Rolle.
    const durch = within(offen).getByRole('combobox', { name: 'Durchführend K-EC-09' });
    expect([...durch.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Lea Berg',
      'Nils Ohm',
    ]);
    const kanzlei = within(offen).getByRole('combobox', { name: 'Durchführend K-EC-03' });
    expect([...kanzlei.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Leon Brandt',
      'StB Dr. Anna Roth',
      'Thomas Kühn',
    ]);
    expect(
      within(offen).getByRole('combobox', {
        name: 'Gegenzeichnung K-EC-04 (Pflicht bei Schlüsselkontrolle)',
      }),
    ).toBeTruthy();
    // Prüflast und Durchführungen aus dem Plan des Dienstes.
    const geplant = within(offen).getByText('Durchführungen im Wirksamkeitszeitraum geplant');
    expect(geplant.previousElementSibling?.textContent).toBe('62');
    expect(within(offen).getByRole('button', { name: /Tax-CMS Version 1 anlegen/ })).toBeTruthy();
    // Erledigte Schritte als Kurzfassung mit Werten des Dienstes.
    const risiken = screen.getByRole('region', { name: /4 · Risikovorschlag/ });
    expect(risiken.textContent).toContain('11 übernommen');
    expect(risiken.textContent).toContain('1 begründet abgelehnt');
    const ziele = screen.getByRole('region', { name: /3 · Compliance-Ziele/ });
    expect(ziele.textContent).toContain('Freigabe bei Lea Berg anfordern');
    // Ansprechpersonen des Mandanten aus den Rollen, Katalog nur für Admin.
    expect(container.textContent).toContain('Lea Berg (Geschäftsführerin)');
    expect(screen.queryByRole('link', { name: 'Katalog des Pakets ansehen' })).toBeNull();
  });

  it('Schritt aus der Adresse nur bis zum erreichbaren; Schritt 1 mit beschrifteter Paketvorlage', async () => {
    const e = antwort();
    e.entwurf!.abgeschlossen = 0;
    const { container } = await rendern({ schritt: '4' });
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(
      '1 Teilbereich',
    );
    expect(screen.getByRole('radio', { name: /Umsatzsteuer & Erlös-Datenkette/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Organschaft \(geplant\)/ })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: /Zurück/ })).toHaveProperty('disabled', true);
    // Spätere Schritte ohne Link.
    expect(
      screen.getByRole('region', { name: /5 · Kontrollvorschlag/ }).querySelector('a'),
    ).toBeNull();
  });

  it.each(['0', '-1', 'abc', '2.5', '99'])(
    'ungültiger Schritt „%s“: nächster offener',
    async (s) => {
      antwort();
      const { container } = await rendern({ schritt: s });
      expect(container.querySelector('[aria-current="step"]')?.textContent).toContain('5');
    },
  );

  it('Profil: neue Monatsangaben nach „heute“ des Dienstes, nicht nach der Uhr des Web-Servers (TCMS s7)', async () => {
    const e = antwort();
    e.heute = '2027-03-05';
    await rendern({ schritt: '2' });
    const profil = screen.getByRole('region', { name: /Geschäftsprofil/ });
    fireEvent.click(within(profil).getByRole('button', { name: /Lager hinzufügen/ }));
    const n = within(profil).getAllByRole('combobox', { name: /^Lager \d+: Land$/ }).length;
    const beginn = within(profil).getByLabelText(`Lager ${n}: Beginn`) as HTMLInputElement;
    expect(beginn.value).toBe('2027-03');
  });

  it('zeigt die offenen Punkte des Dienstes zum geöffneten Schritt', async () => {
    const e = antwort();
    e.pruefung = [{ schritt: 3, fehler: ['Freigabe: Empfänger ist keine gesetzliche Vertretung'] }];
    await rendern({ schritt: '3' });
    const hinweis = screen.getByRole('note');
    expect(hinweis.textContent).toContain('Noch offen in diesem Schritt');
    expect(hinweis.textContent).toContain('Empfänger ist keine gesetzliche Vertretung');
    // Empfänger der Zielfreigabe: nur gesetzliche Vertretung laut Dienst UND Rolle des Mandanten.
    const gv = screen.getByRole('combobox', { name: 'Empfänger' });
    expect([...gv.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Bitte wählen …',
      'Lea Berg (gesetzliche Vertretung)',
    ]);
  });

  it('ohne Schreibrecht des Dienstes: Hinweis, Formular gesperrt, keine Knöpfe aktiv', async () => {
    const e = antwort();
    e.darfBearbeiten = false;
    const { container } = await rendern();
    expect(container.textContent).toContain(TCMS_KEIN_RECHT.BEARBEITEN);
    const fs = container.querySelector('form fieldset') as HTMLFieldSetElement;
    expect(fs.disabled).toBe(true);
    for (const name of [/Entwurf speichern/, /Version 1 anlegen/]) {
      expect(screen.getByRole('button', { name })).toHaveProperty('disabled', true);
    }
  });

  it('vorbelegte Person ohne Zugriff bleibt sichtbar und markiert', async () => {
    const e = antwort();
    e.plan!.kontrollen.find((k) => k.code === 'K-EC-03')!.zust.durchfuehrendId = FREMD;
    await rendern();
    const sel = screen.getByRole('combobox', { name: 'Durchführend K-EC-03' }) as HTMLSelectElement;
    expect(sel.value).toBe(FREMD);
    expect(sel.selectedOptions[0]!.textContent).toBe('Person ohne Zugriff – bitte ändern');
  });

  it('Admin sieht den Verweis auf den Katalog', async () => {
    antwort();
    h.seite.mockResolvedValue(seiteMit(['ADMIN']));
    await rendern();
    expect(
      screen.getByRole('link', { name: 'Katalog des Pakets ansehen' }).getAttribute('href'),
    ).toBe('/staff/tcms/katalog');
  });

  it('eingerichtet: kein Assistent, Verweise in die Bereiche', async () => {
    antwort(tcmsFixtures.einrichtungTalwind());
    await rendern();
    expect(
      screen.getByText(/Das Tax-CMS ist eingerichtet – Version 1 vom 01\.03\.2026/),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Geschäftsprofil' }).getAttribute('href')).toBe(
      `${BASIS}/profil`,
    );
    expect(h.lesen).not.toHaveBeenCalled();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('Mandant nicht im Tax-CMS: Verweis auf das Cockpit, keine weiteren Abfragen', async () => {
    h.lesenOptional.mockResolvedValue({ ok: true, daten: null, requestId: null });
    await rendern();
    expect(screen.getByRole('link', { name: 'Zum Cockpit' }).getAttribute('href')).toBe(BASIS);
    expect(h.lesen).not.toHaveBeenCalled();
    expect(h.namen).not.toHaveBeenCalled();
  });

  it('Antwort ohne Entwurf/Plan: Störungszustand statt erratener Daten', async () => {
    const e = antwort();
    e.plan = null;
    await rendern();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('r');
  });

  it('Störung des Dienstes: Zustand mit requestId', async () => {
    h.lesenOptional.mockResolvedValue({
      ok: false,
      zustand: { art: 'NICHT_ERREICHBAR', requestId: 'req-7' },
    });
    await rendern();
    expect(screen.getByRole('heading', { name: 'Tax-CMS derzeit nicht erreichbar' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('req-7');
  });
});
