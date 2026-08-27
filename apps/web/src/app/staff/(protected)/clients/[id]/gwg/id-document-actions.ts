'use server';

import { randomUUID } from 'node:crypto';
import type { GwgIdDocumentType } from '@prisma/client';
import { z } from 'zod';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import { lockGwgCheckLifecycleTx } from '@/server/gwg/reverification';
import {
  identityAssignmentForSubject,
  resolveIdentitySubject,
  type IdentitySubjectSource,
} from '@/server/gwg/identity-subject';
import {
  findCleanGwgEvidenceDocumentsTx,
  lockCleanGwgEvidenceDocumentsTx,
} from '@/server/gwg/evidence-documents';
import { gwgIdentityDocumentSetRevision } from '@/server/gwg/revisions';
import {
  firstIdentityDateError,
  validateIdentityDates,
} from '@/server/gwg/identity-date-validation';
import { organizeGwgDocumentsTx } from '@/server/gwg-onboarding/document-folders';
import { withStaff, ActionError, parseFormData } from '@/server/actions/staff-action';

import {
  isPersonalIdType,
  assertGwgEditable,
  claimCheckMutation,
  type ActionResult,
} from './_action-helpers';

// Stabile Typ-Importpfade fuer die Form-Komponenten dieser Route.
export type { ActionResult, InvalidatedIdentitySet, SavedBeneficialOwner } from './_action-helpers';

const AddIdDocSchema = z
  .object({
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
    subjectKey: z.string().max(500).optional().or(z.literal('')),
    number: z.string().max(100).optional().or(z.literal('')),
    issuedBy: z.string().max(200).optional().or(z.literal('')),
    issueDate: z.string().date().optional().or(z.literal('')),
    expiryDate: z.string().date().optional().or(z.literal('')),
    replacementMode: z.enum(['none', 'set', 'subject', 'type']).default('none'),
    replaceDocumentSetId: z.string().uuid().optional().or(z.literal('')),
    documentIds: z
      .array(z.string().uuid())
      .min(1, 'Mindestens ein Aktenbeleg ist erforderlich.')
      .max(2, 'Ein Ausweissatz darf höchstens zwei Dateien enthalten.'),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.documentIds).size !== value.documentIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['documentIds'],
        message: 'Jeder Aktenbeleg darf im Satz nur einmal vorkommen.',
      });
    }
    if (!isPersonalIdType(value.type) && value.documentIds.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['documentIds'],
        message: 'Ein Rechtsträgernachweis besteht aus genau einem Aktenbeleg.',
      });
    }
    if (isPersonalIdType(value.type) && !value.subjectKey?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['subjectKey'],
        message: 'Identifizierte Person ist erforderlich.',
      });
    }
    if (value.replacementMode === 'set' && !value.replaceDocumentSetId) {
      ctx.addIssue({
        code: 'custom',
        path: ['replaceDocumentSetId'],
        message: 'Der zu ersetzende Ausweissatz fehlt.',
      });
    }
    if (isPersonalIdType(value.type) && value.replacementMode === 'type') {
      ctx.addIssue({
        code: 'custom',
        path: ['replacementMode'],
        message: 'Ein Ausweis muss als konkreter Ausweissatz ersetzt werden.',
      });
    }
    if (
      !isPersonalIdType(value.type) &&
      (value.replacementMode === 'set' || value.replacementMode === 'subject')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['replacementMode'],
        message: 'Ein Rechtsträgernachweis wird anhand seines Nachweistyps ersetzt.',
      });
    }
    if (isPersonalIdType(value.type)) {
      for (const issue of validateIdentityDates({
        issueDate: value.issueDate || null,
        expiryDate: value.expiryDate || null,
      })) {
        ctx.addIssue({
          code: 'custom',
          path: [issue.field],
          message: issue.message,
        });
      }
    }
  });

const SearchGwgDocumentsSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  query: z.string().trim().min(2).max(100),
});

export interface GwgDocumentSearchResult {
  id: string;
  title: string;
  createdAt: string;
}

/**
 * Durchsucht die gesamte Mandantenakte serverseitig. Die initiale Seite lädt
 * bewusst nur die jüngsten Belege; ältere Treffer bleiben über diese Suche
 * erreichbar. Bereits in diesem Check verknüpfte Dateien werden hier nicht
 * erneut angeboten (Alt-Sätze stellt die Review-Karte separat zum Merge dar).
 */
export async function searchUnlinkedGwgDocumentsAction(input: {
  checkId: string;
  clientId: string;
  query: string;
}): Promise<
  ActionResult & {
    documents?: GwgDocumentSearchResult[];
    limited?: boolean;
  }
> {
  const parsed = SearchGwgDocumentsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Bitte mindestens zwei Zeichen eingeben.' };
  const data = parsed.data;

  return withStaff(async (tx, { tenantId, session }) => {
    await assertClientAccessTx(tx, session, data.clientId);
    const check = await tx.gwgCheck.findFirst({
      where: { id: data.checkId, clientId: data.clientId },
      select: { id: true },
    });
    if (!check) throw new ActionError('GwG-Check nicht gefunden.');

    const matches = await findCleanGwgEvidenceDocumentsTx(tx, {
      tenantId,
      clientId: data.clientId,
      query: data.query,
      excludeLinkedCheckId: data.checkId,
      limit: 51,
    });
    return {
      documents: matches.slice(0, 50).map((document) => ({
        id: document.id,
        title: document.title,
        createdAt: document.createdAt.toISOString(),
      })),
      limited: matches.length > 50,
    };
  });
}

