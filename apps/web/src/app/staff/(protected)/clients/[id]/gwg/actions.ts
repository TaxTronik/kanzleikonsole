'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { isStaffAdmin, toActionError } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import type { Prisma } from '@prisma/client';
import { evidenceService } from '@/server/container';
import { computeRiskScore } from '@/server/gwg/risk-score';
import { emitN8nEvent } from '@/server/n8n/emit';
import { notifyClientContacts } from '@/server/mail/dispatch';
import { fireAndForget } from '@/server/util/fire-and-forget';
import { portalBaseUrl } from '@taxtronik/config';
import { staffActionGuard, withStaff, ActionError, type ActionResult as BaseActionResult } from '@/server/actions/staff-action';

// Einheitliches Action-Ergebnis aus der zentralen Quelle — der bestehende
// Import-Pfad './actions' bleibt für die Form-Komponenten stabil.
export type ActionResult = BaseActionResult;

const OpenSchema = z.object({ clientId: z.string().uuid() });

export async function openCheckAction(formData: FormData): Promise<void> {
  const parsed = OpenSchema.safeParse({ clientId: formData.get('clientId') });
  if (!parsed.success) throw new Error('Validierungsfehler.');
  const { clientId } = parsed.data;

  await withStaff(
    async (tx, { tenantId, staffId }) => {
      const check = await tx.gwgCheck.create({
        data: { tenantId, clientId, status: 'DRAFT' },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.check.open',
        resourceType: 'gwg_check',
        resourceId: check.id,
        after: { clientId },
      });
    },
    { revalidate: [`/staff/clients/${clientId}`, `/staff/clients/${clientId}/gwg`] },
  );
}

const AnswersSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  answers: z.record(z.string(), z.coerce.number().int().min(0).max(3)),
});

export async function saveRiskAnswersAction(input: {
  checkId: string;
  clientId: string;
  answers: Record<string, number>;
}) {
  const parsed = AnswersSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const { checkId, clientId, answers } = parsed.data;
  const result = computeRiskScore(answers);

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const before = await tx.gwgCheck.findFirst({ where: { id: checkId, clientId } });
      if (!before) throw new ActionError('GwG-Check nicht gefunden.');
      const updated = await tx.gwgCheck.update({
        where: { id: checkId },
        data: {
          riskAnswers: answers,
          riskScore: result.score,
          riskLevel: result.level,
          riskBreakdown: { factors: result.breakdown } as unknown as Prisma.InputJsonValue,
          status: before.status === 'DRAFT' ? 'IN_REVIEW' : before.status,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.check.assess',
        resourceType: 'gwg_check',
        resourceId: checkId,
        before: { riskScore: before.riskScore, riskLevel: before.riskLevel },
        after: { riskScore: updated.riskScore, riskLevel: updated.riskLevel },
      });
    },
    { revalidate: `/staff/clients/${clientId}/gwg` },
  );
}

const AddOwnerSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  fullName: z.string().min(1).max(200),
  birthDate: z.string().date().optional().or(z.literal('')),
  birthPlace: z.string().max(200).optional().or(z.literal('')),
  residence: z.string().max(500).optional().or(z.literal('')),
  nationality: z.string().max(100).optional().or(z.literal('')),
  ownershipPct: z.coerce.number().min(0).max(100).optional(),
  isPep: z.enum(['1', 'on', 'true']).optional(),
});

export async function addBeneficialOwnerAction(
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
) {
  const parsed = AddOwnerSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    fullName: formData.get('fullName'),
    birthDate: formData.get('birthDate') ?? '',
    birthPlace: formData.get('birthPlace') ?? '',
    residence: formData.get('residence') ?? '',
    nationality: formData.get('nationality') ?? '',
    ownershipPct: formData.get('ownershipPct') || undefined,
    isPep: formData.get('isPep') ?? undefined,
  });
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };
  const data = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const owner = await tx.gwgBeneficialOwner.create({
        data: {
          gwgCheckId: data.checkId,
          fullName: data.fullName,
          birthDate: data.birthDate ? new Date(data.birthDate) : null,
          birthPlace: data.birthPlace || null,
          residence: data.residence || null,
          nationality: data.nationality || null,
          ownershipPct: data.ownershipPct ?? null,
          isPep: !!data.isPep,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.owner.add',
        resourceType: 'gwg_beneficial_owner',
        resourceId: owner.id,
        after: {
          fullName: data.fullName,
          ownershipPct: data.ownershipPct ?? null,
          isPep: !!data.isPep,
        },
      });
    },
    { revalidate: `/staff/clients/${data.clientId}/gwg` },
  );
}

const AddIdDocSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  type: z.enum([
    'PERSONALAUSWEIS',
    'REISEPASS',
    'HANDELSREGISTERAUSZUG',
    'GESELLSCHAFTSVERTRAG',
    'VOLLMACHT',
    'TRANSPARENZREGISTER_AUSZUG',
    'SONSTIGES',
  ]),
  ownerName: z.string().min(1).max(200),
  number: z.string().max(100).optional().or(z.literal('')),
  issuedBy: z.string().max(200).optional().or(z.literal('')),
  issueDate: z.string().date().optional().or(z.literal('')),
  expiryDate: z.string().date().optional().or(z.literal('')),
  documentId: z.string().uuid().optional().or(z.literal('')),
});

