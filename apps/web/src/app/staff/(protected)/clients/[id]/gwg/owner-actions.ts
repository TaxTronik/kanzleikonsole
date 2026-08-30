'use server';

import { randomUUID } from 'node:crypto';
import type { GwgBeneficialOwner } from '@prisma/client';
import { z } from 'zod';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import { lockGwgCheckLifecycleTx } from '@/server/gwg/reverification';
import { gwgBeneficialOwnerRevision, gwgPersonGeneralRevision } from '@/server/gwg/revisions';
import { validateIdentityDates } from '@/server/gwg/identity-date-validation';
import { withStaff, ActionError, parseFormData } from '@/server/actions/staff-action';

import {
  invalidatedIdentitySetRevisions,
  assertGwgEditable,
  claimCheckMutation,
  confirmUnchangedCheck,
  type ActionResult,
  type InvalidatedIdentitySet,
  type SavedBeneficialOwner,
} from './_action-helpers';

// Stabile Typ-Importpfade fuer die Form-Komponenten dieser Route.
export type { ActionResult, InvalidatedIdentitySet, SavedBeneficialOwner } from './_action-helpers';

const CheckboxSchema = z
  .literal('on')
  .optional()
  .transform((value) => value === 'on');
const OptionalPercentageSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.coerce.number().min(0).max(100).optional(),
);

const AddGwgPersonSchema = z
  .object({
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    fullName: z.string().trim().min(1).max(200),
    isBeneficialOwner: CheckboxSchema,
    isRepresentative: CheckboxSchema,
    birthDate: z.string().date(),
    birthPlace: z.string().trim().min(1).max(200),
    residence: z.string().trim().min(1).max(500),
    nationality: z.string().trim().min(1).max(100),
    ownershipPct: OptionalPercentageSchema,
    isPep: z.enum(['true', 'false']).transform((value) => value === 'true'),
  })
  .superRefine((person, ctx) => {
    if (!person.isBeneficialOwner && !person.isRepresentative) {
      ctx.addIssue({
        code: 'custom',
        path: ['roles'],
        message: 'Mindestens eine Rolle auswählen.',
      });
    }
    for (const issue of validateIdentityDates({ birthDate: person.birthDate })) {
      ctx.addIssue({ code: 'custom', path: ['birthDate'], message: issue.message });
    }
  });

/**
 * Erfasst eine relevante natürliche Person zuerst als eigenes UI-Element und
 * ordnet ihr anschließend die ausgewählten Rollen zu. Eine Vertreterrolle
 * wird nie mehr über die Rechtsträgermaske als freie Namenszeile angelegt.
 */
export async function addGwgPersonAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = parseFormData(AddGwgPersonSchema, formData, {
    errorMessage: 'Die allgemeinen Angaben und mindestens eine Rolle sind erforderlich.',
  });
  if (!parsed.ok) return parsed;
  const data = parsed.data;

  return withStaff(async (tx, { tenantId, staffId, session }) => {
    await assertClientAccessTx(tx, session, data.clientId);
    await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });
    const check = await tx.gwgCheck.findFirst({
      where: { id: data.checkId, clientId: data.clientId },
      select: {
        status: true,
        client: { select: { kind: true } },
        representatives: { select: { position: true }, orderBy: { position: 'asc' } },
      },
    });
    if (!check) throw new ActionError('GwG-Check nicht gefunden.');
    if (check.client.kind !== 'JURPERS' && check.client.kind !== 'PERSGES') {
      throw new ActionError('Zusätzliche Personenrollen sind nur bei Rechtsträgern vorgesehen.');
    }
    assertGwgEditable(check.status);
    await claimCheckMutation(tx, {
      checkId: data.checkId,
      clientId: data.clientId,
      expectedStatus: check.status,
      invalidateRisk: true,
    });

    const owner = data.isBeneficialOwner
      ? await tx.gwgBeneficialOwner.create({
          data: {
            gwgCheckId: data.checkId,
            fullName: data.fullName,
            birthDate: new Date(data.birthDate),
            birthPlace: data.birthPlace,
            residence: data.residence,
            nationality: data.nationality,
            ownershipPct: data.ownershipPct ?? null,
            isPep: data.isPep,
          },
          select: { id: true },
        })
      : null;
    const representativeId = data.isRepresentative ? randomUUID() : null;
    if (representativeId) {
      const position = Math.max(-1, ...check.representatives.map((entry) => entry.position)) + 1;
      await tx.gwgRepresentative.create({
        data: {
          id: representativeId,
          gwgCheckId: data.checkId,
          fullName: data.fullName,
          birthDate: new Date(data.birthDate),
          birthPlace: data.birthPlace,
          residence: data.residence,
          nationality: data.nationality,
          isPep: data.isPep,
          position,
          linkedBeneficialOwnerId: owner?.id ?? null,
        },
      });
    }

    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.person.add',
      resourceType: 'gwg_person',
      resourceId: owner?.id ?? representativeId!,
      after: {
        fullName: data.fullName,
        birthDate: data.birthDate,
        birthPlace: data.birthPlace,
        residence: data.residence,
        nationality: data.nationality,
        isPep: data.isPep,
        beneficialOwnerId: owner?.id ?? null,
        representativeId,
        roles: [
          ...(data.isBeneficialOwner ? ['WIRTSCHAFTLICH_BERECHTIGT'] : []),
          ...(data.isRepresentative ? ['VERTRETUNGSBERECHTIGT'] : []),
        ],
      },
    });
  });
}

