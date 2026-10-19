// Fachkatalog: TCMS-DIENST-001, DOC-PORTAL-SHARING-001, ACCESS-CLIENT-MODE-001
// TCMS Stufe 3, Bereich D, gegen echtes PostgreSQL über die App-Rolle (RLS):
//   - Abruf einer Datei, auf die das Tax-CMS verweist, über die echte
//     Dokumentauslieferung (loadDocumentDelivery): Kanzlei nur mit
//     Mandantenzugriff und nur Dokumente dieses Mandanten; Portal nur für den
//     Mandanten freigegebene Dokumente; bei abweichendem SHA-256 oder Größe
//     keine Auslieferung und KEIN Abrufnachweis im Audit.
//   - Ansprechpersonen (Berufsträger/Hauptbearbeitung) und Auswahl der
//     Zuständigkeit aus der kanzleikonsole: nur aktive Personen, nur mit
//     Zugriff auf den Mandanten.
// Ersetzt werden nur Sitzung, Object Store und die Verbindungsgrenze.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient, TenantContext, TxClient } from '@taxtronik/db';
import { EvidenceService, LocalTimestampAdapter, type AuditEventInput } from '@taxtronik/evidence';
import type { PortalSession } from '@/server/auth/portal';
import type { StaffSession } from '@/server/auth/staff';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

const fixture = vi.hoisted(() => ({
  run: async (_ctx: TenantContext, _run: (tx: TxClient) => unknown): Promise<unknown> => undefined,
  record: async (_tx: TxClient, _event: AuditEventInput): Promise<unknown> => undefined,
  ausgeliefert: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: () => null }));
vi.mock('@taxtronik/storage', () => ({
  sanitizeFilenameForHeader: (s: string) => s,
  streamVerifiedObject: vi.fn(),
}));
vi.mock('@taxtronik/db', async (original) => ({
  ...(await original<typeof import('@taxtronik/db')>()),
  withTenantContext: (ctx: TenantContext, run: (tx: TxClient) => unknown) => fixture.run(ctx, run),
}));
vi.mock('@taxtronik/db/tenant-context', () => ({
  withTenantContext: (ctx: TenantContext, run: (tx: TxClient) => unknown) => fixture.run(ctx, run),
}));
vi.mock('@/server/container', () => ({
  evidenceService: {
    record: (tx: TxClient, event: AuditEventInput) => fixture.record(tx, event),
  },
}));
// Echte Ladefunktion; nur das Streamen aus dem Object Store entfällt.
vi.mock('@/server/documents/delivery', async (original) => ({
  ...(await original<typeof import('@/server/documents/delivery')>()),
  documentDownloadResponse: async (quelle: unknown) => {
    fixture.ausgeliefert(quelle);
    return new Response('bytes');
  },
}));

import { tcmsVerweisAusliefern } from '../abruf/auslieferung';
import { kanzleiPersonenAuswahlTx } from '../ereignisse/personen';
import { ansprechpersonenTx } from '../portal/ansprechpartner';

const enabled = process.env.TCMS_BEREICH_D_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'TCMS_BEREICH_D_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`TCMS_BEREICH_D_DB_TEST requires a valid ${name}.`);
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname.length < 2 ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      throw new Error(`TCMS_BEREICH_D_DB_TEST requires a loopback PostgreSQL ${name}.`);
    }
  }
}

const REQ = { headers: new Headers(), nextUrl: new URL('http://localhost/x') } as never;

