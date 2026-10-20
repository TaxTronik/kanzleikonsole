// =============================================================================
// Red Team kk-tcms-redteam3b (TCMS Stufe 3/4): ausgeführte Angriffe auf die
// Server-Aktionen und Route-Handler gegen einen LAUFENDEN TCMS-Dienst mit
// Demo-Daten (Opt-in, nicht in CI – wie oberflaechen-live.test.tsx).
//
// Next.js bindet `mandantId`, Durchführungs-, Freigabe- und Nachweis-IDs mit
// `.bind` an die Aktion; diese Argumente kommen trotzdem vom Client und sind
// frei wählbar. Jeder Test ruft die Aktion bzw. den Route-Handler deshalb
// DIREKT mit manipulierten Argumenten auf: fremder Mandant (vertraulich, ohne
// Zuständigkeit), fremder Tenant, gefälschter Tenant in der Sitzung, fremde
// Durchführungs-/Nachweis-/Freigabe-/Ereignis-IDs eines anderen Mandanten,
// Dokumente und Kontakte anderer Mandanten bzw. Tenants, Portal-Kontakt mit
// gewechselter Mandantenauswahl (dieselbe Person als Kontakt zweier Mandanten).
//
// Erwartung je Angriff: fail closed – ohne Zugriff keine Bestätigung und KEIN
// Aufruf des Dienstes (gezählt am Transport), sonst Abweisung durch den Dienst
// mit fester Meldung; keine Verknüpfung in tcms_document_reference, keine
// Bytes. Echt: Aktionen, Routen, Akteursabbildung, PostgreSQL (App-Rolle,
// RLS), signierter Transport, Dienst. Ersetzt: nur die Request-
// Authentisierung (staffAuth/portalAuth), next/navigation und next/cache.
//
// Gleicher Tenant wie die übrigen Live-Suiten: einzeln starten, nicht parallel.
// Wie bereich-c-live mit der Superuser-Verbindung als DATABASE_URL (das
// Aufräumen löscht Abrufnachweise aus dem nur anhängenden audit_log).
//   cd apps/web && TCMS_LIVE_TESTS=1 DB_TESTS=1 TCMS_DEPLOYMENT=external \
//     TCMS_URL=… TCMS_SERVICE_TOKEN=… TCMS_ACTOR_PRIVATE_KEY=… TCMS_ACTOR_KEY_ID=… \
//     pnpm exec vitest run src/server/tcms/__tests__/redteam-aktionen-live.test.tsx
// Fachkatalog: TCMS-AKTEUR-001, TCMS-NACHWEIS-001, ACCESS-CLIENT-MODE-001
// =============================================================================
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';

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
}));

import { NextRequest } from 'next/server';
import type { PrismaClient } from '@taxtronik/db';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { DEMO } from '@/__tests__/tcms-fixtures';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

const enabled =
  process.env.TCMS_LIVE_TESTS === '1' &&
  !!process.env.TCMS_URL &&
  (process.env.DB_TESTS === '1' || process.env.TCMS_SEITE_DB_TEST === '1');

const KEIN_ZUGRIFF = 'Kein Zugriff auf das Tax-CMS.';
/** Anderer Mandant desselben Tenants mit Demo-Durchführungen (vertraulich gemacht). */
const ANDERER = DEMO.pixelhafen;
/** Gültiges Format (ObjektIdSchema), aber unbekannt: nur falls die Demo keine Freigabe hat. */
const ERSATZ_FREIGABE = 'freigabe0000000000000001';