const OptionalUuidSchema = z
  .union([z.string().uuid(), z.literal('')])
  .transform((value) => value || undefined);

const UpdateGwgPersonGeneralSchema = z
  .object({
    ownerId: OptionalUuidSchema,
    representativeId: OptionalUuidSchema,
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    fullName: z.string().trim().min(1).max(200),
    birthDate: z.string().date(),
    birthPlace: z.string().trim().min(1).max(200),
    residence: z.string().trim().min(1).max(500),
    nationality: z.string().trim().min(1).max(100),
    isPep: z.enum(['true', 'false']).transform((value) => value === 'true'),
    expectedRevision: z.string().min(1),
  })
  .superRefine((person, ctx) => {
    if (!person.ownerId && !person.representativeId) {
      ctx.addIssue({ code: 'custom', path: ['person'], message: 'Personenbezug fehlt.' });
    }
    for (const issue of validateIdentityDates({ birthDate: person.birthDate })) {
      ctx.addIssue({ code: 'custom', path: ['birthDate'], message: issue.message });
    }
  });

export interface SavedGwgPersonGeneral {
  fullName: string;
  birthDate: string;
  birthPlace: string;
  residence: string;
  nationality: string;
  isPep: boolean | null;
}

interface GwgPersonGeneralMutationPayload {
  saved?: SavedGwgPersonGeneral;
  latest?: SavedGwgPersonGeneral;
  revision?: string;
  conflict?: boolean;
  reviewReset?: boolean;
  invalidatedIdentitySets?: InvalidatedIdentitySet[];
}

export type GwgPersonGeneralActionResult = ActionResult & GwgPersonGeneralMutationPayload;

/**
 * Speichert allgemeine Angaben einmal auf Personenebene. Bei einer Doppelrolle
 * werden die beiden bestehenden Rollensnapshots atomar synchronisiert; die
 * Rollenmaske selbst verarbeitet nur noch rollenspezifische Werte.
 */
export async function updateGwgPersonGeneralAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<GwgPersonGeneralActionResult> {
  const parsed = parseFormData(UpdateGwgPersonGeneralSchema, formData, {
    errorMessage: 'Die allgemeinen Angaben sind unvollständig oder ungültig.',
  });
  if (!parsed.ok) return parsed;
  const data = parsed.data;

  const result = await withStaff(async (tx, { tenantId, staffId, session }) => {
    await assertClientAccessTx(tx, session, data.clientId);
    await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });
    const check = await tx.gwgCheck.findFirst({
      where: { id: data.checkId, clientId: data.clientId },
      select: {
        status: true,
        representativeNames: true,
        beneficialOwners: {
          where: data.ownerId ? { id: data.ownerId } : { id: { in: [] } },
          select: {
            id: true,
            fullName: true,
            birthDate: true,
            birthPlace: true,
            residence: true,
            nationality: true,
            isPep: true,
          },
        },
        representatives: {
          where: data.representativeId ? { id: data.representativeId } : { id: { in: [] } },
          select: {
            id: true,
            fullName: true,
            birthDate: true,
            birthPlace: true,
            residence: true,
            nationality: true,
            isPep: true,
            position: true,
            linkedBeneficialOwnerId: true,
          },
        },
      },
    });
    if (!check) throw new ActionError('GwG-Check nicht gefunden.');
    assertGwgEditable(check.status);
    const owner = check.beneficialOwners[0] ?? null;
    const representative = check.representatives[0] ?? null;
    if (data.ownerId && !owner) throw new ActionError('Die Person wurde nicht gefunden.');
    if (data.representativeId && !representative) {
      throw new ActionError('Die Person wurde nicht gefunden.');
    }
    if (owner && representative && representative.linkedBeneficialOwnerId !== owner.id) {
      throw new ActionError('Die Rollen gehören nicht zu derselben Person.');
    }
    const source = owner ?? representative;
    if (!source) throw new ActionError('Die Person wurde nicht gefunden.');
    const currentGeneral = {
      fullName: source.fullName,
      birthDate: source.birthDate,
      birthPlace: source.birthPlace,
      residence: source.residence,
      nationality: source.nationality,
      isPep: source.isPep,
    };
    const currentRevision = gwgPersonGeneralRevision(currentGeneral);
    if (currentRevision !== data.expectedRevision) {
      return {
        conflict: true,
        latest: {
          fullName: source.fullName,
          birthDate: source.birthDate?.toISOString().slice(0, 10) ?? '',
          birthPlace: source.birthPlace ?? '',
          residence: source.residence ?? '',
          nationality: source.nationality ?? '',
          isPep: source.isPep,
        },
        revision: currentRevision,
      };
    }
    const saved: SavedGwgPersonGeneral = {
      fullName: data.fullName,
      birthDate: data.birthDate,
      birthPlace: data.birthPlace,
      residence: data.residence,
      nationality: data.nationality,
      isPep: data.isPep,
    };
    const identityChanged =
      source.fullName !== data.fullName ||
      source.birthDate?.toISOString().slice(0, 10) !== data.birthDate ||
      (source.birthPlace ?? '') !== data.birthPlace ||
      (source.residence ?? '') !== data.residence ||
      (source.nationality ?? '') !== data.nationality;
    const contentChanged = identityChanged || source.isPep !== data.isPep;
    if (!contentChanged) {
      await confirmUnchangedCheck(tx, {
        checkId: data.checkId,
        clientId: data.clientId,
        expectedStatus: check.status,
      });
      return { saved, revision: data.expectedRevision, reviewReset: false };
    }

    await claimCheckMutation(tx, {
      checkId: data.checkId,
      clientId: data.clientId,
      expectedStatus: check.status,
      invalidateRisk: true,
    });
    let affectedDocuments: Array<{ id: string; documentSetId: string }> = [];
    if (identityChanged) {
      affectedDocuments = await tx.gwgIdDocument.findMany({
        where: {
          gwgCheckId: data.checkId,
          supersededAt: null,
          OR: [
            ...(owner ? [{ beneficialOwnerSubjectId: owner.id }] : []),
            ...(representative ? [{ representativeSubjectId: representative.id }] : []),
          ],
        },
        select: { id: true, documentSetId: true },
      });
      await tx.gwgIdDocument.updateMany({
        where: {
          gwgCheckId: data.checkId,
          id: { in: affectedDocuments.map((document) => document.id) },
          supersededAt: null,
        },
        data: {
          identityAssignmentConfirmedAt: null,
          identityAssignmentConfirmedBy: null,
          verifiedAt: null,
        },
      });
    }
    const commonData = {
      fullName: data.fullName,
      birthDate: new Date(data.birthDate),
      birthPlace: data.birthPlace,
      residence: data.residence,
      nationality: data.nationality,
      isPep: data.isPep,
    };
    if (owner) {
      await tx.gwgBeneficialOwner.update({ where: { id: owner.id }, data: commonData });
    }
    if (representative) {
      await tx.gwgRepresentative.update({
        where: { id: representative.id },
        data: commonData,
      });
      if (representative.fullName !== data.fullName) {
        const representativeNames = [...check.representativeNames];
        representativeNames[representative.position] = data.fullName;
        await tx.gwgCheck.update({
          where: { id: data.checkId },
          data: { representativeNames },
        });
      }
    }
    const invalidatedIdentitySets = await invalidatedIdentitySetRevisions(
      tx,
      data.checkId,
      affectedDocuments.map((document) => document.documentSetId),
    );
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.person.general.update',
      resourceType: 'gwg_person',
      resourceId: owner?.id ?? representative!.id,
      before: {
        ...currentGeneral,
        birthDate: currentGeneral.birthDate?.toISOString().slice(0, 10) ?? null,
      },
      after: { ...saved, invalidatedIdentityDocuments: affectedDocuments.length },
    });
    return {
      saved,
      revision: gwgPersonGeneralRevision({
        ...saved,
        birthDate: data.birthDate,
      }),
      reviewReset: check.status === 'IN_REVIEW',
      invalidatedIdentitySets,
    };
  });

  if (result.conflict && result.latest && result.revision) {
    return {
      ok: false,
      conflict: true,
      latest: result.latest,
      revision: result.revision,
      error:
        'Die allgemeinen Angaben wurden zwischenzeitlich geändert. Der aktuelle Stand wurde automatisch nachgeladen; Ihre Eingabe bleibt erhalten.',
    };
  }
  return result;
}

