import { GwgOnboardingOwnerSchema } from './owner-submission';
import type { IdentityViewport } from '@/lib/gwg/identity-viewport';
import {
  GwgOnboardingRepresentativeSchema,
  onboardingRepresentativeRoleError,
  type GwgOnboardingRepresentativeInput,
} from './representative-submission';
import { legalEntityEvidenceError } from './legal-entity-submission';

interface WizardDocumentRef {
  documentId: string;
  viewport?: IdentityViewport;
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
  countryIso: 'Land',
  sharePercent: 'Anteil',
  isPep: 'PEP-Status',
  idNumber: 'Ausweisnummer',
  idIssuedBy: 'Ausstellende Behörde',
  idIssueDate: 'Ausstellungsdatum des Ausweises',
  idExpiryDate: 'Gültigkeitsdatum des Ausweises',
  idFrontDocumentId: 'Ausweis Vorderseite',
  idBackDocumentId: 'Ausweis Rückseite',
  idFrontViewport: 'Quellversion der Ausweis Vorderseite (bitte Datei neu auswählen)',
  idBackViewport: 'Quellversion der Ausweis Rückseite (bitte Datei neu auswählen)',
};

const REPRESENTATIVE_FIELD_LABELS: Readonly<Record<string, string>> = {
  fullName: 'Vollständiger Name',
  idNumber: 'Ausweisnummer',
  idIssuedBy: 'Ausstellende Behörde',
  idIssueDate: 'Ausstellungsdatum des Ausweises',
  idExpiryDate: 'Gültigkeitsdatum des Ausweises',
  idFrontDocumentId: 'Ausweis Vorderseite',
  idBackDocumentId: 'Ausweis Rückseite',
  idFrontViewport: 'Quellversion der Ausweis Vorderseite (bitte Datei neu auswählen)',
  idBackViewport: 'Quellversion der Ausweis Rückseite (bitte Datei neu auswählen)',
};

function fieldError(prefix: string, path: PropertyKey[], labels: Readonly<Record<string, string>>) {
  const field = String(path[0] ?? '');
  return `${prefix}: ${labels[field] ?? 'Angabe'} fehlt oder ist ungültig.`;
}

function ownerInput(owner: WizardOwnerInput) {
  return {
    ...owner,
    idFrontDocumentId: owner.idFront?.documentId,
    idBackDocumentId: owner.idBack?.documentId,
    idFrontViewport: owner.idFront?.viewport,
    idBackViewport: owner.idBack?.viewport,
  };
}

function representativeInput(
  representative: WizardRepresentativeInput,
  linkedOwner: WizardOwnerInput | null | undefined,
) {
  return {
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
    idFrontViewport: representative.idFront?.viewport,
    idBackViewport: representative.idBack?.viewport,
  };
}

