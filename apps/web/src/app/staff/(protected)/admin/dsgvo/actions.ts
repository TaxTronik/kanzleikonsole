'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { isStaffAdmin, toActionError } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { revokeAllSessions } from '@/server/auth/revocation';
import { anonymizeContactInTx } from '@/server/dsgvo/anonymize-contact';
import { staffActionGuard, ActionError } from '@/server/actions/staff-action';

export interface ActionResult { ok: boolean; error?: string; }

// DSGVO-Anträge sind eine Compliance-Hoheit (Art. 12 ff.) — durchweg
// ADMIN/PARTNER. Eigene, präzisere Meldung als das Standard-Gate.
const DSGVO_ADMIN_MSG = 'Nur ADMIN/PARTNER darf DSGVO-Anträge bearbeiten.';

const CreateSchema = z.object({
  type: z.enum(['ACCESS', 'RECTIFICATION', 'ERASURE', 'RESTRICTION', 'PORTABILITY', 'OBJECTION']),
  subjectType: z.enum(['CLIENT_CONTACT', 'STAFF_USER', 'CLIENT', 'EXTERNAL']),
  subjectRefId: z.string().uuid().optional().or(z.literal('')),
  subjectEmail: z.string().email().max(255),
  subjectName: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
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
  });
  if (!parsed.success) throw new ActionError('Validierungsfehler.');

  const data = parsed.data;
  // Frist nach DSGVO: 1 Monat
  const dueDate = new Date();
  dueDate.setMonth(dueDate.getMonth() + 1);

  const id = await withTenantContext(ctx, async (tx) => {
    const req = await tx.dsgvoRequest.create({
      data: {
        tenantId,
        type: data.type,
        subjectType: data.subjectType,
        subjectRefId: data.subjectRefId || null,
        subjectEmail: data.subjectEmail.toLowerCase(),
        subjectName: data.subjectName,
        description: data.description,
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
        subjectEmail: data.subjectEmail,
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
  });
  if (!parsed.success) return;
  const data = parsed.data;

  await withTenantContext(ctx, async (tx) => {
    const before = await tx.dsgvoRequest.findUnique({ where: { id: data.requestId } });
    if (!before) return;
    const updated = await tx.dsgvoRequest.update({
      where: { id: data.requestId },
      data: {
        status: data.status,
        notes: data.notes || before.notes,
        completedAt: data.status === 'COMPLETED' || data.status === 'REJECTED' ? new Date() : null,
        completedByStaff: data.status === 'COMPLETED' || data.status === 'REJECTED' ? staffId : null,
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
      after: { status: updated.status },
    });
  });

  revalidatePath(`/staff/admin/dsgvo/${data.requestId}`);
  revalidatePath('/staff/admin/dsgvo');
}

/**
 * Auskunfts-Export für einen Client-Contact: alle personenbezogenen Daten
 * der Person als JSON. Wird im Audit-Log dokumentiert (Art.-15-Auskunft).
 */
export async function exportContactDataAction(contactId: string): Promise<{
  ok: boolean;
  error?: string;
  data?: unknown;
}> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  try {
    const data = await withTenantContext(ctx, async (tx) => {
      const contact = await tx.clientContact.findUnique({
        where: { id: contactId },
        include: { client: { select: { id: true, name: true } } },
      });
      if (!contact) throw new ActionError('Kontakt nicht gefunden.');

      // Alle Vorgänge dieser Person sammeln
      const responses = await tx.requestResponse.findMany({
        where: { authorType: 'CLIENT_CONTACT', authorId: contactId },
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
          actorId: contactId,
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
      const magicLinks = await tx.magicLink.count({
        where: { tenantId, email: contact.email },
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
      const [powersOfAttorney, appointmentRequests, formSubmissions, phoneNotes] =
        await Promise.all([
          tx.powerOfAttorney.findMany({
            where: {
              OR: [{ signerContactId: contactId }, { signerEmail: contact.email }],
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
            where: { createdByContact: contactId },
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
            where: { submittedByContact: contactId },
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
        ]);

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'dsgvo.export.contact',
        resourceType: 'client_contact',
        resourceId: contactId,
        after: { exportedFor: contact.email },
      });

      return {
        contact: {
          id: contact.id,
          email: contact.email,
          fullName: contact.fullName,
          client: contact.client.name,
          createdAt: contact.createdAt,
          lastLoginAt: contact.lastLoginAt,
          active: contact.active,
        },
        interactions: {
          requestResponses: responses,
          // N-7: umbenannt — diese Dokumente sind ausschließlich solche, die
          // dem Antragsteller über das Audit-Log direkt zugeordnet sind
          // (Upload, Antwort etc.). NICHT alle Dokumente des Mandanten.
          documentsActedOnByContact: documents,
          magicLinkRequests: magicLinks,
          powersOfAttorney,
          appointmentRequests,
          formSubmissions,
          // Heuristik: gleicher Mandant + Anrufername == Kontaktname (siehe oben).
          phoneNotes,
        },
        // Art. 15 Abs. 1: Verweis statt Inline-Dump — die vollständigen
        // Audit-Einträge der Person liefert der CSV-Export der Audit-Chain.
        auditTrail: {
          note:
            'Audit-Einträge zu dieser Person sind über den Audit-CSV-Export ' +
            'verfügbar (Filter: Akteur/Ressource = dieser Kontakt).',
          csvExport: '/api/staff/admin/audit/export',
        },
        exportedAt: new Date().toISOString(),
        exportedBy: staffId,
      };
    });
    return { ok: true, data };
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
  // admin/dsgvo-retention genutzt). personalDataInAudit: auf Betroffenen-Antrag
  // dokumentiert das Audit-Log, wessen Daten anonymisiert wurden (Art. 5 Abs. 2).
  await withTenantContext(ctx, (tx) =>
    anonymizeContactInTx(tx, { tenantId, staffId, contactId, personalDataInAudit: true }),
  );

  // N-2: Art. 17 ("Recht auf Löschung") — alle aktiven Portal-Sessions der Person
  // sofort revoken. Sonst bliebe der JWT-Cookie bis 24 h gültig und der
  // anonymisierte Kontakt könnte weiter aufs Portal zugreifen.
  await revokeAllSessions('portal', contactId);

  revalidatePath('/staff/admin/dsgvo');
}
