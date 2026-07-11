'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { isStaffAdmin, toActionError } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { revokeAllSessions } from '@/server/auth/revocation';
import { anonymizeContactInTx } from '@/server/dsgvo/anonymize-contact';
import { dsgvoResponseDeadline } from '@/server/dsgvo/deadline';
import { validateDsgvoStatusEvidence } from '@/server/dsgvo/workflow';
import { serializeDsgvoExport } from '@/server/dsgvo/export-package';
import { readPrivacyConfigTx, renderPrivacyNotice } from '@/server/privacy/notice';
import { berlinTodayUtcMidnight } from '@/lib/fmt';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { staffActionGuard, ActionError } from '@/server/actions/staff-action';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

// DSGVO-Anträge sind eine Compliance-Hoheit (Art. 12 ff.) — durchweg
// ADMIN/PARTNER. Eigene, präzisere Meldung als das Standard-Gate.
const DSGVO_ADMIN_MSG = 'Nur ADMIN/PARTNER darf DSGVO-Anträge bearbeiten.';

const YmdSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  });

const CreateSchema = z.object({
  type: z.enum(['ACCESS', 'RECTIFICATION', 'ERASURE', 'RESTRICTION', 'PORTABILITY', 'OBJECTION']),
  subjectType: z.enum(['CLIENT_CONTACT', 'STAFF_USER', 'CLIENT', 'EXTERNAL']),
  subjectRefId: z.string().uuid().optional().or(z.literal('')),
  subjectEmail: z.string().email().max(255),
  subjectName: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  receivedAt: YmdSchema,
});

export async function createDsgvoRequestAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard();
  if (!g.ok) throw new ActionError(g.error);
  const { tenantId, staffId, ctx, session } = g;
  if (!isStaffAdmin(session)) throw new ActionError(DSGVO_ADMIN_MSG);

  const parsed = CreateSchema.safeParse({
    type: formData.get('type'),
    subjectType: formData.get('subjectType'),
    subjectRefId: formData.get('subjectRefId') ?? '',
    subjectEmail: formData.get('subjectEmail'),
    subjectName: formData.get('subjectName'),
    description: formData.get('description'),
    receivedAt: formData.get('receivedAt'),
  });
  if (!parsed.success) throw new ActionError('Validierungsfehler.');

  const data = parsed.data;
  // Frist nach Art. 12 Abs. 3 DSGVO: 1 Monat. Monatsende-sicher (§ 188 Abs. 3
  // BGB) — ein nacktes setMonth(+1) rollt z. B. den 31.01. auf den 03.03. und
  // täuscht Bearbeitungszeit vor, die nicht besteht.
  const receivedAt = new Date(`${data.receivedAt}T00:00:00.000Z`);
  if (receivedAt > berlinTodayUtcMidnight()) {
    throw new ActionError('Der Eingangstag darf nicht in der Zukunft liegen.');
  }
  const dueDate = dsgvoResponseDeadline(receivedAt);

  const id = await withTenantContext(ctx, async (tx) => {
    let subjectName = data.subjectName.trim();
    let subjectEmail = data.subjectEmail.toLowerCase();

    // Eine gesetzte Referenz muss im Tenant und zum gewählten Betroffenen-Typ
    // existieren. Bei Personen übernehmen wir die kanonischen Stammdaten,
    // damit ein Tippfehler die Auskunft nicht der falschen Person zuordnet.
    if (data.subjectRefId) {
      if (data.subjectType === 'CLIENT_CONTACT') {
        const subject = await tx.clientContact.findUnique({
          where: { id: data.subjectRefId },
          select: { fullName: true, email: true },
        });
        if (!subject) throw new ActionError('Referenzierter Mandantenkontakt nicht gefunden.');
        subjectName = subject.fullName;
        subjectEmail = subject.email.toLowerCase();
      } else if (data.subjectType === 'STAFF_USER') {
        const subject = await tx.staffUser.findUnique({
          where: { id: data.subjectRefId },
          select: { fullName: true, email: true },
        });
        if (!subject) throw new ActionError('Referenzierte Mitarbeiterperson nicht gefunden.');
        subjectName = subject.fullName;
        subjectEmail = subject.email.toLowerCase();
      } else if (data.subjectType === 'CLIENT') {
        const subject = await tx.client.findUnique({
          where: { id: data.subjectRefId },
          select: { name: true, invoiceEmail: true },
        });
        if (!subject) throw new ActionError('Referenzierter Mandant nicht gefunden.');
        subjectName = subject.name;
        subjectEmail = subject.invoiceEmail?.toLowerCase() ?? subjectEmail;
      } else {
        throw new ActionError('Externe Personen dürfen keine interne Referenz-ID tragen.');
      }
    }

    const req = await tx.dsgvoRequest.create({
      data: {
        tenantId,
        type: data.type,
        subjectType: data.subjectType,
        subjectRefId: data.subjectRefId || null,
        subjectEmail,
        subjectName,
        description: data.description,
        receivedAt,
        dueDate,
        createdByStaff: staffId,
      },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'dsgvo.request.create',
      resourceType: 'dsgvo_request',
      resourceId: req.id,
      after: {
        type: data.type,
        subjectType: data.subjectType,
        subjectEmail,
        receivedAt: data.receivedAt,
        dueDate: dueDate.toISOString().slice(0, 10),
      },
    });
    return req.id;
  });

  revalidatePath('/staff/admin/dsgvo');
  redirect(`/staff/admin/dsgvo/${id}`); // wirft (never) — NACH der Tx
}

