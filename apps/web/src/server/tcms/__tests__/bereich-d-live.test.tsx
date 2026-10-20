// =============================================================================
// TCMS Stufe 3, Bereich D: Ereigniseingang, Audit und Portal (Aufgabe, Meldung,
// Freigaben) gegen einen LAUFENDEN TCMS-Dienst mit Demo-Daten (Opt-in, nicht
// in CI – wie oberflaechen-live.test.tsx).
//
// Echt: Seiten- und Aktions-Helfer, Akteursabbildung, Namen und Personen gegen
// PostgreSQL (App-Rolle, RLS), signierter Transport, Dienst und Rendering.
// Ersetzt: nur die Request-Authentisierung (staffAuth/portalAuth liefern die
// geprüfte Sitzung), next/navigation, next/cache und das Schreib-Limit.
//
// Zustand im Dienst: Der Vier-Augen-Test stellt den Ausgangszustand wieder her
// (Antrag zurückgezogen); Code anfordern und ein Fehlversuch zählen im Dienst
// (neuer Code setzt die Versuche zurück); die Meldung legt je Lauf ein
// Ereignis an.
//
// Start (Dienst und Umgebung: docs/development/tcms-anbindung.md §6):
//   cd apps/web && TCMS_LIVE_TESTS=1 DB_TESTS=1 TCMS_DEPLOYMENT=external \
//     pnpm exec vitest run src/server/tcms/__tests__/bereich-d-live.test.tsx
// Fachkatalog: TCMS-DIENST-001
// =============================================================================
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { ReactNode } from 'react';
import { within } from '@testing-library/dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const sitzung = vi.hoisted(() => ({ staff: null as unknown, portal: null as unknown }));

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => sitzung.staff }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => sitzung.portal }));
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
vi.mock('@/server/rate-limit', async (original) => ({
  ...(await original<typeof import('@/server/rate-limit')>()),
  checkPortalWriteLimit: async () => ({ ok: true }),
}));

import type { PrismaClient } from '@taxtronik/db';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { DEMO } from '@/__tests__/tcms-fixtures';
import { renderServerMarkup } from '@/__tests__/render-helpers';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';
import { tcmsLesen, tcmsMandantSeite, tcmsPortalSeite } from '../seite';
import { TCMS_KEIN_RECHT } from '../zustand';
import { erwarteAnwendungsfehler } from '@taxtronik/db/testing/db-fehler';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string) => { window: { document: Document } };
};

const enabled =
  process.env.TCMS_LIVE_TESTS === '1' &&
  !!process.env.TCMS_URL &&
  (process.env.DB_TESTS === '1' || process.env.TCMS_BEREICH_D_DB_TEST === '1');

async function rendern(seite: ReactNode | Promise<ReactNode>) {
  const html = await renderServerMarkup(seite);
  const body = new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body;
  return { screen: within(body), container: body };
}

const ZEIT = 60_000;