const AddOwnerSchema = z
  .object({
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    fullName: z.string().trim().min(1).max(200),
    birthDate: z.string().date(),
    birthPlace: z.string().trim().min(1).max(200),
    residence: z.string().trim().min(1).max(500),
    nationality: z.string().trim().min(1).max(100),
    ownershipPct: z.coerce.number().min(0).max(100).optional(),
    isPep: z.enum(['true', 'false']).transform((value) => value === 'true'),
  })
  .superRefine((owner, ctx) => {
    for (const issue of validateIdentityDates({ birthDate: owner.birthDate })) {
      ctx.addIssue({ code: 'custom', path: ['birthDate'], message: issue.message });
    }
  });

const AddBeneficialOwnerRoleSchema = z.object({
  representativeId: z.string().uuid(),
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  ownershipPct: OptionalPercentageSchema,
});

/**
 * Ergänzt eine bereits erfasste gesetzliche Vertretung um die Rolle als
 * wirtschaftlich Berechtigter. Owner-Datensatz und explizite Rollenverknüpfung
 * entstehen in derselben Transaktion; der Vertreter bleibt dabei erhalten.
 */
export async function addBeneficialOwnerRoleAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult & { createdOwnerId?: string; reviewReset?: boolean }> {
  const parsed = parseFormData(AddBeneficialOwnerRoleSchema, formData, {
    errorMessage: 'Die Rolle konnte nicht zugeordnet werden.',
  });
  if (!parsed.ok) return parsed;
  const data = parsed.data;

  return withStaff(async (tx, { tenantId, staffId, session }) => {
    await assertClientAccessTx(tx, session, data.clientId);
    await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });
    const check = await tx.gwgCheck.findFirst({
      where: { id: data.checkId, clientId: data.clientId },
      select: {
        status: true,
        client: { select: { kind: true } },
        representatives: {
          where: { id: data.representativeId },
          select: {
            id: true,
            fullName: true,
            birthDate: true,
            birthPlace: true,
            residence: true,
            nationality: true,
            isPep: true,
            linkedBeneficialOwnerId: true,
          },
        },
      },
    });
    if (!check) throw new ActionError('GwG-Check nicht gefunden.');
    if (check.client.kind !== 'JURPERS' && check.client.kind !== 'PERSGES') {
      throw new ActionError('Doppelrollen sind nur bei Rechtsträgern vorgesehen.');
    }
    assertGwgEditable(check.status);
    const representative = check.representatives[0];
    if (!representative) {
      throw new ActionError('Die gesetzliche Vertretung wurde nicht gefunden.');
    }
    if (representative.linkedBeneficialOwnerId) {
      throw new ActionError('Diese Person ist bereits wirtschaftlich berechtigt.');
    }
    if (
      !representative.birthDate ||
      !representative.birthPlace?.trim() ||
      !representative.residence?.trim() ||
      !representative.nationality?.trim() ||
      representative.isPep === null
    ) {
      throw new ActionError(
        'Bitte zuerst die allgemeinen Angaben der Person vollständig erfassen.',
      );
    }

    await claimCheckMutation(tx, {
      checkId: data.checkId,
      clientId: data.clientId,
      expectedStatus: check.status,
      invalidateRisk: true,
    });
    const owner = await tx.gwgBeneficialOwner.create({
      data: {
        gwgCheckId: data.checkId,
        fullName: representative.fullName,
        birthDate: representative.birthDate,
        birthPlace: representative.birthPlace,
        residence: representative.residence,
        nationality: representative.nationality,
        ownershipPct: data.ownershipPct ?? null,
        isPep: representative.isPep,
      },
      select: { id: true },
    });
    const linked = await tx.gwgRepresentative.updateMany({
      where: {
        id: data.representativeId,
        gwgCheckId: data.checkId,
        linkedBeneficialOwnerId: null,
      },
      data: { linkedBeneficialOwnerId: owner.id },
    });
    if (linked.count !== 1) {
      throw new ActionError('Die Rollen wurden parallel geändert. Bitte Seite neu laden.');
    }

    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.person.roles.update',
      resourceType: 'gwg_person',
      resourceId: data.representativeId,
      before: { roles: ['VERTRETUNGSBERECHTIGT'] },
      after: {
        beneficialOwnerId: owner.id,
        roles: ['VERTRETUNGSBERECHTIGT', 'WIRTSCHAFTLICH_BERECHTIGT'],
        ownershipPct: data.ownershipPct ?? null,
        isPep: representative.isPep,
      },
    });
    return {
      createdOwnerId: owner.id,
      reviewReset: check.status === 'IN_REVIEW',
    };
  });
}

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
    isPep: formData.get('isPep'),
  });
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };
  const data = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, data.clientId);
      await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });
      // Check laden + Status prüfen. Das Scope {id, clientId} bindet die checkId
      // an den autorisierten Mandanten (kein Cross-Check-Write über fremde ID).
      const check = await tx.gwgCheck.findFirst({
        where: { id: data.checkId, clientId: data.clientId },
        select: { status: true },
      });
      if (!check) throw new ActionError('GwG-Check nicht gefunden.');
      assertGwgEditable(check.status);
      await claimCheckMutation(tx, {
        checkId: data.checkId,
        clientId: data.clientId,
        expectedStatus: check.status,
        invalidateRisk: true,
      });
      const owner = await tx.gwgBeneficialOwner.create({
        data: {
          gwgCheckId: data.checkId,
          fullName: data.fullName,
          birthDate: data.birthDate ? new Date(data.birthDate) : null,
          birthPlace: data.birthPlace || null,
          residence: data.residence || null,
          nationality: data.nationality || null,
          ownershipPct: data.ownershipPct ?? null,
          isPep: data.isPep,
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
          isPep: data.isPep,
        },
      });
    },
    // Kein revalidate der aktuellen Route: das erzwang einen kompletten
    // RSC-Re-Render der GwG-Seite IN der Action-Antwort und ließ die
    // Form-Transition bis zur nächsten Interaktion hängen (UI "switcht"
    // erst nach erneutem Klick). Der Client ruft stattdessen nach dem
    // Erfolg router.refresh() außerhalb der Transition auf.
  );
}

