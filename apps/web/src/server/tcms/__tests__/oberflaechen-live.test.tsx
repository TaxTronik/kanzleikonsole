// =============================================================================
// TCMS Stufe 3: Cockpit, Kontakte & Rollen, Portfolio und Portal gegen einen
// LAUFENDEN TCMS-Dienst mit Demo-Daten (Opt-in, nicht in CI – wie der
// Vertragstest in packages/tcms-client).
//
// Echt: Seiten-Helfer, Akteursabbildung und Namensauflösung gegen PostgreSQL
// (App-Rolle, RLS), signierter Transport (@taxtronik/tcms-client), Dienst und
// Rendering. Ersetzt: nur die Request-Authentisierung (staffAuth/portalAuth
// liefern die geprüfte Sitzung), next/navigation und next/cache.
//
// Die kanzleikonsole-Testdatenbank erhält einen Tenant mit genau den UUIDs der
// TCMS-Demo (packages/db/seeds/demo.ts im TCMS-Repo): Kanzlei, Personen,
// Mandanten, Zuständigkeiten, Kontakte; der Tenant wird am Ende gelöscht.
//
// Start (Dienst und Umgebung: docs/development/tcms-anbindung.md §6):
//   cd apps/web && TCMS_LIVE_TESTS=1 DB_TESTS=1 TCMS_DEPLOYMENT=external \
//     TCMS_URL=… TCMS_SERVICE_TOKEN=… TCMS_ACTOR_PRIVATE_KEY=… TCMS_ACTOR_KEY_ID=… \
//     pnpm exec vitest run src/server/tcms/__tests__/oberflaechen-live.test.tsx
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

import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import { DEMO } from '@/__tests__/tcms-fixtures';
import { renderServerMarkup } from '@/__tests__/render-helpers';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

// jsdom (devDependency) ohne Typpaket; nur zum Auswerten des gerenderten HTML.
// Die Umgebung bleibt `node`: Prisma verträgt die jsdom-Umgebung von Vitest nicht.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string) => { window: { document: Document } };
};

const enabled =
  process.env.TCMS_LIVE_TESTS === '1' &&
  !!process.env.TCMS_URL &&
  (process.env.DB_TESTS === '1' || process.env.TCMS_SEITE_DB_TEST === '1');

/**
 * Rendert serverseitig (wie Next) und fragt das Ergebnis in einem eigenen
 * DOM ab. Die Suite läuft in Node, weil Prisma unter jsdom keine Byte-Arrays
 * (GwG-Fixture) annimmt.
 */
async function rendern(seite: ReactNode | Promise<ReactNode>) {
  const html = await renderServerMarkup(seite);
  const body = new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body;
  return { screen: within(body), container: body };
}

