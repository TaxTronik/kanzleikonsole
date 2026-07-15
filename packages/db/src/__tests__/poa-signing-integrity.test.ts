// =============================================================================
// PoA-Signaturintegrität (Migration 03600) — echte PostgreSQL-Regressionen.
//
// Der Trigger schützt auch Owner-/BYPASSRLS-Zugriffe. Legacy-SENT/SIGNED ohne
// Snapshot werden gezielt mit vorübergehend deaktiviertem EINZEL-Trigger
// angelegt; DISABLE/INSERT/ENABLE laufen in derselben Transaktion, sodass der
// Trigger selbst bei einem Testfehler niemals global deaktiviert bleibt.
// =============================================================================

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const hasDatabase = Boolean(process.env['DATABASE_URL']);

if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('PoA-Integritätstest braucht DATABASE_URL in CI.');
}

const describeWithDatabase = hasDatabase ? describe : describe.skip;
const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const contender = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

let tenantId: string;
let clientId: string;
let staffId: string;
let documentId: string;
let versionId: string;
const VERSION_SHA256 = Buffer.alloc(32, 0xab);

beforeAll(async () => {
  const tenant = await owner.tenant.create({
    data: { slug: `test-poa-integrity-${Date.now()}`, name: 'PoA-Integrität Test' },
  });
  tenantId = tenant.id;
  const staff = await owner.staffUser.create({
    data: {
      tenantId,
      email: `poa-integrity-${Date.now()}@test.local`,
      fullName: 'PoA Test Staff',
      passwordHash: 'x',
    },
  });
  staffId = staff.id;
  const client = await owner.client.create({
    data: { tenantId, kind: 'JURPERS', name: 'PoA Testmandant', allowActive: false },
  });
  clientId = client.id;
  await createVerifiedLegalEntityGwgFixture(owner, {
    tenantId,
    clientId,
    verifiedBy: staffId,
    validUntil: new Date('2099-12-31T00:00:00.000Z'),
    registerNumber: 'HRB 12345',
    registerAuthority: 'Amtsgericht Berlin',
    representativeNames: ['Erika Muster'],
    ownershipStructureNotes: 'Teststruktur',
  });
  await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });

  const document = await owner.document.create({
    data: {
      tenantId,
      clientId,
      title: 'Vollmacht.pdf',
      classification: 'GOBD_CONTRACT',
      mimeType: 'application/pdf',
    },
  });
  documentId = document.id;
  const version = await owner.documentVersion.create({
    data: {
      documentId,
      versionNo: 1,
      storageBucket: 'test',
      storageKey: `${tenantId}/poa/v1.pdf`,
      sha256: VERSION_SHA256,
      sizeBytes: 123n,
      immutable: false,
      scanStatus: 'CLEAN',
      scanCompletedAt: new Date(),
      createdById: staffId,
    },
  });
  versionId = version.id;
});

afterAll(async () => {
  if (tenantId) await owner.tenant.deleteMany({ where: { id: tenantId } });
  await contender.$disconnect();
  await owner.$disconnect();
});

let sequence = 0;