function isDateOnOrAfterToday(value: string, now: Date = new Date()): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Number.isFinite(date.getTime()) && date.getTime() >= today;
}

function subjectBirthDate(
  source: IdentitySubjectSource,
  subject: {
    kind: string;
    id: string;
    linkedBeneficialOwnerId?: string;
  },
): Date | string | null {
  const ownerId =
    subject.kind === 'BENEFICIAL_OWNER'
      ? subject.id
      : subject.kind === 'REPRESENTATIVE'
        ? subject.linkedBeneficialOwnerId
        : null;
  return ownerId
    ? (source.beneficialOwners.find((owner) => owner.id === ownerId)?.birthDate ?? null)
    : null;
}

function assertIdentityDatesForSubject(
  source: IdentitySubjectSource,
  subject: ReturnType<typeof resolveIdentitySubject>,
  issueDate: string | null | undefined,
  expiryDate: string | null | undefined,
): void {
  if (!subject) return;
  const dateError = firstIdentityDateError({
    birthDate: subjectBirthDate(source, subject),
    issueDate: issueDate ?? null,
    expiryDate: expiryDate ?? null,
  });
  if (dateError) throw new ActionError(dateError);
}

export async function addIdDocumentAction(
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
) {
  const selectedDocumentIds = formData
    .getAll('documentIds')
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (selectedDocumentIds.length === 0) {
    const legacyDocumentId = formData.get('documentId');
    if (typeof legacyDocumentId === 'string' && legacyDocumentId) {
      selectedDocumentIds.push(legacyDocumentId);
    }
  }
  const parsed = AddIdDocSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    type: formData.get('type'),
    subjectKey: formData.get('subjectKey') ?? '',
    number: formData.get('number') ?? '',
    issuedBy: formData.get('issuedBy') ?? '',
    issueDate: formData.get('issueDate') ?? '',
    expiryDate: formData.get('expiryDate') ?? '',
    replacementMode: formData.get('replacementMode') ?? 'none',
    replaceDocumentSetId: formData.get('replaceDocumentSetId') ?? '',
    documentIds: selectedDocumentIds,
  });
  if (!parsed.success) {
    return {
      ok: false as const,
      error: parsed.error.issues.map((issue) => issue.message).join(' '),
    };
  }
  const data = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, data.clientId);
      await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });
      // Check laden + Status prüfen (bindet checkId an den autorisierten Mandanten).
      const check = await tx.gwgCheck.findFirst({
        where: { id: data.checkId, clientId: data.clientId },
        select: {
          status: true,
          client: { select: { id: true, name: true, kind: true } },
          representatives: {
            select: { id: true, fullName: true, position: true, linkedBeneficialOwnerId: true },
            orderBy: [{ position: 'asc' }, { id: 'asc' }],
          },
          beneficialOwners: {
            select: { id: true, fullName: true, birthDate: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
        },
      });
      if (!check) throw new ActionError('GwG-Check nicht gefunden.');
      assertGwgEditable(check.status);

      const subjectSource: IdentitySubjectSource = {
        clientId: check.client.id,
        clientName: check.client.name,
        clientKind: check.client.kind,
        representatives: check.representatives,
        beneficialOwners: check.beneficialOwners,
      };
      const subject = isPersonalIdType(data.type)
        ? resolveIdentitySubject(subjectSource, data.subjectKey ?? '')
        : null;
      if (isPersonalIdType(data.type) && !subject) {
        throw new ActionError(
          'Die identifizierte Person gehört nicht mehr zu den erfassten Mandanten-, Vertretungs- oder Eigentümerdaten. Bitte Person neu auswählen.',
        );
      }
      assertIdentityDatesForSubject(subjectSource, subject, data.issueDate, data.expiryDate);

      await claimCheckMutation(tx, {
        checkId: data.checkId,
        clientId: data.clientId,
        expectedStatus: check.status,
      });
      if (
        !(await lockCleanGwgEvidenceDocumentsTx(tx, {
          tenantId,
          clientId: data.clientId,
          documentIds: data.documentIds,
        }))
      ) {
        throw new ActionError(
          'Alle verknüpften Nachweise müssen verfügbare GwG-Belege mit vollständig geprüfter, sauberer Dateiversion desselben Mandanten sein.',
        );
      }

      const alreadyLinked = await tx.gwgIdDocument.findFirst({
        where: {
          gwgCheckId: data.checkId,
          documentId:
            data.documentIds.length === 1 ? data.documentIds[0] : { in: data.documentIds },
        },
        select: { id: true, type: true },
      });
      if (alreadyLinked) {
        throw new ActionError(
          'Dieser Aktenbeleg ist dieser GwG-Prüfung bereits zugeordnet. Bitte den vorhandenen Nachweis aufklappen und dort bearbeiten.',
        );
      }

      const assignmentConfirmedAt =
        isPersonalIdType(data.type) &&
        data.number?.trim() &&
        data.issuedBy?.trim() &&
        data.issueDate &&
        data.expiryDate &&
        isDateOnOrAfterToday(data.expiryDate)
          ? new Date()
          : null;
      const assignment = subject
        ? identityAssignmentForSubject(subject)
        : {
            naturalClientSubjectId: null,
            beneficialOwnerSubjectId: null,
            representativeSubjectId: null,
          };
      // Pro Person gibt es genau einen aktiven Ausweissatz. Eine neue
      // Erfassung löst daher alle bisherigen aktiven Ausweise dieser Person
      // ab. Bei Rechtsträgern gilt dieselbe Invariante je Nachweistyp.
      const replacementWhere = isPersonalIdType(data.type)
        ? {
            gwgCheckId: data.checkId,
            type: { in: ['PERSONALAUSWEIS', 'REISEPASS'] as GwgIdDocumentType[] },
            supersededAt: null,
            ...assignment,
          }
        : { gwgCheckId: data.checkId, type: data.type, supersededAt: null };
      const replacedDocuments = await tx.gwgIdDocument.findMany({
        where: replacementWhere,
        select: {
          id: true,
          documentSetId: true,
          documentId: true,
          type: true,
          ownerName: true,
          naturalClientSubjectId: true,
          beneficialOwnerSubjectId: true,
          representativeSubjectId: true,
          verifiedAt: true,
          identityAssignmentConfirmedAt: true,
        },
      });
      const explicitReplacement = data.replacementMode !== 'none';
      const requestedSetPresent =
        data.replacementMode !== 'set' ||
        replacedDocuments.some(
          (entry) => entry.documentSetId === (data.replaceDocumentSetId || null),
        );
      if (explicitReplacement && (replacedDocuments.length === 0 || !requestedSetPresent)) {
        throw new ActionError(
          data.replacementMode === 'set'
            ? 'Der zu ersetzende Ausweissatz ist nicht mehr vorhanden.'
            : data.replacementMode === 'subject'
              ? 'Für diese Person ist kein aktiver Ausweissatz mehr vorhanden.'
              : 'Der zu ersetzende Rechtsträgernachweis ist nicht mehr vorhanden.',
        );
      }

      const documentSetId = randomUUID();
      const sharedData = {
        gwgCheckId: data.checkId,
        type: data.type,
        ownerName: isPersonalIdType(data.type) ? subject!.name : check.client.name,
        number: isPersonalIdType(data.type) ? data.number || null : null,
        issuedBy: isPersonalIdType(data.type) ? data.issuedBy || null : null,
        issueDate: isPersonalIdType(data.type) && data.issueDate ? new Date(data.issueDate) : null,
        expiryDate:
          isPersonalIdType(data.type) && data.expiryDate ? new Date(data.expiryDate) : null,
        documentSetId,
        ...assignment,
        identityAssignmentConfirmedAt: assignmentConfirmedAt,
        identityAssignmentConfirmedBy: assignmentConfirmedAt ? staffId : null,
        verifiedAt: assignmentConfirmedAt,
      };
      if (replacedDocuments.length > 0) {
        const superseded = await tx.gwgIdDocument.updateMany({
          where: {
            gwgCheckId: data.checkId,
            id: { in: replacedDocuments.map((entry) => entry.id) },
            supersededAt: null,
          },
          data: { supersededAt: new Date(), supersededByDocumentSetId: documentSetId },
        });
        if (superseded.count !== replacedDocuments.length) {
          throw new ActionError(
            'Der zu ersetzende Nachweis wurde parallel geändert. Bitte Seite neu laden und erneut versuchen.',
          );
        }
      }
      let resourceId: string = documentSetId;
      if (data.documentIds.length === 1) {
        const idDoc = await tx.gwgIdDocument.create({
          data: { ...sharedData, documentId: data.documentIds[0]! },
        });
        resourceId = idDoc.id;
      } else {
        await tx.gwgIdDocument.createMany({
          data: data.documentIds.map((documentId) => ({ ...sharedData, documentId })),
        });
      }
      await organizeGwgDocumentsTx(tx, {
        tenantId,
        clientId: data.clientId,
        createdByStaff: staffId,
        documents: data.documentIds.map((documentId) => ({
          documentId,
          personName: subject?.name ?? null,
        })),
      });
      if (replacedDocuments.length > 0) {
        await resolveNotificationsTx(tx, {
          tenantId,
          resources: replacedDocuments.map((entry) => ({
            resourceType: 'gwg_id_document',
            resourceId: entry.id,
          })),
        });
      }
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action:
          replacedDocuments.length > 0
            ? isPersonalIdType(data.type)
              ? 'gwg.id_document.replace'
              : 'gwg.evidence.replace'
            : isPersonalIdType(data.type)
              ? 'gwg.id_document.add'
              : 'gwg.evidence.add',
        resourceType: data.documentIds.length === 1 ? 'gwg_id_document' : 'gwg_id_document_set',
        resourceId,
        before:
          replacedDocuments.length > 0
            ? {
                replacedDocuments,
              }
            : undefined,
        after: {
          type: data.type,
          ownerName: isPersonalIdType(data.type) ? subject!.name : null,
          subjectKey: isPersonalIdType(data.type) ? data.subjectKey : null,
          documentIds: data.documentIds,
          identityAssignmentConfirmedAt: assignmentConfirmedAt?.toISOString() ?? null,
          verifiedAt: assignmentConfirmedAt?.toISOString() ?? null,
          replacementMode:
            replacedDocuments.length > 0 && data.replacementMode === 'none'
              ? isPersonalIdType(data.type)
                ? 'subject'
                : 'type'
              : data.replacementMode,
        },
      });
      return replacedDocuments.length > 0
        ? { reviewReset: check.status === 'IN_REVIEW' }
        : undefined;
    },
    // Kein revalidate der aktuellen Route (siehe addBeneficialOwnerAction) —
    // der Client refresht nach dem Erfolg außerhalb der Form-Transition.
  );
}

