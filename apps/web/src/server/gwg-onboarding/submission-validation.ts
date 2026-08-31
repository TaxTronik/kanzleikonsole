import type { ClientKind } from '@prisma/client';
import { distinctIdentityViews } from '@/lib/gwg/identity-viewport';

import {
  legalEntityEvidenceError,
  type GwgOnboardingLegalEntityDeclaration,
} from './legal-entity-submission';
import type { GwgOnboardingOwnerInput } from './owner-submission';
import {
  onboardingRepresentativeRoleError,
  type GwgOnboardingRepresentativeInput,
} from './representative-submission';

export interface OnboardingSubmissionOwner extends GwgOnboardingOwnerInput {
  localId: string;
}

export interface OnboardingExtraDocument {
  documentId: string;
  type:
    | 'HANDELSREGISTERAUSZUG'
    | 'GESELLSCHAFTSVERTRAG'
    | 'TRANSPARENZREGISTER_AUSZUG'
    | 'VOLLMACHT'
    | 'SONSTIGES';
}

export type OnboardingSubmissionValidation =
  | { ok: false; error: string }
  | { ok: true; linkedOwnerLocalIds: string[] };

/** Pure preflight for every cross-reference submitted by the public wizard. */
export function validateOnboardingSubmission(input: {
  clientKind: ClientKind;
  uploadedDocumentIds: unknown;
  existingCheckDocumentIds: Array<string | null>;
  owners: OnboardingSubmissionOwner[];
  representatives: GwgOnboardingRepresentativeInput[];
  extraDocuments: OnboardingExtraDocument[];
  legalEntity: GwgOnboardingLegalEntityDeclaration;
}): OnboardingSubmissionValidation {
  const ownerLocalIds = new Set(input.owners.map((owner) => owner.localId));
  if (ownerLocalIds.size !== input.owners.length) {
    return { ok: false, error: 'Wirtschaftlich Berechtigte enthalten doppelte Personen-IDs.' };
  }

  const representativeError = onboardingRepresentativeRoleError(
    input.clientKind,
    ownerLocalIds,
    input.representatives,
  );
  if (representativeError) return { ok: false, error: representativeError };

  const linkedOwnerLocalIds = input.representatives.flatMap((representative) =>
    representative.linkedOwnerLocalId ? [representative.linkedOwnerLocalId] : [],
  );
  const allowedDocumentIds = new Set([
    ...(Array.isArray(input.uploadedDocumentIds)
      ? input.uploadedDocumentIds.filter((id): id is string => typeof id === 'string')
      : []),
    ...input.existingCheckDocumentIds.filter((id): id is string => id !== null),
  ]);
  const people = [
    ...input.owners,
    ...input.representatives.filter((person) => !person.linkedOwnerLocalId),
  ];
  if (people.some((person) => !person.idFrontViewport || !person.idBackViewport)) {
    return {
      ok: false,
      error:
        'Jede Ausweisseite benötigt eine gebundene Quellversion. Bitte die Datei neu auswählen.',
    };
  }
  if (
    people.some(
      (person) =>
        person.idFrontDocumentId === person.idBackDocumentId &&
        !distinctIdentityViews(person.idFrontViewport, person.idBackViewport),
    )
  ) {
    return {
      ok: false,
      error: 'Vorder- und Rückseite benötigen unterschiedliche Seiten oder Ausschnitte.',
    };
  }
  const referencedDocumentIds = [
    ...input.owners.flatMap((owner) => [
      ...new Set([owner.idFrontDocumentId, owner.idBackDocumentId]),
    ]),
    ...input.representatives.flatMap((representative) =>
      representative.linkedOwnerLocalId
        ? []
        : [...new Set([representative.idFrontDocumentId, representative.idBackDocumentId])].filter(
            (id): id is string => id !== null,
          ),
    ),
    ...input.extraDocuments.map((document) => document.documentId),
  ];
  if (referencedDocumentIds.some((id) => !allowedDocumentIds.has(id))) {
    return {
      ok: false,
      error: 'Referenziertes Dokument wurde nicht über diesen Onboarding-Link hochgeladen.',
    };
  }
  if (new Set(referencedDocumentIds).size !== referencedDocumentIds.length) {
    return { ok: false, error: 'Ein Dokument darf nur einmal zugeordnet werden.' };
  }

  const entityEvidenceError = legalEntityEvidenceError(
    input.clientKind,
    input.legalEntity,
    new Set(input.extraDocuments.map((document) => document.type)),
  );
  if (entityEvidenceError) return { ok: false, error: entityEvidenceError };

  return { ok: true, linkedOwnerLocalIds };
}