export async function addIdDocumentAction(
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
) {
  const parsed = AddIdDocSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    type: formData.get('type'),
    ownerName: formData.get('ownerName'),
    number: formData.get('number') ?? '',
    issuedBy: formData.get('issuedBy') ?? '',
    issueDate: formData.get('issueDate') ?? '',
    expiryDate: formData.get('expiryDate') ?? '',
    documentId: formData.get('documentId') ?? '',
  });
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };
  const data = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const idDoc = await tx.gwgIdDocument.create({
        data: {
          gwgCheckId: data.checkId,
          type: data.type,
          ownerName: data.ownerName,
          number: data.number || null,
          issuedBy: data.issuedBy || null,
          issueDate: data.issueDate ? new Date(data.issueDate) : null,
          expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
          documentId: data.documentId || null,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.id_document.add',
        resourceType: 'gwg_id_document',
        resourceId: idDoc.id,
        after: { type: data.type, ownerName: data.ownerName },
      });
    },
    { revalidate: `/staff/clients/${data.clientId}/gwg` },
  );
}

const VerifySchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
});

export async function verifyCheckAction(
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
) {
  // F5: GwG-Verifikation ist die zentrale Compliance-Entscheidung
  // („Mandantenkonto scharfschalten"). Berufsrechtlich Berufsträger-Aufgabe
  // (Steuerberater). Minimum: ADMIN/PARTNER. Eigene, präzisere Meldung als der
  // Standard-Gate → manueller Check statt requireAdmin. Defense in Depth via
  // clientResponsibility.role === 'BERUFSTRAEGER' im withTenantContext-Block.
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;
  if (!isStaffAdmin(session)) {
    return { ok: false, error: 'Nur ADMIN/PARTNER darf eine GwG-Prüfung verifizieren.' };
  }

  const parsed = VerifySchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler — ungültige IDs.' };
  const { checkId, clientId } = parsed.data;

  try {
    await withTenantContext(ctx, async (tx) => {
      // F5: zusätzliche Prüfung — der entscheidende Staff muss als
      // BERUFSTRAEGER für diesen Mandanten zugeordnet sein. ADMIN/PARTNER
      // alleine reicht nicht; das Berufsrecht knüpft die Verifikation an
      // die fachliche Verantwortung.
      const isBerufstraeger = await tx.clientResponsibility.findFirst({
        where: { clientId, staffId, role: 'BERUFSTRAEGER' },
        select: { id: true },
      });
      if (!isBerufstraeger) {
        throw new ActionError(
          'Nur der für diesen Mandanten zugeordnete Berufsträger darf die GwG-Prüfung verifizieren.',
        );
      }

      const check = await tx.gwgCheck.findFirst({
        where: { id: checkId, clientId },
        include: { idDocuments: true, beneficialOwners: true },
      });
      if (!check) throw new ActionError('GwG-Check nicht gefunden.');
      if (check.riskScore === null || check.riskLevel === null) {
        throw new ActionError('Bitte zuerst Risikobewertung durchführen.');
      }
      if (check.idDocuments.length === 0) {
        throw new ActionError('Mindestens ein Identitätsdokument erforderlich.');
      }

      const validForDays = check.riskLevel === 'HIGH' ? 365 : 365 * 3;
      const validUntil = new Date(Date.now() + validForDays * 24 * 60 * 60 * 1000);

      await tx.gwgCheck.update({
        where: { id: checkId },
        data: {
          status: 'VERIFIED',
          verifiedAt: new Date(),
          verifiedBy: staffId,
          validUntil,
        },
      });

      // Mandant scharf schalten — der Trigger erlaubt das jetzt
      await tx.client.update({
        where: { id: clientId },
        data: { allowActive: true },
      });

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.check.verify',
        resourceType: 'gwg_check',
        resourceId: checkId,
        after: {
          riskLevel: check.riskLevel,
          riskScore: check.riskScore,
          validUntil: validUntil.toISOString(),
        },
      });
    });
  } catch (e) {
    return toActionError(e);
  }

  // Begrüßungs-Mail an alle Mandanten-Kontakte mit Mail-Opt-in (nach Commit).
  // Befund 3: fire-and-forget mit catch+Log statt `void` (unhandled rejection).
  fireAndForget('notifyClientContacts (gwg-activated)', notifyClientContacts({
    tenantId,
    clientId,
    slug: 'gwg-activated',
    vars: {
      portalUrl: `${portalBaseUrl}/portal/dashboard`,
    },
    n8nEvent: 'client.created',
    n8nPayload: { tenantId, clientId, gwgVerified: true },
    fallback: {
      subject: 'Willkommen — Ihre Mandantschaft ist nun aktiv',
      bodyMd:
        'Sehr geehrte/r {{contact.fullName}},\n\nIhre Mandantschaft ist jetzt vollständig eingerichtet. Loggen Sie sich gerne in Ihr Mandantenportal ein:\n\n{{portalUrl}}',
    },
  }));
  revalidatePath(`/staff/clients/${clientId}`);
  revalidatePath(`/staff/clients/${clientId}/gwg`);
  return { ok: true };
}

const RejectSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
});

export async function rejectCheckAction(
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
) {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const parsed = RejectSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return { ok: false, error: 'Begründung erforderlich.' };
  const { checkId, clientId, reason } = parsed.data;

  try {
    await withTenantContext(ctx, async (tx) => {
      await tx.gwgCheck.update({
        where: { id: checkId },
        data: { status: 'REJECTED', rejectedReason: reason },
      });
      await tx.client.updateMany({
        where: { id: clientId, allowActive: true },
        data: { allowActive: false },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.check.reject',
        resourceType: 'gwg_check',
        resourceId: checkId,
        after: { reason },
      });
    });
  } catch (e) {
    return toActionError(e);
  }

  emitN8nEvent('gwg.expired', { tenantId, clientId, reason: 'rejected' });
  revalidatePath(`/staff/clients/${clientId}`);
  revalidatePath(`/staff/clients/${clientId}/gwg`);
  return { ok: true };
}