const ExtendIdentityDocumentSetSchema = z
  .object({
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    targetDocumentSetId: z.string().uuid(),
    documentIds: z
      .array(z.string().uuid())
      .min(1, 'Mindestens eine Datei ist erforderlich.')
      .max(2, 'Es können höchstens zwei Dateien auf einmal ergänzt werden.'),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.documentIds).size !== value.documentIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['documentIds'],
        message: 'Jede Datei darf nur einmal ausgewählt werden.',
      });
    }
  });

/**
 * Ergänzt einen bestehenden Ausweissatz direkt aus der Akte. Unverknüpfte
 * Dateien werden angelegt; ein anderer, noch unbestätigter Alt-Satz wird als
 * Ganzes verschoben. Jede strukturelle Änderung entwertet die bisherige
 * Bestätigung des Ziels, damit Vorder-/Rückseite anschließend gemeinsam erneut
 * geprüft werden müssen.
 */
export async function extendIdentityDocumentSetAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult & { reviewReset?: boolean }> {
  const documentIds = formData
    .getAll('documentIds')
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const parsed = ExtendIdentityDocumentSetSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    targetDocumentSetId: formData.get('targetDocumentSetId'),
    documentIds,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((issue) => issue.message).join(' '),
    };
  }
  const data = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, data.clientId);
      await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });

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
      });

      const targetLockKey = `gwg-document-set:${data.targetDocumentSetId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${targetLockKey}, 0))`;

      // Erst nach Parent- und Set-Lock lesen. Dadurch basiert Kapazität,
      // Bestätigungsstatus und Quellsatz-Auflösung auf einem stabilen Zustand.
      const existingDocuments = await tx.gwgIdDocument.findMany({
        where: { gwgCheckId: data.checkId, supersededAt: null },
        select: {
          id: true,
          documentSetId: true,
          type: true,
          ownerName: true,
          documentId: true,
          number: true,
          issuedBy: true,
          issueDate: true,
          expiryDate: true,
          naturalClientSubjectId: true,
          beneficialOwnerSubjectId: true,
          representativeSubjectId: true,
          identityAssignmentConfirmedAt: true,
          identityAssignmentConfirmedBy: true,
          verifiedAt: true,
          document: {
            select: {
              tenantId: true,
              clientId: true,
              classification: true,
              deletedAt: true,
              gwgDestructionRequestedAt: true,
              gwgDestroyedAt: true,
            },
          },
        },
      });
      const targetDocuments = existingDocuments.filter(
        (entry) => entry.documentSetId === data.targetDocumentSetId,
      );
      if (
        targetDocuments.length === 0 ||
        targetDocuments.some((entry) => !isPersonalIdType(entry.type))
      ) {
        throw new ActionError(
          'Der Ziel-Ausweissatz ist nicht mehr vorhanden oder enthält keinen Personalausweis/Reisepass.',
        );
      }

      const selectedIds = new Set(data.documentIds);
      const selectedLinked = existingDocuments.filter(
        (entry) => entry.documentId !== null && selectedIds.has(entry.documentId),
      );
      if (selectedLinked.some((entry) => entry.documentSetId === data.targetDocumentSetId)) {
        throw new ActionError(
          'Mindestens eine ausgewählte Datei gehört bereits zum Ziel-Ausweissatz.',
        );
      }
      if (selectedLinked.some((entry) => !isPersonalIdType(entry.type))) {
        throw new ActionError(
          'Ein Rechtsträgernachweis kann nicht als Ausweisseite zusammengeführt werden.',
        );
      }

      const sourceSetIds = new Set(selectedLinked.map((entry) => entry.documentSetId));
      const sourceDocuments = existingDocuments.filter((entry) =>
        sourceSetIds.has(entry.documentSetId),
      );
      if (
        sourceDocuments.some(
          (entry) =>
            !isPersonalIdType(entry.type) ||
            entry.verifiedAt !== null ||
            entry.identityAssignmentConfirmedAt !== null ||
            entry.identityAssignmentConfirmedBy !== null,
        )
      ) {
        throw new ActionError(
          'Ein bereits bestätigter Ausweissatz kann nicht mit einem anderen Satz zusammengeführt werden.',
        );
      }

      const selectedLinkedIds = new Set(
        selectedLinked
          .map((entry) => entry.documentId)
          .filter((documentId): documentId is string => documentId !== null),
      );
      const unlinkedDocumentIds = data.documentIds.filter(
        (documentId) => !selectedLinkedIds.has(documentId),
      );
      const finalDocumentCount =
        targetDocuments.length + sourceDocuments.length + unlinkedDocumentIds.length;
      if (finalDocumentCount > 2) {
        throw new ActionError(
          `Der zusammengeführte Ausweissatz hätte ${finalDocumentCount} Dateien. Zulässig sind höchstens zwei.`,
        );
      }

      const fullExistingSet = [...targetDocuments, ...sourceDocuments];
      const allDocumentIds = [
        ...fullExistingSet.map((entry) => entry.documentId),
        ...unlinkedDocumentIds,
      ];
      if (allDocumentIds.some((documentId) => documentId === null)) {
        throw new ActionError(
          'Der Ziel- oder Quellsatz enthält eine nicht mehr verfügbare Datei und kann nicht zusammengeführt werden.',
        );
      }
      const uniqueDocumentIds = [
        ...new Set(
          allDocumentIds.filter((documentId): documentId is string => documentId !== null),
        ),
      ].sort();
      if (
        !(await lockCleanGwgEvidenceDocumentsTx(tx, {
          tenantId,
          clientId: data.clientId,
          documentIds: uniqueDocumentIds,
        }))
      ) {
        throw new ActionError(
          'Alle Dateien des Ziel-/Quellsatzes und der Auswahl müssen verfügbare GwG-Belege mit vollständig geprüfter, sauberer Dateiversion desselben Mandanten sein.',
        );
      }

      const first = targetDocuments[0]!;
      const sharedData = {
        documentSetId: data.targetDocumentSetId,
        type: first.type,
        ownerName: first.ownerName,
        number: first.number,
        issuedBy: first.issuedBy,
        issueDate: first.issueDate,
        expiryDate: first.expiryDate,
        naturalClientSubjectId: first.naturalClientSubjectId,
        beneficialOwnerSubjectId: first.beneficialOwnerSubjectId,
        representativeSubjectId: first.representativeSubjectId,
        identityAssignmentConfirmedAt: null,
        identityAssignmentConfirmedBy: null,
        verifiedAt: null,
      };
      const rowsToNormalize = [...targetDocuments, ...sourceDocuments];
      const normalized = await tx.gwgIdDocument.updateMany({
        where: {
          gwgCheckId: data.checkId,
          id: { in: rowsToNormalize.map((entry) => entry.id) },
          documentSetId: {
            in: [data.targetDocumentSetId, ...sourceSetIds],
          },
        },
        data: sharedData,
      });
      if (normalized.count !== rowsToNormalize.length) {
        throw new ActionError(
          'Ein Ausweissatz wurde parallel geändert. Bitte Seite neu laden und erneut versuchen.',
        );
      }
      if (unlinkedDocumentIds.length > 0) {
        await tx.gwgIdDocument.createMany({
          data: unlinkedDocumentIds.map((documentId) => ({
            gwgCheckId: data.checkId,
            documentId,
            ...sharedData,
            notes: 'Ausweissatz durch Kanzlei ergänzt',
          })),
        });
      }
      await organizeGwgDocumentsTx(tx, {
        tenantId,
        clientId: data.clientId,
        createdByStaff: staffId,
        documents: uniqueDocumentIds.map((documentId) => ({
          documentId,
          personName: first.ownerName,
        })),
      });

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.id_document.set_files_update',
        resourceType: 'gwg_id_document_set',
        resourceId: data.targetDocumentSetId,
        before: {
          targetDocumentIds: targetDocuments.map((entry) => entry.documentId),
          sourceDocumentSetIds: [...sourceSetIds],
          targetWasConfirmed: targetDocuments.some(
            (entry) => entry.verifiedAt !== null || entry.identityAssignmentConfirmedAt !== null,
          ),
        },
        after: {
          documentIds: [
            ...targetDocuments.map((entry) => entry.documentId),
            ...sourceDocuments.map((entry) => entry.documentId),
            ...unlinkedDocumentIds,
          ],
          mergedDocumentSetIds: [...sourceSetIds],
          identityAssignmentRequiresConfirmation: true,
        },
      });
      return { reviewReset: check.status === 'IN_REVIEW' };
    },
    {
      // Kein revalidate der aktuellen Route (siehe addBeneficialOwnerAction).
      uniqueError:
        'Mindestens eine Datei wurde zwischenzeitlich bereits zugeordnet. Bitte Seite neu laden.',
    },
  );
}

