// =============================================================================
// TCMS Stufe 3, Bereich B: Risikoinventar, Kontrollmatrix, Länder-Monitor,
// Kontrollkalender und Prüfungsvorbereitung gegen einen LAUFENDEN TCMS-Dienst
// mit Demo-Daten (Opt-in, nicht in CI – wie oberflaechen-live.test.tsx;
// Integration TCMS Stufe 3).
//
// Echt: Seiten- und Aktions-Helfer, Akteursabbildung, Namensauflösung gegen
// PostgreSQL (App-Rolle, RLS), signierter Transport, Dienst und Rendering.
// Ersetzt: nur die Request-Authentisierung, next/navigation und next/cache.
// Je Seite ein Rendering und – wo die Seite schreibt – eine Aktion:
//   - Risiken: Bewertung unverändert bestätigen (Anna); ohne Recht (Thomas)
//     die feste Meldung zum Grund des Dienstes;
//   - Kontrollen: Frequenzabweichung beantragen (Leon), selbst entscheiden
//     wird mit dem Vier-Augen-Grund abgewiesen, Anna lehnt ab – danach gilt
//     wieder die bisherige Frequenz;
//   - Länder: Stand eines Landes mit unveränderten Werten erfassen (neuer
//     Stand in der Historie, kein Ereignis).
// Objekt-IDs liest die Suite aus den Antworten des Dienstes (der Seed vergibt
// sie je Datenbank neu). Gleicher Demo-Tenant wie die anderen Live-Suiten:
// einzeln starten, nie parallel. Der Dienst behält neue Stände (Bestätigung,
// Antrag und Ablehnung, Länderstand); die Tests sind wiederholbar.
//
//   cd apps/web && TCMS_LIVE_TESTS=1 DB_TESTS=1 TCMS_DEPLOYMENT=external \
//     TCMS_URL=… TCMS_SERVICE_TOKEN=… TCMS_ACTOR_PRIVATE_KEY=… TCMS_ACTOR_KEY_ID=… \
//     pnpm exec vitest run src/server/tcms/__tests__/bereich-b-live.test.tsx
// Fachkatalog: TCMS-DIENST-001
// =============================================================================
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { ReactNode } from 'react';
import { within } from '@testing-library/dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const sitzung = vi.hoisted(() => ({ staff: null as unknown }));

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => sitzung.staff }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (ziel: string) => {
    throw new Error(`NEXT_REDIRECT:${ziel}`);
  },
  usePathname: () => '/staff/clients/x/tcms',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import type { z } from 'zod';
import type { PrismaClient } from '@taxtronik/db';
import { ENDPUNKTE, type Endpunkt } from '@taxtronik/tcms-contract';
import { DEMO } from '@/__tests__/tcms-fixtures';
import { renderServerMarkup } from '@/__tests__/render-helpers';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string) => { window: { document: Document } };
};

const enabled =
  process.env.TCMS_LIVE_TESTS === '1' &&
  !!process.env.TCMS_URL &&
  (process.env.DB_TESTS === '1' || process.env.TCMS_SEITE_DB_TEST === '1');

async function rendern(seite: ReactNode | Promise<ReactNode>) {
  const html = await renderServerMarkup(seite);
  const body = new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body;
  return { screen: within(body), container: body };
}

const BEGRUENDUNG = 'Live-Test Bereich B: Bewertung und Frequenz mit der Kanzlei abgestimmt.';