const UpdateOwnerSchema = z
  .object({
    ownerId: z.string().uuid(),
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    fullName: z.string().trim().min(1).max(200),
    birthDate: z.string().date(),
    birthPlace: z.string().trim().min(1).max(200),
    residence: z.string().trim().min(1).max(500),
    nationality: z.string().trim().min(1).max(100),
    ownershipPct: z.coerce.number().min(0).max(100).optional(),
    isPep: z.enum(['true', 'false']).transform((value) => value === 'true'),
    expectedRevision: z.string().min(2).max(20_000),
  })
  .superRefine((owner, ctx) => {
    for (const issue of validateIdentityDates({ birthDate: owner.birthDate })) {
      ctx.addIssue({ code: 'custom', path: ['birthDate'], message: issue.message });
    }
  });

type UpdatedOwnerInput = z.infer<typeof UpdateOwnerSchema>;
type StoredOwnerSnapshot = Pick<
  GwgBeneficialOwner,
  | 'id'
  | 'fullName'
  | 'birthDate'
  | 'birthPlace'
  | 'residence'
  | 'nationality'
  | 'ownershipPct'
  | 'isPep'
>;

// GWG-BENEFICIAL-OWNERS-001 / GWG-IDENTIFICATION-EVIDENCE-001: these pure
// comparisons/mappings leave the transaction, CAS, synchronization and audit
// sequence in the action unchanged.
function ownerIdentityFieldsChanged(owner: StoredOwnerSnapshot, data: UpdatedOwnerInput): boolean {
  return (
    owner.fullName !== data.fullName ||
    owner.birthDate?.toISOString().slice(0, 10) !== data.birthDate ||
    (owner.birthPlace ?? '') !== data.birthPlace ||
    (owner.residence ?? '') !== data.residence ||
    (owner.nationality ?? '') !== data.nationality
  );
}

function savedBeneficialOwner(data: UpdatedOwnerInput): SavedBeneficialOwner {
  return {
    id: data.ownerId,
    fullName: data.fullName,
    birthDate: data.birthDate,
    birthPlace: data.birthPlace,
    residence: data.residence,
    nationality: data.nationality,
    ownershipPct: data.ownershipPct === undefined ? '' : String(data.ownershipPct),
    isPep: data.isPep,
  };
}

function updatedOwnerColumns(data: UpdatedOwnerInput) {
  return {
    fullName: data.fullName,
    birthDate: data.birthDate ? new Date(data.birthDate) : null,
    birthPlace: data.birthPlace || null,
    residence: data.residence || null,
    nationality: data.nationality || null,
    ownershipPct: data.ownershipPct ?? null,
    isPep: data.isPep,
  };
}

