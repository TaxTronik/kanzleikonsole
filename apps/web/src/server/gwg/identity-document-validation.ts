// =============================================================================
// Gemeinsame Prüfungen der GwG-Ausweis- und Nachweisservices
// (identity-document-sets.ts, identity-document-confirmation.ts; vormals
// Helfer in app/staff/(protected)/clients/[id]/gwg/id-document-actions.ts).
//
// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001.
// =============================================================================

import { Prisma } from '@taxtronik/db/prisma-client';
import { ActionError } from '@/server/actions/action-error';
import { log } from '@/server/logger';
import { firstIdentityDateError } from './identity-date-validation';
import { IdentitySourceStorageError } from './identity-source';
import type { resolveIdentitySubject, IdentitySubjectSource } from './identity-subject';

export const PERSONAL_ID_TYPES = ['PERSONALAUSWEIS', 'REISEPASS'] as const;

export function isPersonalIdType(type: string): type is (typeof PERSONAL_ID_TYPES)[number] {
  return (PERSONAL_ID_TYPES as readonly string[]).includes(type);
}

export type ResolvedIdentitySubject = ReturnType<typeof resolveIdentitySubject>;

export const SUBJECT_NO_LONGER_PART_OF_CHECK =
  'Die identifizierte Person gehört nicht mehr zu den erfassten Mandanten-, Vertretungs- oder Eigentümerdaten. Bitte Person neu auswählen.';

/** Personenquelle der Ausweiszuordnung aus dem geladenen GwG-Snapshot. */
export function identitySubjectSourceOf(check: {
  client: { id: string; name: string; kind: IdentitySubjectSource['clientKind'] };
  representatives: IdentitySubjectSource['representatives'];
  beneficialOwners: IdentitySubjectSource['beneficialOwners'];
}): IdentitySubjectSource {
  return {
    clientId: check.client.id,
    clientName: check.client.name,
    clientKind: check.client.kind,
    representatives: check.representatives,
    beneficialOwners: check.beneficialOwners,
  };
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

/** Ausstellungs-/Ablaufdatum gegen das Geburtsdatum der identifizierten Person. */
export function assertIdentityDatesForSubject(
  source: IdentitySubjectSource,
  subject: ResolvedIdentitySubject,
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

/**
 * F-05: Ein S3-Lesefehler beim Prüfen der Ausweisquelle ist vorübergehend. Er wird
 * geloggt und als Speicherfehler gemeldet — nicht als „Nachweis neu erfassen" und
 * nicht mit der rohen Storage-Meldung.
 */
function identityStorageActionError(
  error: IdentitySourceStorageError,
  context: { tenantId: string; clientId: string; documentId: string },
): ActionError {
  const cause = error.cause instanceof Error ? error.cause : null;
  log.error(
    {
      component: 'gwg-identity',
      ...context,
      err: error.message,
      causeName: cause?.name ?? null,
      cause: cause?.message ?? null,
    },
    'gwg-identity: Ausweisdatei im Dokumentenspeicher nicht lesbar',
  );
  return new ActionError(
    'Die Ausweisdatei konnte gerade nicht aus dem Dokumentenspeicher gelesen werden. Der Nachweis ist unverändert; bitte in einigen Minuten erneut versuchen.',
  );
}

function isDatabaseError(error: unknown): error is Error {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientInitializationError
  );
}

/**
 * Fehler aus validateIdentityViewportsTx: Speicherfehler → Speicher-Meldung (geloggt),
 * Datenbankfehler → zentrales Fehler-Mapping, alles andere → fachliche Meldung.
 */
export function identityValidationFailure(
  error: unknown,
  context: { tenantId: string; clientId: string; documentId: string },
  sourceMessage: string,
): Error {
  if (error instanceof IdentitySourceStorageError) {
    return identityStorageActionError(error, context);
  }
  if (isDatabaseError(error)) return error;
  return new ActionError(sourceMessage);
}