async function makeDraft(
  opts: { external?: boolean; forClientId?: string; createdAt?: Date } = {},
) {
  sequence += 1;
  return owner.powerOfAttorney.create({
    data: {
      tenantId,
      clientId: opts.forClientId ?? clientId,
      signerEmail: `signer-${sequence}@example.de`,
      signerName: `Sina Signer ${sequence}`,
      subject: `Vollmacht ${sequence}`,
      scope: opts.external ? '— Extern als PDF hinterlegt —' : 'Vertretung gegenüber dem Finanzamt',
      validFrom: new Date('2026-08-01T00:00:00.000Z'),
      validUntil: new Date('2099-08-01T00:00:00.000Z'),
      status: 'DRAFT',
      createdByStaff: staffId,
      documentId: opts.external ? documentId : null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
}

function snapshotFor(poa: {
  subject: string;
  signerName: string;
  signerEmail: string;
  scope: string;
  documentId: string | null;
}) {
  const serialized = JSON.stringify({
    schemaVersion: 1,
    subject: poa.subject,
    signerName: poa.signerName,
    signerEmail: poa.signerEmail,
    validFrom: '2026-08-01',
    validUntil: '2099-08-01',
    scope: poa.documentId ? null : poa.scope,
    document: poa.documentId
      ? {
          documentId,
          versionId,
          sha256: VERSION_SHA256.toString('hex'),
        }
      : null,
  });
  return {
    serialized,
    sha256: createHash('sha256').update(serialized, 'utf8').digest(),
    documentVersionId: poa.documentId ? versionId : null,
  };
}

async function sendValid(poa: Awaited<ReturnType<typeof makeDraft>>) {
  const snapshot = snapshotFor(poa);
  const sent = await owner.powerOfAttorney.update({
    where: { id: poa.id },
    data: {
      status: 'SENT',
      signingTokenHash: `token-${poa.id}`,
      signingTokenExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      signingContentSnapshot: snapshot.serialized,
      signingContentSha256: snapshot.sha256,
      signingDocumentVersionId: snapshot.documentVersionId,
    },
  });
  return { sent, snapshot };
}

function signedAtAfterSend(sent: { sentAt: Date | null }): Date {
  if (!sent.sentAt) throw new Error('Test-Fixture: sentAt fehlt nach DRAFT -> SENT.');
  // PostgreSQL kann sent_at mit höherer Sub-Millisekunden-Präzision halten,
  // als JavaScript Date beim Roundtrip abbildet. Ein klarer +1s-Abstand stellt
  // sicher, dass der Fixture-Zeitpunkt auch unter Last wirklich danach liegt.
  return new Date(sent.sentAt.getTime() + 1_000);
}

async function revokeWithDatabaseClock(id: string, reason: string) {
  const [revoked] = await owner.$queryRaw<Array<{ id: string; revokedAt: Date }>>(Prisma.sql`
    UPDATE "power_of_attorney"
       SET "status" = 'REVOKED',
           "revoked_at" = statement_timestamp(),
           "revoked_reason" = ${reason},
           "signing_token_hash" = NULL,
           "signing_otp_hash" = NULL,
           "updated_at" = statement_timestamp()
     WHERE "id" = ${id}::uuid
       AND "tenant_id" = ${tenantId}::uuid
       AND "status" <> 'REVOKED'
     RETURNING "id", "revoked_at" AS "revokedAt"
  `);
  if (!revoked) throw new Error('Test-Fixture: Widerruf hat keine Zeile aktualisiert.');
  return revoked;
}

async function makeLegacy(
  status: 'SENT' | 'SIGNED',
  opts: { prepopulatedEvidence?: boolean } = {},
) {
  sequence += 1;
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'ALTER TABLE "power_of_attorney" DISABLE TRIGGER poa_protect_integrity',
    );
    const row = await tx.powerOfAttorney.create({
      data: {
        tenantId,
        clientId,
        signerEmail: `legacy-${sequence}@example.de`,
        signerName: `Legacy ${sequence}`,
        subject: `Legacy Vollmacht ${sequence}`,
        scope: 'Legacy-Inhalt',
        validFrom: new Date('2026-08-01T00:00:00.000Z'),
        validUntil: new Date('2099-08-01T00:00:00.000Z'),
        status,
        signedAt:
          status === 'SIGNED' || opts.prepopulatedEvidence
            ? new Date('2020-02-01T00:00:00.000Z')
            : null,
        signedContentSha256: opts.prepopulatedEvidence ? Buffer.alloc(32, 0xef) : null,
        signingTokenHash: status === 'SENT' ? `legacy-token-${sequence}` : null,
        createdByStaff: staffId,
      },
    });
    await tx.$executeRawUnsafe(
      'ALTER TABLE "power_of_attorney" ENABLE TRIGGER poa_protect_integrity',
    );
    return row;
  });
}