const UpdateIdDocumentsSchema = z
  .object({
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    documentSetId: z.string().uuid(),
    type: z.enum(['PERSONALAUSWEIS', 'REISEPASS']),
    subjectKey: z.string().min(1).max(500),
    number: z.string().trim().min(1).max(100),
    issuedBy: z.string().trim().min(1).max(200),
    issueDate: z.string().date(),
    expiryDate: z.string().date(),
    expectedRevision: z.string().min(2).max(50_000),
  })
  .superRefine((document, ctx) => {
    for (const issue of validateIdentityDates({
      issueDate: document.issueDate,
      expiryDate: document.expiryDate,
    })) {
      ctx.addIssue({ code: 'custom', path: [issue.field], message: issue.message });
    }
  });

/**
 * Bestätigt oder korrigiert einen zusammengehörigen Ausweissatz (z. B.
 * Vorder- und Rückseite) in einem atomaren Schritt. Die Person kommt niemals
 * aus Freitext, sondern wird gegen den aktuellen GwG-Snapshot aufgelöst.
 */
export async function updateIdDocumentsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<
  ActionResult & {
    reviewReset?: boolean;
    saved?: {
      type: 'PERSONALAUSWEIS' | 'REISEPASS';
      subjectKey: string;
      ownerName: string;
      number: string;
      issuedBy: string;
      issueDate: string;
      expiryDate: string;
    };
    revision?: string;
  }
