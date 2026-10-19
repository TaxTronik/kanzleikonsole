// =============================================================================
// TCMS Stufe 3, Bereich C: Durchführungen, Nachweise, Feststellungen und
// Arbeitskorb gegen einen LAUFENDEN TCMS-Dienst mit Demo-Daten (Opt-in, nicht
// in CI – wie oberflaechen-live.test.tsx).
//
// Echt: Seiten- und Aktions-Helfer, Akteursabbildung, Namensauflösung,
// Nachweis-Verknüpfung und Löschsperre gegen PostgreSQL (App-Rolle, RLS,
// Trigger), signierter Transport, Dienst und Rendering. Ersetzt: nur die
// Request-Authentisierung, next/navigation und next/cache. Ohne Object Store
// und Virenscanner: Hochladen ist hier nicht abgedeckt, der Abruf endet nach
// allen Prüfungen am Speicher („storage_unavailable“).
//
// Gleicher Tenant wie oberflaechen-live.test.tsx: beide Dateien einzeln
// starten, nicht parallel. Der Dienst behält Änderungen (Beginn von K-EC-06,
// §-153-Folgeentscheidung zu F-2026-007); die Tests sind wiederholbar.
//
//   cd apps/web && TCMS_LIVE_TESTS=1 DB_TESTS=1 TCMS_DEPLOYMENT=external \
//     TCMS_URL=… TCMS_SERVICE_TOKEN=… TCMS_ACTOR_PRIVATE_KEY=… TCMS_ACTOR_KEY_ID=… \
//     pnpm exec vitest run src/server/tcms/__tests__/bereich-c-live.test.tsx
// Fachkatalog: TCMS-NACHWEIS-001
// =============================================================================
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { ReactNode } from 'react';
import { within } from '@testing-library/dom';
import { NextRequest } from 'next/server';
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

import type { PrismaClient } from '@taxtronik/db';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
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

/** K-EC-06 September 2026 (Demo): fällig, durchführende Person Leon Brandt. */
const K_EC_06 = 'cmvf9pzzo0048fu7d8zdkiu4f';
const F_P153 = 'cmvf9q0c40082fu7dh1ef2q31';
const F_VERTRAULICH = 'cmvf9q0bi007xfu7dqkshgfrc';