const retentionRedaction = {
  signerContactId: null,
  signerName: 'Anonymisiert',
  signerEmail: 'anonymisiert@taxtronik.local',
  subject: 'Anonymisiert',
  scope: 'Anonymisiert',
  signingTokenHash: null,
  signingTokenExpiresAt: null,
  signingOtpHash: null,
  signingOtpExpiresAt: null,
  signingOtpAttempts: 0,
  signingOtpAttemptsTotal: 0,
  signingContentSnapshot: null,
  signingContentSha256: null,
  signingDocumentVersionId: null,
  signedAt: null,
  signedContentSha256: null,
  signedDocumentVersionId: null,
  signedByIp: null,
  signedByUserAgent: null,
  documentId: null,
  revokedReason: null,
} as const;

async function makeNaturalPersonForRetention(mandateEndedAt: string) {
  sequence += 1;
  return owner.client.create({
    data: {
      tenantId,
      kind: 'NATPERS',
      name: 'Anonymisiert',
      allowActive: false,
      mandateEndedAt: new Date(mandateEndedAt),
    },
  });
}

describeWithDatabase('PoA-DB-Invarianten: Versand-Snapshot', () => {
  it('erzwingt DRAFT als Initialstatus und eine echte Tenant-/Client-Paarung', async () => {
    sequence += 1;
    await expect(
      owner.powerOfAttorney.create({
        data: {
          tenantId,
          clientId,
          signerEmail: `direct-signed-${sequence}@example.de`,
          signerName: `Direct Signed ${sequence}`,
          subject: `Direkt signiert ${sequence}`,
          scope: 'Unzulässiger Direktpfad',
          validFrom: new Date('2026-08-01T00:00:00.000Z'),
          status: 'SIGNED',
          signedAt: new Date(),
          signedContentSha256: Buffer.alloc(32, 0xaa),
          createdByStaff: staffId,
        },
      }),
    ).rejects.toThrow(/Status DRAFT/);

    const otherTenant = await owner.tenant.create({
      data: { slug: `poa-scope-${Date.now()}`, name: 'PoA Scope Tenant' },
    });
    try {
      const otherClient = await owner.client.create({
        data: { tenantId: otherTenant.id, kind: 'NATPERS', name: 'Fremdmandant' },
      });
      const draft = await makeDraft();
      await expect(
        owner.powerOfAttorney.update({
          where: { id: draft.id },
          data: { clientId: otherClient.id },
        }),
      ).rejects.toThrow();
      await expect(
        owner.powerOfAttorney.create({
          data: {
            tenantId,
            clientId: otherClient.id,
            signerEmail: `wrong-scope-${sequence}@example.de`,
            signerName: 'Falscher Scope',
            subject: 'Falscher Scope',
            scope: 'Falscher Scope',
            validFrom: new Date('2026-08-01T00:00:00.000Z'),
            status: 'DRAFT',
            createdByStaff: staffId,
          },
        }),
      ).rejects.toThrow(/angegebenen Tenant|Foreign key constraint/i);
    } finally {
      await owner.tenant.delete({ where: { id: otherTenant.id } });
    }
  });

  it('blockiert DRAFT -> SENT ohne vollständigen Snapshot', async () => {
    const poa = await makeDraft();
    await expect(
      owner.powerOfAttorney.update({ where: { id: poa.id }, data: { status: 'SENT' } }),
    ).rejects.toThrow(/Snapshot|SHA-256/);
  });

  it('blockiert falsche Hashlänge und einen nicht zum JSON passenden Hash', async () => {
    const short = await makeDraft();
    const shortSnapshot = snapshotFor(short);
    await expect(
      owner.powerOfAttorney.update({
        where: { id: short.id },
        data: {
          status: 'SENT',
          signingContentSnapshot: shortSnapshot.serialized,
          signingContentSha256: Buffer.alloc(31),
        },
      }),
    ).rejects.toThrow(/32 Byte/);

    const wrong = await makeDraft();
    const wrongSnapshot = snapshotFor(wrong);
    await expect(
      owner.powerOfAttorney.update({
        where: { id: wrong.id },
        data: {
          status: 'SENT',
          signingContentSnapshot: wrongSnapshot.serialized,
          signingContentSha256: Buffer.alloc(32, 0xcd),
        },
      }),
    ).rejects.toThrow(/stimmt nicht/);
  });

  it('akzeptiert nur das exakte Snapshot-Schema ohne verborgene Zusatzfelder', async () => {
    const extra = await makeDraft();
    const base = JSON.parse(snapshotFor(extra).serialized) as Record<string, unknown>;
    const withHiddenField = JSON.stringify({ ...base, hiddenEvidence: 'nicht angezeigt' });
    await expect(
      owner.powerOfAttorney.update({
        where: { id: extra.id },
        data: {
          status: 'SENT',
          signingContentSnapshot: withHiddenField,
          signingContentSha256: createHash('sha256').update(withHiddenField).digest(),
        },
      }),
    ).rejects.toThrow(/unvollständig/);

    const wrongType = await makeDraft();
    const wrongSchema = JSON.stringify({
      ...(JSON.parse(snapshotFor(wrongType).serialized) as Record<string, unknown>),
      schemaVersion: '1',
    });
    await expect(
      owner.powerOfAttorney.update({
        where: { id: wrongType.id },
        data: {
          status: 'SENT',
          signingContentSnapshot: wrongSchema,
          signingContentSha256: createHash('sha256').update(wrongSchema).digest(),
        },
      }),
    ).rejects.toThrow(/unvollständig/);
  });

  it('validiert externe Dokument-ID, Versions-ID und den echten Version-Hash', async () => {
    const poa = await makeDraft({ external: true });
    const snapshot = snapshotFor(poa);
    const tampered = snapshot.serialized.replace(
      VERSION_SHA256.toString('hex'),
      Buffer.alloc(32, 0xcd).toString('hex'),
    );
    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: {
          status: 'SENT',
          signingContentSnapshot: tampered,
          signingContentSha256: createHash('sha256').update(tampered).digest(),
          signingDocumentVersionId: versionId,
        },
      }),
    ).rejects.toThrow(/Dokumenthash/);

    await expect(sendValid(poa)).resolves.toBeTruthy();
  });

  it('erlaubt OTP-Updates und Resend mit identischem Snapshot, blockiert Inhaltsänderung', async () => {
    const poa = await makeDraft();
    const { snapshot } = await sendValid(poa);
    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: {
          signingOtpHash: 'otp-hash',
          signingOtpExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
          signingOtpAttempts: 1,
        },
      }),
    ).resolves.toBeTruthy();
    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: {
          signingTokenHash: 'resend-token',
          signingContentSnapshot: snapshot.serialized,
          signingContentSha256: snapshot.sha256,
          signingDocumentVersionId: snapshot.documentVersionId,
        },
      }),
    ).resolves.toBeTruthy();
    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: { scope: 'Nachträglich erweitert' },
      }),
    ).rejects.toThrow(/Inhaltsfelder/);
  });

  it('setzt den ersten Versandzeitpunkt DB-seitig und friert ihn ein', async () => {
    const poa = await makeDraft();
    const { sent } = await sendValid(poa);
    expect(sent.sentAt).toBeInstanceOf(Date);
    expect(sent.sentAt!.getTime()).toBeGreaterThanOrEqual(poa.createdAt.getTime());

    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: { sentAt: new Date('2000-01-01T00:00:00.000Z') },
      }),
    ).rejects.toThrow(/Versandzeitpunkt/);
  });

  it('rundet sent_at wie created_at, ohne zukünftige Erstellzeiten zu übernehmen', async () => {
    const poa = await makeDraft();
    const { sent } = await sendValid(poa);
    const [precision] = await owner.$queryRaw<Array<{ millisecondAligned: boolean }>>(
      Prisma.sql`
        SELECT "sent_at" = date_trunc('milliseconds', "sent_at") AS "millisecondAligned"
          FROM "power_of_attorney"
         WHERE "id" = ${poa.id}::uuid
      `,
    );

    expect(sent.sentAt).not.toBeNull();
    expect(sent.sentAt!.getTime()).toBeGreaterThanOrEqual(poa.createdAt.getTime());

    // created_at ist normalerweise DB-seitig gesetzt. Ein manipuliertes Datum
    // darf die Versandprovenienz weder in die Zukunft ziehen noch den CHECK
    // umgehen, der sent_at an die Erstellzeit bindet.
    const future = await makeDraft({ createdAt: new Date(Date.now() + 60_000) });
    await expect(sendValid(future)).rejects.toThrow(/poa_sent_at_after_created_check/);
    expect(precision?.millisecondAligned).toBe(true);
  });
});