(enabled ? describe : describe.skip)('Bereich B gegen den laufenden Dienst', () => {
  // Freigegebener Owner-Client aus @taxtronik/db (prisma-client-guard) nur für
  // Fixtures und Aufräumen; Seiten und Aktionen lesen über withTenantContext.
  let owner!: PrismaClient;
  const inEinerStunde = () => new Date(Date.now() + 3_600_000).toISOString();
  const als = (staffId: string, roles: string[]) => {
    sitzung.staff = {
      user: {
        id: staffId,
        email: `${staffId}@kanzlei-roth.example`,
        name: 'Person',
        fullName: 'Person',
        tenantId: DEMO.tenant,
        staffId,
        roles,
        permissions: [],
      },
      expires: inEinerStunde(),
    };
  };
  const anna = () => als(DEMO.anna, ['ADMIN']);
  const leon = () => als(DEMO.leon, ['EMPLOYEE']);
  const thomas = () => als(DEMO.thomas, ['EMPLOYEE']);
  const params = Promise.resolve({ id: DEMO.talwind });
  const mit = (sp: Record<string, string> = {}) => ({
    params,
    searchParams: Promise.resolve(sp),
  });

  /** Antwort eines Lesepfads des Dienstes für Talwind als angemeldete Person. */
  async function lies<E extends Endpunkt>(endpunkt: E): Promise<z.output<E['antwortSchema']>> {
    const { tcmsLesen, tcmsMandantSeite } = await import('@/server/tcms/seite');
    const seite = await tcmsMandantSeite(DEMO.talwind);
    if (!seite.ok) throw new Error(`Seite: ${seite.zustand.art}`);
    const antwort = await tcmsLesen(seite, endpunkt);
    if (!antwort.ok) throw new Error(`${endpunkt.name}: ${antwort.zustand.art}`);
    return antwort.daten;
  }

  function formular(werte: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(werte)) fd.set(k, v);
    return fd;
  }

  beforeAll(async () => {
    ({ prismaOwner: owner } = await import('@taxtronik/db'));
    await owner.tenant.deleteMany({ where: { id: DEMO.tenant } });
    await owner.tenant.create({
      data: { id: DEMO.tenant, slug: `tcms-demo-b-${randomUUID()}`, name: 'Kanzlei Roth (Demo)' },
    });
    const person = (id: string, fullName: string, role: string, isProfessional: boolean) =>
      owner.staffUser.create({
        data: {
          id,
          tenantId: DEMO.tenant,
          email: `${id}@kanzlei-roth.example`,
          fullName,
          passwordHash: 'synthetic',
          isProfessional,
          roles: { create: [{ role: role as never }] },
        },
      });
    await person(DEMO.anna, 'StB Dr. Anna Roth', 'ADMIN', true);
    await person(DEMO.leon, 'Leon Brandt', 'EMPLOYEE', false);
    await person(DEMO.thomas, 'StB Thomas Kern', 'EMPLOYEE', true);
    for (const [id, name] of [
      [DEMO.talwind, 'Talwind Outdoor GmbH'],
      [DEMO.seestern, 'Seestern Home & Living GmbH'],
    ] as const) {
      await owner.client.create({ data: { id, tenantId: DEMO.tenant, kind: 'JURPERS', name } });
    }
    await owner.clientResponsibility.createMany({
      data: [
        {
          tenantId: DEMO.tenant,
          clientId: DEMO.talwind,
          staffId: DEMO.anna,
          role: 'BERUFSTRAEGER',
        },
        {
          tenantId: DEMO.tenant,
          clientId: DEMO.talwind,
          staffId: DEMO.leon,
          role: 'HAUPTBEARBEITER',
        },
        {
          tenantId: DEMO.tenant,
          clientId: DEMO.seestern,
          staffId: DEMO.thomas,
          role: 'BERUFSTRAEGER',
        },
      ],
    });
    await createVerifiedLegalEntityGwgFixture(owner as never, {
      tenantId: DEMO.tenant,
      clientId: DEMO.talwind,
      verifiedBy: DEMO.anna,
      registerNumber: `HRB-${randomUUID().slice(0, 8)}`,
    });
    await owner.client.update({ where: { id: DEMO.talwind }, data: { allowActive: true } });
    for (const [id, fullName] of [
      [DEMO.jana, 'Jana Weller'],
      [DEMO.murat, 'Murat Yilmaz'],
      [DEMO.sabine, 'Sabine Berg'],
    ] as const) {
      await owner.clientContact.create({
        data: {
          id,
          tenantId: DEMO.tenant,
          clientId: DEMO.talwind,
          fullName,
          email: `${id}@x.example`,
        },
      });
    }
    await owner.tenantSetting.create({
      data: { tenantId: DEMO.tenant, key: 'modules', value: { tcms: true } },
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await owner.tenant.deleteMany({ where: { id: DEMO.tenant } });
    } finally {
      await owner.$disconnect();
    }
  }, 60_000);

  it('Risiken: Inventar und Detail; Bewertung bestätigen, ohne Recht feste Meldung', async () => {
    anna();
    const liste = await lies(ENDPUNKTE.risikenLesen);
    const risiko = liste.risiken.find((r) => r.code === 'EC-UST-02');
    if (!risiko) throw new Error('EC-UST-02 fehlt in den Demo-Daten');
    const { default: Seite } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/risiken/page');
    const { screen, container } = await rendern(Seite(mit({ risiko: risiko.id })));
    expect(screen.getByRole('heading', { level: 2, name: 'Risikoinventar' })).toBeTruthy();
    // Erste Tabelle: das Inventar (der Detailbereich hat eigene Tabellen).
    const inventar = screen.getAllByRole('table')[0]!;
    expect(within(inventar).getAllByRole('row').length).toBeGreaterThan(5);
    expect(inventar.textContent).toContain('EC-UST-02');
    expect(screen.getByRole('region', { name: /^EC-UST-02 · / })).toBeTruthy();
    // Namen nur aus der kanzleikonsole, keine IDs im Text.
    expect(container.textContent).not.toContain(DEMO.anna);

    const aktionen = await import('@/app/staff/(protected)/clients/[id]/tcms/risiken/actions');
    const fd = () =>
      formular({ risikoId: risiko.id, standId: risiko.standId, begruendung: BEGRUENDUNG });
    thomas();
    expect(await aktionen.risikoBewertungBestaetigenAction(DEMO.talwind, null, fd())).toEqual({
      ok: false,
      error: TCMS_KEIN_RECHT.BEARBEITEN,
      errorCode: 'FORBIDDEN',
    });
    anna();
    const ergebnis = await aktionen.risikoBewertungBestaetigenAction(DEMO.talwind, null, fd());
    expect(ergebnis).toMatchObject({ ok: true });
    expect(ergebnis.meldung).toMatch(/^EC-UST-02: Bewertung unverändert bestätigt\./);
  });

  it('Kontrollen: Abweichung beantragen, Vier-Augen beim Entscheiden, Ablehnung stellt her', async () => {
    leon();
    const vorher = await lies(ENDPUNKTE.kontrollenLesen);
    const k = vorher.kontrollen.find(
      (x) => x.partei === 'KANZLEI' && x.abweichung === null && x.frequenz.turnus !== 'JAEHRLICH',
    );
    if (!k) throw new Error('Keine Kanzlei-Kontrolle ohne Abweichung in den Demo-Daten');
    const { default: Seite } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/kontrollen/page');
    const { screen } = await rendern(Seite(mit({ kontrolle: k.id })));
    expect(screen.getByRole('heading', { level: 2, name: 'Kontrollmatrix' })).toBeTruthy();
    expect(screen.getByRole('region', { name: new RegExp(`^${k.code} · `) })).toBeTruthy();

    const aktionen = await import('@/app/staff/(protected)/clients/[id]/tcms/kontrollen/actions');
    const beantragt = await aktionen.frequenzAbweichungBeantragenAction(
      DEMO.talwind,
      null,
      formular({
        kontrolleId: k.id,
        standId: k.standId,
        turnus: 'JAEHRLICH',
        begruendung: BEGRUENDUNG,
      }),
    );
    expect(beantragt).toMatchObject({ ok: true });
    expect(beantragt.meldung).toMatch(/^Frequenzabweichung beantragt \(jährlich\)/);
    try {
      const offen = (await lies(ENDPUNKTE.kontrollenLesen)).kontrollen.find((x) => x.id === k.id)!;
      expect(offen.abweichung).toMatchObject({
        frequenz: { turnus: 'JAEHRLICH' },
        beantragtVon: DEMO.leon,
      });
      const entscheiden = (entscheidung: string, standId: string) =>
        aktionen.frequenzAbweichungEntscheidenAction(
          DEMO.talwind,
          null,
          formular({ kontrolleId: k.id, standId, entscheidung, begruendung: BEGRUENDUNG }),
        );
      // Dieselbe Person darf nicht entscheiden: Grund VIER_AUGEN des Dienstes.
      expect(await entscheiden('FREIGEBEN', offen.standId)).toEqual({
        ok: false,
        error: TCMS_KEIN_RECHT.VIER_AUGEN,
        errorCode: 'FORBIDDEN',
      });
      anna();
      const abgelehnt = await entscheiden('ABLEHNEN', offen.standId);
      expect(abgelehnt).toMatchObject({ ok: true });
      expect(abgelehnt.meldung).toMatch(/^Frequenzabweichung abgelehnt\./);
    } finally {
      anna();
      const danach = (await lies(ENDPUNKTE.kontrollenLesen)).kontrollen.find((x) => x.id === k.id)!;
      expect(danach.frequenz).toEqual(k.frequenz);
    }
  });

  it('Länder: Monitor rendern, Stand mit unveränderten Werten erfassen (kein Ereignis)', async () => {
    anna();
    const ctx = await lies(ENDPUNKTE.kontextLesen);
    const land = ctx.laender[0];
    if (!land) throw new Error('Keine Länder in den Demo-Daten');
    const { default: Seite } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/laender/page');
    const { screen } = await rendern(Seite(mit({ land: land.land })));
    expect(screen.getByRole('table', { name: /^Länder im Monitor/ })).toBeTruthy();

    const aktionen = await import('@/app/staff/(protected)/clients/[id]/tcms/laender/actions');
    const werte: Record<string, string> = {
      datenstand: ctx.heute.slice(0, 10),
      land: land.land,
      fernverkaeufeLfdEur: String(land.fernverkaeufeLfdEur),
      fernverkaeufeVorjahrEur: String(land.fernverkaeufeVorjahrEur),
      lagerSeit: land.lagerSeit ?? '',
      steuersaetzeGeprueftAm: land.steuersaetzeGeprueftAm?.slice(0, 10) ?? '',
    };
    if (land.oss) werte['oss'] = 'on';
    if (land.lokaleUstNr) werte['lokaleUstNr'] = 'on';
    if (land.zmRelevant) werte['zmRelevant'] = 'on';
    expect(await aktionen.landStaendeSpeichernAction(DEMO.talwind, null, formular(werte))).toEqual({
      ok: true,
      meldung: `Neuer Stand für ${land.land} gespeichert; der bisherige Stand bleibt in der Historie.`,
    });
  });

  it('Kalender und Prüfungsvorbereitung: Antworten des Dienstes, Namen der kanzleikonsole', async () => {
    anna();
    const { default: Kalender } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/kalender/page');
    const kalender = await rendern(Kalender(mit()));
    expect(
      kalender.screen.getByRole('heading', { level: 2, name: 'Kontrollkalender' }),
    ).toBeTruthy();
    expect(
      kalender.screen.getByRole('table', {
        name: /^Durchführungen je Kontrolle und Fälligkeitsmonat/,
      }),
    ).toBeTruthy();

    const { default: Pruefung } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/pruefung/page');
    const pruefung = await rendern(Pruefung(mit()));
    expect(
      pruefung.screen.getByRole('heading', { level: 2, name: 'Prüfungsvorbereitung' }),
    ).toBeTruthy();
    expect(pruefung.screen.getByRole('region', { name: 'Prüfungsgegenstand' })).toBeTruthy();
    expect(pruefung.screen.getByRole('region', { name: 'Lückenanalyse' })).toBeTruthy();
    for (const c of [kalender.container, pruefung.container]) {
      expect(c.textContent).not.toContain(DEMO.leon);
    }
  });
});
