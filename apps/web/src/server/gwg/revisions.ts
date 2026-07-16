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

function revision(value: unknown): string {
  return JSON.stringify(normalized(value));
}

function dateOnly(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return (value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

function instant(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function decimal(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'object' && value && 'toString' in value
    ? String((value as { toString(): string }).toString())
    : String(value);
}

export function gwgRiskRevision(source: {
  riskAnswers: unknown;
  riskScore: number | null;
  riskLevel: string | null;
}): string {
  return revision({
    riskAnswers: source.riskAnswers ?? {},
    riskScore: source.riskScore,
    riskLevel: source.riskLevel,
  });
}

export function gwgLegalEntityRevision(source: {
  legalForm: string | null;
  registerNumber: string | null;
  registerAuthority: string | null;
  noRegisterEntry: boolean;
  representativeNames: string[];
  representatives?: Array<{
    id: string;
    fullName: string;
    position: number;
    linkedBeneficialOwnerId?: string | null;
  }>;
  ownershipStructureNotes: string | null;
}): string {
  return revision({
    legalForm: source.legalForm,
    registerNumber: source.registerNumber,
    registerAuthority: source.registerAuthority,
    noRegisterEntry: source.noRegisterEntry,
    representativeNames: source.representativeNames,
    representatives: source.representatives
      ? [...source.representatives]
          .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
          .map((representative) => ({
            id: representative.id,
            fullName: representative.fullName,
            position: representative.position,
            linkedBeneficialOwnerId: representative.linkedBeneficialOwnerId ?? null,
          }))
      : null,
    ownershipStructureNotes: source.ownershipStructureNotes,
  });
}

export function gwgBeneficialOwnerRevision(source: {
  id: string;
  fullName: string;
  birthDate: Date | string | null;
  birthPlace: string | null;
  residence: string | null;
  nationality: string | null;
  ownershipPct: unknown;
  isPep: boolean;
}): string {
  return revision({
    id: source.id,
    fullName: source.fullName,
    birthDate: dateOnly(source.birthDate),
    birthPlace: source.birthPlace,
    residence: source.residence,
    nationality: source.nationality,
    ownershipPct: decimal(source.ownershipPct),
    isPep: source.isPep,
  });
}

export interface IdentityDocumentRevisionSource {
  id: string;
  gwgCheckId?: string;
  documentSetId: string;
  documentId?: string | null;
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
}

export function gwgIdentityDocumentSetRevision(
  documents: IdentityDocumentRevisionSource[],
): string {
  return revision(
    [...documents]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((document) => ({
        id: document.id,
        gwgCheckId: document.gwgCheckId ?? null,
        documentSetId: document.documentSetId,
        documentId: document.documentId ?? null,
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
      })),
  );
}
