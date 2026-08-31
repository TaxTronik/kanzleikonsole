'use client';

import { useState, useTransition, type Dispatch, type SetStateAction } from 'react';
import {
  discardOnboardingUploadAction,
  uploadIdImageAction,
  submitOnboardingAction,
} from './actions';
import {
  consentForNewDeclaration,
  missingRequiredConsentOptions,
  type ConsentSelections,
  type ResolvedConsentOption,
} from '@/server/privacy/consent';
import type { LoadedInviteDraft } from '@/server/gwg-onboarding/service';
import { fullIdentityViewport } from '@/lib/gwg/identity-viewport';
import {
  onboardingLegalEntityStepError,
  onboardingOwnersStepError,
  onboardingRepresentativesStepError,
} from '@/server/gwg-onboarding/wizard-validation';
import {
  DocumentsStep,
  MasterDataStep,
  MAX_UPLOAD_LABEL,
  ONBOARDING_STEPS,
  OnboardingSubmitted,
  OwnersStep,
  PrivacyStep,
  SubmitStep,
  WizardNavigation,
  WizardStepper,
  type BeneficialOwner,
  type EntityEvidenceDocument,
  type EntityEvidenceType,
  type OnboardingClientKind,
  type Representative,
} from './wizard-steps';

// Client-seitiges Upload-Limit: Die Datei wird Base64-kodiert an die Server-
// Action geschickt (+33 % Overhead). Damit eine Datei knapp unter dem Limit
// das Server-Action-bodySizeLimit von 10 MB (next.config.mjs) nicht sprengt,
// liegt die effektive Grenze bei 7 MB (7 MB × 4/3 ≈ 9,3 MB + JSON-Overhead).
const MAX_UPLOAD_BYTES = 7 * 1024 * 1024;

// Stabile React-Keys für Owner-Cards (Add/Remove) — kein key={index}.
let ownerIdSeq = 0;
const nextOwnerId = () => `owner-${++ownerIdSeq}`;
let representativeIdSeq = 0;
const nextRepresentativeId = () => `representative-${++representativeIdSeq}`;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Datei konnte nicht gelesen werden.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

type OnboardingUploadResult =
  | { ok: true; documentId: string; versionId?: string }
  | { ok: false; error: string };

async function uploadOnboardingFile(
  token: string,
  file: File,
  kind: 'ID_DOCUMENT' | 'EXTRA',
  personName?: string,
): Promise<OnboardingUploadResult> {
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `Datei zu groß (max. ${MAX_UPLOAD_LABEL}).` };
  }
  try {
    const base64 = await fileToBase64(file);
    const result = await uploadIdImageAction({
      token,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      base64,
      kind,
      personName,
    });
    if (!result.ok || !result.documentId) {
      return { ok: false, error: result.error ?? 'Upload fehlgeschlagen.' };
    }
    return { ok: true, documentId: result.documentId, versionId: result.versionId };
  } catch {
    return {
      ok: false,
      error: 'Upload fehlgeschlagen — bitte Verbindung prüfen und erneut versuchen.',
    };
  }
}

async function discardOnboardingFile(
  token: string,
  documentId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const result = await discardOnboardingUploadAction({ token, documentId });
    return result.ok
      ? { ok: true }
      : { ok: false, error: result.error ?? 'Datei konnte nicht entfernt werden.' };
  } catch {
    return {
      ok: false,
      error: 'Datei konnte nicht entfernt werden — bitte Verbindung prüfen.',
    };
  }
}

type IdentityUploadSubject = Pick<BeneficialOwner, 'id' | 'fullName' | 'idFront' | 'idBack'>;

interface ClientShape {
  id: string;
  name: string;
  kind: OnboardingClientKind;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  countryIso: string | null;
}

