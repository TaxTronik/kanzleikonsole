'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { revokeAllSessions } from '@/server/auth/revocation';

type StaffAuthResult = Awaited<ReturnType<typeof staffAuth>>;

function requireAdmin(session: StaffAuthResult): asserts session is NonNullable<StaffAuthResult> {
  if (!session?.user) throw new Error('Nicht eingeloggt.');
  if (!isStaffAdmin(session)) {
    throw new Error('Nur ADMIN/PARTNER darf DSGVO-Anträge bearbeiten.');
  }
}

const CreateSchema = z.object({
  type: z.enum(['ACCESS', 'RECTIFICATION', 'ERASURE', 'RESTRICTION', 'PORTABILITY', 'OBJECTION']),
  subjectType: z.enum(['CLIENT_CONTACT', 'STAFF_USER', 'CLIENT', 'EXTERNAL']),
  subjectRefId: z.string().uuid().optional().or(z.literal('')),
  subjectEmail: z.string().email().max(255),
  subjectName: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
});

export interface ActionResult { ok: boolean; error?: string; }

export async function createDsgvoRequestAction(formData: FormData): Promise<void> {
  const session = await staffAuth();
  requireAdmin(session);

  const parsed = CreateSchema.safeParse({
    type: formData.get('type'),
    subjectType: formData.get('subjectType'),
    subjectRefId: formData.get('subjectRefId') ?? '',
    subjectEmail: formData.get('subjectEmail'),
    subjectName: formData.get('subjectName'),
    description: formData.get('description'),
  });
  if (!parsed.success) throw new Error('Validierungsfehler.');

  const { tenantId, staffId } = session.user;
  const data = parsed.data;
  // Frist nach DSGVO: 1 Monat
  const dueDate = new Date();
  dueDate.setMonth(dueDate.getMonth() + 1);

  const id = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
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
    },
  );

  revalidatePath('/staff/admin/dsgvo');
  redirect(`/staff/admin/dsgvo/${id}`);
}

const UpdateStatusSchema = z.object({
  requestId: z.string().uuid(),
  status: z.enum(['RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED']),
  notes: z.string().max(5000).optional().or(z.literal('')),
});

export async function updateStatusAction(formData: FormData): Promise<void> {
  const session = await staffAuth();
  requireAdmin(session);
  const parsed = UpdateStatusSchema.safeParse({
    requestId: formData.get('requestId'),
    status: formData.get('status'),
    notes: formData.get('notes') ?? '',
  });
  if (!parsed.success) return;

  const { tenantId, staffId } = session.user;
  const data = parsed.data;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
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
    },
  );

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
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };

  const { tenantId, staffId } = session.user;

  try {
    const data = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const contact = await tx.clientContact.findUnique({
          where: { id: contactId },
          include: { client: { select: { id: true, name: true } } },
        });
        if (!contact) throw new Error('Kontakt nicht gefunden.');

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
          },
          exportedAt: new Date().toISOString(),
          exportedBy: staffId,
        };
      },
    );
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
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
  const session = await staffAuth();
  requireAdmin(session);
  const contactIdRaw = formData.get('contactId');
  // NEW5: Input via Zod statt nur typeof — Prisma akzeptiert sonst beliebige
  // Strings für UUID-Spalten und wirft erst zur Laufzeit.
  const parsed = z.object({ contactId: z.string().uuid() }).safeParse({ contactId: contactIdRaw });
  if (!parsed.success) return;
  const { contactId } = parsed.data;

  const { tenantId, staffId } = session.user;
  const anonymizedAt = new Date().toISOString();
  // NEW5: randomUUID statt Date.now() — bei zwei Anonymisierungen in derselben
  // Millisekunde würde Unique-Constraint (tenant_id, email) sonst kollidieren.
  const anonymousEmail = `anonymized-${crypto.randomUUID()}@taxtronik.local`;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const before = await tx.clientContact.findUnique({ where: { id: contactId } });
      if (!before) return;
      await tx.clientContact.update({
        where: { id: contactId },
        data: {
          email: anonymousEmail,
          fullName: 'Anonymisiert',
          active: false,
        },
      });
      // Magic-Links der Person ungültig machen (consumed)
      await tx.magicLink.updateMany({
        where: { tenantId, email: before.email, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'dsgvo.anonymize.contact',
        resourceType: 'client_contact',
        resourceId: contactId,
        before: { email: before.email, fullName: before.fullName },
        after: { email: anonymousEmail, fullName: 'Anonymisiert', anonymizedAt },
      });
    },
  );

  // N-2: Art. 17 ("Recht auf Löschung") — alle aktiven Portal-Sessions der Person
  // sofort revoken. Sonst bliebe der JWT-Cookie bis 24 h gültig und der
  // anonymisierte Kontakt könnte weiter aufs Portal zugreifen.
  await revokeAllSessions('portal', contactId);

  revalidatePath('/staff/admin/dsgvo');
}