/** Client feedback driven by the same Zod contract used by submitOnboardingAction. */
export function onboardingOwnersStepError(owners: WizardOwnerInput[]): string | null {
  if (owners.length === 0) return 'Mindestens eine Person erforderlich.';
  for (const [index, owner] of owners.entries()) {
    const parsed = GwgOnboardingOwnerSchema.safeParse(ownerInput(owner));
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
    const parsed = GwgOnboardingRepresentativeSchema.safeParse(
      representativeInput(representative, linkedOwner),
    );
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

// ---------------------------------------------------------------------------
// Rückmeldung im Personenschritt des Mandanten-Wizards: alle offenen Angaben je
// Person in Alltagssprache, mit dem Abschnitt, in dem sie stehen. Grundlage ist
// derselbe Zod-Vertrag wie beim Submit; nur die Darstellung ist verständlicher.
// ---------------------------------------------------------------------------

export type OnboardingPersonSection = 'role' | 'id' | 'details' | 'share';

export interface OnboardingPersonIssue {
  role: 'owner' | 'representative';
  id: string;
  /** „Person 2“ bzw. „Vertretung 1“. */
  title: string;
  /** Erster Abschnitt mit offener Angabe, in Bearbeitungsreihenfolge. */
  section: OnboardingPersonSection;
  bySection: Partial<Record<OnboardingPersonSection, string[]>>;
  items: string[];
}

const SECTION_ORDER: readonly OnboardingPersonSection[] = ['role', 'id', 'details', 'share'];

const PERSON_FIELDS: Readonly<Record<string, readonly [string, OnboardingPersonSection]>> = {
  fullName: ['Name', 'details'],
  birthDate: ['Geburtsdatum', 'details'],
  birthPlace: ['Geburtsort', 'details'],
  nationality: ['Staatsangehörigkeit', 'details'],
  street: ['Wohnanschrift', 'details'],
  postalCode: ['Wohnanschrift', 'details'],
  city: ['Wohnanschrift', 'details'],
  countryIso: ['Land der Wohnanschrift', 'details'],
  idNumber: ['Ausweisnummer', 'details'],
  idIssuedBy: ['ausstellende Behörde', 'details'],
  idIssueDate: ['Ausstellungsdatum', 'details'],
  idExpiryDate: ['„Gültig bis“', 'details'],
  idFrontDocumentId: ['Foto der Vorderseite', 'id'],
  idBackDocumentId: ['Foto der Rückseite', 'id'],
  idFrontViewport: ['Foto der Vorderseite (bitte neu hochladen)', 'id'],
  idBackViewport: ['Foto der Rückseite (bitte neu hochladen)', 'id'],
  sharePercent: ['Anteil', 'share'],
  isPep: ['Antwort zur PEP-Frage', 'share'],
};

const VIEWPORT_DOCUMENT: Readonly<Record<string, string>> = {
  idFrontViewport: 'idFrontDocumentId',
  idBackViewport: 'idBackDocumentId',
};

interface ContractIssue {
  path: readonly PropertyKey[];
  code: string;
  message: string;
}

function personIssue(
  base: Pick<OnboardingPersonIssue, 'role' | 'id' | 'title'>,
  issues: readonly ContractIssue[],
  input: Readonly<Record<string, unknown>>,
): OnboardingPersonIssue | null {
  const bySection: Partial<Record<OnboardingPersonSection, string[]>> = {};
  const isEmpty = (value: unknown) =>
    value == null || (typeof value === 'string' && value.trim() === '');
  for (const issue of issues) {
    const field = String(issue.path[0] ?? '');
    // Ohne Datei ist der fehlende Seitenverweis keine eigene Angabe.
    const document = VIEWPORT_DOCUMENT[field];
    if (document && isEmpty(input[document])) continue;
    const [label, section] = PERSON_FIELDS[field] ?? ['Angabe', 'details'];
    const empty = isEmpty(input[field]);
    // Fehlt etwas, genügt der Name des Feldes; sonst die konkrete Erklärung
    // (z. B. „Das Ausstellungsdatum darf nicht in der Zukunft liegen.“).
    const text = empty ? label : issue.code === 'custom' ? issue.message : `${label} prüfen`;
    const list = (bySection[section] ??= []);
    if (!list.includes(text)) list.push(text);
  }
  const sections = SECTION_ORDER.filter((section) => bySection[section]?.length);
  if (!sections.length) return null;
  return {
    ...base,
    section: sections[0]!,
    bySection,
    items: sections.flatMap((section) => bySection[section]!),
  };
}

function representativeIssue(
  representative: WizardRepresentativeInput,
  title: string,
  owners: WizardOwnerInput[],
): OnboardingPersonIssue | null {
  const base = { role: 'representative' as const, id: representative.id, title };
  const roleOnly = (item: string): OnboardingPersonIssue => ({
    ...base,
    section: 'role',
    bySection: { role: [item] },
    items: [item],
  });
  if (representative.linkedOwnerId === undefined)
    return roleOnly('Entscheidung, ob die Person bereits wirtschaftlich berechtigt ist');
  const linkedOwner = representative.linkedOwnerId
    ? owners.find((owner) => owner.id === representative.linkedOwnerId)
    : null;
  if (representative.linkedOwnerId && !linkedOwner)
    return roleOnly('Die verknüpfte Person gibt es nicht mehr – bitte neu auswählen');
  const input = representativeInput(representative, linkedOwner);
  const parsed = GwgOnboardingRepresentativeSchema.safeParse(input);
  return parsed.success ? null : personIssue(base, parsed.error.issues, input);
}

/**
 * Alle offenen Angaben des Personenschritts. `general` meldet, was keiner
 * einzelnen Person zuzuordnen ist (keine Person, keine Vertretung, Rollenkonflikt).
 */
export function onboardingPersonIssues(
  clientKind: 'NATPERS' | 'JURPERS' | 'PERSGES',
  owners: WizardOwnerInput[],
  representatives: WizardRepresentativeInput[],
): { persons: OnboardingPersonIssue[]; general: string | null } {
  const persons: OnboardingPersonIssue[] = [];
  for (const [index, owner] of owners.entries()) {
    const input = ownerInput(owner);
    const parsed = GwgOnboardingOwnerSchema.safeParse(input);
    const issue = parsed.success
      ? null
      : personIssue(
          { role: 'owner', id: owner.id, title: `Person ${index + 1}` },
          parsed.error.issues,
          input,
        );
    if (issue) persons.push(issue);
  }
  if (clientKind !== 'NATPERS') {
    for (const [index, representative] of representatives.entries()) {
      const issue = representativeIssue(representative, `Vertretung ${index + 1}`, owners);
      if (issue) persons.push(issue);
    }
  }
  const general =
    owners.length === 0
      ? 'Bitte erfassen Sie mindestens eine wirtschaftlich berechtigte Person.'
      : clientKind !== 'NATPERS' && representatives.length === 0
        ? 'Bitte erfassen Sie mindestens eine vertretungsberechtigte Person.'
        : persons.length
          ? null
          : onboardingRepresentativesStepError(clientKind, owners, representatives);
  return { persons, general };
}

/** Kurzfassung für eine einzeilige Meldung (z. B. beim Übermitteln). */
export function onboardingPersonIssueText(issues: {
  persons: OnboardingPersonIssue[];
  general: string | null;
}): string | null {
  const first = issues.persons[0];
  if (first) return `${first.title}: Bitte noch ergänzen – ${first.items.join(', ')}.`;
  return issues.general;
}