function ownerAuditBefore(owner: StoredOwnerSnapshot) {
  return {
    fullName: owner.fullName,
    birthDate: owner.birthDate?.toISOString().slice(0, 10) ?? null,
    birthPlace: owner.birthPlace,
    residence: owner.residence,
    nationality: owner.nationality,
    ownershipPct: owner.ownershipPct?.toString() ?? null,
    isPep: owner.isPep,
  };
}

function ownerAuditAfter(data: UpdatedOwnerInput, invalidatedIdentityDocuments: number) {
  return {
    fullName: data.fullName,
    birthDate: data.birthDate || null,
    birthPlace: data.birthPlace || null,
    residence: data.residence || null,
    nationality: data.nationality || null,
    ownershipPct: data.ownershipPct ?? null,
    isPep: data.isPep,
    invalidatedIdentityDocuments,
  };
}

function updatedOwnerRevision(data: UpdatedOwnerInput): string {
  return gwgBeneficialOwnerRevision({
    id: data.ownerId,
    fullName: data.fullName,
    birthDate: data.birthDate,
    birthPlace: data.birthPlace || null,
    residence: data.residence || null,
    nationality: data.nationality || null,
    ownershipPct: data.ownershipPct ?? null,
    isPep: data.isPep,
  });
}

/**
 * Korrigiert die Angaben eines vorhandenen wirtschaftlich Berechtigten. Die
 * Check-Zeile wird zuerst per Status-CAS beansprucht; eine zeitgleiche Freigabe
 * gewinnt damit entweder vollstaendig oder wird sauber mit einem Konflikt
 * abgewiesen. Jede inhaltliche Korrektur nimmt eine laufende Freigabe zurueck.
 */
export async function updateBeneficialOwnerAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<
  ActionResult & {
    reviewReset?: boolean;
    revision?: string;
    saved?: SavedBeneficialOwner;
    invalidatedIdentitySets?: InvalidatedIdentitySet[];
  }