describeWithDatabase('PoA-DB-Invarianten: Signatur und Terminalstatus', () => {
  it('verbietet vorbefüllte oder außerhalb SENT -> SIGNED nachgetragene Signaturnachweise', async () => {
    sequence += 1;
    await expect(
      owner.powerOfAttorney.create({
        data: {
          tenantId,
          clientId,
          signerEmail: `terminal-${sequence}@example.de`,
          signerName: `Terminal ${sequence}`,
          subject: `Terminal Vollmacht ${sequence}`,
          scope: 'Nicht signiert',
          validFrom: new Date('2026-08-01T00:00:00.000Z'),
          status: 'EXPIRED',
          signedAt: new Date(),
          signedContentSha256: Buffer.alloc(32, 0xaa),
          createdByStaff: staffId,
        },
      }),
    ).rejects.toThrow(/Signaturnachweis|Status DRAFT/);

    const draft = await makeDraft();
    await expect(
      owner.powerOfAttorney.update({
        where: { id: draft.id },
        data: { signedAt: new Date(), signedByIp: '203.0.113.10' },
      }),
    ).rejects.toThrow(/Signaturnachweis/);

    const sent = await makeDraft();
    const { snapshot } = await sendValid(sent);
    await expect(
      owner.powerOfAttorney.update({
        where: { id: sent.id },
        data: { signedAt: new Date(), signedContentSha256: snapshot.sha256 },
      }),
    ).rejects.toThrow(/Signaturnachweis/);

    const terminal = await makeDraft();
    await expect(
      owner.powerOfAttorney.update({
        where: { id: terminal.id },
        data: {
          status: 'REVOKED',
          signedAt: new Date(),
          signedContentSha256: Buffer.alloc(32, 0xaa),
        },
      }),
    ).rejects.toThrow(/Signaturnachweis/);
  });

  it('erzwingt beim SENT -> SIGNED denselben Hash und dieselbe Dokumentversion', async () => {
    const poa = await makeDraft({ external: true });
    const { sent, snapshot } = await sendValid(poa);
    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: {
          status: 'SIGNED',
          signedAt: signedAtAfterSend(sent),
          signedContentSha256: Buffer.alloc(32, 0xcd),
          signedDocumentVersionId: versionId,
        },
      }),
    ).rejects.toThrow(/Signaturhash/);
    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: {
          status: 'SIGNED',
          signedAt: signedAtAfterSend(sent),
          signedContentSha256: snapshot.sha256,
          signedDocumentVersionId: '33333333-3333-4333-8333-333333333333',
        },
      }),
    ).rejects.toThrow(/Dokumentversion/);
    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: {
          status: 'SIGNED',
          signedAt: signedAtAfterSend(sent),
          signedContentSha256: snapshot.sha256,
          signedDocumentVersionId: versionId,
        },
      }),
    ).resolves.toBeTruthy();
  });

  it('verhindert Rückdatierung und friert die technische Signaturprovenienz ein', async () => {
    const poa = await makeDraft();
    const { sent, snapshot } = await sendValid(poa);
    expect(sent.sentAt).not.toBeNull();

    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: {
          status: 'SIGNED',
          signedAt: new Date('1900-01-01T00:00:00.000Z'),
          signedContentSha256: snapshot.sha256,
        },
      }),
    ).rejects.toThrow(/Signaturzeitpunkt/);

    const signed = await owner.powerOfAttorney.update({
      where: { id: poa.id },
      data: {
        status: 'SIGNED',
        signedAt: signedAtAfterSend(sent),
        signedByIp: '203.0.113.10',
        signedByUserAgent: 'PoA-Test/1.0',
        signedContentSha256: snapshot.sha256,
      },
    });
    expect(signed.signedByIp).toBe('203.0.113.10');

    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: { signedByIp: '203.0.113.11', signedByUserAgent: 'Manipuliert' },
      }),
    ).rejects.toThrow(/Signaturnachweis/);
    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: { createdAt: new Date('2000-01-01T00:00:00.000Z') },
      }),
    ).rejects.toThrow(/Erstellungsprovenienz/);
  });

  it('friert Signaturnachweis und gebundene Unterzeichnerdaten bis zur Retention ein', async () => {
    const poa = await makeDraft();
    const { sent, snapshot } = await sendValid(poa);
    const signedAt = signedAtAfterSend(sent);
    await owner.powerOfAttorney.update({
      where: { id: poa.id },
      data: {
        status: 'SIGNED',
        signedAt,
        signedContentSha256: snapshot.sha256,
      },
    });
    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: { signedAt: new Date('2026-08-02T12:00:00.000Z') },
      }),
    ).rejects.toThrow(/Signaturnachweis/);
    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: {
          signerName: 'Anonymisiert',
          signerEmail: 'anonymisiert@taxtronik.local',
          signedByIp: null,
          signedByUserAgent: null,
        },
      }),
    ).rejects.toThrow(/Inhaltsfelder/);
  });

  it('erlaubt die exakte DSGVO-Redaktion nur nach Fristablauf und ohne Reparenting', async () => {
    const dueClient = await makeNaturalPersonForRetention('2010-06-30T00:00:00.000Z');
    const recentClient = await makeNaturalPersonForRetention('2025-06-30T00:00:00.000Z');

    const duePoa = await makeDraft({ forClientId: dueClient.id });
    const { sent: dueSent, snapshot: dueSnapshot } = await sendValid(duePoa);
    await owner.powerOfAttorney.update({
      where: { id: duePoa.id },
      data: {
        status: 'SIGNED',
        signedAt: signedAtAfterSend(dueSent),
        signedContentSha256: dueSnapshot.sha256,
      },
    });
    await owner.client.update({ where: { id: dueClient.id }, data: { anonymizedAt: new Date() } });

    await expect(
      owner.powerOfAttorney.update({
        where: { id: duePoa.id },
        data: { ...retentionRedaction, validFrom: new Date('2000-01-01T00:00:00.000Z') },
      }),
    ).rejects.toThrow(/Inhaltsfelder/);

    const recentPoa = await makeDraft({ forClientId: recentClient.id });
    const { sent: recentSent, snapshot: recentSnapshot } = await sendValid(recentPoa);
    await owner.powerOfAttorney.update({
      where: { id: recentPoa.id },
      data: {
        status: 'SIGNED',
        signedAt: signedAtAfterSend(recentSent),
        signedContentSha256: recentSnapshot.sha256,
      },
    });
    await owner.client.update({
      where: { id: recentClient.id },
      data: { anonymizedAt: new Date() },
    });
    await expect(
      owner.powerOfAttorney.update({
        where: { id: recentPoa.id },
        data: retentionRedaction,
      }),
    ).rejects.toThrow(/Inhaltsfelder|Versand-Snapshot|Signaturnachweis|Signer-Retention/);

    const otherPoa = await makeDraft();
    const { sent: otherSent, snapshot: otherSnapshot } = await sendValid(otherPoa);
    await owner.powerOfAttorney.update({
      where: { id: otherPoa.id },
      data: {
        status: 'SIGNED',
        signedAt: signedAtAfterSend(otherSent),
        signedContentSha256: otherSnapshot.sha256,
      },
    });
    await expect(
      owner.powerOfAttorney.update({
        where: { id: otherPoa.id },
        data: { ...retentionRedaction, clientId: dueClient.id },
      }),
    ).rejects.toThrow(
      /Inhaltsfelder|Versand-Snapshot|Signaturnachweis|Neuanlage\/-zuordnung|Signer-Retention/,
    );

    const redacted = await owner.powerOfAttorney.update({
      where: { id: duePoa.id },
      data: retentionRedaction,
    });
    expect(redacted).toMatchObject({
      clientId: dueClient.id,
      signerName: 'Anonymisiert',
      signerEmail: 'anonymisiert@taxtronik.local',
      subject: 'Anonymisiert',
      scope: 'Anonymisiert',
      signingContentSnapshot: null,
      signingContentSha256: null,
      signedAt: null,
      signedContentSha256: null,
      documentId: null,
    });
  });

  it('redigiert fällige JURPERS/PERSGES-Signer über den Marker und sperrt Neuanlagen', async () => {
    const legalClient = await owner.client.create({
      data: {
        tenantId,
        kind: 'JURPERS',
        name: 'Retention GmbH',
        allowActive: false,
        mandateEndedAt: new Date('2010-06-30T00:00:00.000Z'),
      },
    });
    const poa = await makeDraft({ forClientId: legalClient.id });
    const { sent, snapshot } = await sendValid(poa);
    await owner.powerOfAttorney.update({
      where: { id: poa.id },
      data: {
        status: 'SIGNED',
        signedAt: signedAtAfterSend(sent),
        signedContentSha256: snapshot.sha256,
      },
    });

    await owner.client.update({
      where: { id: legalClient.id },
      data: { poaSignerDataRedactedAt: new Date() },
    });
    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: retentionRedaction,
      }),
    ).resolves.toMatchObject({
      clientId: legalClient.id,
      signerName: 'Anonymisiert',
      signingContentSnapshot: null,
      signedContentSha256: null,
    });

    await expect(makeDraft({ forClientId: legalClient.id })).rejects.toThrow(/Signer-Retention/);
  });

  it('serialisiert eine NATPERS-Retention mit paralleler PoA-Neuanlage', async () => {
    const dueClient = await makeNaturalPersonForRetention('2010-06-30T00:00:00.000Z');
    let releaseRetention!: () => void;
    let retentionLocked!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseRetention = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      retentionLocked = resolve;
    });

    const retentionTx = owner.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM public."client"
                       WHERE "id" = ${dueClient.id}::uuid FOR UPDATE`,
        );
        await tx.client.update({
          where: { id: dueClient.id },
          data: { anonymizedAt: new Date() },
        });
        retentionLocked();
        await release;
      },
      { timeout: 10_000 },
    );

    await locked;
    let reportPid!: (pid: number) => void;
    const pidReady = new Promise<number>((resolve) => {
      reportPid = resolve;
    });
    const insert = contender.$transaction(
      async (tx) => {
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid()::integer AS pid`,
        );
        reportPid(backend!.pid);
        return tx.powerOfAttorney.create({
          data: {
            tenantId,
            clientId: dueClient.id,
            signerEmail: `retention-race-${Date.now()}@example.de`,
            signerName: 'Retention Race',
            subject: 'Retention Race',
            scope: 'Darf nicht nachlaufen',
            validFrom: new Date('2026-08-01T00:00:00.000Z'),
            status: 'DRAFT',
            createdByStaff: staffId,
          },
        });
      },
      { timeout: 10_000 },
    );

    try {
      const pid = await pidReady;
      let observedLockWait = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [activity] = await owner.$queryRaw<Array<{ waiting: boolean }>>(
          Prisma.sql`SELECT COALESCE(wait_event_type = 'Lock', FALSE) AS waiting
                       FROM pg_stat_activity WHERE pid = ${pid}`,
        );
        if (activity?.waiting) {
          observedLockWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedLockWait).toBe(true);
    } finally {
      releaseRetention();
    }

    await retentionTx;
    await expect(insert).rejects.toThrow(/Signer-Retention/);
    expect(await owner.powerOfAttorney.count({ where: { clientId: dueClient.id } })).toBe(0);
  }, 15_000);

  it('lässt Revoke/Expiry vorwärts zu, aber keine Rücktransition', async () => {
    const incompleteRevoke = await makeDraft();
    await expect(
      owner.powerOfAttorney.update({
        where: { id: incompleteRevoke.id },
        data: { status: 'REVOKED' },
      }),
    ).rejects.toThrow(/Widerruf/);

    const revokedDraft = await makeDraft();
    const revoked = await revokeWithDatabaseClock(revokedDraft.id, 'Widerruf');
    expect(revoked.revokedAt.getTime()).toBeGreaterThanOrEqual(revokedDraft.createdAt.getTime());
    await expect(
      owner.powerOfAttorney.update({
        where: { id: revokedDraft.id },
        data: { revokedReason: 'Nachträglich verändert' },
      }),
    ).rejects.toThrow(/Widerrufsnachweis/);
    await expect(
      owner.powerOfAttorney.update({ where: { id: revokedDraft.id }, data: { status: 'DRAFT' } }),
    ).rejects.toThrow(/Statuswechsel/);

    const backdatedRevoke = await makeDraft();
    await expect(
      owner.powerOfAttorney.update({
        where: { id: backdatedRevoke.id },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(backdatedRevoke.createdAt.getTime() - 1_000),
          revokedReason: 'Rueckdatierter Widerruf',
        },
      }),
    ).rejects.toThrow(/Widerrufszeitpunkt/);

    const signed = await makeDraft();
    const { sent, snapshot } = await sendValid(signed);
    await owner.powerOfAttorney.update({
      where: { id: signed.id },
      data: {
        status: 'SIGNED',
        signedAt: signedAtAfterSend(sent),
        signedContentSha256: snapshot.sha256,
      },
    });
    await expect(
      owner.powerOfAttorney.update({ where: { id: signed.id }, data: { status: 'EXPIRED' } }),
    ).resolves.toBeTruthy();
    await expect(
      owner.powerOfAttorney.update({ where: { id: signed.id }, data: { status: 'SIGNED' } }),
    ).rejects.toThrow(/Statuswechsel/);
  });
});

