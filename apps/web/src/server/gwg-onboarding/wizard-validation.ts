import { GwgOnboardingOwnerSchema } from './owner-submission';
import {
  GwgOnboardingRepresentativeSchema,
  onboardingRepresentativeRoleError,
  type GwgOnboardingRepresentativeInput,
} from './representative-submission';
import { legalEntityEvidenceError } from './legal-entity-submission';

interface WizardDocumentRef {
  documentId: string;
}

export interface WizardOwnerInput {
  id: string;
  fullName: string;
  birthDate: string;
  birthPlace: string;
  nationality: string;
  street: string;
  postalCode: string;
  city: string;
  countryIso: string;
  sharePercent: string;
  isPep: boolean | null;
  idType: 'PERSONALAUSWEIS' | 'REISEPASS';
  idNumber: string;
  idIssuedBy: string;
  idIssueDate: string;
  idExpiryDate: string;
  idFront: WizardDocumentRef | null;
  idBack: WizardDocumentRef | null;
}

export interface WizardRepresentativeInput {
  id: string;
  fullName: string;
  linkedOwnerId: string | null | undefined;
  idType: 'PERSONALAUSWEIS' | 'REISEPASS';
  idNumber: string;
  idIssuedBy: string;
  idIssueDate: string;
  idExpiryDate: string;
  idFront: WizardDocumentRef | null;
  idBack: WizardDocumentRef | null;
}

const OWNER_FIELD_LABELS: Readonly<Record<string, string>> = {
  fullName: 'Vollständiger Name',
  birthDate: 'Geburtsdatum',
  birthPlace: 'Geburtsort (§ 11 Abs. 4 GwG)',
  nationality: 'Staatsangehörigkeit (§ 11 Abs. 4 GwG)',
  street: 'Wohnanschrift (§ 11 Abs. 4 GwG)',
  postalCode: 'Wohnanschrift (§ 11 Abs. 4 GwG)',
  city: 'Wohnanschrift (§ 11 Abs. 4 GwG)',
  isPep: 'PEP-Status',
  idNumber: 'Ausweisnummer',
  idIssuedBy: 'Ausstellende Behörde',
  idExpiryDate: 'Gültigkeitsdatum des Ausweises',
  idFrontDocumentId: 'Ausweis Vorderseite',
  idBackDocumentId: 'Ausweis Rückseite',
};

const REPRESENTATIVE_FIELD_LABELS: Readonly<Record<string, string>> = {
  fullName: 'Vollständiger Name',
  idNumber: 'Ausweisnummer',
  idIssuedBy: 'Ausstellende Behörde',
  idExpiryDate: 'Gültigkeitsdatum des Ausweises',
  idFrontDocumentId: 'Ausweis Vorderseite',
  idBackDocumentId: 'Ausweis Rückseite',
};

function fieldError(prefix: string, path: PropertyKey[], labels: Readonly<Record<string, string>>) {
  const field = String(path[0] ?? '');
  return `${prefix}: ${labels[field] ?? 'Angabe'} fehlt oder ist ungültig.`;
}

/** Client feedback driven by the same Zod contract used by submitOnboardingAction. */
export function onboardingOwnersStepError(owners: WizardOwnerInput[]): string | null {
  if (owners.length === 0) return 'Mindestens eine Person erforderlich.';
  for (const [index, owner] of owners.entries()) {
    const parsed = GwgOnboardingOwnerSchema.safeParse({
      ...owner,
      idFrontDocumentId: owner.idFront?.documentId,
      idBackDocumentId: owner.idBack?.documentId,
    });
    if (!parsed.success) {
      return fieldError(
        `Person ${index + 1}`,
        parsed.error.issues[0]?.path ?? [],
        OWNER_FIELD_LABELS,
      );
    }
  }
  return null;
}

export function onboardingRepresentativesStepError(
  clientKind: 'NATPERS' | 'JURPERS' | 'PERSGES',
  owners: WizardOwnerInput[],
  representatives: WizardRepresentativeInput[],
): string | null {
  if (clientKind === 'NATPERS')
    return representatives.length === 0 ? null : 'Keine Vertretung erwartet.';
  if (representatives.length === 0) {
    return 'Mindestens eine vertretungsberechtigte Person ist erforderlich.';
  }

  const parsedRepresentatives: GwgOnboardingRepresentativeInput[] = [];
  for (const [index, representative] of representatives.entries()) {
    const prefix = `Vertretung ${index + 1}`;
    if (representative.linkedOwnerId === undefined) {
      return `${prefix}: Bitte entscheiden Sie ausdrücklich, ob dieselbe Person bereits wirtschaftlich berechtigt ist.`;
    }
    const linkedOwner = representative.linkedOwnerId
      ? owners.find((owner) => owner.id === representative.linkedOwnerId)
      : null;
    if (representative.linkedOwnerId && !linkedOwner) {
      return `${prefix}: Die verknüpfte Person ist nicht mehr vorhanden.`;
    }
    const parsed = GwgOnboardingRepresentativeSchema.safeParse({
      localId: representative.id,
      fullName: linkedOwner?.fullName ?? representative.fullName,
      linkedOwnerLocalId: representative.linkedOwnerId,
      idType: representative.idType,
      idNumber: representative.idNumber,
      idIssuedBy: representative.idIssuedBy,
      idIssueDate: representative.idIssueDate,
      idExpiryDate: representative.idExpiryDate,
      idFrontDocumentId: representative.idFront?.documentId ?? null,
      idBackDocumentId: representative.idBack?.documentId ?? null,
    });
    if (!parsed.success) {
      return fieldError(prefix, parsed.error.issues[0]?.path ?? [], REPRESENTATIVE_FIELD_LABELS);
    }
    parsedRepresentatives.push(parsed.data);
  }

  return onboardingRepresentativeRoleError(
    clientKind,
    new Set(owners.map((owner) => owner.id)),
    parsedRepresentatives,
  );
}

export function onboardingLegalEntityStepError(input: {
  clientKind: 'NATPERS' | 'JURPERS' | 'PERSGES';
  noRegisterEntry: boolean | null;
  evidenceTypes: Iterable<string>;
}): string | null {
  return legalEntityEvidenceError(
    input.clientKind,
    input.clientKind === 'NATPERS' || input.noRegisterEntry === null
      ? null
      : { noRegisterEntry: input.noRegisterEntry },
    new Set(input.evidenceTypes),
  );
}