(enabled ? describe : describe.skip)('Tax-CMS-Oberflächen gegen den laufenden Dienst', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
  });
  const neuerMandant = randomUUID();
  const neuerKontakt = randomUUID();
  const inEinerStunde = () => new Date(Date.now() + 3_600_000).toISOString();

  const staffSitzung = (staffId: string, roles: string[]) => ({
    user: {
      id: staffId,
      email: 'anna.roth@kanzlei-roth.example',
      name: 'Anna',
      fullName: 'Anna',
      tenantId: DEMO.tenant,
      staffId,
      roles,
      permissions: [],
    },
    expires: inEinerStunde(),
  });

  beforeAll(async () => {
    await owner.tenant.deleteMany({ where: { id: DEMO.tenant } });
    await owner.tenant.create({
      data: { id: DEMO.tenant, slug: `tcms-demo-${randomUUID()}`, name: 'Kanzlei Roth (Demo)' },
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
    const mandanten: Array<[string, string]> = [
      [DEMO.talwind, 'Talwind Outdoor GmbH'],
      [DEMO.seestern, 'Seestern Home & Living GmbH'],
      [DEMO.kleinwerk, 'Kleinwerk Manufaktur UG (haftungsbeschränkt)'],
      [DEMO.pixelhafen, 'Pixelhafen Electronics KG'],
      [DEMO.bergkamm, 'Bergkamm Kaffeerösterei GmbH'],
      [neuerMandant, 'Neu Handel GmbH'],
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
        {
          tenantId: DEMO.tenant,
          clientId: DEMO.seestern,
          staffId: DEMO.thomas,
          role: 'BERUFSTRAEGER',
        },
      ],
    });
    // Portalzugang der gesetzlichen Vertretung: verifizierte GwG-Prüfung.
    await createVerifiedLegalEntityGwgFixture(owner as never, {
      tenantId: DEMO.tenant,
      clientId: DEMO.talwind,
      verifiedBy: DEMO.anna,
      registerNumber: `HRB-${randomUUID().slice(0, 8)}`,
    });
    await owner.client.update({ where: { id: DEMO.talwind }, data: { allowActive: true } });
    const kontakt = (id: string, clientId: string, fullName: string, email: string) =>
      owner.clientContact.create({
        data: { id, tenantId: DEMO.tenant, clientId, fullName, email },
      });
    await kontakt(DEMO.jana, DEMO.talwind, 'Jana Weller', 'jana.weller@talwind.example');
    await kontakt(DEMO.murat, DEMO.talwind, 'Murat Yilmaz', 'murat@talwind.example');
    await kontakt(DEMO.sabine, DEMO.talwind, 'Sabine Berg', 'sabine@talwind.example');
    await kontakt(neuerKontakt, neuerMandant, 'Nina Neu', 'nina@neu-handel.example');
    await owner.tenantSetting.create({
      data: { tenantId: DEMO.tenant, key: 'modules', value: { tcms: true } },
    });
    sitzung.staff = staffSitzung(DEMO.anna, ['ADMIN']);
    sitzung.portal = {
      user: {
        id: DEMO.jana,
        email: 'jana.weller@talwind.example',
        name: 'Jana Weller',
        fullName: 'Jana Weller',
        tenantId: DEMO.tenant,
        contactId: DEMO.jana,
        clientId: DEMO.talwind,
        sessionIssuedAt: 0,
        sessionOriginContactId: DEMO.jana,
      },
      expires: inEinerStunde(),
    };
  }, 60_000);

  afterAll(async () => {
    try {
      await owner.tenant.deleteMany({ where: { id: DEMO.tenant } });
    } finally {
      await owner.$disconnect();
    }
  }, 60_000);

  it('Cockpit: Kontext des Dienstes, Namen aus der kanzleikonsole', async () => {
    const { default: Seite } = await import('@/app/staff/(protected)/clients/[id]/tcms/page');
    const { screen, container } = await rendern(
      Seite({ params: Promise.resolve({ id: DEMO.talwind }), searchParams: Promise.resolve({}) }),
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Cockpit' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Sieben Grundelemente' })).toBeTruthy();
    expect(screen.getByRole('region', { name: /^Risiken – \d+ aktiv$/ })).toBeTruthy();
    const faellig = screen.getByRole('region', { name: 'Fällige Kontrollen' });
    const zustaendig = within(faellig)
      .getAllByRole('row')
      .slice(1)
      .map((zeile) => zeile.lastElementChild?.textContent);
    expect(zustaendig.length).toBeGreaterThan(0);
    // Jede zuständige Person der Demo ist in der kanzleikonsole bekannt.
    expect(zustaendig).not.toContain('Unbekannte Person');
    expect(container.textContent).toContain('Angemessenheit und Wirksamkeit');
  });

  it('Kontakte & Rollen: Kontakte der kanzleikonsole, Rollen des Dienstes', async () => {
    const { default: Seite } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/kontakte/page');
    const { screen } = await rendern(Seite({ params: Promise.resolve({ id: DEMO.talwind }) }));
    const zeilen = screen.getAllByRole('row').slice(1);
    const text = zeilen.map((z) => z.textContent ?? '');
    expect(text.find((t) => t.includes('Jana Weller'))).toContain('Gesetzliche Vertretung');
    expect(text.find((t) => t.includes('Murat Yilmaz'))).toContain('Tax-Compliance-Beauftragte');
    expect(text.find((t) => t.includes('Sabine Berg'))).toContain('Mitarbeitende');
  });

  it('Portfolio: Kennzahlen des Dienstes, Namen und Mandantenmenge der kanzleikonsole', async () => {
    const { default: Seite } = await import('@/app/staff/(protected)/tcms/page');
    const { screen } = await rendern(Seite({ searchParams: Promise.resolve({}) }));
    const zeilen = screen
      .getAllByRole('row')
      .slice(1)
      .map((z) => z.textContent ?? '');
    expect(zeilen).toHaveLength(6);
    expect(zeilen.find((t) => t.includes('Neu Handel GmbH'))).toContain(
      'nicht im Tax-CMS angelegt',
    );
    expect(zeilen.find((t) => t.includes('Talwind Outdoor GmbH'))).toContain('StB Dr. Anna Roth');
    expect(zeilen.find((t) => t.includes('Bergkamm'))).toContain('kein Tax-CMS eingerichtet');
  });

  it('Portal: Übersicht der gesetzlichen Vertretung', async () => {
    const { default: Seite } = await import('@/app/portal/(protected)/tcms/page');
    const { screen } = await rendern(Seite());
    expect(screen.getByRole('region', { name: 'Ihre Aufgaben' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Ereignis melden/ })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Letzte Meldungen' })).toBeTruthy();
  });

  it('Mandant anlegen und Kontaktrolle setzen über die Aktionen; fremde Kontakte abgewiesen', async () => {
    const { default: Cockpit } = await import('@/app/staff/(protected)/clients/[id]/tcms/page');
    const params = Promise.resolve({ id: neuerMandant });
    const vorher = await rendern(Cockpit({ params, searchParams: Promise.resolve({}) }));
    expect(vorher.screen.getByRole('button', { name: 'Mandant im Tax-CMS anlegen' })).toBeTruthy();

    const { mandantImTcmsAnlegenAction } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/actions');
    expect(await mandantImTcmsAnlegenAction(neuerMandant, null, new FormData())).toEqual({
      ok: true,
      angelegt: true,
      geaendert: true,
    });
    const nachher = await rendern(Cockpit({ params, searchParams: Promise.resolve({}) }));
    expect(
      nachher.screen.getByText('Für diesen Mandanten ist noch kein Tax-CMS eingerichtet.'),
    ).toBeTruthy();

    const { kontaktRollenSetzenAction } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/kontakte/actions');
    const formular = (kontaktId: string) => {
      const daten = new FormData();
      daten.set('kontaktId', kontaktId);
      daten.append('rollen', 'GESETZLICHER_VERTRETER');
      daten.set('funktion', 'Geschäftsführerin');
      return daten;
    };
    expect(await kontaktRollenSetzenAction(neuerMandant, null, formular(neuerKontakt))).toEqual({
      ok: true,
    });
    // Kontakt eines anderen Mandanten: abgewiesen, bevor das TCMS gefragt wird.
    expect(await kontaktRollenSetzenAction(neuerMandant, null, formular(DEMO.jana))).toMatchObject({
      ok: false,
      error: 'Der gewählte Kontakt gehört nicht zu diesem Mandanten.',
      fieldErrors: { kontaktId: ['Der gewählte Kontakt gehört nicht zu diesem Mandanten.'] },
    });
    const { default: Kontakte } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/kontakte/page');
    const kontakte = await rendern(Kontakte({ params }));
    expect(kontakte.screen.getAllByRole('row')[1]!.textContent).toContain('Gesetzliche Vertretung');
  });

  it('ohne Berechtigung im Dienst: feste Meldung (Mitarbeiter ohne Zuständigkeit legt nicht an)', async () => {
    const vorher = sitzung.staff;
    sitzung.staff = staffSitzung(DEMO.leon, ['EMPLOYEE']);
    try {
      const { mandantImTcmsAnlegenAction } =
        await import('@/app/staff/(protected)/clients/[id]/tcms/actions');
      const ergebnis = await mandantImTcmsAnlegenAction(DEMO.bergkamm, null, new FormData());
      expect(ergebnis).toEqual({
        ok: false,
        error:
          'Dieser Schritt ist Admins und Partnern sowie der zuständigen Berufsträgerin oder Hauptbearbeitung des Mandanten vorbehalten.',
        errorCode: 'FORBIDDEN',
      });
    } finally {
      sitzung.staff = vorher;
    }
  });
});
