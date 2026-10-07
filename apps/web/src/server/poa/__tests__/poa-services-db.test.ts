// Fachkatalog: POA-LIFECYCLE-001
// Fachkatalog: POA-SIGNING-SNAPSHOT-001
// Fachkatalog: POA-SIGNING-CONFIRMATION-001
// Fachkatalog: CLIENT-MANDATE-LIFECYCLE-001
// Fachkatalog: DOC-UPLOAD-JOURNAL-001
// Review-Finding K-03: die Vollmachten-Services (server/poa) gegen echtes
// PostgreSQL — App-Rolle mit RLS, die PoA-Integritäts-Trigger (DRAFT-Anlage,
// Statusmatrix, DB-Versandzeit), die Versionstrigger des zweiphasigen PDF-Uploads
// und die Audit-Hash-Chain. Ersetzt werden nur Session, Modulschalter, Mail,
// Object Store (Fake mit fester Speicheridentität) und die Verbindungsgrenze.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { TenantContext, TxClient } from '@taxtronik/db';
import { EvidenceService, LocalTimestampAdapter, type AuditEventInput } from '@taxtronik/evidence';
import type { CommitDocumentResult, PreparedBytesCommit } from '@taxtronik/storage';
import type { StaffCtx } from '@/server/actions/staff-action';
import type { StaffSession } from '@/server/auth/staff';
import { readPoaSigningSnapshot } from '@/server/poa/signing-snapshot';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

const fixture = vi.hoisted(() => ({
  inTransaction: false,
  transactions: 0,
  poaMode: 'MARKDOWN_OTP' as 'OFF' | 'MARKDOWN_OTP' | 'PDF_TEMPLATE',
  mails: [] as Array<Record<string, unknown>>,
  mailOk: true,
  prepared: 0,
  run: async (_ctx: TenantContext, _run: (tx: TxClient) => unknown): Promise<unknown> => undefined,
  record: async (_tx: TxClient, _event: AuditEventInput): Promise<unknown> => undefined,
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: {} }));
vi.mock('@taxtronik/config', () => ({ portalBaseUrl: 'https://portal.k03.test' }));
vi.mock('@taxtronik/db', () => ({
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
vi.mock('@/server/settings/modules', () => ({
  readModules: async () => ({ poaMode: fixture.poaMode }),
}));
vi.mock('@/server/mail/dispatch', () => ({
  sendTemplateMail: async (input: Record<string, unknown>) => {
    fixture.mails.push(input);
    return { ok: fixture.mailOk };
  },
}));
vi.mock('@taxtronik/storage', async () => {
  const { createHash: hash, randomUUID: uuid } = await import('node:crypto');
  return {
    MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
    prepareBytesCommitWithTier: async (input: {
      fileData: Buffer;
      tier: 'NONE' | 'GWG' | 'GOBD';
      tenantId: string;
    }): Promise<PreparedBytesCommit> => {
      fixture.prepared += 1;
      return {
        tier: input.tier,
        tenantId: input.tenantId,
        targetBucket: 'gobd',
        targetKey: `tenants/${input.tenantId}/gobd/poa-${uuid()}.bin`,
        sha256: hash('sha256').update(input.fileData).digest(),
        sizeBytes: BigInt(input.fileData.length),
        immutable: true,
        retentionUntil: new Date(Date.UTC(2033, 0, 1)),
        detectedMime: 'application/pdf',
      };
    },
    commitPreparedBytes: async ({
      prepared,
    }: {
      fileData: Buffer;
      prepared: PreparedBytesCommit;
    }): Promise<CommitDocumentResult> => ({
      targetBucket: prepared.targetBucket,
      targetKey: prepared.targetKey,
      storageVersionId: `object-version-${uuid()}`,
      sha256: Buffer.from(prepared.sha256),
      sizeBytes: prepared.sizeBytes,
      immutable: prepared.immutable,
      retentionUntil: prepared.retentionUntil,
      detectedMime: prepared.detectedMime,
    }),
    recoverPreparedBytesCommit: async () => null,
  };
});

import {
  createPoaRecord,
  preparePoaCreate,
  type PoaCreateInput,
  type PoaCreatePreparation,
  type PreparedPoaCreate,
} from '../create-poa';
import { sendPoaForSignature } from '../send-for-signature';
import { revokePoaTx } from '../revoke-poa';

// Der normale Qualitätsjob hat keine Datenbank; der db-Job schaltet die Suite
// ausdrücklich zu. Dann gelten nur lokale PostgreSQL-Ziele.
// B-02: lokal per POA_SERVICE_DB_TEST=1, im db-CI-Job per DB_TESTS=1 (Glob über alle
// *-db.test.ts). In CI scheitert die Suite ohne Opt-in, statt still übersprungen zu werden.
const enabled = process.env.POA_SERVICE_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'POA_SERVICE_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`POA_SERVICE_DB_TEST requires a valid ${name}.`);
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname.length < 2 ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      throw new Error(`POA_SERVICE_DB_TEST requires a loopback PostgreSQL ${name}.`);
    }
  }
}