> {
  const parsed = UpdateOwnerSchema.safeParse({
    ownerId: formData.get('ownerId'),
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    fullName: formData.get('fullName'),
    birthDate: formData.get('birthDate') ?? '',
    birthPlace: formData.get('birthPlace') ?? '',
    residence: formData.get('residence') ?? '',
    nationality: formData.get('nationality') ?? '',
    ownershipPct: formData.get('ownershipPct') || undefined,
    isPep: formData.get('isPep'),
    expectedRevision: formData.get('expectedRevision'),
  });
  if (!parsed.success) return { ok: false, error: 'Ungültige Angaben zur Person.' };
  const data = parsed.data;

  return withStaff(async (tx, { tenantId, staffId, session }) => {
    await assertClientAccessTx(tx, session, data.clientId);
    await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });
    const check = await tx.gwgCheck.findFirst({
      where: { id: data.checkId, clientId: data.clientId },
      select: {
        status: true,
        beneficialOwners: {
          where: { id: data.ownerId },
          select: {
            id: true,
            fullName: true,
            birthDate: true,
            birthPlace: true,
            residence: true,
            nationality: true,
            ownershipPct: true,
            isPep: true,
          },
        },
        representatives: {
          select: { id: true, fullName: true, position: true, linkedBeneficialOwnerId: true },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!check) throw new ActionError('GwG-Check nicht gefunden.');
    const owner = check.beneficialOwners[0];
    if (!owner) throw new ActionError('Wirtschaftlich Berechtigter nicht gefunden.');
    assertGwgEditable(check.status);
    if (gwgBeneficialOwnerRevision(owner) !== data.expectedRevision) {
      throw new ActionError(
        'Die Personendaten wurden zwischenzeitlich geändert. Bitte Seite neu laden; Ihre Eingabe wurde nicht überschrieben.',
      );
    }
    const identityFieldsChanged = ownerIdentityFieldsChanged(owner, data);
    const ownershipBefore = owner.ownershipPct === null ? null : Number(owner.ownershipPct);
    const ownershipAfter = data.ownershipPct ?? null;
    const contentChanged =
      identityFieldsChanged || ownershipBefore !== ownershipAfter || owner.isPep !== data.isPep;

    if (!contentChanged) {
      await confirmUnchangedCheck(tx, {
        checkId: data.checkId,
        clientId: data.clientId,
        expectedStatus: check.status,
      });
      return {
        reviewReset: false,
        revision: gwgBeneficialOwnerRevision(owner),
        saved: savedBeneficialOwner(data),
      };
    }

    await claimCheckMutation(tx, {
      checkId: data.checkId,
      clientId: data.clientId,
      expectedStatus: check.status,
      invalidateRisk: true,
    });
    const linkedRepresentatives = (check.representatives ?? []).filter(
      (representative) => representative.linkedBeneficialOwnerId === data.ownerId,
    );
    const generalPersonFieldsChanged = identityFieldsChanged || owner.isPep !== data.isPep;
    if (generalPersonFieldsChanged && linkedRepresentatives.length > 0) {
      const synchronized = await tx.gwgRepresentative.updateMany({
        where: {
          gwgCheckId: data.checkId,
          linkedBeneficialOwnerId: data.ownerId,
        },
        data: {
          fullName: data.fullName,
          birthDate: new Date(data.birthDate),
          birthPlace: data.birthPlace,
          residence: data.residence,
          nationality: data.nationality,
          isPep: data.isPep,
        },
      });
      if (synchronized.count !== linkedRepresentatives.length) {
        throw new ActionError(
          'Die Doppelrolle konnte nicht vollständig synchronisiert werden. Bitte erneut versuchen.',
        );
      }
    }
    if (owner.fullName !== data.fullName && linkedRepresentatives.length > 0) {
      await tx.gwgCheck.update({
        where: { id: data.checkId },
        data: {
          representativeNames: check.representatives.map((representative) =>
            representative.linkedBeneficialOwnerId === data.ownerId
              ? data.fullName
              : representative.fullName,
          ),
        },
      });
    }
    let invalidatedIdentityDocuments = 0;
    let invalidatedIdentityDocumentSetIds: string[] = [];
    if (identityFieldsChanged) {
      const linkedRepresentativeIds = linkedRepresentatives.map(
        (representative) => representative.id,
      );
      const assignedDocuments = await tx.gwgIdDocument.findMany({
        where: {
          gwgCheckId: data.checkId,
          supersededAt: null,
          OR: [
            { beneficialOwnerSubjectId: data.ownerId },
            ...(linkedRepresentativeIds.length > 0
              ? [{ representativeSubjectId: { in: linkedRepresentativeIds } }]
              : []),
          ],
        },
        select: { id: true, documentSetId: true },
      });
      const invalidated = await tx.gwgIdDocument.updateMany({
        where: {
          gwgCheckId: data.checkId,
          id: { in: assignedDocuments.map((document) => document.id) },
          supersededAt: null,
        },
        data: {
          identityAssignmentConfirmedAt: null,
          identityAssignmentConfirmedBy: null,
          verifiedAt: null,
        },
      });
      invalidatedIdentityDocuments = invalidated.count;
      invalidatedIdentityDocumentSetIds = assignedDocuments.map(
        (document) => document.documentSetId,
      );
    }
    await tx.gwgBeneficialOwner.update({
      where: { id: data.ownerId },
      data: updatedOwnerColumns(data),
    });
    const invalidatedIdentitySets = await invalidatedIdentitySetRevisions(
      tx,
      data.checkId,
      invalidatedIdentityDocumentSetIds,
    );
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.owner.update',
      resourceType: 'gwg_beneficial_owner',
      resourceId: data.ownerId,
      before: ownerAuditBefore(owner),
      after: ownerAuditAfter(data, invalidatedIdentityDocuments),
    });
    return {
      reviewReset: check.status === 'IN_REVIEW',
      ...(invalidatedIdentitySets.length > 0 ? { invalidatedIdentitySets } : {}),
      revision: updatedOwnerRevision(data),
      saved: savedBeneficialOwner(data),
    };
  });
}

const RemoveOwnerSchema = z.object({
  ownerId: z.string().uuid(),
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  expectedRevision: z.string().min(2).max(20_000),
});

/**
 * Entfernt eine nicht mehr wirtschaftlich berechtigte Person nur aus dem
 * aktuellen, bearbeitbaren Snapshot. Zugehörige Ausweisbelege bleiben in der
 * Akte erhalten, werden aber bewusst entbestätigt und müssen einer aktuellen
 * Person neu zugeordnet werden. Der alte VERIFIED-Snapshot bleibt unverändert.
 */
export async function removeBeneficialOwnerAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<
  ActionResult & {
    removedOwnerId?: string;
    reviewReset?: boolean;
    invalidatedIdentitySets?: InvalidatedIdentitySet[];
  }
