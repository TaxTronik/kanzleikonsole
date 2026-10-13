// =============================================================================
// Fachkatalog: DSGVO-CONTACT-EXPORT-001
// Fachkatalog: ACCESS-TENANT-RLS-001
//
// Welle 15 (Folgepunkt P-11): Die DSGVO-Auskunft (Art. 15/20) erzeugt jetzt der
// Worker dsgvo-export mit buildDsgvoContactExport im SYSTEM-Kontext. Inhalt und
// Format müssen gleich bleiben. Belegt gegen PostgreSQL mit der App-Rolle:
//  (1) Für dieselbe Fixture liefert der neue Paketaufbau im SYSTEM-Kontext
//      byte-gleich dasselbe Paket wie die eingefrorene Server-Action vor
//      Welle 15 im Kontext der anfordernden ADMIN-Person (gleicher Zeitpunkt).
//  (2) dsgvo_export: Guard (offener Antrag desselben Tenants über genau diesen
//      Kontakt), Statusfolge, Unveränderlichkeit, ein aktiver Auftrag je Antrag
//      und RLS gegenüber einem fremden Tenant.
// Alle Fixtures liegen in zurückgerollten Transaktionen.
// =============================================================================
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { PrismaClient as GeneratedPrismaClient } from '@prisma/client';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import { buildDsgvoContactExport, serializeDsgvoExport } from '../dsgvo-contact-export';
import { readPrivacyConfigTx, renderPrivacyNotice } from '../privacy-notice';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('DSGVO-Auskunft braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const db = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
afterAll(() => db.$disconnect());

const ROLLBACK = new Error('rollback');

async function inRollback(work: (tx: TxClient) => Promise<void>): Promise<void> {
  try {
    await db.$transaction(
      async (tx) => {
        await work(tx);
        throw ROLLBACK;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (error) {
    if (error === ROLLBACK) return;
    throw error;
  }
  throw new Error('Fixture-Transaktion wurde nicht zurückgerollt.');
}

async function asApp(tx: TxClient, tenantId: string, actorId: string, actorType: string) {
  await tx.$executeRawUnsafe('SET LOCAL ROLE taxtronik_app');
  await tx.$queryRaw`
    SELECT set_config('app.current_tenant_id', ${tenantId}, true),
           set_config('app.current_actor_id', ${actorId}, true),
           set_config('app.current_actor_type', ${actorType}, true)
  `;
}

/**
 * Eingefrorene Fassung vor Welle 15: Paketaufbau aus exportContactDataAction
 * (apps/web/src/app/staff/(protected)/admin/dsgvo/actions.ts, Stand c1d0b66),
 * wörtlich bis auf Eingabeobjekt, Fehlerklasse und den übergebenen Zeitpunkt.
 */
async function formerActionPackage(
  tx: TxClient,
  input: {
    tenantId: string;
    requestId: string;
    contactId: string;
    staffId: string;
    generatedAt: Date;
  },
) {
  const { tenantId } = input;
  const request = await tx.dsgvoRequest.findFirst({
    where: {
      id: input.requestId,
      tenantId,
      subjectType: 'CLIENT_CONTACT',
      subjectRefId: input.contactId,
      type: { in: ['ACCESS', 'PORTABILITY'] },
      status: { in: ['RECEIVED', 'IN_PROGRESS'] },
    },
  });
  if (!request) throw new Error('Passender offener DSGVO-Antrag nicht gefunden.');

  const contact = await tx.clientContact.findUnique({
    where: { id: input.contactId },
    include: { client: { select: { id: true, name: true } } },
  });
  if (!contact) throw new Error('Kontakt nicht gefunden.');

  // Alle Vorgänge dieser Person sammeln
  const responses = await tx.requestResponse.findMany({
    where: { authorType: 'CLIENT_CONTACT', authorId: input.contactId },
    select: {
      id: true,
      requestId: true,
      message: true,
      createdAt: true,
      request: { select: { title: true } },
    },
  });
  // N-7: Auskunftsanspruch nach Art. 15 DSGVO bezieht sich auf
  // personenbezogene Daten DES ANTRAGSTELLERS — nicht auf alle Dokumente
  // seines Mandanten. Bei einem Mandanten mit mehreren Kontakten bekäme
  // sonst jeder Kontakt im Export Metadaten von Dokumenten anderer
  // Personen.
  //
  // Wir filtern auf Dokumente, die im Audit-Trail eine Aktion DIESES
  // Kontakts haben (Upload via Portal, Antwort mit Anhang etc.) — das
  // ist die einzige zuverlässige Verknüpfung „Kontakt ↔ Dokument" im
  // Schema (Document.ownerStaffId zeigt auf Staff, nicht Contact).
  const auditDocs = await tx.auditLog.findMany({
    where: {
      tenantId,
      actorType: 'CLIENT_CONTACT',
      actorId: input.contactId,
      resourceType: 'document',
    },
    select: { resourceId: true },
    distinct: ['resourceId'],
  });
  const docIds = auditDocs
    .map((a) => a.resourceId)
    .filter((id): id is string => typeof id === 'string');
  const documents = docIds.length
    ? await tx.document.findMany({
        where: { id: { in: docIds } },
        select: { id: true, title: true, classification: true, createdAt: true },
      })
    : [];
  const magicLinks = await tx.magicLink.findMany({
    where: {
      tenantId,
      OR: [{ contactId: input.contactId }, { contactId: null, email: contact.email }],
    },
    select: {
      id: true,
      email: true,
      expiresAt: true,
      consumedAt: true,
      createdAt: true,
    },
  });

  // Art. 15/20: weitere Datenklassen mit Personenbezug des Antragstellers.
  // Verknüpfungs-Heuristiken (kommentiert, weil das Schema nicht überall
  // einen Kontakt-FK hat):
  //  - power_of_attorney: signerContactId (FK) ODER signerEmail-Match
  //    (citext → case-insensitiv) — Vollmachten tragen Name/E-Mail/IP
  //    des Unterzeichners.
  //  - appointment_request: createdByContact (FK).
  //  - form_submission: submittedByContact (FK); answers sind die von der
  //    Person selbst eingegebenen Daten (Art.-20-relevant).
  //  - phone_note: KEIN Kontakt-FK im Schema → Heuristik „gleicher Mandant
  //    + Anrufername == Kontaktname (case-insensitiv)". Kann Namens-
  //    gleiche Dritte treffen bzw. abweichende Schreibweisen verfehlen —
  //    der Sachbearbeiter prüft den Export vor Herausgabe ohnehin.
  const [
    powersOfAttorney,
    appointmentRequests,
    formSubmissions,
    phoneNotes,
    consents,
    masterChangeRequests,
    auditEntries,
    providers,
    tenant,
    privacyConfig,
  ] = await Promise.all([
    tx.powerOfAttorney.findMany({
      where: {
        OR: [{ signerContactId: input.contactId }, { signerEmail: contact.email }],
      },
      select: {
        id: true,
        subject: true,
        scope: true,
        status: true,
        signerName: true,
        signerEmail: true,
        signedAt: true,
        signedByIp: true,
        validFrom: true,
        validUntil: true,
      },
    }),
    tx.appointmentRequest.findMany({
      where: { createdByContact: input.contactId },
      select: {
        id: true,
        subject: true,
        notes: true,
        status: true,
        createdAt: true,
        decidedAt: true,
      },
    }),
    tx.formSubmission.findMany({
      where: { submittedByContact: input.contactId },
      select: {
        id: true,
        name: true,
        status: true,
        answers: true,
        submittedAt: true,
      },
    }),
    tx.phoneNote.findMany({
      where: {
        clientId: contact.clientId,
        callerName: { equals: contact.fullName, mode: 'insensitive' },
      },
      select: {
        id: true,
        subject: true,
        body: true,
        callerName: true,
        callerPhone: true,
        createdAt: true,
      },
    }),
    tx.clientConsent.findMany({
      where: { signedByContact: input.contactId },
      select: {
        id: true,
        noticeVersion: true,
        noticeSnapshot: true,
        consents: true,
        source: true,
        signedByName: true,
        isRevocation: true,
        note: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    tx.clientMasterChangeRequest.findMany({
      where: { contactId: input.contactId },
      select: {
        id: true,
        fields: true,
        note: true,
        status: true,
        createdAt: true,
        decidedAt: true,
        decisionNote: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    tx.auditLog.findMany({
      where: {
        tenantId,
        OR: [
          { actorType: 'CLIENT_CONTACT', actorId: input.contactId },
          { resourceType: 'client_contact', resourceId: input.contactId },
        ],
      },
      select: {
        id: true,
        occurredAt: true,
        actorType: true,
        actorId: true,
        action: true,
        resourceType: true,
        resourceId: true,
        before: true,
        after: true,
        ip: true,
        userAgent: true,
      },
      orderBy: { id: 'asc' },
    }),
    tx.serviceProvider.findMany({
      where: { tenantId, hasDataAccess: true },
      select: { name: true, category: true },
      orderBy: { name: 'asc' },
    }),
    tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    readPrivacyConfigTx(tx, tenantId),
  ]);

  const privacyNotice = renderPrivacyNotice({
    kanzleiName: tenant?.name ?? 'Kanzlei',
    config: privacyConfig,
    providers,
  });
  const generatedAt = input.generatedAt; // eingefroren: vorher new Date()
  const exportData = {
    request: {
      id: request.id,
      type: request.type,
      receivedAt: request.receivedAt,
      subjectName: request.subjectName,
      subjectEmail: request.subjectEmail,
    },
    contact: {
      id: contact.id,
      email: contact.email,
      fullName: contact.fullName,
      phone: contact.phone,
      role: contact.role,
      notificationsEnabled: contact.notificationsEnabled,
      client: { id: contact.client.id, name: contact.client.name },
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
      lastLoginAt: contact.lastLoginAt,
      active: contact.active,
    },
    interactions: {
      requestResponses: responses,
      // Nur Dokumente, die über einen personenbezogenen Audit-Akteur
      // direkt mit diesem Kontakt verbunden sind — nie pauschal die ganze
      // Mandantenakte mit Daten Dritter.
      documentsActedOnByContact: documents,
      magicLinks,
      powersOfAttorney,
      appointmentRequests,
      formSubmissions,
      consents,
      masterChangeRequests,
      // Heuristik: gleicher Mandant + Anrufername == Kontaktname. Muss vor
      // Herausgabe personell auf Fehlzuordnungen geprüft werden.
      phoneNotes,
    },
    auditTrail: auditEntries.map((entry) => ({
      ...entry,
      id: entry.id.toString(),
    })),
    processingInformation: {
      purposes: [
        'Mandatsanbahnung und -bearbeitung',
        'Kommunikation und Dokumentenaustausch',
        'Erfüllung steuer-, berufs- und geldwäscherechtlicher Pflichten',
        'Abrechnung, Forderungsmanagement, IT-Sicherheit und Rechtsverteidigung',
      ],
      dataCategories: [
        'Stamm-, Identifikations- und Kontaktdaten',
        'Kommunikations-, Formular- und Portaldaten',
        'Mandats-, Vollmachts-, Dokument- und Abrechnungsmetadaten',
        'Technische Nachweisdaten wie Zeitstempel, IP-Adresse und User-Agent',
      ],
      recipientCategories: [
        'Finanzbehörden, Sozialversicherungsträger, Gerichte und sonstige mandatsbezogene Stellen',
        'Zur Verschwiegenheit verpflichtete Kanzleimitarbeiter und Berufsträger',
        ...providers.map((provider) => `${provider.name} (${provider.category})`),
      ],
      source:
        'Direkt von der betroffenen Person, vom vertretenen Mandanten sowie aus mandatsbezogenen Vorgängen und gesetzlichen Quellen.',
      retention:
        'Je Datenklasse nach Mandats-, Steuer-, Handels-, Berufs- und GwG-Aufbewahrung; Einschränkung oder Löschung nach Wegfall sämtlicher Zwecke und Pflichten.',
      automatedDecisionMaking: false,
      privacyNoticeSnapshot: privacyNotice,
      privacyContact: privacyConfig.privacyContact,
      supervisoryAuthority: privacyConfig.supervisoryAuthority,
    },
    coverage: {
      automaticLinks:
        'Der Export enthält sicher bzw. heuristisch mit diesem Kontakt verknüpfte Systemdaten.',
      manualReviewRequired: [
        'Telefonnotizen auf Namensgleichheit und mögliche Daten Dritter prüfen.',
        'Dokumentinhalte, Freitexte und Alt-/Importdaten auf weitere personenbezogene Angaben prüfen.',
        'Rechtsgrundlagen, Empfänger und konkrete Aufbewahrungsfristen fallbezogen ergänzen.',
        'Vor Herausgabe Daten Dritter schwärzen und Identität des Antragstellers prüfen.',
      ],
    },
    exportedAt: generatedAt.toISOString(),
    exportedBy: input.staffId,
  };
  return exportData;
}

interface Fixture {
  tenantId: string;
  adminId: string;
  contactId: string;
  requestId: string;
}

async function fixture(tx: TxClient, label = 'a'): Promise<Fixture> {
  const seed = `${label}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const tenantId = (
    await tx.tenant.create({ data: { slug: `w15-dsgvo-${seed}`, name: `Kanzlei ${label}` } })
  ).id;
  const adminId = (
    await tx.staffUser.create({
      data: {
        tenantId,
        email: `admin-${seed}@example.test`,
        fullName: 'Welle 15 Admin',
        passwordHash: 'synthetic',
        roles: { create: { role: 'ADMIN' } },
      },
    })
  ).id;
  const clientId = (
    await tx.client.create({
      data: { tenantId, kind: 'JURPERS', name: `Muster GmbH ${label}`, allowActive: false },
    })
  ).id;
  const inTransaction = { $transaction: (fn: (t: TxClient) => unknown) => fn(tx) };
  await createVerifiedLegalEntityGwgFixture(inTransaction as unknown as GeneratedPrismaClient, {
    tenantId,
    clientId,
    verifiedBy: adminId,
    registerNumber: `HRB W15 ${seed}`,
  });
  await tx.client.update({ where: { id: clientId }, data: { allowActive: true } });
  const contact = await tx.clientContact.create({
    data: {
      tenantId,
      clientId,
      email: `kontakt-${seed}@example.test`,
      fullName: 'Erika Mustermann',
      phone: '+49 30 123',
      role: 'Geschäftsführerin',
    },
  });
  const request = await tx.request.create({
    data: {
      tenantId,
      clientId,
      title: 'Unterlagen Jahresabschluss',
      description: 'Bitte Belege hochladen.',
      createdByStaff: adminId,
    },
  });
  await tx.requestResponse.create({
    data: {
      requestId: request.id,
      authorType: 'CLIENT_CONTACT',
      authorId: contact.id,
      message: 'Anbei die Belege.',
    },
  });
  const document = await tx.document.create({
    data: {
      tenantId,
      clientId,
      title: 'Kontoauszug',
      classification: 'GENERAL',
      mimeType: 'application/pdf',
    },
  });
  // Audit-Ausschnitt: Aktion des Kontakts an einem Dokument und am Kontakt selbst.
  for (const [actorType, actorId, resourceType, resourceId, action] of [
    ['CLIENT_CONTACT', contact.id, 'document', document.id, 'document.upload'],
    ['STAFF', adminId, 'client_contact', contact.id, 'client_contact.update'],
  ] as const) {
    await tx.$executeRaw`
      INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, resource_type, resource_id, after, ip, user_agent, prev_hash, this_hash)
      VALUES (${tenantId}::uuid, ${actorType}::audit_actor_type, ${actorId}::uuid, ${action}, ${resourceType}, ${resourceId},
              ${JSON.stringify({ note: 'w15' })}::jsonb, '192.0.2.7'::inet, 'vitest', '\\x00'::bytea, '\\x01'::bytea)
    `;
  }
  await tx.magicLink.create({
    data: {
      tenantId,
      contactId: contact.id,
      email: contact.email,
      tokenHash: `w15-${seed}`,
      expiresAt: new Date('2026-11-01T00:00:00Z'),
    },
  });
  await tx.phoneNote.create({
    data: {
      tenantId,
      clientId,
      callerName: 'erika mustermann',
      callerPhone: '+49 30 123',
      subject: 'Rückruf',
      body: 'Bitte zurückrufen.',
      takenByStaff: adminId,
    },
  });
  await tx.serviceProvider.create({
    data: { tenantId, name: 'Rechenzentrum Muster', category: 'Hosting', hasDataAccess: true },
  });
  await tx.tenantSetting.create({
    data: {
      tenantId,
      key: 'privacy.notice',
      value: {
        responsibleBody: 'Kanzlei Muster, Musterstraße 1',
        supervisoryAuthority: 'HBDI Wiesbaden',
        privacyContact: 'datenschutz@kanzlei.example',
      },
    },
  });
  const dsgvo = await tx.dsgvoRequest.create({
    data: {
      tenantId,
      type: 'ACCESS',
      subjectType: 'CLIENT_CONTACT',
      subjectRefId: contact.id,
      subjectEmail: contact.email,
      subjectName: contact.fullName,
      description: 'Auskunft nach Art. 15 DSGVO',
      receivedAt: new Date('2026-10-01T00:00:00Z'),
      dueDate: new Date('2026-11-01T00:00:00Z'),
      createdByStaff: adminId,
    },
  });
  return { tenantId, adminId, contactId: contact.id, requestId: dsgvo.id };
}

describeWithDatabase('Welle 15: DSGVO-Auskunft im Worker (P-11)', () => {
  it('liefert im SYSTEM-Kontext byte-gleich das Paket der früheren Server-Action', async () => {
    await inRollback(async (tx) => {
      const f = await fixture(tx);
      const generatedAt = new Date('2026-10-12T09:30:00.000Z');
      const input = {
        tenantId: f.tenantId,
        requestId: f.requestId,
        contactId: f.contactId,
        generatedAt,
      };

      await asApp(tx, f.tenantId, f.adminId, 'STAFF');
      const before = serializeDsgvoExport(
        await formerActionPackage(tx, { ...input, staffId: f.adminId }),
      );
      await asApp(tx, f.tenantId, '', 'SYSTEM');
      const built = await buildDsgvoContactExport(tx, { ...input, exportedBy: f.adminId });
      const after = serializeDsgvoExport(built.exportData);
      await tx.$executeRawUnsafe('RESET ROLE');

      expect(after.serialized).toBe(before.serialized);
      expect(after.sha256.equals(before.sha256)).toBe(true);
      expect(built.contact.id).toBe(f.contactId);
      // Die Fixture deckt die Datenklassen tatsächlich ab.
      const pkg = JSON.parse(after.serialized) as {
        interactions: Record<string, unknown[]>;
        auditTrail: unknown[];
        processingInformation: { recipientCategories: string[]; privacyNoticeSnapshot: string };
      };
      expect(pkg.interactions['requestResponses']).toHaveLength(1);
      expect(pkg.interactions['documentsActedOnByContact']).toHaveLength(1);
      expect(pkg.interactions['magicLinks']).toHaveLength(1);
      expect(pkg.interactions['phoneNotes']).toHaveLength(1);
      expect(pkg.auditTrail).toHaveLength(2);
      expect(pkg.processingInformation.recipientCategories).toContain(
        'Rechenzentrum Muster (Hosting)',
      );
      expect(pkg.processingInformation.privacyNoticeSnapshot).toContain('Kanzlei Muster');
    });
  }, 60_000);

  it('bindet Aufträge an einen offenen Antrag, lässt den Status nur vorwärts laufen und isoliert Tenants', async () => {
    await inRollback(async (tx) => {
      const f = await fixture(tx, 'a');
      const other = await fixture(tx, 'b');
      await asApp(tx, f.tenantId, f.adminId, 'STAFF');

      const savepoint = async (sql: () => Promise<unknown>, message: RegExp) => {
        await tx.$executeRawUnsafe('SAVEPOINT w15');
        await expect(sql()).rejects.toThrow(message);
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT w15');
      };
      const base = { tenantId: f.tenantId, requestId: f.requestId, requestedBy: f.adminId };

      // Guard: fremder Kontakt, fremder Antrag, Start außerhalb REQUESTED.
      await savepoint(
        () => tx.dsgvoExport.create({ data: { ...base, contactId: other.contactId } }),
        /kein offener Auskunftsantrag/,
      );
      await savepoint(
        () =>
          tx.dsgvoExport.create({
            data: { ...base, requestId: other.requestId, contactId: other.contactId },
          }),
        /kein offener Auskunftsantrag/,
      );
      await savepoint(
        () =>
          tx.dsgvoExport.create({
            data: { ...base, contactId: f.contactId, status: 'RUNNING', startedAt: new Date() },
          }),
        /kein offener Auskunftsantrag/,
      );

      const job = await tx.dsgvoExport.create({ data: { ...base, contactId: f.contactId } });
      // Höchstens ein aktiver Auftrag je Antrag.
      await savepoint(
        () => tx.dsgvoExport.create({ data: { ...base, contactId: f.contactId } }),
        /dsgvo_export_one_active|Unique constraint/,
      );
      // Kein Sprung REQUESTED → DONE, keine Änderung der Identität.
      await savepoint(
        () =>
          tx.dsgvoExport.update({
            where: { id: job.id },
            data: {
              status: 'DONE',
              finishedAt: new Date(),
              sha256: new Uint8Array(32),
              sizeBytes: 2n,
              storageBucket: 'b',
              storageKey: 'k',
            },
          }),
        /unzulässiger Statuswechsel REQUESTED -> DONE/,
      );
      await savepoint(
        () =>
          tx.dsgvoExport.update({ where: { id: job.id }, data: { requestedBy: other.adminId } }),
        /Auftragsidentität ist unveränderlich/,
      );

      await tx.dsgvoExport.update({
        where: { id: job.id },
        data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 } },
      });
      const done = await tx.dsgvoExport.update({
        where: { id: job.id },
        data: {
          status: 'DONE',
          finishedAt: new Date(),
          sha256: new Uint8Array(32).fill(7),
          sizeBytes: 42n,
          storageBucket: 'general',
          storageKey: `tenants/${f.tenantId}/none/x.bin`,
          storageVersionId: 'v1',
        },
      });
      expect(done.status).toBe('DONE');
      // Ein fertiges Ergebnis bleibt; nur der Löschvermerk darf folgen.
      await savepoint(
        () => tx.dsgvoExport.update({ where: { id: job.id }, data: { storageVersionId: 'v2' } }),
        /abgeschlossener Auftrag ist unveränderlich/,
      );
      await tx.dsgvoExport.update({ where: { id: job.id }, data: { objectDeletedAt: new Date() } });
      // Kein DELETE für die App-Rolle.
      await savepoint(() => tx.dsgvoExport.delete({ where: { id: job.id } }), /permission denied/);

      // RLS: Tenant B sieht und ändert den Auftrag von A nicht.
      await asApp(tx, other.tenantId, other.adminId, 'STAFF');
      await expect(tx.dsgvoExport.findMany({ where: { id: job.id } })).resolves.toEqual([]);
      await expect(
        tx.dsgvoExport.updateMany({ where: { id: job.id }, data: { error: 'x' } }),
      ).resolves.toEqual({ count: 0 });
      await savepoint(
        () => tx.dsgvoExport.create({ data: { ...base, contactId: f.contactId } }),
        /row-level security|kein offener Auskunftsantrag/,
      );
      await tx.$executeRawUnsafe('RESET ROLE');
    });
  }, 60_000);
});