const noPdf = async (): Promise<Buffer> => {
  throw new Error('Im In-App-Modus wird kein PDF gelesen.');
};
const pdfBytes = async () => Buffer.from('%PDF-1.7\nK-03 Vollmacht\n');
const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

(enabled ? describe : describe.skip)('K-03 Vollmachten-Services gegen PostgreSQL', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
  });
  const evidence = new EvidenceService(new LocalTimestampAdapter());
  let tenantId: string, staffId: string, clientId: string, otherClientId: string;
  let endedClientId: string, contactId: string, otherContactId: string;
  let staff: StaffCtx;

  beforeAll(async () => {
    const suffix = randomUUID();
    tenantId = (
      await owner.tenant.create({ data: { slug: `k03-poa-${suffix}`, name: 'Kanzlei K-03' } })
    ).id;
    // Vollmachten legen nur Berufsträger an (ADMIN/PARTNER-Gate der Actions).
    staffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `k03-poa-${suffix}@example.test`,
          fullName: 'K-03 Berufsträger',
          passwordHash: 'x',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    // Dokumente brauchen aktive Mandanten (GwG-Schranke): erst die verifizierte
    // GwG-Prüfung über die fail-closed Fixture, dann allow_active.
    const activeClient = async (name: string) => {
      const id = (
        await owner.client.create({
          data: { tenantId, kind: 'JURPERS', name, allowActive: false },
        })
      ).id;
      await createVerifiedLegalEntityGwgFixture(owner, {
        tenantId,
        clientId: id,
        verifiedBy: staffId,
        registerNumber: `HRB-K03-${randomUUID()}`,
      });
      await owner.client.update({ where: { id }, data: { allowActive: true } });
      return id;
    };
    clientId = await activeClient('K-03 Vollmachtgeber GmbH');
    otherClientId = await activeClient('K-03 Andere GmbH');
    endedClientId = await activeClient('K-03 Beendet GmbH');
    await owner.client.update({
      where: { id: endedClientId },
      data: { mandateEndedAt: new Date('2026-06-30T00:00:00.000Z') },
    });
    const contact = async (forClient: string, fullName: string) =>
      (
        await owner.clientContact.create({
          data: {
            tenantId,
            clientId: forClient,
            fullName,
            email: `${randomUUID()}@example.test`,
          },
        })
      ).id;
    contactId = await contact(clientId, 'Sina Signer');
    otherContactId = await contact(otherClientId, 'Fremde Person');

    const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };
    fixture.run = async (context, run) => {
      expect(context).toEqual(ctx);
      expect(fixture.inTransaction).toBe(false);
      fixture.transactions++;
      fixture.inTransaction = true;
      try {
        return await app.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${staffId},true), set_config('app.current_actor_type','STAFF',true)`;
          return run(tx);
        });
      } finally {
        fixture.inTransaction = false;
      }
    };
    fixture.record = (tx, event) => evidence.record(tx, event);
    staff = {
      session: {
        user: { tenantId, staffId, roles: ['ADMIN'], permissions: [] },
      } as unknown as StaffSession,
      ctx,
      tenantId,
      staffId,
    };
  });

  beforeEach(() => {
    fixture.transactions = 0;
    fixture.poaMode = 'MARKDOWN_OTP';
    fixture.mails = [];
    fixture.mailOk = true;
    fixture.prepared = 0;
  });

  afterAll(async () => {
    // Wie die übrigen DB-Suiten: der synthetische Tenant bleibt mit seinen
    // append-only Audit-Zeilen in der Wegwerf-Datenbank; Evidence-Guards bleiben aktiv.
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  });

  function input(patch: Partial<PoaCreateInput> = {}): PoaCreateInput {
    return {
      clientId,
      signerContactId: contactId,
      signerEmail: 'Sina.Signer@Example.TEST',
      signerName: 'Sina Signer',
      subject: `Vollmacht Finanzamt ${randomUUID().slice(0, 8)}`,
      scope: '  Vertretung gegenüber dem Finanzamt  ',
      validFrom: '2026-10-01',
      validUntil: '2099-12-31',
      pendingDocumentId: '',
      uploadIntentId: '',
      ...patch,
    };
  }

  const audits = (resourceId: string) =>
    owner.auditLog.findMany({
      where: { tenantId, resourceId },
      orderBy: { id: 'asc' },
      select: { action: true, after: true },
    });

  async function expectIntactChainTail() {
    const tail = await owner.auditLog.findMany({
      where: { tenantId },
      orderBy: { id: 'desc' },
      take: 20,
      select: { prevHash: true, thisHash: true },
    });
    for (let index = 0; index < tail.length - 1; index++) {
      expect(
        Buffer.from(tail[index]!.prevHash).equals(Buffer.from(tail[index + 1]!.thisHash)),
      ).toBe(true);
    }
  }

  /** In-App-Vollmacht über beide Service-Schritte; liefert die ID. */
  async function createInApp(patch: Partial<PoaCreateInput> = {}) {
    const data = input(patch);
    return {
      data,
      id: await createPoaRecord(staff, data, ready(await preparePoaCreate(staff, data, noPdf))),
    };
  }

  it('legt im In-App-Modus eine DRAFT-Vollmacht mit Audit an', async () => {
    const data = input();

    const preparation = await preparePoaCreate(staff, data, noPdf);
    expect(preparation).toEqual({
      ok: true,
      existingPoaId: null,
      prepared: { externMode: false, scope: 'Vertretung gegenüber dem Finanzamt', pdf: null },
    });
    const id = await createPoaRecord(staff, data, ready(preparation));

    // Kein Lese-/Upload-Schritt vor der einen Anlage-Transaktion.
    expect(fixture.transactions).toBe(1);
    expect(
      await owner.powerOfAttorney.findUnique({
        where: { id },
        select: {
          status: true,
          clientId: true,
          signerContactId: true,
          signerEmail: true,
          signerName: true,
          subject: true,
          scope: true,
          validFrom: true,
          validUntil: true,
          documentId: true,
          createdByStaff: true,
          sentAt: true,
        },
      }),
    ).toEqual({
      status: 'DRAFT',
      clientId,
      signerContactId: contactId,
      signerEmail: 'sina.signer@example.test',
      signerName: 'Sina Signer',
      subject: data.subject,
      scope: 'Vertretung gegenüber dem Finanzamt',
      validFrom: new Date('2026-10-01T00:00:00.000Z'),
      validUntil: new Date('2099-12-31T00:00:00.000Z'),
      documentId: null,
      createdByStaff: staffId,
      sentAt: null,
    });
    expect(await audits(id)).toEqual([
      {
        action: 'poa.create',
        after: {
          subject: data.subject,
          signerEmail: 'Sina.Signer@Example.TEST',
          externMode: false,
          withPdf: false,
        },
      },
    ]);
    await expectIntactChainTail();
  });

  it('prüft Mandat und Ansprechpartner erneut in der Anlage-Transaktion', async () => {
    const prepared = { externMode: false, scope: 'Vertretung', pdf: null };
    const before = await owner.powerOfAttorney.count({ where: { tenantId } });

    await expect(
      createPoaRecord(staff, input({ clientId: endedClientId, signerContactId: '' }), prepared),
    ).rejects.toThrow(
      'Fuer ein beendetes oder anonymisiertes Mandat kann keine neue Vollmacht angelegt werden.',
    );
    await expect(
      createPoaRecord(staff, input({ signerContactId: otherContactId }), prepared),
    ).rejects.toThrow('Ansprechpartner gehoert nicht zum gewaehlten Mandanten.');

    expect(await owner.powerOfAttorney.count({ where: { tenantId } })).toBe(before);
  });

  it('lehnt im In-App-Modus einen fehlenden Umfang und einen vorgemerkten PDF-Upload ab', async () => {
    await expect(preparePoaCreate(staff, input({ scope: '   ' }), noPdf)).resolves.toEqual({
      ok: false,
      error: 'Umfang (Markdown) ist im In-App-Modus Pflicht.',
    });
    fixture.poaMode = 'OFF';
    const pendingDocumentId = randomUUID();
    await expect(preparePoaCreate(staff, input({ pendingDocumentId }), noPdf)).resolves.toEqual({
      ok: false,
      error: 'Das Vollmachten-Modul ist deaktiviert.',
      pendingDocumentId,
    });
    expect(fixture.transactions).toBe(0);
  });

  it('speichert im Extern-Modus das PDF zweiphasig und bindet es an die neue Vollmacht', async () => {
    fixture.poaMode = 'PDF_TEMPLATE';
    const uploadIntentId = randomUUID();
    const data = input({ uploadIntentId, scope: '' });

    const preparation = await preparePoaCreate(staff, data, pdfBytes);
    expect(preparation).toEqual({
      ok: true,
      existingPoaId: null,
      prepared: {
        externMode: true,
        scope: '— Extern als PDF hinterlegt —',
        pdf: { documentId: uploadIntentId, versionId: expect.any(String) },
      },
    });
    const prepared = ready(preparation);
    const document = await owner.document.findUnique({
      where: { id: uploadIntentId },
      select: {
        clientId: true,
        title: true,
        classification: true,
        mimeType: true,
        retentionUntil: true,
        versions: true,
      },
    });
    expect(document).toMatchObject({
      clientId,
      title: `Vollmacht - ${data.subject}`,
      classification: 'GOBD_CONTRACT',
      mimeType: 'application/pdf',
      retentionUntil: new Date(Date.UTC(2033, 0, 1)),
    });
    // DOC-UPLOAD-JOURNAL-001: dieselbe Version wechselt von PENDING auf CLEAN.
    expect(document!.versions).toEqual([
      expect.objectContaining({
        id: prepared.pdf!.versionId,
        versionNo: 1,
        immutable: true,
        scanStatus: 'CLEAN',
        storageVersionId: expect.stringMatching(/^object-version-/),
      }),
    ]);

    const id = await createPoaRecord(staff, data, prepared);

    expect(
      await owner.powerOfAttorney.findUnique({
        where: { id },
        select: { documentId: true, scope: true, status: true },
      }),
    ).toEqual({
      documentId: uploadIntentId,
      scope: '— Extern als PDF hinterlegt —',
      status: 'DRAFT',
    });
    expect((await audits(uploadIntentId)).map((row) => row.action)).toEqual([
      'document.upload.pending',
      'document.upload.complete',
    ]);
    expect(await audits(id)).toEqual([
      expect.objectContaining({
        action: 'poa.create',
        after: expect.objectContaining({ externMode: true, withPdf: true }),
      }),
    ]);

    // Wiederholter Aufruf mit demselben Upload-Intent: kein zweites PDF, die
    // Action leitet zur vorhandenen Vollmacht.
    const prepareCalls = fixture.prepared;
    await expect(preparePoaCreate(staff, data, pdfBytes)).resolves.toEqual({
      ok: true,
      existingPoaId: id,
      prepared: null,
    });
    expect(fixture.prepared).toBe(prepareCalls);
    await expectIntactChainTail();
  });

  it('versendet zur Unterschrift: Token-Hash, Snapshot und DB-Versandzeit sind gebunden', async () => {
    const { data, id } = await createInApp();
    const draft = await owner.powerOfAttorney.findUniqueOrThrow({ where: { id } });

    const result = await sendPoaForSignature(staff, {
      poaId: id,
      expectedUpdatedAt: draft.updatedAt,
    });

    expect(result).toEqual({ ok: true });
    expect(fixture.mails).toHaveLength(1);
    const mail = fixture.mails[0]! as {
      tenantId: string;
      clientId: string;
      slug: string;
      to: string;
      vars: { link: string; expiresHours: number; client: { name: string } };
    };
    expect(mail).toMatchObject({
      tenantId,
      clientId,
      slug: 'poa-sign',
      to: 'sina.signer@example.test',
      vars: { expiresHours: 72, client: { name: 'Kanzlei K-03' } },
    });
    const token = decodeURIComponent(
      new URL(mail.vars.link).searchParams.get('token') ?? 'missing',
    );
    expect(mail.vars.link.startsWith('https://portal.k03.test/poa/sign?token=')).toBe(true);

    const sent = await owner.powerOfAttorney.findUniqueOrThrow({ where: { id } });
    expect(sent).toMatchObject({
      status: 'SENT',
      signingTokenHash: sha256Hex(token),
      signingOtpHash: null,
      signingOtpAttempts: 0,
      signingOtpAttemptsTotal: 0,
      signingDocumentVersionId: null,
    });
    // POA-LIFECYCLE-001: der erste Versandzeitpunkt stammt von der Datenbank.
    expect(sent.sentAt).toBeInstanceOf(Date);
    const ttl = sent.signingTokenExpiresAt!.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(71 * 60 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(72 * 60 * 60 * 1000);
    expect(readPoaSigningSnapshot(sent.signingContentSnapshot, sent.signingContentSha256)).toEqual({
      schemaVersion: 1,
      subject: data.subject,
      signerName: 'Sina Signer',
      signerEmail: 'sina.signer@example.test',
      validFrom: '2026-10-01',
      validUntil: '2099-12-31',
      scope: 'Vertretung gegenüber dem Finanzamt',
      document: null,
    });
    expect(await audits(id)).toEqual([
      expect.objectContaining({ action: 'poa.create' }),
      {
        action: 'poa.send',
        after: {
          signerEmail: 'sina.signer@example.test',
          contentSha256: sha256Hex(sent.signingContentSnapshot!),
          documentVersionId: null,
        },
      },
    ]);

    // Zweiter Versand mit demselben (veralteten) Seitenstand: kein Claim, keine Mail.
    await expect(
      sendPoaForSignature(staff, { poaId: id, expectedUpdatedAt: draft.updatedAt }),
    ).resolves.toEqual({
      ok: false,
      error: 'Status wurde zwischenzeitlich geändert — bitte Seite neu laden.',
    });
    expect(fixture.mails).toHaveLength(1);
    expect(
      (await owner.powerOfAttorney.findUniqueOrThrow({ where: { id } })).signingTokenHash,
    ).toBe(sha256Hex(token));
    await expectIntactChainTail();
  });

  it('bindet beim PDF-Versand die neueste Dokumentversion samt Hash', async () => {
    fixture.poaMode = 'PDF_TEMPLATE';
    const uploadIntentId = randomUUID();
    const data = input({ uploadIntentId, scope: '' });
    const prepared = ready(await preparePoaCreate(staff, data, pdfBytes));
    const id = await createPoaRecord(staff, data, prepared);
    const draft = await owner.powerOfAttorney.findUniqueOrThrow({ where: { id } });
    const version = await owner.documentVersion.findUniqueOrThrow({
      where: { id: prepared.pdf!.versionId },
    });

    await expect(
      sendPoaForSignature(staff, { poaId: id, expectedUpdatedAt: draft.updatedAt }),
    ).resolves.toEqual({ ok: true });

    const sent = await owner.powerOfAttorney.findUniqueOrThrow({ where: { id } });
    expect(sent.signingDocumentVersionId).toBe(version.id);
    expect(
      readPoaSigningSnapshot(sent.signingContentSnapshot, sent.signingContentSha256)?.document,
    ).toEqual({
      documentId: uploadIntentId,
      versionId: version.id,
      sha256: Buffer.from(version.sha256).toString('hex'),
    });
  });

  it('meldet eine nicht zugestellte Einladung; der Versand bleibt gebunden', async () => {
    const { id } = await createInApp();
    const draft = await owner.powerOfAttorney.findUniqueOrThrow({ where: { id } });
    fixture.mailOk = false;

    await expect(
      sendPoaForSignature(staff, { poaId: id, expectedUpdatedAt: draft.updatedAt }),
    ).resolves.toEqual({
      ok: false,
      error:
        'Die Vollmacht wurde vorbereitet, die E-Mail konnte aber nicht zugestellt werden. Bitte Seite neu laden und erneut senden.',
    });
    expect((await owner.powerOfAttorney.findUniqueOrThrow({ where: { id } })).status).toBe('SENT');
  });

  it('widerruft mit der Datenbank-Uhr, entwertet den Token und erledigt Hinweise', async () => {
    const { id } = await createInApp();
    const draft = await owner.powerOfAttorney.findUniqueOrThrow({ where: { id } });
    await sendPoaForSignature(staff, { poaId: id, expectedUpdatedAt: draft.updatedAt });
    const notification = await owner.notification.create({
      data: {
        tenantId,
        staffId,
        kind: 'POA_SIGNED',
        title: 'Vollmacht',
        resourceType: 'power_of_attorney',
        resourceId: id,
      },
    });
    const before = Date.now();

    await fixture.run(staff.ctx, (tx) =>
      revokePoaTx(tx, staff, { poaId: id, reason: 'Mandant hat widerrufen' }),
    );

    const revoked = await owner.powerOfAttorney.findUniqueOrThrow({ where: { id } });
    expect(revoked).toMatchObject({
      status: 'REVOKED',
      revokedReason: 'Mandant hat widerrufen',
      signingTokenHash: null,
      signingOtpHash: null,
    });
    expect(revoked.revokedAt!.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(
      (await owner.notification.findUniqueOrThrow({ where: { id: notification.id } })).readAt,
    ).toBeInstanceOf(Date);
    expect((await audits(id)).at(-1)).toEqual({
      action: 'poa.revoke',
      after: { reason: 'Mandant hat widerrufen' },
    });

    // REVOKED ist terminal: weder ein zweiter Widerruf noch ein erneuter Versand.
    await expect(
      fixture.run(staff.ctx, (tx) => revokePoaTx(tx, staff, { poaId: id, reason: 'nochmals' })),
    ).rejects.toThrow('Bereits widerrufen.');
    await expect(
      sendPoaForSignature(staff, { poaId: id, expectedUpdatedAt: revoked.updatedAt }),
    ).resolves.toEqual({ ok: false, error: 'Vollmacht ist widerrufen.' });
    await expectIntactChainTail();
  });
});

/** Die vorbereitete Anlage — weder abgelehnt noch eine schon vorhandene Vollmacht. */
function ready(preparation: PoaCreatePreparation): PreparedPoaCreate {
  if (!preparation.ok || !preparation.prepared) {
    throw new Error(`Vorbereitung ohne Anlage: ${JSON.stringify(preparation)}`);
  }
  return preparation.prepared;
}