> {
  const parsed = parseFormData(RemoveOwnerSchema, formData);
  if (!parsed.ok) return { ok: false, error: 'Ungültige Angaben zur Person.' };
  const data = parsed.data;

  return withStaff(async (tx, { tenantId, staffId, session }) => {
    await assertClientAccessTx(tx, session, data.clientId);
    await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });
    const check = await tx.gwgCheck.findFirst({
      where: { id: data.checkId, clientId: data.clientId },
      select: {
        status: true,
        representatives: {
          where: { linkedBeneficialOwnerId: data.ownerId },
          select: { id: true },
        },
        beneficialOwners: {
          where: { id: data.ownerId },
          select: {
            id: true,
            fullName: true,
            birthDate: true,
            birthPlace: true,
            residence: true,
            nationality: true,
            ownershipPct: true,
            isPep: true,
          },
        },
      },
    });
    if (!check) throw new ActionError('GwG-Check nicht gefunden.');
    assertGwgEditable(check.status);
    const owner = check.beneficialOwners[0];
    if (!owner) throw new ActionError('Wirtschaftlich Berechtigter nicht gefunden.');
    if (gwgBeneficialOwnerRevision(owner) !== data.expectedRevision) {
      throw new ActionError(
        'Die Personendaten wurden zwischenzeitlich geändert. Bitte Seite neu laden.',
      );
    }

    await claimCheckMutation(tx, {
      checkId: data.checkId,
      clientId: data.clientId,
      expectedStatus: check.status,
      invalidateRisk: true,
    });
    const linkedRepresentativeIds = check.representatives.map(
      (representative) => representative.id,
    );
    const affectedDocuments = await tx.gwgIdDocument.findMany({
      where: {
        gwgCheckId: data.checkId,
        supersededAt: null,
        OR: [
          { beneficialOwnerSubjectId: data.ownerId },
          ...(linkedRepresentativeIds.length > 0
            ? [{ representativeSubjectId: { in: linkedRepresentativeIds } }]
            : []),
        ],
      },
      select: {
        id: true,
        documentSetId: true,
        beneficialOwnerSubjectId: true,
      },
    });
    const directlyAssignedDocumentIds = affectedDocuments
      .filter((document) => document.beneficialOwnerSubjectId === data.ownerId)
      .map((document) => document.id);
    if (directlyAssignedDocumentIds.length > 0) {
      await tx.gwgIdDocument.updateMany({
        where: {
          gwgCheckId: data.checkId,
          id: { in: directlyAssignedDocumentIds },
          supersededAt: null,
        },
        data: {
          beneficialOwnerSubjectId: null,
          identityAssignmentConfirmedAt: null,
          identityAssignmentConfirmedBy: null,
          verifiedAt: null,
        },
      });
    }
    const unlinkedRepresentativeRoles = await tx.gwgRepresentative.updateMany({
      where: {
        gwgCheckId: data.checkId,
        linkedBeneficialOwnerId: data.ownerId,
      },
      data: {
        linkedBeneficialOwnerId: null,
        fullName: owner.fullName,
        birthDate: owner.birthDate,
        birthPlace: owner.birthPlace,
        residence: owner.residence,
        nationality: owner.nationality,
        isPep: owner.isPep,
      },
    });
    const removed = await tx.gwgBeneficialOwner.deleteMany({
      where: { id: data.ownerId, gwgCheckId: data.checkId },
    });
    if (removed.count !== 1) {
      throw new ActionError('Die Person wurde parallel geändert. Bitte Seite neu laden.');
    }
    const invalidatedIdentitySets = await invalidatedIdentitySetRevisions(
      tx,
      data.checkId,
      affectedDocuments.map((document) => document.documentSetId),
    );
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.owner.remove',
      resourceType: 'gwg_beneficial_owner',
      resourceId: data.ownerId,
      before: {
        fullName: owner.fullName,
        birthDate: owner.birthDate?.toISOString().slice(0, 10) ?? null,
        birthPlace: owner.birthPlace,
        residence: owner.residence,
        nationality: owner.nationality,
        ownershipPct: owner.ownershipPct?.toString() ?? null,
        isPep: owner.isPep,
      },
      after: {
        removedFromCurrentSnapshot: true,
        invalidatedIdentityDocuments: affectedDocuments.length,
        unlinkedRepresentativeRoles: unlinkedRepresentativeRoles.count,
      },
    });
    return {
      removedOwnerId: data.ownerId,
      reviewReset: check.status === 'IN_REVIEW',
      ...(invalidatedIdentitySets.length > 0 ? { invalidatedIdentitySets } : {}),
    };
  });
}