> {
  const parsed = UpdateIdDocumentsSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    documentSetId: formData.get('documentSetId'),
    type: formData.get('type'),
    subjectKey: formData.get('subjectKey'),
    number: formData.get('number'),
    issuedBy: formData.get('issuedBy'),
    issueDate: formData.get('issueDate') ?? '',
    expiryDate: formData.get('expiryDate'),
    expectedRevision: formData.get('expectedRevision'),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((issue) => issue.message).join(' '),
    };
  }
  const data = parsed.data;

  return withStaff(async (tx, { tenantId, staffId, session }) => {
    await assertClientAccessTx(tx, session, data.clientId);
    await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });
    const check = await tx.gwgCheck.findFirst({
      where: { id: data.checkId, clientId: data.clientId },
      select: {
        status: true,
        client: { select: { id: true, name: true, kind: true } },
        representatives: {
          select: { id: true, fullName: true, position: true, linkedBeneficialOwnerId: true },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        },
        beneficialOwners: {
          select: { id: true, fullName: true, birthDate: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
        idDocuments: {
          where: { documentSetId: data.documentSetId, supersededAt: null },
          select: {
            id: true,
            gwgCheckId: true,
            documentId: true,
            type: true,
            ownerName: true,
            number: true,
            issuedBy: true,
            issueDate: true,
            expiryDate: true,
            verifiedAt: true,
            documentSetId: true,
            naturalClientSubjectId: true,
            beneficialOwnerSubjectId: true,
            representativeSubjectId: true,
            identityAssignmentConfirmedAt: true,
            identityAssignmentConfirmedBy: true,
            document: {
              select: {
                id: true,
                tenantId: true,
                clientId: true,
                classification: true,
                deletedAt: true,
                gwgDestructionRequestedAt: true,
                gwgDestroyedAt: true,
              },
            },
          },
        },
      },
    });
    if (!check) throw new ActionError('GwG-Check nicht gefunden.');
    assertGwgEditable(check.status);
    if (
      check.idDocuments.length === 0 ||
      check.idDocuments.some((document) => !isPersonalIdType(document.type))
    ) {
      throw new ActionError(
        'Der Ausweissatz ist unvollständig oder gehört nicht zu dieser GwG-Prüfung.',
      );
    }
    if (gwgIdentityDocumentSetRevision(check.idDocuments) !== data.expectedRevision) {
      throw new ActionError(
        'Der Ausweissatz wurde zwischenzeitlich geändert. Bitte Seite neu laden; Ihre Eingabe wurde nicht überschrieben.',
      );
    }
    if (
      check.idDocuments.some(
        (entry) =>
          !entry.document ||
          entry.document.id === null ||
          entry.document.tenantId !== tenantId ||
          entry.document.clientId !== data.clientId ||
          entry.document.classification !== 'GWG_EVIDENCE' ||
          entry.document.deletedAt !== null ||
          entry.document.gwgDestructionRequestedAt !== null ||
          entry.document.gwgDestroyedAt !== null,
      )
    ) {
      throw new ActionError(
        'Mindestens eine Datei dieses Ausweissatzes ist nicht mehr als GwG-Nachweis verfügbar.',
      );
    }
    if (!isDateOnOrAfterToday(data.expiryDate)) {
      throw new ActionError(
        'Der Ausweis ist abgelaufen. Bitte ein gültiges Ablaufdatum oder einen neuen Ausweis erfassen.',
      );
    }

    const subjectSource: IdentitySubjectSource = {
      clientId: check.client.id,
      clientName: check.client.name,
      clientKind: check.client.kind,
      representatives: check.representatives,
      beneficialOwners: check.beneficialOwners,
    };
    const subject = resolveIdentitySubject(subjectSource, data.subjectKey);
    if (!subject) {
      throw new ActionError(
        'Die identifizierte Person gehört nicht mehr zu den erfassten Mandanten-, Vertretungs- oder Eigentümerdaten. Bitte Person neu auswählen.',
      );
    }
    assertIdentityDatesForSubject(subjectSource, subject, data.issueDate, data.expiryDate);

    await claimCheckMutation(tx, {
      checkId: data.checkId,
      clientId: data.clientId,
      expectedStatus: check.status,
    });
    if (
      !(await lockCleanGwgEvidenceDocumentsTx(tx, {
        tenantId,
        clientId: data.clientId,
        documentIds: check.idDocuments.map((entry) => entry.document!.id),
      }))
    ) {
      throw new ActionError(
        'Mindestens eine Datei dieses Ausweissatzes besitzt keine vollständig geprüfte, saubere neueste Dateiversion.',
      );
    }
    const verifiedAt = new Date();
    const assignment = identityAssignmentForSubject(subject);
    const update = await tx.gwgIdDocument.updateMany({
      where: {
        documentSetId: data.documentSetId,
        gwgCheckId: data.checkId,
        supersededAt: null,
      },
      data: {
        type: data.type,
        ownerName: subject.name,
        number: data.number,
        issuedBy: data.issuedBy,
        issueDate: new Date(data.issueDate),
        expiryDate: new Date(data.expiryDate),
        ...assignment,
        identityAssignmentConfirmedAt: verifiedAt,
        identityAssignmentConfirmedBy: staffId,
        verifiedAt,
      },
    });
    if (update.count !== check.idDocuments.length) {
      throw new ActionError(
        'Der Ausweissatz wurde parallel geändert. Bitte Seite neu laden und erneut prüfen.',
      );
    }
    await organizeGwgDocumentsTx(tx, {
      tenantId,
      clientId: data.clientId,
      createdByStaff: staffId,
      documents: check.idDocuments.map((document) => ({
        documentId: document.document!.id,
        personName: subject.name,
      })),
    });
    await resolveNotificationsTx(tx, {
      tenantId,
      resources: check.idDocuments.map((document) => ({
        resourceType: 'gwg_id_document',
        resourceId: document.id,
      })),
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.id_document.update',
      resourceType: 'gwg_id_document_set',
      resourceId: data.documentSetId,
      before: { documents: check.idDocuments },
      after: {
        documentSetId: data.documentSetId,
        documentIds: check.idDocuments.map((document) => document.id),
        type: data.type,
        ownerName: subject.name,
        subjectKey: data.subjectKey,
        number: data.number,
        issuedBy: data.issuedBy,
        issueDate: data.issueDate,
        expiryDate: data.expiryDate,
        verifiedAt: verifiedAt.toISOString(),
      },
    });
    return {
      reviewReset: check.status === 'IN_REVIEW',
      saved: {
        type: data.type,
        subjectKey: data.subjectKey,
        ownerName: subject.name,
        number: data.number,
        issuedBy: data.issuedBy,
        issueDate: data.issueDate,
        expiryDate: data.expiryDate,
      },
      revision: gwgIdentityDocumentSetRevision(
        check.idDocuments.map((document) => ({
          ...document,
          type: data.type,
          ownerName: subject.name,
          number: data.number,
          issuedBy: data.issuedBy,
          issueDate: data.issueDate,
          expiryDate: data.expiryDate,
          ...assignment,
          identityAssignmentConfirmedAt: verifiedAt,
          identityAssignmentConfirmedBy: staffId,
          verifiedAt,
        })),
      ),
    };
  });
}

const RemoveGwgEvidenceLinkSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  gwgIdDocumentId: z.string().uuid(),
});

/**
 * Entfernt ausschließlich eine irrtümliche Zuordnung aus dem aktiven
 * GwG-Prüfsnapshot. Das Document und sämtliche Object-Store-Versionen bleiben
 * unverändert in der Mandantenakte erhalten (GWG-IDENTIFICATION-EVIDENCE-001).
 */
export async function removeGwgEvidenceLinkAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult & { reviewReset?: boolean }> {
  const parsed = parseFormData(RemoveGwgEvidenceLinkSchema, formData, {
    errorMessage: 'Der Nachweis konnte nicht zugeordnet werden.',
  });
  if (!parsed.ok) return parsed;
  const data = parsed.data;

  return withStaff(async (tx, { tenantId, staffId, session }) => {
    await assertClientAccessTx(tx, session, data.clientId);
    await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });

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
    });

    const linkedEvidence = await tx.gwgIdDocument.findFirst({
      where: {
        id: data.gwgIdDocumentId,
        gwgCheckId: data.checkId,
        supersededAt: null,
      },
      select: {
        id: true,
        documentId: true,
        documentSetId: true,
        type: true,
        ownerName: true,
        naturalClientSubjectId: true,
        beneficialOwnerSubjectId: true,
        representativeSubjectId: true,
      },
    });
    if (!linkedEvidence) {
      throw new ActionError('Der aktive Nachweis ist nicht mehr vorhanden. Bitte Seite neu laden.');
    }

    const removed = await tx.gwgIdDocument.deleteMany({
      where: {
        id: linkedEvidence.id,
        gwgCheckId: data.checkId,
        supersededAt: null,
      },
    });
    if (removed.count !== 1) {
      throw new ActionError(
        'Der Nachweis wurde parallel geändert. Bitte Seite neu laden und erneut versuchen.',
      );
    }

    const personal = isPersonalIdType(linkedEvidence.type);
    if (personal) {
      // Schon eine entfernte Vorder-/Rückseite ändert den geprüften Satz. Eine
      // etwaige Restseite muss deshalb vor einer Entscheidung erneut bestätigt
      // werden.
      await tx.gwgIdDocument.updateMany({
        where: {
          gwgCheckId: data.checkId,
          documentSetId: linkedEvidence.documentSetId,
          supersededAt: null,
        },
        data: {
          identityAssignmentConfirmedAt: null,
          identityAssignmentConfirmedBy: null,
          verifiedAt: null,
        },
      });
    }

    await resolveNotificationsTx(tx, {
      tenantId,
      resources: [{ resourceType: 'gwg_id_document', resourceId: linkedEvidence.id }],
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: personal ? 'gwg.id_document.unlink' : 'gwg.evidence.unlink',
      resourceType: 'gwg_id_document',
      resourceId: linkedEvidence.id,
      before: linkedEvidence,
      after: {
        gwgCheckId: data.checkId,
        documentRetainedInClientFile: true,
        documentId: linkedEvidence.documentId,
      },
    });
    return { reviewReset: check.status === 'IN_REVIEW' };
  });
}

const SelectCurrentIdentityDocumentSetSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  documentSetId: z.string().uuid(),
});

/**
 * Repariert historische Doppelbestände, ohne einen fachlich aktuellen Satz
 * automatisch zu erraten. Der Mitarbeiter wählt den aktuellen Satz bewusst;
 * alle übrigen aktiven Ausweise derselben Person werden als Alt-Nachweise
 * markiert (GWG-IDENTIFICATION-EVIDENCE-001).
 */
export async function selectCurrentIdentityDocumentSetAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult & { reviewReset?: boolean }> {
  const parsed = parseFormData(SelectCurrentIdentityDocumentSetSchema, formData, {
    errorMessage: 'Der Ausweissatz konnte nicht ausgewählt werden.',
  });
  if (!parsed.ok) return parsed;
  const data = parsed.data;

  return withStaff(async (tx, { tenantId, staffId, session }) => {
    await assertClientAccessTx(tx, session, data.clientId);
    await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });

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
    });

    const selectedDocuments = await tx.gwgIdDocument.findMany({
      where: {
        gwgCheckId: data.checkId,
        documentSetId: data.documentSetId,
        type: { in: ['PERSONALAUSWEIS', 'REISEPASS'] },
        supersededAt: null,
      },
      select: {
        id: true,
        documentSetId: true,
        documentId: true,
        type: true,
        naturalClientSubjectId: true,
        beneficialOwnerSubjectId: true,
        representativeSubjectId: true,
      },
    });
    const selected = selectedDocuments[0];
    if (!selected) {
      throw new ActionError('Der ausgewählte aktive Ausweissatz ist nicht mehr vorhanden.');
    }
    const assignment = {
      naturalClientSubjectId: selected.naturalClientSubjectId,
      beneficialOwnerSubjectId: selected.beneficialOwnerSubjectId,
      representativeSubjectId: selected.representativeSubjectId,
    };
    const assignedSubjects = Object.values(assignment).filter((value) => value !== null);
    const consistentSelection =
      assignedSubjects.length === 1 &&
      selectedDocuments.every(
        (entry) =>
          entry.naturalClientSubjectId === assignment.naturalClientSubjectId &&
          entry.beneficialOwnerSubjectId === assignment.beneficialOwnerSubjectId &&
          entry.representativeSubjectId === assignment.representativeSubjectId,
      );
    if (!consistentSelection) {
      throw new ActionError(
        'Der ausgewählte Ausweissatz besitzt keine eindeutige Personenzuordnung und kann nicht als aktuell festgelegt werden.',
      );
    }

    const activeDocuments = await tx.gwgIdDocument.findMany({
      where: {
        gwgCheckId: data.checkId,
        type: { in: ['PERSONALAUSWEIS', 'REISEPASS'] },
        supersededAt: null,
        ...assignment,
      },
      select: { id: true, documentSetId: true, documentId: true, type: true },
    });
    const supersededDocuments = activeDocuments.filter(
      (entry) => entry.documentSetId !== data.documentSetId,
    );
    if (supersededDocuments.length === 0) {
      throw new ActionError('Dieser Ausweis ist bereits der einzige aktive Satz der Person.');
    }

    const superseded = await tx.gwgIdDocument.updateMany({
      where: {
        gwgCheckId: data.checkId,
        id: { in: supersededDocuments.map((entry) => entry.id) },
        supersededAt: null,
      },
      data: {
        supersededAt: new Date(),
        supersededByDocumentSetId: data.documentSetId,
      },
    });
    if (superseded.count !== supersededDocuments.length) {
      throw new ActionError(
        'Die Ausweissätze wurden parallel geändert. Bitte Seite neu laden und erneut versuchen.',
      );
    }

    await resolveNotificationsTx(tx, {
      tenantId,
      resources: supersededDocuments.map((entry) => ({
        resourceType: 'gwg_id_document',
        resourceId: entry.id,
      })),
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.id_document.make_current',
      resourceType: 'gwg_id_document_set',
      resourceId: data.documentSetId,
      before: { activeDocuments },
      after: {
        selectedDocumentSetId: data.documentSetId,
        supersededDocuments,
      },
    });
    return { reviewReset: check.status === 'IN_REVIEW' };
  });
}
