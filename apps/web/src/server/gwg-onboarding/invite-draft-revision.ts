import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';

export const GWG_INVITE_CLIENT_SELECT = {
  id: true,
  tenantId: true,
  kind: true,
  name: true,
  street: true,
  postalCode: true,
  city: true,
  countryIso: true,
  vatId: true,
} as const satisfies Prisma.ClientSelect;

export const GWG_INVITE_DRAFT_INCLUDE = {
  client: { select: GWG_INVITE_CLIENT_SELECT },
  beneficialOwners: true,
  representatives: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
  idDocuments: {
    include: {
      document: {
        select: {
          id: true,
          title: true,
          clientId: true,
          classification: true,
          deletedAt: true,
          gwgDestructionRequestedAt: true,
          gwgDestroyedAt: true,
          versions: {
            orderBy: { versionNo: 'desc' },
            take: 1,
            select: {
              id: true,
              versionNo: true,
              sha256: true,
              sizeBytes: true,
            },
          },
        },
      },
    },
  },
} as const satisfies Prisma.GwgCheckInclude;

export type GwgInviteDraftRevisionSource = Prisma.GwgCheckGetPayload<{
  include: typeof GWG_INVITE_DRAFT_INCLUDE;
}>;

export type GwgInviteClientRevisionSource = Prisma.ClientGetPayload<{
  select: typeof GWG_INVITE_CLIENT_SELECT;
}>;

function date(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function dateOnly(value: Date | string | null | undefined): string | null {
  return date(value)?.slice(0, 10) ?? null;
}

function bytes(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function normalized(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return bytes(value);
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalized(entry)]),
    );
  }
  return value ?? null;
}

function digest(kind: 'check' | 'client', snapshot: unknown): string {
  return createHash('sha256')
    .update(`${kind}:v1:${JSON.stringify(normalized(snapshot))}`, 'utf8')
    .digest('hex');
}

function clientSnapshot(source: GwgInviteClientRevisionSource) {
  return {
    id: source.id,
    tenantId: source.tenantId,
    kind: source.kind,
    name: source.name,
    street: source.street,
    postalCode: source.postalCode,
    city: source.city,
    countryIso: source.countryIso,
    vatId: source.vatId,
  };
}

/**
 * Bindet eine echte Ersteinladung ohne Check an die Mandanten-Baseline, damit
 * zwischen Anzeige und Submit keine Kanzleiänderung überschrieben werden kann.
 */
export function gwgInviteClientBaselineHash(source: GwgInviteClientRevisionSource): string {
  return digest('client', clientSnapshot(source));
}

/**
 * Revisionshash für einen gebundenen DRAFT. Erwartbare Scanner-Übergänge
 * (PENDING → CLEAN und scanCompletedAt) sind bewusst ausgeschlossen. Eine neue
 * Dateiversion ändert dagegen ID/Nummer/Hash und invalidiert den Link.
 */
export function gwgInviteDraftRevisionHash(source: GwgInviteDraftRevisionSource): string {
  return digest('check', {
    id: source.id,
    tenantId: source.tenantId,
    clientId: source.clientId,
    client: clientSnapshot(source.client),
    status: source.status,
    changeScope: source.changeScope,
    predecessorCheckId: source.predecessorCheckId,
    riskLevel: source.riskLevel,
    riskScore: source.riskScore,
    riskAnswers: source.riskAnswers,
    riskBreakdown: source.riskBreakdown,
    notes: source.notes,
    legalForm: source.legalForm,
    registerNumber: source.registerNumber,
    registerAuthority: source.registerAuthority,
    noRegisterEntry: source.noRegisterEntry,
    representativeNames: source.representativeNames,
    ownershipStructureNotes: source.ownershipStructureNotes,
    reviewSubmittedAt: date(source.reviewSubmittedAt),
    reviewSubmittedBy: source.reviewSubmittedBy,
    representatives: source.representatives.map((representative) => ({
      id: representative.id,
      fullName: representative.fullName,
      position: representative.position,
      linkedBeneficialOwnerId: representative.linkedBeneficialOwnerId,
    })),
    beneficialOwners: [...source.beneficialOwners]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((owner) => ({
        id: owner.id,
        fullName: owner.fullName,
        birthDate: dateOnly(owner.birthDate),
        birthPlace: owner.birthPlace,
        residence: owner.residence,
        nationality: owner.nationality,
        ownershipPct: owner.ownershipPct === null ? null : String(owner.ownershipPct),
        isPep: owner.isPep,
        notes: owner.notes,
      })),
    idDocuments: [...source.idDocuments]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((document) => ({
        id: document.id,
        documentSetId: document.documentSetId,
        documentId: document.documentId,
        type: document.type,
        ownerName: document.ownerName,
        number: document.number,
        issuedBy: document.issuedBy,
        issueDate: dateOnly(document.issueDate),
        expiryDate: dateOnly(document.expiryDate),
        verifiedAt: date(document.verifiedAt),
        naturalClientSubjectId: document.naturalClientSubjectId,
        beneficialOwnerSubjectId: document.beneficialOwnerSubjectId,
        representativeSubjectId: document.representativeSubjectId,
        identityAssignmentConfirmedAt: date(document.identityAssignmentConfirmedAt),
        identityAssignmentConfirmedBy: document.identityAssignmentConfirmedBy,
        notes: document.notes,
        evidence: document.document
          ? {
              id: document.document.id,
              clientId: document.document.clientId,
              classification: document.document.classification,
              deletedAt: date(document.document.deletedAt),
              gwgDestructionRequestedAt: date(document.document.gwgDestructionRequestedAt),
              gwgDestroyedAt: date(document.document.gwgDestroyedAt),
              versions: document.document.versions.map((version) => ({
                id: version.id,
                versionNo: version.versionNo,
                sha256: bytes(version.sha256),
                sizeBytes: version.sizeBytes.toString(),
              })),
            }
          : null,
      })),
  });
}

export function loadLatestGwgInviteDraftTx(
  tx: TxClient,
  input: { tenantId: string; clientId: string },
) {
  return tx.gwgCheck.findFirst({
    where: { tenantId: input.tenantId, clientId: input.clientId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: GWG_INVITE_DRAFT_INCLUDE,
  });
}

export function loadGwgInviteClientBaselineTx(
  tx: TxClient,
  input: { tenantId: string; clientId: string },
) {
  return tx.client.findFirst({
    where: { id: input.clientId, tenantId: input.tenantId },
    select: GWG_INVITE_CLIENT_SELECT,
  });
}
