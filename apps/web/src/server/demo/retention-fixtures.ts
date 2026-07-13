// =============================================================================
// Dev-Fixture: GwG-Retention/Object-Lock testen.
//
// Erzeugt drei Demo-Mandate mit echten GWG_EVIDENCE-Objekten im S3/GwG-Bucket:
//   1. löschreif, Object-Lock abgelaufen      -> Vernichtung sollte durchgehen
//   2. löschreif, Object-Lock läuft noch      -> Queue sichtbar, Action blockt
//   3. Mandat noch nicht löschreif            -> Queue unsichtbar
//
// Bewusst nie in Production ausführen.
// =============================================================================

import { randomUUID, createHash } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { Prisma } from '@taxtronik/db/prisma-client';
import { s3, getBucketForTier } from '@taxtronik/storage';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { prismaOwner } from '@/server/db/prisma-owner';
import { evidenceService } from '@/server/container';

if (process.env['NODE_ENV'] === 'production') {
  console.error('[demo-retention] FATAL: Retention-Demodaten nie in Produktion seeden.');
  process.exit(1);
}

const DEMO_STAFF_EMAIL = 'admin@taxtronik.local';

type Fixture = {
  datevNo: string;
  clientName: string;
  title: string;
  mandateEndedAt: Date;
  retainUntil: Date;
  queueExpectation: string;
};

const fixtures: Fixture[] = [
  {
    datevNo: '19901',
    clientName: 'Demo GwG - loeschreif, Object-Lock abgelaufen',
    title: 'Demo GwG Nachweis - Object-Lock abgelaufen',
    mandateEndedAt: new Date(Date.UTC(2018, 5, 30)),
    retainUntil: new Date(Date.UTC(2025, 0, 1)),
    queueExpectation: 'sichtbar; Vernichtung sollte durchgehen',
  },
  {
    datevNo: '19902',
    clientName: 'Demo GwG - loeschreif, Object-Lock aktiv',
    title: 'Demo GwG Nachweis - Object-Lock aktiv',
    mandateEndedAt: new Date(Date.UTC(2018, 5, 30)),
    retainUntil: new Date(Date.UTC(2032, 0, 1)),
    queueExpectation: 'sichtbar; Vernichtung muss vor Object-Lock-Ablauf blocken',
  },
  {
    datevNo: '19903',
    clientName: 'Demo GwG - noch nicht loeschreif',
    title: 'Demo GwG Nachweis - Mandat jung',
    mandateEndedAt: new Date(Date.UTC(2024, 5, 30)),
    retainUntil: new Date(Date.UTC(2032, 0, 1)),
    queueExpectation: 'nicht sichtbar; gesetzliche Loeschfrist laeuft noch',
  },
];

