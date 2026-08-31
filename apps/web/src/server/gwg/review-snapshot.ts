import { createHash } from 'node:crypto';

interface ReviewOwner {
  id: string;
  fullName: string;
  birthDate: Date | string | null;
  birthPlace: string | null;
  residence: string | null;
  nationality: string | null;
  ownershipPct: unknown;
  isPep: boolean;
  notes?: string | null;
}

interface ReviewRepresentative {
  id: string;
  fullName: string;
  position: number;
  linkedBeneficialOwnerId?: string | null;
}

interface ReviewDocument {
  id: string;
  documentSetId: string;
  documentId: string | null;
  type: string;
  ownerName: string;
  number: string | null;
  issuedBy: string | null;
  issueDate: Date | string | null;
  expiryDate: Date | string | null;
  verifiedAt: Date | string | null;
  naturalClientSubjectId: string | null;
  beneficialOwnerSubjectId: string | null;
  representativeSubjectId: string | null;
  identityAssignmentConfirmedAt: Date | string | null;
  identityAssignmentConfirmedBy: string | null;
  notes?: string | null;
  viewports?: unknown;
  document: {
    id?: string;
    clientId: string | null;
    classification: string;
    deletedAt: Date | string | null;
    gwgDestructionRequestedAt: Date | string | null;
    gwgDestroyedAt: Date | string | null;
    versions: Array<{ scanStatus: string; scanCompletedAt: Date | string | null }>;
  } | null;
}

export interface GwgProfessionalReviewSource {
  id: string;
  clientId: string;
  client: {
    id?: string;
    kind: string;
    name: string;
    street?: string | null;
    postalCode?: string | null;
    city?: string | null;
    countryIso?: string | null;
    vatId?: string | null;
  };
  changeScope?: string;
  predecessorCheckId?: string | null;
  status: string;
  riskLevel: string | null;
  riskScore: number | null;
  riskAnswers: unknown;
  riskBreakdown?: unknown;
  notes: string | null;
  legalForm: string | null;
  registerNumber: string | null;
  registerAuthority: string | null;
  noRegisterEntry: boolean;
  representativeNames: string[];
  representatives: ReviewRepresentative[];
  ownershipStructureNotes: string | null;
  beneficialOwners: ReviewOwner[];
  idDocuments: ReviewDocument[];
  reviewSubmittedAt: Date | string | null;
  reviewSubmittedBy: string | null;
}

function instant(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function dateOnly(value: Date | string | null | undefined): string | null {
  return instant(value)?.slice(0, 10) ?? null;
}

function decimal(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function normalized(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
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

/**
 * Bindet die haftungsrelevante Berufsträger-Bestätigung an genau den auf der
 * Entscheidungsseite angezeigten, vollständig persistierten Prüfsnapshot.
 * Sortierung und explizite Feldprojektion halten den Hash unabhängig von
 * Prisma-Ladereihenfolge und Decimal-Implementierungsdetails stabil.
 */
export function gwgProfessionalReviewSnapshotHash(source: GwgProfessionalReviewSource): string {
  const snapshot = {
    checkId: source.id,
    clientId: source.clientId,
    client: {
      id: source.client.id ?? source.clientId,
      kind: source.client.kind,
      name: source.client.name,
      street: source.client.street ?? null,
      postalCode: source.client.postalCode ?? null,
      city: source.client.city ?? null,
      countryIso: source.client.countryIso ?? null,
    },
    changeScope: source.changeScope ?? 'INITIAL',
    predecessorCheckId: source.predecessorCheckId ?? null,
    status: source.status,
    riskLevel: source.riskLevel,
    riskScore: source.riskScore,
    riskAnswers: source.riskAnswers ?? {},
    riskBreakdown: source.riskBreakdown ?? null,
    notes: source.notes,
    legalForm: source.legalForm,
    registerNumber: source.registerNumber,
    registerAuthority: source.registerAuthority,
    noRegisterEntry: source.noRegisterEntry,
    representativeNames: source.representativeNames,
    representatives: [...source.representatives]
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
      .map((representative) => ({
        id: representative.id,
        fullName: representative.fullName,
        position: representative.position,
        linkedBeneficialOwnerId: representative.linkedBeneficialOwnerId ?? null,
      })),
    ownershipStructureNotes: source.ownershipStructureNotes,
    beneficialOwners: [...source.beneficialOwners]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((owner) => ({
        id: owner.id,
        fullName: owner.fullName,
        birthDate: dateOnly(owner.birthDate),
        birthPlace: owner.birthPlace,
        residence: owner.residence,
        nationality: owner.nationality,
        ownershipPct: decimal(owner.ownershipPct),
        isPep: owner.isPep,
        notes: owner.notes ?? null,
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
        verifiedAt: instant(document.verifiedAt),
        naturalClientSubjectId: document.naturalClientSubjectId,
        beneficialOwnerSubjectId: document.beneficialOwnerSubjectId,
        representativeSubjectId: document.representativeSubjectId,
        identityAssignmentConfirmedAt: instant(document.identityAssignmentConfirmedAt),
        identityAssignmentConfirmedBy: document.identityAssignmentConfirmedBy,
        notes: document.notes ?? null,
        viewports: document.viewports ?? null,
        evidence: document.document
          ? {
              id: document.document.id ?? document.documentId,
              clientId: document.document.clientId,
              classification: document.document.classification,
              deletedAt: instant(document.document.deletedAt),
              gwgDestructionRequestedAt: instant(document.document.gwgDestructionRequestedAt),
              gwgDestroyedAt: instant(document.document.gwgDestroyedAt),
              versions: document.document.versions.map((version) => ({
                scanStatus: version.scanStatus,
                scanCompletedAt: instant(version.scanCompletedAt),
              })),
            }
          : null,
      })),
    reviewSubmittedAt: instant(source.reviewSubmittedAt),
    reviewSubmittedBy: source.reviewSubmittedBy,
  };

  return createHash('sha256')
    .update(`gwg-professional-review:v2:${JSON.stringify(normalized(snapshot))}`, 'utf8')
    .digest('hex');
}
