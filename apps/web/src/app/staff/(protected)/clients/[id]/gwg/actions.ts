'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { isStaffAdmin, toActionError, assertClientAccessTx } from '@/server/auth/rbac';
import { revokeAllSessions } from '@/server/auth/revocation';
import { withTenantContext } from '@taxtronik/db';
import type { Prisma } from '@prisma/client';
import { evidenceService } from '@/server/container';
import { computeRiskScore, riskValidForDays, DEFAULT_FACTORS } from '@/server/gwg/risk-score';
import { emitN8nEvent } from '@/server/n8n/emit';
import { notifyClientContacts } from '@/server/mail/dispatch';
import { fireAndForget } from '@/server/util/fire-and-forget';
import { portalBaseUrl } from '@taxtronik/config';
import { gwgVerificationErrors } from '@/server/gwg/verification';
import {
  staffActionGuard,
  withStaff,
  ActionError,
  type ActionResult as BaseActionResult,
} from '@/server/actions/staff-action';

// Einheitliches Action-Ergebnis aus der zentralen Quelle — der bestehende
// Import-Pfad './actions' bleibt für die Form-Komponenten stabil.
export type ActionResult = BaseActionResult;

// #2 (GwG-Integrität): Nach Abschluss einer Prüfung sind ihre Substanzdaten
// (Risikoantworten, wirtschaftlich Berechtigte, Ausweisdokumente) unveränderlich
// — § 8 GwG verlangt die unveränderte Aufbewahrung der Aufzeichnungen. Nur
// DRAFT/IN_REVIEW sind editierbar; eine Aktualisierung erfolgt über eine neue
// Prüfung (openCheckAction) bzw. den durch eine GwG-relevante Stammdaten-
// änderung ausgelösten Reset auf IN_REVIEW (clients/[id]/edit/actions.ts).
const EDITABLE_GWG_STATUSES: readonly string[] = ['DRAFT', 'IN_REVIEW'];

function assertGwgEditable(status: string): void {
  if (!EDITABLE_GWG_STATUSES.includes(status)) {
    throw new ActionError(
      'Diese GwG-Prüfung ist bereits abgeschlossen (verifiziert/abgelehnt/abgelaufen) und darf nicht mehr geändert werden (§ 8 GwG). Für eine Aktualisierung bitte eine neue Prüfung anlegen.',
    );
  }
}

const OpenSchema = z.object({ clientId: z.string().uuid() });

export async function openCheckAction(formData: FormData): Promise<void> {
  const parsed = OpenSchema.safeParse({ clientId: formData.get('clientId') });
  if (!parsed.success) throw new Error('Validierungsfehler.');
  const { clientId } = parsed.data;

  await withStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, clientId);
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
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, clientId);
      const before = await tx.gwgCheck.findFirst({ where: { id: checkId, clientId } });
      if (!before) throw new ActionError('GwG-Check nicht gefunden.');
      assertGwgEditable(before.status);
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

const LegalEntityDetailsSchema = z
  .object({
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    legalForm: z.string().trim().min(1).max(100),
    registerNumber: z.string().trim().max(100).optional().or(z.literal('')),
    registerAuthority: z.string().trim().max(200).optional().or(z.literal('')),
    noRegisterEntry: z.boolean(),
    representativeNamesText: z.string().max(4000),
    ownershipStructureNotes: z.string().trim().min(1).max(10000),
  })
  .superRefine((value, ctx) => {
    if (!value.noRegisterEntry && !value.registerNumber) {
      ctx.addIssue({
        code: 'custom',
        path: ['registerNumber'],
        message: 'Registernummer erforderlich.',
      });
    }
    if (!value.noRegisterEntry && !value.registerAuthority) {
      ctx.addIssue({
        code: 'custom',
        path: ['registerAuthority'],
        message: 'Register/Registergericht erforderlich.',
      });
    }
    const representatives = value.representativeNamesText
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);
    if (representatives.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['representativeNamesText'],
        message: 'Mindestens ein Vertreter erforderlich.',
      });
    }
  });