function pdfBytes(title: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n` + `% ${title}\n%%EOF\n`,
    'utf8',
  );
}

async function main() {
  const tenant = await prismaOwner.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant)
    throw new Error('Kein Tenant gefunden. Erst pnpm db:seed oder Provisioning ausfuehren.');

  const staff = await prismaOwner.staffUser.findFirst({
    where: { tenantId: tenant.id, email: DEMO_STAFF_EMAIL },
    orderBy: { createdAt: 'asc' },
  });
  if (!staff) throw new Error(`Kein Demo-Staff ${DEMO_STAFF_EMAIL} gefunden.`);

  const gwgType = await prismaOwner.documentType.findFirst({
    where: { tenantId: tenant.id, classificationKey: 'GWG_EVIDENCE' },
    select: { id: true },
  });
  if (!gwgType) throw new Error('Dokumenttyp GWG_EVIDENCE fehlt. Erst Seed/Migration ausfuehren.');

  console.log(`[demo-retention] Tenant: ${tenant.name} (${tenant.id})`);
  for (const fixture of fixtures) {
    await seedFixture(tenant.id, staff.id, gwgType.id, fixture);
  }

  console.log('[demo-retention] Fertig. Pruefen: /staff/admin/gwg-retention');
}

async function seedFixture(
  tenantId: string,
  staffId: string,
  documentTypeId: string,
  fixture: Fixture,
): Promise<void> {
  const existing = await prismaOwner.document.findFirst({
    where: { tenantId, title: fixture.title, classification: 'GWG_EVIDENCE' },
    select: { id: true },
  });
  if (existing) {
    console.log(
      `[demo-retention] Bereits vorhanden: ${fixture.title} (${fixture.queueExpectation})`,
    );
    return;
  }

  const client = await prismaOwner.client.upsert({
    where: { tenantId_datevNo: { tenantId, datevNo: fixture.datevNo } },
    update: {
      name: fixture.clientName,
      mandateEndedAt: fixture.mandateEndedAt,
      allowActive: false,
    },
    create: {
      tenantId,
      kind: 'JURPERS',
      name: fixture.clientName,
      datevNo: fixture.datevNo,
      allowActive: false,
      mandateEndedAt: fixture.mandateEndedAt,
    },
  });

  const existingCheck = await prismaOwner.gwgCheck.findFirst({
    where: { tenantId, clientId: client.id },
    select: { id: true },
  });
  if (existingCheck) {
    await prismaOwner.gwgCheck.update({
      where: { id: existingCheck.id },
      data: {
        status: 'VERIFIED',
        verifiedAt: fixture.mandateEndedAt,
        verifiedBy: staffId,
        destroyedAt: null,
      },
    });
  } else {
    await prismaOwner.gwgCheck.create({
      data: {
        tenantId,
        clientId: client.id,
        status: 'VERIFIED',
        verifiedAt: fixture.mandateEndedAt,
        verifiedBy: staffId,
      },
    });
  }

  const bytes = pdfBytes(fixture.title);
  const sha256 = createHash('sha256').update(bytes).digest();
  const bucket = getBucketForTier('GWG');
  const key = `tenants/${tenantId}/gwg/demo-retention/${randomUUID()}.pdf`;

  const objectLock = await putFixtureObject(bucket, key, bytes, fixture.retainUntil);

  await prismaOwner.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        tenantId,
        clientId: client.id,
        ownerStaffId: staffId,
        title: fixture.title,
        classification: 'GWG_EVIDENCE',
        documentTypeId,
        mimeType: 'application/pdf',
        retentionUntil: fixture.retainUntil,
      },
    });
    await tx.documentVersion.create({
      data: {
        documentId: document.id,
        versionNo: 1,
        storageBucket: bucket,
        storageKey: key,
        storageVersionId: objectLock.storageVersionId,
        sha256: prismaBytes(sha256),
        sizeBytes: BigInt(bytes.length),
        immutable: true,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        createdById: staffId,
      },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'SYSTEM',
      actorId: null,
      action: 'document.upload',
      resourceType: 'document',
      resourceId: document.id,
      after: {
        title: fixture.title,
        classification: 'GWG_EVIDENCE',
        clientId: client.id,
        demo: 'retention-fixture',
        retainUntil: fixture.retainUntil.toISOString(),
        objectLockState: objectLock.state,
      },
    });
  });

  console.log(`[demo-retention] Angelegt: ${fixture.title} -> ${fixture.queueExpectation}`);
}

async function putFixtureObject(
  bucket: string,
  key: string,
  bytes: Buffer,
  retainUntil: Date,
): Promise<{ state: string; storageVersionId: string }> {
  const base = {
    Bucket: bucket,
    Key: key,
    Body: bytes,
    ContentLength: bytes.length,
    ContentType: 'application/pdf',
  };

  if (retainUntil.getTime() > Date.now()) {
    const stored = await s3.send(
      new PutObjectCommand({
        ...base,
        ObjectLockMode: 'GOVERNANCE',
        ObjectLockRetainUntilDate: retainUntil,
      }),
    );
    return fixtureObjectResult('governance-active', stored.VersionId);
  }

  try {
    const stored = await s3.send(
      new PutObjectCommand({
        ...base,
        ObjectLockMode: 'GOVERNANCE',
        ObjectLockRetainUntilDate: retainUntil,
      }),
    );
    return fixtureObjectResult('governance-expired', stored.VersionId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(
      `[demo-retention] Historisches Object-Lock-Datum wurde abgelehnt (${message}); ` +
        'lege abgelaufenen Testfall ohne aktiven Lock an.',
    );
    const stored = await s3.send(new PutObjectCommand(base));
    return fixtureObjectResult('expired-without-active-lock', stored.VersionId);
  }
}

function fixtureObjectResult(state: string, versionId: string | undefined) {
  if (!versionId || versionId === 'null') {
    throw new Error('Demo-GwG-Objekt wurde ohne nachweisbare S3-VersionId gespeichert.');
  }
  return { state, storageVersionId: versionId };
}

main()
  .catch((e) => {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      console.error(`[demo-retention] Prisma ${e.code}: ${e.message}`);
    } else {
      console.error('[demo-retention] Fehler:', e);
    }
    process.exit(1);
  })
  .finally(() => prismaOwner.$disconnect());