export function OnboardingWizard({
  token,
  inviteName,
  client,
  initialDraft,
  noticeBody,
  noticeVersion,
  consentOptions,
  consentDisplayRevision,
}: {
  token: string;
  inviteName: string;
  client: ClientShape;
  initialDraft: LoadedInviteDraft | null;
  /** Gerenderte Datenschutzhinweise (Teil A) — kanzleispezifisch. */
  noticeBody: string;
  noticeVersion: number;
  consentOptions: ResolvedConsentOption[];
  /** SHA-256-Bindung an exakt den gerenderten Hinweis und Optionskatalog. */
  consentDisplayRevision: string;
}) {
  const [step, setStep] = useState(0);

  // Datenschutz-Einwilligungen (Teil B) + Bestätigung + Unterschrift.
  const [consent, setConsent] = useState<ConsentSelections>(() => consentForNewDeclaration());
  const [noticeAck, setNoticeAck] = useState(false);
  const [signedByName, setSignedByName] = useState(inviteName);

  // Stammdaten
  const [companyName, setCompanyName] = useState(client.name);
  const [street, setStreet] = useState(client.street ?? '');
  const [postalCode, setPostalCode] = useState(client.postalCode ?? '');
  const [city, setCity] = useState(client.city ?? '');
  const [countryIso, setCountryIso] = useState(client.countryIso ?? 'DE');

  // Wirtschaftlich Berechtigte
  const [owners, setOwners] = useState<BeneficialOwner[]>(() =>
    initialDraft?.owners.length
      ? initialDraft.owners.map((owner) => ({ ...owner }))
      : [emptyOwner(inviteName)],
  );
  const [representatives, setRepresentatives] = useState<Representative[]>(() =>
    initialDraft
      ? initialDraft.representatives.map((representative) => ({ ...representative }))
      : client.kind === 'NATPERS'
        ? []
        : [emptyRepresentative(inviteName)],
  );

  // Sonstige Dokumente
  const [extraDocs, setExtraDocs] = useState<EntityEvidenceDocument[]>(
    () => initialDraft?.extraDocuments.map((document) => ({ ...document })) ?? [],
  );
  const [extraType, setExtraType] = useState<EntityEvidenceType>(
    client.kind === 'NATPERS' ? 'SONSTIGES' : 'GESELLSCHAFTSVERTRAG',
  );
  const [noRegisterEntry, setNoRegisterEntry] = useState<boolean | null>(
    initialDraft?.noRegisterEntry ?? null,
  );
  const [extraUploadError, setExtraUploadError] = useState<string | null>(null);
  const [discardingDocumentIds, setDiscardingDocumentIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // Ausweis-Upload-Fehler je Owner+Seite (Key: `${ownerId}:${side}`).
  const [idUploadErrors, setIdUploadErrors] = useState<Record<string, string | null>>({});
  function setIdError(ownerId: string, side: 'front' | 'back', msg: string | null) {
    setIdUploadErrors((s) => ({ ...s, [`${ownerId}:${side}`]: msg }));
  }

  // Submit-State
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [isPending, start] = useTransition();

  function patchOwner(i: number, patch: Partial<BeneficialOwner>) {
    setOwners((s) => s.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));
  }
  function addOwner() {
    setOwners((s) => [...s, emptyOwner('')]);
  }

  async function discardDocuments(documentIds: Array<string | undefined>): Promise<string | null> {
    for (const documentId of new Set(documentIds.filter((id): id is string => Boolean(id)))) {
      setDiscardingDocumentIds((current) => new Set(current).add(documentId));
      const result = await discardOnboardingFile(token, documentId);
      setDiscardingDocumentIds((current) => {
        const next = new Set(current);
        next.delete(documentId);
        return next;
      });
      if (!result.ok) return result.error;
    }
    return null;
  }

  async function removeOwner(i: number) {
    const owner = owners[i];
    if (!owner) return;
    setStepError(null);
    const discardError = await discardDocuments([
      owner.idFront?.documentId,
      owner.idBack?.documentId,
    ]);
    if (discardError) {
      setStepError(discardError);
      return;
    }
    setOwners((current) => current.filter((entry) => entry.id !== owner.id));
    setRepresentatives((entries) =>
      entries.map((entry) =>
        entry.linkedOwnerId === owner.id ? { ...entry, linkedOwnerId: undefined } : entry,
      ),
    );
  }

  async function patchRepresentative(i: number, patch: Partial<Representative>) {
    const representative = representatives[i];
    if (!representative) return;
    if (
      typeof patch.linkedOwnerId === 'string' &&
      (representative.idFront || representative.idBack)
    ) {
      setStepError(null);
      const discardError = await discardDocuments([
        representative.idFront?.documentId,
        representative.idBack?.documentId,
      ]);
      if (discardError) {
        setStepError(discardError);
        return;
      }
      patch = { ...patch, idFront: null, idBack: null };
    }
    setRepresentatives((current) =>
      current.map((representative, index) =>
        index === i ? { ...representative, ...patch } : representative,
      ),
    );
  }
  function addRepresentative() {
    setRepresentatives((current) => [...current, emptyRepresentative('')]);
  }
  async function removeRepresentative(i: number) {
    const representative = representatives[i];
    if (!representative) return;
    setStepError(null);
    const discardError = await discardDocuments([
      representative.idFront?.documentId,
      representative.idBack?.documentId,
    ]);
    if (discardError) {
      setStepError(discardError);
      return;
    }
    setRepresentatives((current) => current.filter((entry) => entry.id !== representative.id));
  }

  async function handleIdentityUpload<T extends IdentityUploadSubject>(
    subjectId: string,
    side: 'front' | 'back',
    file: File,
    personName: string,
    setSubjects: Dispatch<SetStateAction<T[]>>,
  ) {
    setIdError(subjectId, side, null);
    const result = await uploadOnboardingFile(token, file, 'ID_DOCUMENT', personName);
    if (!result.ok) {
      setIdError(subjectId, side, result.error);
      return;
    }
    if (!result.versionId) {
      setIdError(
        subjectId,
        side,
        'Die Quellversion konnte nicht gebunden werden. Bitte die Datei erneut hochladen.',
      );
      return;
    }
    // Manual entry needs no OCR/canvas: bind the untouched original immediately.
    const viewport = fullIdentityViewport(result.versionId, side);
    setSubjects((current) =>
      current.map((subject) =>
        subject.id === subjectId
          ? ({
              ...subject,
              [side === 'front' ? 'idFront' : 'idBack']: {
                documentId: result.documentId,
                fileName: file.name,
                localFile: file,
                versionId: result.versionId,
                viewport,
              },
            } as T)
          : subject,
      ),
    );
  }

  async function handleIdentityRemove<T extends IdentityUploadSubject>(
    subjectId: string,
    side: 'front' | 'back',
    documentId: string,
    setSubjects: Dispatch<SetStateAction<T[]>>,
  ) {
    setIdError(subjectId, side, null);
    const person = [...owners, ...representatives].find((entry) => entry.id === subjectId);
    const otherSide = side === 'front' ? person?.idBack : person?.idFront;
    const discardError =
      otherSide?.documentId === documentId ? null : await discardDocuments([documentId]);
    if (discardError) {
      setIdError(subjectId, side, discardError);
      return;
    }
    setSubjects((current) =>
      current.map((subject) =>
        subject.id === subjectId
          ? ({ ...subject, [side === 'front' ? 'idFront' : 'idBack']: null } as T)
          : subject,
      ),
    );
  }

  async function handleExtraUpload(file: File, type: EntityEvidenceType) {
    setExtraUploadError(null);
    const result = await uploadOnboardingFile(token, file, 'EXTRA');
    if (!result.ok) {
      setExtraUploadError(result.error);
      return;
    }
    setExtraDocs((documents) => [
      ...documents,
      { documentId: result.documentId, fileName: file.name, type },
    ]);
  }

  async function handleExtraRemove(documentId: string) {
    setExtraUploadError(null);
    const discardError = await discardDocuments([documentId]);
    if (discardError) {
      setExtraUploadError(discardError);
      return;
    }
    setExtraDocs((documents) => documents.filter((document) => document.documentId !== documentId));
  }

  function validateStep(): string | null {
    if (step === 0) {
      if (!companyName.trim()) return 'Firma / Name ist erforderlich.';
      if (!street.trim()) return 'Straße ist erforderlich.';
      if (!postalCode.trim()) return 'PLZ ist erforderlich.';
      if (!city.trim()) return 'Ort ist erforderlich.';
    }
    if (step === 1) {
      const ownerError = onboardingOwnersStepError(owners);
      if (ownerError) return ownerError;
      const representativeError = onboardingRepresentativesStepError(
        client.kind,
        owners,
        representatives,
      );
      if (representativeError) return representativeError;
    }
    if (ONBOARDING_STEPS[step]?.key === 'documents' && client.kind !== 'NATPERS') {
      const legalEntityError = onboardingLegalEntityStepError({
        clientKind: client.kind,
        noRegisterEntry,
        evidenceTypes: extraDocs.map((document) => document.type),
      });
      if (legalEntityError) return legalEntityError;
    }
    if (ONBOARDING_STEPS[step]?.key === 'privacy') {
      if (!noticeAck)
        return 'Bitte bestätigen Sie, dass Sie die Datenschutzhinweise zur Kenntnis genommen haben.';
      if (!signedByName.trim()) return 'Bitte geben Sie den Namen der erklärenden Person an.';
      const missingRequired = missingRequiredConsentOptions(consent, consentOptions);
      if (missingRequired.length > 0) {
        return `Bitte bestätigen Sie die folgenden Pflichtoptionen: ${missingRequired
          .map((option) => option.label)
          .join(', ')}.`;
      }
    }
    return null;
  }

  function next() {
    const err = validateStep();
    if (err) {
      setStepError(err);
      return;
    }
    setStepError(null);
    setStep((s) => Math.min(ONBOARDING_STEPS.length - 1, s + 1));
  }
  function prev() {
    setStepError(null);
    setStep((s) => Math.max(0, s - 1));
  }

  function submit() {
    setSubmitError(null);
    const err =
      validateStep() ??
      onboardingOwnersStepError(owners) ??
      onboardingRepresentativesStepError(client.kind, owners, representatives);
    if (err) {
      setSubmitError(err);
      return;
    }
    start(async () => {
      const r = await submitOnboardingAction({
        token,
        master: { companyName, street, postalCode, city, countryIso },
        legalEntity: client.kind === 'NATPERS' ? null : { noRegisterEntry: noRegisterEntry! },
        owners: owners.map((o) => ({
          localId: o.id,
          fullName: o.fullName,
          birthDate: o.birthDate,
          birthPlace: o.birthPlace,
          nationality: o.nationality,
          street: o.street,
          postalCode: o.postalCode,
          city: o.city,
          countryIso: o.countryIso,
          sharePercent: o.sharePercent,
          isPep: o.isPep!,
          idType: o.idType,
          idNumber: o.idNumber,
          idIssuedBy: o.idIssuedBy,
          idIssueDate: o.idIssueDate,
          idExpiryDate: o.idExpiryDate,
          idFrontDocumentId: o.idFront!.documentId,
          idBackDocumentId: o.idBack!.documentId,
          idFrontViewport: o.idFront!.viewport!,
          idBackViewport: o.idBack!.viewport!,
        })),
        representatives: representatives.map((representative) => ({
          localId: representative.id,
          fullName: representative.linkedOwnerId
            ? (owners.find((owner) => owner.id === representative.linkedOwnerId)?.fullName ?? '')
            : representative.fullName,
          linkedOwnerLocalId: representative.linkedOwnerId ?? null,
          idType: representative.idType,
          idNumber: representative.idNumber,
          idIssuedBy: representative.idIssuedBy,
          idIssueDate: representative.idIssueDate,
          idExpiryDate: representative.idExpiryDate,
          idFrontDocumentId: representative.idFront?.documentId ?? null,
          idBackDocumentId: representative.idBack?.documentId ?? null,
          idFrontViewport: representative.idFront?.viewport,
          idBackViewport: representative.idBack?.viewport,
        })),
        extraDocuments: extraDocs.map((document) => ({
          documentId: document.documentId,
          type: document.type,
        })),
        consent: {
          noticeAcknowledged: true as const,
          signedByName,
          selections: consent,
          displayRevision: consentDisplayRevision,
        },
      });
      if (!r.ok) {
        setSubmitError(r.error ?? 'Übermittlung fehlgeschlagen.');
        return;
      }
      setSubmitted(true);
    });
  }

  if (submitted) return <OnboardingSubmitted />;

  return (
    <div>
      <WizardStepper step={step} />

      {step === 0 && (
        <MasterDataStep
          companyName={companyName}
          street={street}
          postalCode={postalCode}
          city={city}
          countryIso={countryIso}
          onCompanyNameChange={setCompanyName}
          onStreetChange={setStreet}
          onPostalCodeChange={setPostalCode}
          onCityChange={setCity}
          onCountryIsoChange={setCountryIso}
        />
      )}

      {step === 1 && (
        <OwnersStep
          token={token}
          clientKind={client.kind}
          owners={owners}
          representatives={representatives}
          idUploadErrors={idUploadErrors}
          discardingDocumentIds={discardingDocumentIds}
          onPatchOwner={patchOwner}
          onRemoveOwner={removeOwner}
          onAddOwner={addOwner}
          onOwnerUpload={(ownerId, side, file) => {
            const personName = owners.find((owner) => owner.id === ownerId)?.fullName ?? '';
            void handleIdentityUpload(ownerId, side, file, personName, setOwners);
          }}
          onOwnerUploadRemove={(ownerId, side, documentId) => {
            void handleIdentityRemove(ownerId, side, documentId, setOwners);
          }}
          onPatchRepresentative={patchRepresentative}
          onRemoveRepresentative={removeRepresentative}
          onAddRepresentative={addRepresentative}
          onRepresentativeUpload={(representativeId, side, file) => {
            const representative = representatives.find((entry) => entry.id === representativeId);
            const personName = representative?.linkedOwnerId
              ? (owners.find((owner) => owner.id === representative.linkedOwnerId)?.fullName ?? '')
              : (representative?.fullName ?? '');
            void handleIdentityUpload(representativeId, side, file, personName, setRepresentatives);
          }}
          onRepresentativeUploadRemove={(representativeId, side, documentId) => {
            void handleIdentityRemove(representativeId, side, documentId, setRepresentatives);
          }}
        />
      )}

      {step === 2 && (
        <DocumentsStep
          clientKind={client.kind}
          noRegisterEntry={noRegisterEntry}
          extraType={extraType}
          extraDocs={extraDocs}
          extraUploadError={extraUploadError}
          discardingDocumentIds={discardingDocumentIds}
          onRegisterStatusChange={setNoRegisterEntry}
          onExtraTypeChange={setExtraType}
          onUpload={(file, type) => {
            void handleExtraUpload(file, type);
          }}
          onRemove={(documentId) => void handleExtraRemove(documentId)}
        />
      )}

      {step === 3 && (
        <PrivacyStep
          noticeVersion={noticeVersion}
          noticeBody={noticeBody}
          consent={consent}
          consentOptions={consentOptions}
          noticeAck={noticeAck}
          signedByName={signedByName}
          onConsentChange={setConsent}
          onNoticeAckChange={setNoticeAck}
          onSignedByNameChange={setSignedByName}
        />
      )}

      {step === 4 && (
        <SubmitStep
          companyName={companyName}
          street={street}
          postalCode={postalCode}
          city={city}
          countryIso={countryIso}
          clientKind={client.kind}
          owners={owners}
          representatives={representatives}
          noRegisterEntry={noRegisterEntry}
          extraDocs={extraDocs}
          submitError={submitError}
          isPending={isPending}
          onSubmit={submit}
        />
      )}

      {stepError && <div className="alert-error-sm mt-6">{stepError}</div>}
      <WizardNavigation step={step} onPrevious={prev} onNext={next} />
    </div>
  );
}

function emptyOwner(name: string): BeneficialOwner {
  return {
    id: nextOwnerId(),
    fullName: name,
    birthDate: '',
    birthPlace: '',
    nationality: 'DE',
    street: '',
    postalCode: '',
    city: '',
    countryIso: 'DE',
    sharePercent: '',
    isPep: null,
    idType: 'PERSONALAUSWEIS',
    idNumber: '',
    idIssuedBy: '',
    idIssueDate: '',
    idExpiryDate: '',
    idFront: null,
    idBack: null,
  };
}

function emptyRepresentative(name: string): Representative {
  return {
    id: nextRepresentativeId(),
    fullName: name,
    linkedOwnerId: undefined,
    idType: 'PERSONALAUSWEIS',
    idNumber: '',
    idIssuedBy: '',
    idIssueDate: '',
    idExpiryDate: '',
    idFront: null,
    idBack: null,
  };
}