export async function saveLegalEntityDetailsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = LegalEntityDetailsSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    legalForm: formData.get('legalForm'),
    registerNumber: formData.get('registerNumber') ?? '',
    registerAuthority: formData.get('registerAuthority') ?? '',
    noRegisterEntry: formData.get('noRegisterEntry') === 'on',
    representativeNamesText: formData.get('representativeNamesText'),
    ownershipStructureNotes: formData.get('ownershipStructureNotes'),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join(' ') };
  }
  const data = parsed.data;
  const representativeNames = Array.from(
    new Set(
      data.representativeNamesText
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  );

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, data.clientId);
      const check = await tx.gwgCheck.findFirst({
        where: { id: data.checkId, clientId: data.clientId },
        select: {
          status: true,
          legalForm: true,
          registerNumber: true,
          registerAuthority: true,
          noRegisterEntry: true,
          representativeNames: true,
          ownershipStructureNotes: true,
          client: { select: { kind: true } },
        },
      });
      if (!check) throw new ActionError('GwG-Check nicht gefunden.');
      if (check.client.kind !== 'JURPERS' && check.client.kind !== 'PERSGES') {
        throw new ActionError(
          'Rechtsträger-Angaben sind nur bei juristischen Personen/Personengesellschaften erforderlich.',
        );
      }
      assertGwgEditable(check.status);

      const after = {
        legalForm: data.legalForm,
        registerNumber: data.noRegisterEntry ? null : data.registerNumber || null,
        registerAuthority: data.noRegisterEntry ? null : data.registerAuthority || null,
        noRegisterEntry: data.noRegisterEntry,
        representativeNames,
        ownershipStructureNotes: data.ownershipStructureNotes,
      };
      await tx.gwgCheck.update({ where: { id: data.checkId }, data: after });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.legal_entity_details.update',
        resourceType: 'gwg_check',
        resourceId: data.checkId,
        before: {
          legalForm: check.legalForm,
          registerNumber: check.registerNumber,
          registerAuthority: check.registerAuthority,
          noRegisterEntry: check.noRegisterEntry,
          representativeNames: check.representativeNames,
          ownershipStructureNotes: check.ownershipStructureNotes,
        },
        after,
      });
    },
    { revalidate: `/staff/clients/${data.clientId}/gwg` },
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
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, data.clientId);
      // Check laden + Status prüfen. Das Scope {id, clientId} bindet die checkId
      // an den autorisierten Mandanten (kein Cross-Check-Write über fremde ID).
      const check = await tx.gwgCheck.findFirst({
        where: { id: data.checkId, clientId: data.clientId },
        select: { status: true },
      });
      if (!check) throw new ActionError('GwG-Check nicht gefunden.');
      assertGwgEditable(check.status);
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
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, data.clientId);
      // Check laden + Status prüfen (bindet checkId an den autorisierten Mandanten).
      const check = await tx.gwgCheck.findFirst({
        where: { id: data.checkId, clientId: data.clientId },
        select: { status: true },
      });
      if (!check) throw new ActionError('GwG-Check nicht gefunden.');
      assertGwgEditable(check.status);
      if (data.documentId) {
        const evidenceDocument = await tx.document.findFirst({
          where: {
            id: data.documentId,
            tenantId,
            clientId: data.clientId,
            classification: 'GWG_EVIDENCE',
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!evidenceDocument) {
          throw new ActionError(
            'Der verknüpfte Nachweis muss ein nicht gelöschtes GwG-Dokument desselben Mandanten sein.',
          );
        }
      }
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
        include: {
          client: { select: { kind: true } },
          beneficialOwners: true,
          idDocuments: {
            include: {
              document: {
                select: { clientId: true, classification: true, deletedAt: true },
              },
            },
          },
        },
      });
      if (!check) throw new ActionError('GwG-Check nicht gefunden.');
      if (check.riskScore === null || check.riskLevel === null) {
        throw new ActionError('Bitte zuerst Risikobewertung durchführen.');
      }
      // § 10 Abs. 2 GwG: Die Risikoanalyse muss VOLLSTÄNDIG sein. Fehlende
      // Faktoren zählen im Score als 0 und könnten eine unbewertete Prüfung als
      // LOW verschleiern — vor der Scharfschaltung muss jeder Faktor bewusst
      // bewertet sein (Defense-in-Depth zum Formular-Placeholder).
      const savedAnswers = (check.riskAnswers as Record<string, number> | null) ?? {};
      const unbewertet = DEFAULT_FACTORS.filter(
        (f) => savedAnswers[f.key] === undefined || savedAnswers[f.key] === null,
      );
      if (unbewertet.length > 0) {
        throw new ActionError(
          'Die Risikoanalyse ist unvollständig — bitte alle Risikofaktoren bewerten, bevor die Prüfung verifiziert wird (§ 10 Abs. 2 GwG).',
        );
      }
      if (check.idDocuments.length === 0) {
        throw new ActionError('Mindestens ein Identitätsdokument erforderlich.');
      }
      // P2-2 / § 10 Abs. 1 Nr. 2, § 3 GwG: Bei juristischen Personen und
      // Personengesellschaften ist mindestens EIN wirtschaftlich Berechtigter
      // zu ermitteln (fiktiv-wB, wenn keiner > 25 % hält).
      const clientKind = await tx.client.findUnique({
        where: { id: clientId },
        select: { kind: true },
      });
      if (
        (clientKind?.kind === 'JURPERS' || clientKind?.kind === 'PERSGES') &&
        check.beneficialOwners.length === 0
      ) {
        throw new ActionError(
          'Bei juristischen Personen/Personengesellschaften ist mindestens ein wirtschaftlich Berechtigter zu erfassen (§ 10 Abs. 1 Nr. 2 GwG).',
        );
      }
      // P2-3 / § 12 Abs. 1, § 8 GwG: Es muss mindestens EIN identifikations-
      // taugliches Dokument (kein VOLLMACHT/SONSTIGES) mit hinterlegter Kopie
      // (documentId) und — falls ein Ablaufdatum erfasst ist — GÜLTIGER
      // Ausweis (nicht abgelaufen) vorliegen.
      const ID_SUITABLE: string[] = [
        'PERSONALAUSWEIS',
        'REISEPASS',
        'HANDELSREGISTERAUSZUG',
        'GESELLSCHAFTSVERTRAG',
        'TRANSPARENZREGISTER_AUSZUG',
      ];
      const heute = new Date();
      const taugliches = check.idDocuments.find(
        (d) =>
          ID_SUITABLE.includes(d.type) &&
          d.documentId != null &&
          (d.expiryDate == null || d.expiryDate.getTime() >= heute.getTime()),
      );
      if (!taugliches) {
        throw new ActionError(
          'Kein gültiges, identifikationstaugliches Ausweisdokument mit hinterlegter Kopie (§ 12 Abs. 1 GwG). Bitte amtlichen Ausweis/Registerauszug mit Datei und gültigem Ablaufdatum erfassen.',
        );
      }
      // H-2 / § 15 GwG: Ist ein wirtschaftlich Berechtigter als PEP markiert,
      // MUSS die Risikostufe HIGH sein (jährliche Überwachung). Bei
      // widersprechender Bewertung Verifikation blockieren — die erneute
      // Risikobewertung erzwingt über den PEP-Override HIGH.
      const verificationErrors = gwgVerificationErrors({
        clientId,
        clientKind: check.client.kind,
        legalForm: check.legalForm,
        registerNumber: check.registerNumber,
        registerAuthority: check.registerAuthority,
        noRegisterEntry: check.noRegisterEntry,
        representativeNames: check.representativeNames,
        ownershipStructureNotes: check.ownershipStructureNotes,
        beneficialOwnerCount: check.beneficialOwners.length,
        idDocuments: check.idDocuments,
      });
      if (verificationErrors.length > 0) {
        throw new ActionError(verificationErrors.join(' '));
      }

      if (check.beneficialOwners.some((o) => o.isPep) && check.riskLevel !== 'HIGH') {
        throw new ActionError(
          'Wirtschaftlich Berechtigter ist als PEP markiert — bitte die Risikobewertung erneut durchführen (§ 15 GwG: zwingend hohes Risiko, jährliche Aktualisierung).',
        );
      }

      const validForDays = riskValidForDays(check.riskLevel);
      const validUntil = new Date(Date.now() + validForDays * 24 * 60 * 60 * 1000);

      // TOCTOU-Schutz: nur aus dem Prüfstatus heraus verifizieren. Verhindert,
      // dass ein bereits REJECTED-Check ohne Neubewertung auf VERIFIED flippt
      // bzw. eine parallele Reject-Entscheidung überschrieben wird.
      const claim = await tx.gwgCheck.updateMany({
        where: { id: checkId, clientId, status: { in: ['DRAFT', 'IN_REVIEW'] } },
        data: {
          status: 'VERIFIED',
          verifiedAt: new Date(),
          verifiedBy: staffId,
          validUntil,
        },
      });
      if (claim.count === 0) {
        throw new ActionError('GwG-Check ist nicht mehr im Prüfstatus — bitte Seite neu laden.');
      }

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
  fireAndForget(
    'notifyClientContacts (gwg-activated)',
    notifyClientContacts({
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
    }),
  );
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
  const { tenantId, staffId, ctx, session } = g;

  const parsed = RejectSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return { ok: false, error: 'Begründung erforderlich.' };
  const { checkId, clientId, reason } = parsed.data;

  let contactIds: string[] = [];
  try {
    await withTenantContext(ctx, async (tx) => {
      await assertClientAccessTx(tx, session, clientId);
      // TOCTOU-Schutz: ein bereits verifizierter Check darf nicht per Race
      // nachträglich abgelehnt werden (sonst allowActive=true trotz Reject).
      const claim = await tx.gwgCheck.updateMany({
        where: { id: checkId, clientId, status: { not: 'VERIFIED' } },
        data: { status: 'REJECTED', rejectedReason: reason },
      });
      if (claim.count === 0) {
        throw new ActionError('GwG-Check ist bereits verifiziert — Ablehnung nicht möglich.');
      }
      await tx.client.updateMany({
        where: { id: clientId, allowActive: true },
        data: { allowActive: false },
      });
      contactIds = (
        await tx.clientContact.findMany({
          where: { clientId, active: true },
          select: { id: true },
        })
      ).map((c) => c.id);
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

  // GwG-Schranke (§ 11 GwG): bestehende Portal-Sessions aller Kontakte des
  // Mandanten sofort beenden — sonst bliebe ein bereits eingeloggter Kontakt
  // bis zum JWT-Ablauf (24 h) handlungsfähig. Nach dem Commit (Redis ist
  // nicht transaktional); fail-open analog revocation.ts, der Session-
  // Callback in portal.ts prüft allowActive zusätzlich pro Request.
  for (const contactId of contactIds) {
    await revokeAllSessions('portal', contactId);
  }

  emitN8nEvent('gwg.expired', { tenantId, clientId, reason: 'rejected' });
  revalidatePath(`/staff/clients/${clientId}`);
  revalidatePath(`/staff/clients/${clientId}/gwg`);
  return { ok: true };
}