describeWithDatabase('PoA-DB-Invarianten: Legacy-Kompatibilität', () => {
  it('Legacy-SENT ohne Snapshot bleibt OTP-fähig und widerrufbar', async () => {
    const poa = await makeLegacy('SENT');
    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: { signingOtpHash: 'legacy-otp', signingOtpAttempts: 1 },
      }),
    ).resolves.toBeTruthy();
    await expect(revokeWithDatabaseClock(poa.id, 'Legacy-Widerruf')).resolves.toBeTruthy();
  });

  it('Legacy-SENT muss separat neu versendet werden, bevor SIGNED zulässig ist', async () => {
    const poa = await makeLegacy('SENT');
    const snapshot = snapshotFor(poa);
    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: {
          status: 'SIGNED',
          signingContentSnapshot: snapshot.serialized,
          signingContentSha256: snapshot.sha256,
          signedAt: new Date(),
          signedContentSha256: snapshot.sha256,
        },
      }),
    ).rejects.toThrow(/separat neu versendet|vor der Signatur/);

    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: {
          signingContentSnapshot: snapshot.serialized,
          signingContentSha256: snapshot.sha256,
        },
      }),
    ).resolves.toBeTruthy();
  });

  it('Legacy-SENT mit vorbefülltem Nachweis kann nicht mit vordatierten Daten signieren', async () => {
    const poa = await makeLegacy('SENT', { prepopulatedEvidence: true });
    const snapshot = snapshotFor(poa);
    await owner.powerOfAttorney.update({
      where: { id: poa.id },
      data: {
        signingContentSnapshot: snapshot.serialized,
        signingContentSha256: snapshot.sha256,
      },
    });

    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: { status: 'SIGNED' },
      }),
    ).rejects.toThrow(/atomar/);
  });

  it('Legacy-SIGNED ohne Snapshot bleibt expirable; Redaktion bleibt retention-gebunden', async () => {
    const poa = await makeLegacy('SIGNED');
    await expect(
      owner.powerOfAttorney.update({
        where: { id: poa.id },
        data: {
          signerName: 'Anonymisiert',
          signerEmail: 'anonymisiert@taxtronik.local',
          signedByIp: null,
          signedByUserAgent: null,
        },
      }),
    ).rejects.toThrow(/Inhaltsfelder/);
    await expect(
      owner.powerOfAttorney.update({ where: { id: poa.id }, data: { status: 'EXPIRED' } }),
    ).resolves.toBeTruthy();
  });
});