(enabled ? describe : describe.skip)('Tax-CMS Bereich D gegen den laufenden Dienst', () => {
  // Owner-Client aus @taxtronik/db (prisma-client-guard), erst im beforeAll
  // geladen, damit eine übersprungene Suite keine Verbindung braucht.
  let owner!: PrismaClient;
  const inEinerStunde = () => new Date(Date.now() + 3_600_000).toISOString();

  const staffSitzung = (staffId: string, roles: string[]) => ({
    user: {
      id: staffId,
      email: `${staffId}@kanzlei-roth.example`,
      name: 'Kanzlei',
      fullName: 'Kanzlei',
      tenantId: DEMO.tenant,
      staffId,
      roles,
      permissions: [],
    },
    expires: inEinerStunde(),
  });
  const EMAIL: Record<string, string> = {
    [DEMO.jana]: 'jana.weller@talwind.example',
    [DEMO.murat]: 'murat@talwind.example',
  };
  const portalSitzung = (contactId: string) => ({
    user: {
      id: contactId,
      email: EMAIL[contactId]!,
      name: 'Kontakt',
      fullName: 'Kontakt',
      tenantId: DEMO.tenant,
      contactId,
      clientId: DEMO.talwind,
      sessionIssuedAt: 0,
      sessionOriginContactId: contactId,
    },
    expires: inEinerStunde(),
  });

  beforeAll(async () => {
    ({ prismaOwner: owner } = await import('@taxtronik/db'));
    await owner.tenant.deleteMany({ where: { id: DEMO.tenant } });
    await owner.tenant.create({
      data: { id: DEMO.tenant, slug: `tcms-demo-d-${randomUUID()}`, name: 'Kanzlei Roth (Demo)' },
    });
    const person = (id: string, fullName: string, role: string) =>
      owner.staffUser.create({
        data: {
          id,
          tenantId: DEMO.tenant,
          email: `${id}@kanzlei-roth.example`,
          fullName,
          passwordHash: 'synthetic',
          isProfessional: role === 'ADMIN',
          roles: { create: [{ role: role as never }] },
        },
      });
    await person(DEMO.anna, 'StB Dr. Anna Roth', 'ADMIN');
    await person(DEMO.leon, 'Leon Brandt', 'EMPLOYEE');
    await person(DEMO.thomas, 'StB Thomas Kern', 'EMPLOYEE');
    const mandanten: Array<[string, string]> = [
      [DEMO.talwind, 'Talwind Outdoor GmbH'],
      [DEMO.seestern, 'Seestern Home & Living GmbH'],
      [DEMO.kleinwerk, 'Kleinwerk Manufaktur UG (haftungsbeschränkt)'],
      [DEMO.pixelhafen, 'Pixelhafen Electronics KG'],
      [DEMO.bergkamm, 'Bergkamm Kaffeerösterei GmbH'],
    ];
    for (const [id, name] of mandanten) {
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
      ],
    });
    await createVerifiedLegalEntityGwgFixture(owner as never, {
      tenantId: DEMO.tenant,
      clientId: DEMO.talwind,
      verifiedBy: DEMO.anna,
      registerNumber: `HRB-${randomUUID().slice(0, 8)}`,
    });
    await owner.client.update({ where: { id: DEMO.talwind }, data: { allowActive: true } });
    const kontakt = (id: string, fullName: string, email: string) =>
      owner.clientContact.create({
        data: { id, tenantId: DEMO.tenant, clientId: DEMO.talwind, fullName, email },
      });
    await kontakt(DEMO.jana, 'Jana Weller', EMAIL[DEMO.jana]!);
    await kontakt(DEMO.murat, 'Murat Yilmaz', EMAIL[DEMO.murat]!);
    await kontakt(DEMO.sabine, 'Sabine Berg', 'sabine@talwind.example');
    await owner.tenantSetting.create({
      data: { tenantId: DEMO.tenant, key: 'modules', value: { tcms: true } },
    });
  }, ZEIT);

  afterAll(async () => {
    try {
      await owner.tenant.deleteMany({ where: { id: DEMO.tenant } });
    } finally {
      await owner.$disconnect();
    }
  }, ZEIT);

  /** Ereignis-ID zur Vorgangsnummer aus der Liste des Dienstes. */
  async function ereignisId(nummer: string): Promise<string> {
    const seite = await tcmsMandantSeite(DEMO.talwind);
    if (!seite.ok) throw new Error(seite.zustand.art);
    const liste = await tcmsLesen(seite, ENDPUNKTE.ereignisseLesen);
    if (!liste.ok) throw new Error(liste.zustand.art);
    const e = liste.daten.ereignisse.find((x) => x.nummer === nummer);
    if (!e) throw new Error(`${nummer} fehlt`);
    return e.id;
  }

  it(
    'Ereigniseingang (Hauptbearbeitung): Liste, Triage und Namen der kanzleikonsole',
    async () => {
      sitzung.staff = staffSitzung(DEMO.leon, ['EMPLOYEE']);
      const { default: Seite } =
        await import('@/app/staff/(protected)/clients/[id]/tcms/ereignisse/page');
      const { screen, container } = await rendern(
        Seite({ params: Promise.resolve({ id: DEMO.talwind }), searchParams: Promise.resolve({}) }),
      );
      expect(screen.getByRole('heading', { level: 2, name: 'Ereigniseingang' })).toBeTruthy();
      expect(container.textContent).toContain('2026-T-0345');
      expect(container.textContent).toContain('Murat Yilmaz');
      expect(container.textContent).not.toContain('Unbekannte Person');
      expect(screen.getByRole('button', { name: 'In Prüfung nehmen' })).toBeTruthy();
    },
    ZEIT,
  );

  it(
    'Vier-Augen beim Verwerfen: Antragsteller kann nicht bestätigen; Zurückziehen stellt den Stand her',
    async () => {
      sitzung.staff = staffSitzung(DEMO.leon, ['EMPLOYEE']);
      const id = await ereignisId('2026-T-0342');
      const aktionen = await import('@/app/staff/(protected)/clients/[id]/tcms/ereignisse/actions');
      const begruendung = new FormData();
      begruendung.set(
        'begruendung',
        'Live-Test: Doppelte Meldung, wird gleich wieder zurückgezogen (Vier-Augen-Prüfung).',
      );
      expect(
        await aktionen.ereignisVerwerfenBeantragenAction(DEMO.talwind, id, null, begruendung),
      ).toMatchObject({ ok: true });
      try {
        const selbst = await aktionen.ereignisVerwerfenBestaetigenAction(
          DEMO.talwind,
          id,
          null,
          new FormData(),
        );
        expect(selbst).toMatchObject({ ok: false });
        expect(selbst.ok ? '' : selbst.error).toBe(TCMS_KEIN_RECHT.VIER_AUGEN);

        const { default: Seite } =
          await import('@/app/staff/(protected)/clients/[id]/tcms/ereignisse/page');
        const params = Promise.resolve({ id: DEMO.talwind });
        const eigen = await rendern(Seite({ params, searchParams: Promise.resolve({ e: id }) }));
        expect(eigen.screen.queryByRole('button', { name: 'Verwerfen bestätigen' })).toBeNull();
        expect(eigen.screen.getByRole('button', { name: 'Antrag zurückziehen' })).toBeTruthy();

        sitzung.staff = staffSitzung(DEMO.anna, ['ADMIN']);
        const andere = await rendern(Seite({ params, searchParams: Promise.resolve({ e: id }) }));
        expect(andere.screen.getByRole('button', { name: 'Verwerfen bestätigen' })).toBeTruthy();
      } finally {
        sitzung.staff = staffSitzung(DEMO.leon, ['EMPLOYEE']);
        expect(
          await aktionen.ereignisVerwerfenAblehnenAction(DEMO.talwind, id, null, new FormData()),
        ).toEqual({ ok: true, meldung: 'Antrag zurückgezogen.' });
      }
    },
    ZEIT,
  );

  it(
    'Audit: Liste und Kettenprüfung nur für Admins/Partner',
    async () => {
      sitzung.staff = staffSitzung(DEMO.anna, ['ADMIN']);
      const { default: Seite } = await import('@/app/staff/(protected)/tcms/audit/page');
      const { screen } = await rendern(Seite({ searchParams: Promise.resolve({}) }));
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
      const { auditPruefenAction } = await import('@/app/staff/(protected)/tcms/audit/actions');
      expect(await auditPruefenAction(null, new FormData())).toMatchObject({
        ok: true,
        meldung: expect.stringContaining('Hashkette intakt'),
      });
      // Gate der kanzleikonsole (nurAdmin) vor jedem Dienstaufruf.
      sitzung.staff = staffSitzung(DEMO.leon, ['EMPLOYEE']);
      expect(await auditPruefenAction(null, new FormData())).toEqual({
        ok: false,
        error: 'Nur ADMIN/PARTNER.',
      });
    },
    ZEIT,
  );

  it(
    'Portal-Aufgabe (durchführende Person): Mängel und Anlagen laut Dienst',
    async () => {
      sitzung.portal = portalSitzung(DEMO.murat);
      const seite = await tcmsPortalSeite();
      if (!seite.ok) throw new Error(seite.zustand.art);
      const u = await tcmsLesen(seite, ENDPUNKTE.portalUebersichtLesen);
      if (!u.ok) throw new Error(u.zustand.art);
      const aufgabe = u.daten.aufgaben.find((a) => a.code === 'K-EC-23' && a.eigene);
      expect(aufgabe).toBeTruthy();
      const { default: Seite } = await import('@/app/portal/(protected)/tcms/aufgaben/[id]/page');
      const { container } = await rendern(
        Seite({
          params: Promise.resolve({ id: aufgabe!.durchfuehrungId }),
          searchParams: Promise.resolve({}),
        }),
      );
      expect(container.textContent).toContain('Noch offen:');
      expect(container.textContent).toContain('Amazon_VAT_Transactions_Q3-2026.csv');
      expect(container.textContent).toContain('Murat Yilmaz');
    },
    ZEIT,
  );

  it(
    'Freigabe mit Code: anfordern, falscher Code → fester Text ohne Code',
    async () => {
      sitzung.portal = portalSitzung(DEMO.jana);
      const seite = await tcmsPortalSeite();
      if (!seite.ok) throw new Error(seite.zustand.art);
      const liste = await tcmsLesen(seite, ENDPUNKTE.portalFreigabenLesen);
      if (!liste.ok) throw new Error(liste.zustand.art);
      const f = liste.daten.freigaben.find((x) => x.brauchtCode && x.darfFreigeben);
      expect(f).toBeTruthy();
      const aktionen = await import('@/app/portal/(protected)/tcms/freigaben/actions');
      expect(
        await aktionen.portalFreigabeCodeAnfordernAction(f!.id, null, new FormData()),
      ).toMatchObject({ ok: true, meldung: expect.stringContaining('gültig bis') });

      const { default: Seite } = await import('@/app/portal/(protected)/tcms/freigaben/page');
      const nachher = await rendern(Seite({ searchParams: Promise.resolve({}) }));
      expect(nachher.screen.getByLabelText('Bestätigungscode (6 Ziffern)')).toBeTruthy();

      const code = new FormData();
      code.set('code', '000000');
      const r = await aktionen.portalFreigebenAction(f!.id, null, code);
      expect(r).toMatchObject({ ok: false, errorCode: 'VALIDATION_ERROR' });
      expect(r.ok ? '' : r.error).toMatch(/^Der Code stimmt nicht\. Noch \d+ Versuch/);
      expect(JSON.stringify(r)).not.toContain('000000');
    },
    ZEIT,
  );

  it(
    'Ereignis melden: Meldung mit Benachrichtigung der Hauptbearbeitung, Bestätigung mit Vorgangsnummer',
    async () => {
      sitzung.portal = portalSitzung(DEMO.jana);
      const { portalEreignisMeldenAction } =
        await import('@/app/portal/(protected)/tcms/ereignis/actions');
      const daten = new FormData();
      daten.set('typ', 'T-01');
      daten.set('titel', 'Live-Test: neuer Verkaufskanal');
      daten.set(
        'beschreibung',
        'Live-Test der kanzleikonsole: Start auf einem weiteren Marktplatz.',
      );
      daten.set('datum', '2026-12-01');
      daten.set('zusage', '1');
      let ziel = '';
      try {
        await portalEreignisMeldenAction(null, daten);
      } catch (e) {
        ziel = erwarteAnwendungsfehler(e, /^NEXT_REDIRECT:/).message;
      }
      const nummer = /^NEXT_REDIRECT:\/portal\/tcms\/ereignis\?gemeldet=(.+)$/.exec(ziel)?.[1];
      expect(nummer, ziel).toMatch(/^\d{4}-T-\d{4}$/);
      const { default: Seite } = await import('@/app/portal/(protected)/tcms/ereignis/page');
      const { container } = await rendern(
        Seite({ searchParams: Promise.resolve({ gemeldet: nummer! }) }),
      );
      expect(container.textContent).toContain(`Vorgangsnummer: ${nummer}`);
      expect(container.textContent).toContain('Leon Brandt');
    },
    ZEIT,
  );
});