(enabled ? describe : describe.skip)('Red Team: Aktionen und Routen mit manipulierten IDs', () => {
  let owner!: PrismaClient;
  let fetchSpy!: MockInstance<typeof fetch>;
  const fremderTenant = randomUUID();
  const eve = randomUUID();
  const fremderMandant = randomUUID();
  const fremderKontakt = randomUUID();
  /** Dieselbe Person (gleiche E-Mail) als Kontakt von Pixelhafen. */
  const janaAnders = randomUUID();
  const JANA_MAIL = 'jana.weller@talwind.example';
  let dokTalwind = '';
  let dokAnders = '';
  // IDs des Dienstes (der Seed vergibt sie je Datenbank neu).
  let dfTalwind = '';
  let dfAnders = '';
  let ereignisTalwind = '';
  let freigabeTalwind = '';

  const inEinerStunde = () => new Date(Date.now() + 3_600_000).toISOString();
  const alsStaff = (staffId: string, roles: string[], tenantId: string = DEMO.tenant) => {
    sitzung.staff = {
      user: {
        id: staffId,
        email: `${staffId}@kanzlei-roth.example`,
        name: 'Person',
        fullName: 'Person',
        tenantId,
        staffId,
        roles,
        permissions: [],
      },
      expires: inEinerStunde(),
    };
  };
  const anna = () => alsStaff(DEMO.anna, ['ADMIN']);
  const leon = () => alsStaff(DEMO.leon, ['EMPLOYEE']);
  const alsPortal = (contactId: string, clientId: string) => {
    sitzung.portal = {
      user: {
        id: contactId,
        email: JANA_MAIL,
        name: 'Jana Weller',
        fullName: 'Jana Weller',
        tenantId: DEMO.tenant,
        contactId,
        clientId,
        sessionIssuedAt: 0,
        sessionOriginContactId: contactId,
      },
      expires: inEinerStunde(),
    };
  };

  /** Anzahl der Anfragen an den Dienst (Transport des Clients). */
  function dienstAufrufe(): number {
    const basis = process.env.TCMS_URL!;
    return fetchSpy.mock.calls.filter(([ziel]) => {
      const url = ziel instanceof Request ? ziel.url : String(ziel);
      return url.startsWith(basis);
    }).length;
  }

  /** Führt den Angriff aus und belegt, dass der Dienst NICHT gefragt wurde. */
  async function ohneDienst<T>(angriff: () => Promise<T>): Promise<T> {
    const vorher = dienstAufrufe();
    const ergebnis = await angriff();
    expect(dienstAufrufe(), 'kein Aufruf des Dienstes').toBe(vorher);
    return ergebnis;
  }

  async function aufraeumen() {
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRaw`DELETE FROM audit_log WHERE tenant_id IN (${DEMO.tenant}::uuid, ${fremderTenant}::uuid)`;
      await tx.$executeRaw`DELETE FROM tcms_document_reference WHERE tenant_id = ${DEMO.tenant}::uuid`;
    });
    await owner.tenant.deleteMany({ where: { id: { in: [DEMO.tenant, fremderTenant] } } });
  }

  async function dokument(tenantId: string, clientId: string, byte: number, staffId: string) {
    const typ = await owner.documentType.create({
      data: { tenantId, name: `Allgemein ${byte}`, tier: 'NONE', classificationKey: 'GENERAL' },
    });
    const doc = await owner.document.create({
      data: {
        tenantId,
        clientId,
        title: `Rote Liste ${byte}`,
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
        storageKey: `tenants/${tenantId}/none/${doc.id}.csv`,
        sha256: Buffer.alloc(32, byte),
        sizeBytes: 2048n,
        immutable: false,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        createdById: staffId,
      },
    });
    return doc.id;
  }

  beforeAll(async () => {
    ({ prismaOwner: owner } = await import('@taxtronik/db'));
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    await aufraeumen();
    await owner.tenant.create({
      data: { id: DEMO.tenant, slug: `tcms-rt3b-${randomUUID()}`, name: 'Kanzlei Roth (Demo)' },
    });
    await owner.tenant.create({
      data: { id: fremderTenant, slug: `tcms-rt3b-fremd-${randomUUID()}`, name: 'Fremde Kanzlei' },
    });
    const person = (
      id: string,
      tenantId: string,
      fullName: string,
      role: string,
      isProfessional: boolean,
    ) =>
      owner.staffUser.create({
        data: {
          id,
          tenantId,
          email: `${id}@kanzlei.example`,
          fullName,
          passwordHash: 'synthetic',
          isProfessional,
          roles: { create: [{ role: role as never }] },
        },
      });
    await person(DEMO.anna, DEMO.tenant, 'StB Dr. Anna Roth', 'ADMIN', true);
    await person(DEMO.leon, DEMO.tenant, 'Leon Brandt', 'EMPLOYEE', false);
    await person(DEMO.thomas, DEMO.tenant, 'StB Thomas Kern', 'EMPLOYEE', true);
    await person(eve, fremderTenant, 'Eve Fremd', 'ADMIN', true);
    for (const [id, name] of [
      [DEMO.talwind, 'Talwind Outdoor GmbH'],
      [DEMO.seestern, 'Seestern Home & Living GmbH'],
      [DEMO.kleinwerk, 'Kleinwerk Manufaktur UG (haftungsbeschränkt)'],
      [ANDERER, 'Pixelhafen Electronics KG'],
      [DEMO.bergkamm, 'Bergkamm Kaffeerösterei GmbH'],
    ] as const) {
      await owner.client.create({ data: { id, tenantId: DEMO.tenant, kind: 'JURPERS', name } });
    }
    // Pixelhafen ist vertraulich: nur Admin/Partner und die Zuständigen (Thomas).
    await owner.client.update({ where: { id: ANDERER }, data: { vertraulich: true } });
    await owner.client.create({
      data: { id: fremderMandant, tenantId: fremderTenant, kind: 'JURPERS', name: 'Fremd GmbH' },
    });
    await createVerifiedLegalEntityGwgFixture(owner as never, {
      tenantId: fremderTenant,
      clientId: fremderMandant,
      verifiedBy: eve,
      registerNumber: `HRB-${randomUUID().slice(0, 8)}`,
    });
    await owner.client.update({ where: { id: fremderMandant }, data: { allowActive: true } });
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
          clientId: ANDERER,
          staffId: DEMO.thomas,
          role: 'BERUFSTRAEGER',
        },
      ],
    });
    for (const clientId of [DEMO.talwind, ANDERER]) {
      await createVerifiedLegalEntityGwgFixture(owner as never, {
        tenantId: DEMO.tenant,
        clientId,
        verifiedBy: DEMO.anna,
        registerNumber: `HRB-${randomUUID().slice(0, 8)}`,
      });
      await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });
    }
    const kontakt = (
      id: string,
      tenantId: string,
      clientId: string,
      fullName: string,
      email: string,
    ) => owner.clientContact.create({ data: { id, tenantId, clientId, fullName, email } });
    await kontakt(DEMO.jana, DEMO.tenant, DEMO.talwind, 'Jana Weller', JANA_MAIL);
    await kontakt(DEMO.murat, DEMO.tenant, DEMO.talwind, 'Murat Yilmaz', 'murat@talwind.example');
    await kontakt(janaAnders, DEMO.tenant, ANDERER, 'Jana Weller', JANA_MAIL);
    await kontakt(
      fremderKontakt,
      fremderTenant,
      fremderMandant,
      'Fritz Fremd',
      'fritz@fremd.example',
    );
    for (const tenantId of [DEMO.tenant, fremderTenant]) {
      await owner.tenantSetting.create({
        data: { tenantId, key: 'modules', value: { tcms: true } },
      });
    }
    dokTalwind = await dokument(DEMO.tenant, DEMO.talwind, 0x61, DEMO.anna);
    dokAnders = await dokument(DEMO.tenant, ANDERER, 0x62, DEMO.anna);

    anna();
    const { tcmsLesen, tcmsMandantSeite } = await import('@/server/tcms/seite');
    const kontext = async (mandantId: string) => {
      const seite = await tcmsMandantSeite(mandantId);
      if (!seite.ok) throw new Error(`Seite ${mandantId}: ${seite.zustand.art}`);
      const k = await tcmsLesen(seite, ENDPUNKTE.kontextLesen);
      if (!k.ok) throw new Error(`Kontext ${mandantId}: ${k.zustand.art}`);
      return { seite, daten: k.daten };
    };
    const t = await kontext(DEMO.talwind);
    const s = await kontext(ANDERER);
    // K-EC-06 September 2026 (Demo, fällig) wie in bereich-c-live.
    dfTalwind =
      t.daten.durchfuehrungen.find(
        (d) => d.code === 'K-EC-06' && d.periodeLabel === 'September 2026' && !d.ausserplanmaessig,
      )?.id ?? '';
    dfAnders = s.daten.durchfuehrungen[0]?.id ?? '';
    const ereignisse = await tcmsLesen(t.seite, ENDPUNKTE.ereignisseLesen);
    if (ereignisse.ok) ereignisTalwind = ereignisse.daten.ereignisse[0]?.id ?? '';
    const freigaben = await tcmsLesen(t.seite, ENDPUNKTE.freigabenHistorieLesen);
    if (freigaben.ok) freigabeTalwind = freigaben.daten.freigaben[0]?.id ?? '';
    // Der Zähler sieht den Transport des Clients; sonst wäre jedes `ohneDienst` wertlos.
    expect(dienstAufrufe()).toBeGreaterThanOrEqual(4);
    expect(ereignisTalwind, 'Demo: Ereignis von Talwind').not.toBe('');
    expect(freigabeTalwind, 'Demo: Freigabe von Talwind').not.toBe('');
    if (!dfTalwind || !dfAnders) {
      throw new Error(
        `Demo-Daten des Tax-CMS unvollständig (Talwind ${t.daten.durchfuehrungen.length}, Pixelhafen ${s.daten.durchfuehrungen.length})`,
      );
    }
  }, 90_000);

  afterAll(async () => {
    fetchSpy?.mockRestore();
    try {
      await aufraeumen();
    } finally {
      await owner.$disconnect();
    }
  }, 60_000);

  const aktionenC = () =>
    import('@/app/staff/(protected)/clients/[id]/tcms/durchfuehrungen/[did]/actions');
  const formular = (felder: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(felder)) f.set(k, v);
    return f;
  };
  const offeneVerknuepfungen = () =>
    owner.tcmsDocumentReference.count({ where: { tenantId: DEMO.tenant, releasedAt: null } });

  it('RT3B-A1: Mitarbeiter ohne Zugriff bindet den vertraulichen Mandanten – keine Bestätigung, kein Dienstaufruf', async () => {
    leon();
    const c = await aktionenC();
    for (const angriff of [
      () => c.durchfuehrungBeginnenAction(ANDERER, dfAnders, null, new FormData()),
      () =>
        c.nachweisAuswaehlenAction(ANDERER, dfAnders, null, formular({ dokumentId: dokAnders })),
      () =>
        c.nachweisEntfernenAction(
          ANDERER,
          dfAnders,
          null,
          formular({ nachweisId: 'nachweisaaa1' }),
        ),
    ]) {
      expect(await ohneDienst(angriff)).toMatchObject({ ok: false, error: KEIN_ZUGRIFF });
    }
    expect(await offeneVerknuepfungen()).toBe(0);
  });

  it('RT3B-A2: Admin eines fremden Tenants bindet einen Mandanten dieses Tenants – kein Dienstaufruf', async () => {
    alsStaff(eve, ['ADMIN'], fremderTenant);
    const c = await aktionenC();
    expect(
      await ohneDienst(() =>
        c.durchfuehrungBeginnenAction(DEMO.talwind, dfTalwind, null, new FormData()),
      ),
    ).toMatchObject({ ok: false });
    const { kontaktRollenSetzenAction } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/kontakte/actions');
    expect(
      await ohneDienst(() =>
        kontaktRollenSetzenAction(
          DEMO.talwind,
          null,
          formular({ kontaktId: DEMO.jana, rollen: 'GESETZLICHER_VERTRETER' }),
        ),
      ),
    ).toMatchObject({ ok: false });
  });

  it('RT3B-A3: Sitzung mit gefälschtem Tenant (Person existiert dort nicht) – keine Bestätigung, kein Dienstaufruf', async () => {
    alsStaff(eve, ['ADMIN'], DEMO.tenant);
    const c = await aktionenC();
    expect(
      await ohneDienst(() =>
        c.durchfuehrungBeginnenAction(DEMO.talwind, dfTalwind, null, new FormData()),
      ),
    ).toMatchObject({ ok: false, error: KEIN_ZUGRIFF });
    // Rollen der Sitzung höher als in der Datenbank (Leon als ADMIN): veraltet → abgewiesen.
    alsStaff(DEMO.leon, ['ADMIN']);
    expect(
      await ohneDienst(() =>
        c.durchfuehrungBeginnenAction(ANDERER, dfAnders, null, new FormData()),
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/^Kein Zugriff auf das Tax-CMS\./) });
  });

  it('RT3B-A4: eigener Mandant gebunden, Durchführung eines anderen Mandanten – Dienst weist ab, keine Verknüpfung', async () => {
    anna();
    const c = await aktionenC();
    const vorher = await offeneVerknuepfungen();
    expect(
      await c.nachweisAuswaehlenAction(
        DEMO.talwind,
        dfAnders,
        null,
        formular({ dokumentId: dokTalwind }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await c.durchfuehrungBeginnenAction(DEMO.talwind, dfAnders, null, new FormData()),
    ).toMatchObject({ ok: false });
    expect(await owner.tcmsDocumentReference.count({ where: { tcmsExecutionId: dfAnders } })).toBe(
      0,
    );
    expect(await offeneVerknuepfungen()).toBe(vorher);
  });

  it('RT3B-A5: eigener Mandant und eigene Durchführung, Dokument eines anderen Mandanten bzw. Tenants – kein Dienstaufruf', async () => {
    anna();
    const c = await aktionenC();
    const fremdesDok = await dokument(fremderTenant, fremderMandant, 0x63, eve);
    for (const dokumentId of [dokAnders, fremdesDok]) {
      expect(
        await ohneDienst(() =>
          c.nachweisAuswaehlenAction(DEMO.talwind, dfTalwind, null, formular({ dokumentId })),
        ),
      ).toMatchObject({ ok: false, error: expect.stringMatching(/kann nicht als Nachweis/) });
    }
    expect(await owner.tcmsDocumentReference.count({ where: { documentId: dokAnders } })).toBe(0);
    expect(await owner.tcmsDocumentReference.count({ where: { documentId: fremdesDok } })).toBe(0);
  });

  it('RT3B-A6: Nachweis von Talwind über den gebundenen Mandanten Pixelhafen entfernen – Verknüpfung bleibt offen', async () => {
    const c = await aktionenC();
    // Legitim (wie bereich-c-live): Leon (Hauptbearbeitung) hängt ein Talwind-Dokument an K-EC-06.
    leon();
    await c.durchfuehrungBeginnenAction(DEMO.talwind, dfTalwind, null, new FormData());
    expect(
      await c.nachweisAuswaehlenAction(
        DEMO.talwind,
        dfTalwind,
        null,
        formular({ dokumentId: dokTalwind }),
      ),
    ).toEqual({ ok: true, meldung: 'Dokument als Nachweis angehängt.' });
    const zeile = await owner.tcmsDocumentReference.findFirstOrThrow({
      where: { documentId: dokTalwind, releasedAt: null },
    });
    const nachweisId = zeile.tcmsEvidenceId!;
    expect(nachweisId).toMatch(/^[a-z0-9]+$/);
    // Angriff (Anna hat Zugriff auf beide Mandanten): Mandant Pixelhafen gebunden,
    // Durchführung von Pixelhafen bzw. von Talwind, Nachweis von Talwind.
    anna();
    for (const did of [dfAnders, dfTalwind]) {
      const vorher = dienstAufrufe();
      expect(
        await c.nachweisEntfernenAction(ANDERER, did, null, formular({ nachweisId })),
      ).toMatchObject({ ok: false });
      expect(dienstAufrufe(), 'der Angriff erreicht den Dienst').toBeGreaterThan(vorher);
    }
    // Die Verknüpfung von Talwind bleibt offen, das Dokument gesperrt.
    const danach = await owner.tcmsDocumentReference.findUniqueOrThrow({ where: { id: zeile.id } });
    expect(danach).toMatchObject({ releasedAt: null, tcmsEvidenceId: nachweisId });
    // Aufräumen auf legitimem Weg.
    leon();
    expect(
      await c.nachweisEntfernenAction(DEMO.talwind, dfTalwind, null, formular({ nachweisId })),
    ).toEqual({ ok: true, meldung: 'Nachweis entfernt.' });
  });

  it('RT3B-A7: Personen- und Kontakt-IDs anderer Mandanten/Tenants in Formularen – kein Dienstaufruf', async () => {
    anna();
    const { kontaktRollenSetzenAction } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/kontakte/actions');
    for (const kontaktId of [janaAnders, fremderKontakt]) {
      expect(
        await ohneDienst(() =>
          kontaktRollenSetzenAction(
            DEMO.talwind,
            null,
            formular({ kontaktId, rollen: 'GESETZLICHER_VERTRETER' }),
          ),
        ),
      ).toMatchObject({
        ok: false,
        error: 'Der gewählte Kontakt gehört nicht zu diesem Mandanten.',
      });
    }
    const { freigabeNeuadressierenAction } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/kommunikation/actions');
    expect(
      await ohneDienst(() =>
        freigabeNeuadressierenAction(
          DEMO.talwind,
          null,
          formular({ freigabeId: freigabeTalwind || ERSATZ_FREIGABE, empfaengerId: janaAnders }),
        ),
      ),
    ).toMatchObject({ ok: false });
    const { verantwortlicheAendernAction } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/kontrollen/actions');
    // Eve (fremder Tenant) und Leon (ohne Zugriff auf das vertrauliche Pixelhafen) als Verantwortliche.
    for (const [mandant, person] of [
      [DEMO.talwind, eve],
      [ANDERER, DEMO.leon],
    ] as const) {
      expect(
        await ohneDienst(() =>
          verantwortlicheAendernAction(
            mandant,
            null,
            formular({
              kontrolleId: 'kontrolleaaa1',
              standId: 'standaaa1',
              partei: 'KANZLEI',
              durchfuehrendId: person,
              vertretungId: DEMO.anna,
            }),
          ),
        ),
      ).toMatchObject({ ok: false });
    }
  });

  it('RT3B-A8: Freigabe von Talwind über den gebundenen Mandanten Pixelhafen neu adressieren – Dienst weist ab', async () => {
    anna();
    const { freigabeNeuadressierenAction } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/kommunikation/actions');
    // Empfänger ist ein gültiger Kontakt des gebundenen Mandanten: die
    // kanzleikonsole lässt ihn zu, der Angriff erreicht den Dienst.
    const vorher = dienstAufrufe();
    expect(
      await freigabeNeuadressierenAction(
        ANDERER,
        null,
        formular({ freigabeId: freigabeTalwind || ERSATZ_FREIGABE, empfaengerId: janaAnders }),
      ),
    ).toMatchObject({ ok: false });
    expect(dienstAufrufe()).toBeGreaterThan(vorher);
  });

  it('RT3B-P1: Portal-Kontakt mit gewechselter Mandantenauswahl (dieselbe Person bei zwei Mandanten) – kein Dienstaufruf', async () => {
    // Kontakt-ID von Talwind, Mandant der Sitzung Pixelhafen (und umgekehrt).
    for (const [kontakt, mandant] of [
      [DEMO.jana, ANDERER],
      [janaAnders, DEMO.talwind],
    ] as const) {
      alsPortal(kontakt, mandant);
      const { portalFreigabeCodeAnfordernAction } =
        await import('@/app/portal/(protected)/tcms/freigaben/actions');
      expect(
        await ohneDienst(() =>
          portalFreigabeCodeAnfordernAction(
            freigabeTalwind || ERSATZ_FREIGABE,
            null,
            new FormData(),
          ),
        ),
      ).toMatchObject({ ok: false, error: KEIN_ZUGRIFF });
      const { portalEreignisMeldenAction } =
        await import('@/app/portal/(protected)/tcms/ereignis/actions');
      const vorherDoks = await owner.document.count({ where: { tenantId: DEMO.tenant } });
      expect(
        await ohneDienst(() =>
          portalEreignisMeldenAction(
            null,
            // Gültiges Formular: der Angriff erreicht die Akteursprüfung, nicht nur `parse`.
            formular({
              typ: 'SONST',
              titel: 'Gewechselte Auswahl',
              beschreibung: 'Gewechselte Mandantenauswahl im Portal',
              datum: '2026-10-01',
              zusage: '1',
            }),
          ),
        ),
      ).toMatchObject({ ok: false });
      expect(await owner.document.count({ where: { tenantId: DEMO.tenant } })).toBe(vorherDoks);
    }
  });

  it('RT3B-P2: Portal-Kontakt von Pixelhafen (gültige Sitzung) mit IDs von Talwind – Dienst weist ab', async () => {
    alsPortal(janaAnders, ANDERER);
    const aufgaben = await import('@/app/portal/(protected)/tcms/aufgaben/[id]/actions');
    expect(
      await aufgaben.portalAufgabeBestaetigenAction(dfTalwind, null, new FormData()),
    ).toMatchObject({ ok: false });
    expect(
      await aufgaben.portalAnlageEntfernenAction(dfTalwind, 'nachweisaaa1', null, new FormData()),
    ).toMatchObject({ ok: false });
    const { portalFreigabeCodeAnfordernAction } =
      await import('@/app/portal/(protected)/tcms/freigaben/actions');
    expect(
      await portalFreigabeCodeAnfordernAction(
        freigabeTalwind || ERSATZ_FREIGABE,
        null,
        new FormData(),
      ),
    ).toMatchObject({ ok: false });
  });

  it('RT3B-R1: Route-Handler mit fremdem Mandanten, fremdem Nachweis, fremdem Ereignis – 404 ohne Bytes', async () => {
    const { GET: nachweis } =
      await import('@/app/api/staff/clients/[id]/tcms/nachweise/[nachweisId]/route');
    const { GET: anlage } =
      await import('@/app/api/staff/clients/[id]/tcms/ereignisse/anlage/route');
    const anfrage = (pfad: string) => new NextRequest(`http://localhost${pfad}`);
    // Leon: vertraulicher Mandant ohne Zugriff – kein Dienstaufruf.
    leon();
    const r1 = await ohneDienst(() =>
      nachweis(anfrage(`/api/staff/clients/${ANDERER}/tcms/nachweise/nachweisaaa1`), {
        params: Promise.resolve({ id: ANDERER, nachweisId: 'nachweisaaa1' }),
      }),
    );
    expect(r1.status).toBe(404);
    // Eve: fremder Tenant – kein Dienstaufruf.
    alsStaff(eve, ['ADMIN'], fremderTenant);
    const r2 = await ohneDienst(() =>
      nachweis(anfrage(`/api/staff/clients/${DEMO.talwind}/tcms/nachweise/nachweisaaa1`), {
        params: Promise.resolve({ id: DEMO.talwind, nachweisId: 'nachweisaaa1' }),
      }),
    );
    expect(r2.status).toBe(404);
    // Anna: Pfad Pixelhafen (Zugriff), Ereignis von Talwind – der Dienst weist ab.
    anna();
    if (ereignisTalwind) {
      const h = '00'.repeat(32);
      const r3 = await anlage(
        anfrage(`/api/staff/clients/${ANDERER}/tcms/ereignisse/anlage?e=${ereignisTalwind}&h=${h}`),
        { params: Promise.resolve({ id: ANDERER }) },
      );
      expect(r3.status).toBe(404);
      expect(r3.headers.get('content-disposition')).toBeNull();
    }
    // Portal: Durchführung in Pfad und Antwort weichen ab – 404.
    alsPortal(janaAnders, ANDERER);
    const { GET: portalAnlage } =
      await import('@/app/api/portal/tcms/aufgaben/[id]/anlagen/[nachweisId]/route');
    const r4 = await portalAnlage(
      anfrage(`/api/portal/tcms/aufgaben/${dfTalwind}/anlagen/nachweisaaa1`),
      { params: Promise.resolve({ id: dfTalwind, nachweisId: 'nachweisaaa1' }) },
    );
    expect(r4.status).toBe(404);
    expect(r4.headers.get('content-disposition')).toBeNull();
  });
});