(enabled ? describe : describe.skip)('Bereich C gegen den laufenden Dienst', () => {
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
  let dokumentId = '';

  /** Tenant entfernen; Abrufnachweise (audit_log, nur anhängend) vorher im Testlauf löschen. */
  async function aufraeumen() {
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRaw`DELETE FROM audit_log WHERE tenant_id = ${DEMO.tenant}::uuid`;
    });
    await owner.tenant.deleteMany({ where: { id: DEMO.tenant } });
  }

  beforeAll(async () => {
    ({ prismaOwner: owner } = await import('@taxtronik/db'));
    await aufraeumen();
    await owner.tenant.create({
      data: { id: DEMO.tenant, slug: `tcms-demo-c-${randomUUID()}`, name: 'Kanzlei Roth (Demo)' },
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
      [DEMO.kleinwerk, 'Kleinwerk Manufaktur UG (haftungsbeschränkt)'],
      [DEMO.pixelhafen, 'Pixelhafen Electronics KG'],
      [DEMO.bergkamm, 'Bergkamm Kaffeerösterei GmbH'],
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
    // Gespeichertes, sauber gescanntes Dokument des Mandanten (ohne Object Store).
    const typ = await owner.documentType.create({
      data: {
        tenantId: DEMO.tenant,
        name: 'Allgemein',
        tier: 'NONE',
        classificationKey: 'GENERAL',
      },
    });
    const doc = await owner.document.create({
      data: {
        tenantId: DEMO.tenant,
        clientId: DEMO.talwind,
        title: 'Lieferantenliste September',
        classification: 'GENERAL',
        documentTypeId: typ.id,
        mimeType: 'text/csv',
      },
    });
    await owner.documentVersion.create({
      data: {
        documentId: doc.id,
        versionNo: 1,
        storageBucket: 'general',
        storageKey: `tenants/${DEMO.tenant}/none/${doc.id}.csv`,
        sha256: Buffer.alloc(32, 0x5a),
        sizeBytes: 2048n,
        immutable: false,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        createdById: DEMO.leon,
      },
    });
    dokumentId = doc.id;
  }, 60_000);

  afterAll(async () => {
    try {
      await aufraeumen();
    } finally {
      await owner.$disconnect();
    }
  }, 60_000);

  it('Liste der Durchführungen aus dem Kontext', async () => {
    anna();
    const { default: Seite } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/durchfuehrungen/page');
    const { screen } = await rendern(
      Seite({
        params: Promise.resolve({ id: DEMO.talwind }),
        searchParams: Promise.resolve({ status: 'alle' }),
      }),
    );
    const liste = screen.getByRole('region', { name: /Alle ·/ });
    const links = within(liste).getAllByRole('link');
    expect(links.length).toBeGreaterThan(5);
    expect(links[0]!.getAttribute('href')).toMatch(/\/tcms\/durchfuehrungen\/[a-z0-9]+$/);
  });

  it('Durchführung: beginnen, speichern, Nachweis aus der Ablage anhängen, sperren, abrufen, entfernen', async () => {
    leon();
    const aktionen =
      await import('@/app/staff/(protected)/clients/[id]/tcms/durchfuehrungen/[did]/actions');
    const { default: Seite } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/durchfuehrungen/[did]/page');
    const seite = () =>
      rendern(
        Seite({
          params: Promise.resolve({ id: DEMO.talwind, did: K_EC_06 }),
          searchParams: Promise.resolve({}),
        }),
      );
    let { screen } = await seite();
    if (screen.queryByRole('button', { name: /Durchführung beginnen/ })) {
      expect(
        await aktionen.durchfuehrungBeginnenAction(DEMO.talwind, K_EC_06, null, new FormData()),
      ).toEqual({ ok: true, meldung: 'Durchführung begonnen.' });
    }
    const entwurf = new FormData();
    entwurf.set('schritt_0_erledigt', 'on');
    entwurf.set('schritt_0_kommentar', 'Live-Test Bereich C');
    entwurf.set('absicht', 'speichern');
    expect(
      await aktionen.durchfuehrungSpeichernAction(DEMO.talwind, K_EC_06, null, entwurf),
    ).toEqual({ ok: true, meldung: 'Entwurf gespeichert.' });

    const wahl = new FormData();
    wahl.set('dokumentId', dokumentId);
    expect(await aktionen.nachweisAuswaehlenAction(DEMO.talwind, K_EC_06, null, wahl)).toEqual({
      ok: true,
      meldung: 'Dokument als Nachweis angehängt.',
    });
    const verknuepfung = await owner.tcmsDocumentReference.findFirstOrThrow({
      where: { documentId: dokumentId, releasedAt: null },
    });
    expect(verknuepfung.tcmsEvidenceId).toMatch(/^[a-z0-9]+$/);
    expect(verknuepfung.tcmsExecutionId).toBe(K_EC_06);
    const nachweisId = verknuepfung.tcmsEvidenceId!;

    // Gleiches Dokument erneut: kein zweiter Nachweis.
    expect(
      await aktionen.nachweisAuswaehlenAction(DEMO.talwind, K_EC_06, null, wahl),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/^Bereits als Nachweis angehängt/) });

    // Seite: Nachweis mit Abruf (Abgleich mit der Ablage stimmt).
    ({ screen } = await seite());
    const nachweise = screen.getByRole('region', { name: 'Nachweise' });
    expect(
      within(nachweise)
        .getByRole('link', { name: 'Lieferantenliste September.csv' })
        .getAttribute('href'),
    ).toBe(`/api/staff/clients/${DEMO.talwind}/tcms/nachweise/${nachweisId}`);

    // Löschsperre: jedes Soft-Delete scheitert, solange die Verknüpfung offen ist.
    await expect(
      owner.document.update({ where: { id: dokumentId }, data: { deletedAt: new Date() } }),
    ).rejects.toThrow(/als Nachweis im Tax-CMS verknüpft/);

    // Abruf: alle Prüfungen bestanden, Ende am (hier fehlenden) Object Store.
    const { GET } = await import('@/app/api/staff/clients/[id]/tcms/nachweise/[nachweisId]/route');
    const anfrage = (mandant: string) =>
      GET(
        new NextRequest(
          `http://localhost/api/staff/clients/${mandant}/tcms/nachweise/${nachweisId}`,
        ),
        {
          params: Promise.resolve({ id: mandant, nachweisId }),
        },
      );
    const abruf = await anfrage(DEMO.talwind);
    expect([200, 503]).toContain(abruf.status);
    if (abruf.status === 503)
      expect(await abruf.json()).toMatchObject({ error: 'storage_unavailable' });
    // Derselbe Nachweis über einen anderen Mandanten: nicht gefunden.
    leon();
    expect((await anfrage(DEMO.seestern)).status).toBe(404);

    const entfernen = new FormData();
    entfernen.set('nachweisId', nachweisId);
    expect(await aktionen.nachweisEntfernenAction(DEMO.talwind, K_EC_06, null, entfernen)).toEqual({
      ok: true,
      meldung: 'Nachweis entfernt.',
    });
    expect(
      await owner.tcmsDocumentReference.findUniqueOrThrow({ where: { id: verknuepfung.id } }),
    ).toMatchObject({ releaseReason: 'REMOVED', releasedBy: DEMO.leon });
    await owner.document.update({ where: { id: dokumentId }, data: { deletedAt: new Date() } });
  });

  it('§ 153: ohne Würdigungsrecht feste Meldung; Berufsträgerin dokumentiert weitere Klärung', async () => {
    const aktionen =
      await import('@/app/staff/(protected)/clients/[id]/tcms/feststellungen/actions');
    const formular = (bisher: string) => {
      const fd = new FormData();
      fd.set('entscheidung', 'WEITERE_KLAERUNG');
      fd.set('begruendung', 'Registrierungspflicht in CZ wird mit der Beraterin vor Ort geklärt.');
      fd.set('frist', new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
      fd.set('bisher', bisher);
      return fd;
    };
    leon();
    expect(await aktionen.p153EntscheidenAction(DEMO.talwind, F_P153, null, formular(''))).toEqual({
      ok: false,
      error: TCMS_KEIN_RECHT.WUERDIGEN,
      errorCode: 'FORBIDDEN',
    });

    anna();
    const { tcmsLesen, tcmsMandantSeite } = await import('@/server/tcms/seite');
    const seite = await tcmsMandantSeite(DEMO.talwind);
    if (!seite.ok) throw new Error('Seite');
    const vorher = await tcmsLesen(seite, ENDPUNKTE.feststellungLesen, {
      params: { feststellungId: F_P153 },
    });
    if (!vorher.ok || vorher.daten.maskiert) throw new Error('Feststellung');
    const { default: Detail } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/feststellungen/[fid]/page');
    const { screen } = await rendern(
      Detail({
        params: Promise.resolve({ id: DEMO.talwind, fid: F_P153 }),
        searchParams: Promise.resolve({}),
      }),
    );
    const optionen = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(optionen.map((o) => o.value)).toEqual([
      'BERICHTIGUNG',
      'KEINE_PFLICHT',
      'WEITERE_KLAERUNG',
      'UEBERGABE',
    ]);
    expect(optionen.some((o) => o.checked)).toBe(false);
    const ergebnis = await aktionen.p153EntscheidenAction(
      DEMO.talwind,
      F_P153,
      null,
      formular(vorher.daten.p153?.entscheidung ?? ''),
    );
    expect(ergebnis).toMatchObject({ ok: true });
    expect((ergebnis as { meldung?: string }).meldung).toMatch(
      /^Entscheidung dokumentiert: Weitere Klärung · Wiedervorlage #\d+\.$/,
    );
  });

  it('Vertraulich: Nicht-Beteiligte sehen nur die Nummer', async () => {
    const aktionen =
      await import('@/app/staff/(protected)/clients/[id]/tcms/feststellungen/actions');
    const setzen = (wert: '0' | '1') => {
      const fd = new FormData();
      fd.set('vertraulich', wert);
      return aktionen.vertraulichAction(DEMO.talwind, F_VERTRAULICH, null, fd);
    };
    anna();
    expect(await setzen('1')).toMatchObject({ ok: true });
    try {
      thomas();
      const { default: Detail } =
        await import('@/app/staff/(protected)/clients/[id]/tcms/feststellungen/[fid]/page');
      const { screen, container } = await rendern(
        Detail({
          params: Promise.resolve({ id: DEMO.talwind, fid: F_VERTRAULICH }),
          searchParams: Promise.resolve({}),
        }),
      );
      expect(
        screen.getByRole('heading', { level: 2, name: 'F-2026-006 · Vertrauliche Feststellung' }),
      ).toBeTruthy();
      expect(container.textContent).not.toContain('Erstattungen FR/IT');
      // Vertraulich markieren ist nur mit Würdigungsrecht möglich.
      expect(await setzen('0')).toEqual({
        ok: false,
        error: TCMS_KEIN_RECHT.VERTRAULICH,
        errorCode: 'FORBIDDEN',
      });
    } finally {
      anna();
      expect(await setzen('0')).toMatchObject({ ok: true });
    }
  });

  it('Arbeitskorb: Aufgaben des Dienstes, Namen der kanzleikonsole', async () => {
    anna();
    const { default: Seite } = await import('@/app/staff/(protected)/tcms/arbeitskorb/page');
    const { screen, container } = await rendern(Seite());
    expect(screen.getByRole('heading', { level: 1, name: 'Arbeitskorb' })).toBeTruthy();
    const gegen = screen.getByRole('region', { name: 'Gegenzeichnungen' });
    expect(within(gegen).getAllByRole('link').length).toBeGreaterThan(0);
    expect(gegen.textContent).toContain('Durchgeführt von');
    expect(gegen.textContent).not.toContain('Unbekannte Person');
    expect(container.textContent).toContain('Talwind Outdoor GmbH');
  });
});