(enabled ? describe : describe.skip)('TCMS Bereich D gegen PostgreSQL', () => {
  // Freigegebene Clients aus @taxtronik/db (prisma-client-guard): Owner nur für
  // Fixtures, die App-Rolle (DATABASE_APP_URL, RLS) für alle Prüfungen. Erst im
  // beforeAll geladen, damit eine übersprungene Suite keine Verbindung braucht.
  let owner!: PrismaClient;
  let app!: PrismaClient;
  const evidence = new EvidenceService(new LocalTimestampAdapter());
  let tenantId = '';
  let typ = '';
  const staff: Record<string, string> = {};
  const mandant: Record<string, string> = {};
  let kontakt = '';

  async function person(key: string, daten: { active?: boolean } = {}) {
    staff[key] = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `${key}-${randomUUID()}@example.test`,
          fullName: `Person ${key}`,
          passwordHash: 'synthetic',
          roles: { create: [{ role: 'EMPLOYEE' }] },
          ...daten,
        },
      })
    ).id;
  }

  async function aktiverMandant(key: string, vertraulich: boolean) {
    const clientId = (
      await owner.client.create({
        data: {
          tenantId,
          kind: 'JURPERS',
          name: `Mandant ${key}`,
          vertraulich,
          allowActive: false,
        },
      })
    ).id;
    await createVerifiedLegalEntityGwgFixture(owner, {
      tenantId,
      clientId,
      verifiedBy: staff.anna!,
      registerNumber: `HRB-TCMS-D-${randomUUID()}`,
    });
    await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });
    mandant[key] = clientId;
  }

  async function zustaendig(key: string, role: string, staffKey: string, vor: number) {
    await owner.clientResponsibility.create({
      data: {
        tenantId,
        clientId: mandant[key]!,
        staffId: staff[staffKey]!,
        role: role as never,
        createdAt: new Date(Date.now() - vor * 60_000),
      },
    });
  }

  /** Dokument mit einer sauberen Version (Inhalt 7 × 0x07, 7 Bytes). */
  async function dokument(clientKey: string, geteilt = false): Promise<string> {
    const d = await owner.document.create({
      data: {
        tenantId,
        clientId: mandant[clientKey]!,
        title: 'Bescheid',
        classification: 'GENERAL',
        documentTypeId: typ,
        mimeType: 'application/pdf',
        ...(geteilt ? { sharedWithClientAt: new Date() } : {}),
      },
    });
    await owner.documentVersion.create({
      data: {
        documentId: d.id,
        versionNo: 1,
        storageBucket: 'general',
        storageKey: `tenants/${tenantId}/none/2026/10/${d.id}.bin`,
        sha256: Buffer.alloc(32, 7),
        sizeBytes: 7n,
        immutable: false,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        createdById: staff.anna!,
      },
    });
    return d.id;
  }

  const SHA = Buffer.alloc(32, 7).toString('hex');
  const verweis = (dokumentId: string, abw: { sha256?: string; groesse?: number } = {}) => ({
    dokumentId,
    sha256: abw.sha256 ?? SHA,
    groesse: abw.groesse ?? 7,
  });
  const abrufe = (dokumentId: string) =>
    owner.auditLog.count({
      where: { tenantId, resourceId: dokumentId, action: 'document.download' },
    });
  const kanzlei = (staffKey: string, mandantKey: string) => ({
    flaeche: 'KANZLEI' as const,
    session: {
      user: { tenantId, staffId: staff[staffKey]!, roles: ['EMPLOYEE'], permissions: [] },
    } as unknown as StaffSession,
    mandantId: mandant[mandantKey]!,
  });
  const portal = () => ({
    flaeche: 'PORTAL' as const,
    session: {
      user: { tenantId, contactId: kontakt, clientId: mandant.offen! },
    } as unknown as PortalSession,
    mandantId: mandant.offen!,
  });

  beforeAll(async () => {
    ({ prismaOwner: owner, prisma: app } = await import('@taxtronik/db'));
    tenantId = (
      await owner.tenant.create({ data: { slug: `tcms-d-${randomUUID()}`, name: 'TCMS D' } })
    ).id;
    await person('anna');
    await person('leon');
    await person('thomas');
    await person('alt', { active: false });
    await aktiverMandant('offen', false);
    await aktiverMandant('vertraulich', true);
    typ = (
      await owner.documentType.create({
        data: { tenantId, name: 'Allgemein', tier: 'NONE', classificationKey: 'GENERAL' },
      })
    ).id;
    kontakt = (
      await owner.clientContact.create({
        data: {
          tenantId,
          clientId: mandant.offen!,
          email: `kontakt-${randomUUID()}@example.test`,
          fullName: 'Murat Aydin',
          active: true,
        },
      })
    ).id;
    // Hauptbearbeitung: die älteste Zuordnung ist inaktiv → nächste aktive zählt.
    await zustaendig('offen', 'HAUPTBEARBEITER', 'alt', 30);
    await zustaendig('offen', 'HAUPTBEARBEITER', 'leon', 20);
    await zustaendig('offen', 'BERUFSTRAEGER', 'anna', 10);
    await zustaendig('offen', 'BERUFSTRAEGER', 'thomas', 5);
    await zustaendig('vertraulich', 'HAUPTBEARBEITER', 'leon', 1);

    fixture.run = async (context, run) =>
      app.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${context.tenantId},true), set_config('app.current_actor_id',${context.actorId ?? ''},true), set_config('app.current_actor_type',${context.actorType ?? 'STAFF'},true)`;
        return run(tx as unknown as TxClient);
      });
    fixture.record = (tx, event) => evidence.record(tx, event);
  });

  beforeEach(() => {
    fixture.ausgeliefert.mockClear();
  });

  afterAll(async () => {
    // Append-only Audit-Zeilen bleiben in der Wegwerf-Datenbank (wie die übrigen DB-Suiten).
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  });

  describe('tcmsVerweisAusliefern', () => {
    it('Kanzlei: passender Verweis → Auslieferung mit Abrufnachweis', async () => {
      const id = await dokument('offen');
      const r = await tcmsVerweisAusliefern(REQ, kanzlei('thomas', 'offen'), verweis(id));
      expect(r.art).toBe('AUSGELIEFERT');
      expect(fixture.ausgeliefert).toHaveBeenCalledTimes(1);
      expect(await abrufe(id)).toBe(1);
    });

    it('abweichender SHA-256 oder Größe → keine Auslieferung, kein Abrufnachweis', async () => {
      const id = await dokument('offen');
      const a = await tcmsVerweisAusliefern(
        REQ,
        kanzlei('thomas', 'offen'),
        verweis(id, { sha256: 'ab'.repeat(32) }),
      );
      const b = await tcmsVerweisAusliefern(REQ, portal(), verweis(id, { groesse: 8 }));
      expect(a).toEqual({ art: 'ABWEICHUNG' });
      expect(b).toEqual({ art: 'NICHT_VERFUEGBAR' }); // nicht geteilt: vor dem Abgleich gefiltert
      expect(fixture.ausgeliefert).not.toHaveBeenCalled();
      expect(await abrufe(id)).toBe(0);
    });

    it('Kanzlei: vertraulicher Mandant ohne Zuständigkeit → nicht verfügbar, kein Abrufnachweis', async () => {
      const id = await dokument('vertraulich');
      expect(
        await tcmsVerweisAusliefern(REQ, kanzlei('thomas', 'vertraulich'), verweis(id)),
      ).toEqual({ art: 'NICHT_VERFUEGBAR' });
      expect(await abrufe(id)).toBe(0);
      // Mit Zuständigkeit (Hauptbearbeitung) ausgeliefert.
      expect(
        (await tcmsVerweisAusliefern(REQ, kanzlei('leon', 'vertraulich'), verweis(id))).art,
      ).toBe('AUSGELIEFERT');
    });

    it('Dokument eines anderen Mandanten → nicht verfügbar', async () => {
      const id = await dokument('vertraulich');
      expect(await tcmsVerweisAusliefern(REQ, kanzlei('leon', 'offen'), verweis(id))).toEqual({
        art: 'NICHT_VERFUEGBAR',
      });
      expect(await abrufe(id)).toBe(0);
    });

    it('Portal: nur geteilte Dokumente des Sitzungsmandanten; Abweichung ohne Abrufnachweis', async () => {
      const geteilt = await dokument('offen', true);
      const nichtGeteilt = await dokument('offen');
      expect((await tcmsVerweisAusliefern(REQ, portal(), verweis(geteilt))).art).toBe(
        'AUSGELIEFERT',
      );
      expect(await abrufe(geteilt)).toBe(1);
      expect(await tcmsVerweisAusliefern(REQ, portal(), verweis(nichtGeteilt))).toEqual({
        art: 'NICHT_VERFUEGBAR',
      });
      expect(await tcmsVerweisAusliefern(REQ, portal(), verweis(geteilt, { groesse: 8 }))).toEqual({
        art: 'ABWEICHUNG',
      });
      expect(await abrufe(geteilt)).toBe(1);
      expect(await abrufe(nichtGeteilt)).toBe(0);
    });
  });

  describe('Personen aus der kanzleikonsole', () => {
    const imTenant = <T>(run: (tx: TxClient) => Promise<T>) =>
      fixture.run({ tenantId, actorId: staff.anna!, actorType: 'STAFF' }, run) as Promise<T>;

    it('Ansprechpersonen: älteste aktive Zuordnung je Rolle', async () => {
      const r = await imTenant((tx) =>
        ansprechpersonenTx(tx, { tenantId, mandantId: mandant.offen! }),
      );
      expect(r).toEqual({
        berufstraeger: { id: staff.anna, name: 'Person anna' },
        hauptbearbeitung: { id: staff.leon, name: 'Person leon' },
      });
    });

    it('Auswahl der Zuständigkeit: vertraulicher Mandant nur mit Zuständigkeit, keine Inaktiven', async () => {
      const offen = await imTenant((tx) =>
        kanzleiPersonenAuswahlTx(tx, { tenantId, mandantId: mandant.offen! }),
      );
      expect(offen.map((o) => o.wert).sort()).toEqual(
        [staff.anna, staff.leon, staff.thomas].map((id) => `K:${id}`).sort(),
      );
      const vertraulich = await imTenant((tx) =>
        kanzleiPersonenAuswahlTx(tx, { tenantId, mandantId: mandant.vertraulich! }),
      );
      expect(vertraulich).toEqual([{ wert: `K:${staff.leon}`, label: 'Person leon (Kanzlei)' }]);
    });
  });
});