const UpdateStatusSchema = z.object({
  requestId: z.string().uuid(),
  status: z.enum(['RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED']),
  notes: z.string().max(5000).optional().or(z.literal('')),
  resultDocumentId: z.string().uuid().optional().or(z.literal('')),
  responseSentAt: YmdSchema.optional().or(z.literal('')),
  responseMethod: z.string().max(200).optional().or(z.literal('')),
  rejectionReason: z.string().max(5000).optional().or(z.literal('')),
  resultReviewConfirmed: z.literal('on').optional(),
  rejectionNoticeComplete: z.literal('on').optional(),
});

export async function updateStatusAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard();
  if (!g.ok) throw new ActionError(g.error);
  const { tenantId, staffId, ctx, session } = g;
  if (!isStaffAdmin(session)) throw new ActionError(DSGVO_ADMIN_MSG);

  const parsed = UpdateStatusSchema.safeParse({
    requestId: formData.get('requestId'),
    status: formData.get('status'),
    notes: formData.get('notes') ?? '',
    resultDocumentId: formData.get('resultDocumentId') ?? '',
    responseSentAt: formData.get('responseSentAt') ?? '',
    responseMethod: formData.get('responseMethod') ?? '',
    rejectionReason: formData.get('rejectionReason') ?? '',
    resultReviewConfirmed: formData.get('resultReviewConfirmed') ?? undefined,
    rejectionNoticeComplete: formData.get('rejectionNoticeComplete') ?? undefined,
  });
  if (!parsed.success) throw new ActionError('Validierungsfehler.');
  const data = parsed.data;

  await withTenantContext(ctx, async (tx) => {
    const before = await tx.dsgvoRequest.findUnique({ where: { id: data.requestId } });
    if (!before) throw new ActionError('DSGVO-Antrag nicht gefunden.');

    const responseSentAt = data.responseSentAt
      ? new Date(`${data.responseSentAt}T00:00:00.000Z`)
      : null;
    if (responseSentAt && responseSentAt > berlinTodayUtcMidnight()) {
      throw new ActionError('Der Antworttag darf nicht in der Zukunft liegen.');
    }
    if (responseSentAt && responseSentAt < before.receivedAt) {
      throw new ActionError('Der Antworttag darf nicht vor dem Eingangstag liegen.');
    }

    let resultDocumentId = data.resultDocumentId || before.resultDocumentId;
    if (data.resultDocumentId) {
      const document = await tx.document.findFirst({
        where: { id: data.resultDocumentId, tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!document) throw new ActionError('Ergebnisdokument nicht gefunden.');
      resultDocumentId = document.id;
    }

    const notes = data.notes || before.notes || '';
    const resultChanged = Boolean(
      data.resultDocumentId && data.resultDocumentId !== before.resultDocumentId,
    );
    const previouslyReviewedCurrentResult = Boolean(before.resultReviewedAt && !resultChanged);
    const workflowError = validateDsgvoStatusEvidence({
      from: before.status,
      to: data.status,
      type: before.type,
      notes,
      responseSentAt,
      responseMethod: data.responseMethod ?? '',
      rejectionReason: data.rejectionReason ?? '',
      rejectionNoticeComplete: data.rejectionNoticeComplete === 'on',
      hasResultArtifact: Boolean(before.resultSha256 || resultDocumentId),
      // Prüfung und Versand müssen als getrennte, zeitlich belastbare Schritte
      // vorliegen. Ein ausgetauschtes Ergebnis entwertet die frühere Prüfung.
      resultReviewed: previouslyReviewedCurrentResult,
      resultReviewedOn: before.resultReviewedAt
        ? berlinTodayUtcMidnight(before.resultReviewedAt)
        : null,
    });
    if (workflowError) throw new ActionError(workflowError);

    const updated = await tx.dsgvoRequest.update({
      where: { id: data.requestId },
      data: {
        status: data.status,
        notes: notes || null,
        resultDocumentId,
        ...(resultChanged ? { resultReviewedAt: null, resultReviewedBy: null } : {}),
        ...(data.resultReviewConfirmed && data.status !== 'COMPLETED' && data.status !== 'REJECTED'
          ? { resultReviewedAt: new Date(), resultReviewedBy: staffId }
          : {}),
        ...(data.status === 'COMPLETED'
          ? {
              responseSentAt,
              responseMethod: (data.responseMethod ?? '').trim(),
              rejectionReason: null,
            }
          : {}),
        ...(data.status === 'REJECTED'
          ? {
              rejectionReason: (data.rejectionReason ?? '').trim(),
              responseSentAt,
              responseMethod: (data.responseMethod ?? '').trim(),
            }
          : {}),
        completedAt: data.status === 'COMPLETED' || data.status === 'REJECTED' ? new Date() : null,
        completedByStaff:
          data.status === 'COMPLETED' || data.status === 'REJECTED' ? staffId : null,
      },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: `dsgvo.request.${data.status.toLowerCase()}`,
      resourceType: 'dsgvo_request',
      resourceId: updated.id,
      before: { status: before.status },
      after: {
        status: updated.status,
        responseSentAt: updated.responseSentAt?.toISOString().slice(0, 10) ?? null,
        responseMethod: updated.responseMethod,
        rejectionReason: updated.rejectionReason,
        resultDocumentId: updated.resultDocumentId,
        hasGeneratedResult: Boolean(updated.resultSha256),
        resultReviewedAt: updated.resultReviewedAt?.toISOString() ?? null,
        rejectionNoticeComplete:
          data.status === 'REJECTED' ? data.rejectionNoticeComplete === 'on' : null,
      },
    });
  });

  revalidatePath(`/staff/admin/dsgvo/${data.requestId}`);
  revalidatePath('/staff/admin/dsgvo');
}

/**
 * Auskunfts-Export für einen Client-Contact: alle personenbezogenen Daten
 * der Person als JSON. Wird im Audit-Log dokumentiert (Art.-15-Auskunft).
 */
export async function exportContactDataAction(
  requestId: string,
  contactId: string,
): Promise<{
  ok: boolean;
  error?: string;
  serialized?: string;
  sha256?: string;
}> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const input = z
    .object({ requestId: z.string().uuid(), contactId: z.string().uuid() })
    .safeParse({ requestId, contactId });
  if (!input.success) return { ok: false, error: 'Validierungsfehler.' };

  try {
    const generated = await withTenantContext(ctx, async (tx) => {
      const request = await tx.dsgvoRequest.findFirst({
        where: {
          id: input.data.requestId,
          tenantId,
          subjectType: 'CLIENT_CONTACT',
          subjectRefId: input.data.contactId,
          type: { in: ['ACCESS', 'PORTABILITY'] },
          status: { in: ['RECEIVED', 'IN_PROGRESS'] },
        },
      });
      if (!request) throw new ActionError('Passender offener DSGVO-Antrag nicht gefunden.');

      const contact = await tx.clientContact.findUnique({
        where: { id: input.data.contactId },
        include: { client: { select: { id: true, name: true } } },
      });
      if (!contact) throw new ActionError('Kontakt nicht gefunden.');

      // Alle Vorgänge dieser Person sammeln
      const responses = await tx.requestResponse.findMany({
        where: { authorType: 'CLIENT_CONTACT', authorId: input.data.contactId },
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
          actorId: input.data.contactId,
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
          OR: [{ contactId: input.data.contactId }, { contactId: null, email: contact.email }],
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
            OR: [{ signerContactId: input.data.contactId }, { signerEmail: contact.email }],
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
          where: { createdByContact: input.data.contactId },
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
          where: { submittedByContact: input.data.contactId },
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
          where: { signedByContact: input.data.contactId },
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
          where: { contactId: input.data.contactId },
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
              { actorType: 'CLIENT_CONTACT', actorId: input.data.contactId },
              { resourceType: 'client_contact', resourceId: input.data.contactId },
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
      const generatedAt = new Date();
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
        exportedBy: staffId,
      };

      // Hash exakt über DIE Bytes, die der Browser herunterlädt. Ein Hash über
      // kompaktes JSON bei anschließend hübsch eingerückter Download-Datei
      // würde sonst trotz identischer Daten niemals verifizieren.
      const { serialized, sha256: resultSha256 } = serializeDsgvoExport(exportData);
      await tx.dsgvoRequest.update({
        where: { id: request.id },
        data: {
          resultSha256: prismaBytes(resultSha256),
          resultPreparedAt: generatedAt,
          resultPreparedBy: staffId,
          // Jede Neugenerierung verändert das Paket und braucht eine neue
          // personelle Vollständigkeitsprüfung.
          resultReviewedAt: null,
          resultReviewedBy: null,
          status: request.status === 'RECEIVED' ? 'IN_PROGRESS' : request.status,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'dsgvo.export.contact',
        resourceType: 'dsgvo_request',
        resourceId: request.id,
        after: {
          exportedFor: contact.email,
          contactId: contact.id,
          sha256: resultSha256.toString('hex'),
          manualReviewRequired: true,
        },
      });

      return {
        serialized,
        sha256: resultSha256.toString('hex'),
      };
    });
    revalidatePath(`/staff/admin/dsgvo/${input.data.requestId}`);
    revalidatePath('/staff/admin/dsgvo');
    return { ok: true, ...generated };
  } catch (e) {
    return toActionError(e);
  }
}

/**
 * Anonymisiert einen Client-Contact (Art. 17): Email/Name werden überschrieben,
 * Account deaktiviert. Vorgänge bleiben erhalten (Audit-Pflicht), aber nicht mehr
 * personenbezogen.
 *
 * Achtung: GoBD-pflichtige Belege (Rechnungen etc.) bleiben unverändert — die
 * Lösch-Pflicht greift nur, soweit keine gesetzliche Aufbewahrungspflicht besteht.
 */
export async function anonymizeContactAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard();
  if (!g.ok) throw new ActionError(g.error);
  const { tenantId, staffId, ctx, session } = g;
  if (!isStaffAdmin(session)) throw new ActionError(DSGVO_ADMIN_MSG);

  const contactIdRaw = formData.get('contactId');
  // NEW5: Input via Zod statt nur typeof — Prisma akzeptiert sonst beliebige
  // Strings für UUID-Spalten und wirft erst zur Laufzeit.
  const parsed = z.object({ contactId: z.string().uuid() }).safeParse({ contactId: contactIdRaw });
  if (!parsed.success) return;
  const { contactId } = parsed.data;

  // Geteilte Anonymisierungs-Logik (auch von der Mandanten-Anonymisierung in
  // admin/dsgvo-retention genutzt). Keine gelöschten Klardaten erneut in die
  // unveränderliche Audit-Chain kopieren; Antrag-ID und Kontakt-ID liefern den
  // Rechenschaftsnachweis ohne eine zweite, unbegrenzt persistente PII-Kopie.
  await withTenantContext(ctx, (tx) =>
    anonymizeContactInTx(tx, { tenantId, staffId, contactId, personalDataInAudit: false }),
  );

  // N-2: Art. 17 ("Recht auf Löschung") — alle aktiven Portal-Sessions der Person
  // sofort revoken. Sonst bliebe der JWT-Cookie bis 24 h gültig und der
  // anonymisierte Kontakt könnte weiter aufs Portal zugreifen.
  await revokeAllSessions('portal', contactId);

  revalidatePath('/staff/admin/dsgvo');
}
