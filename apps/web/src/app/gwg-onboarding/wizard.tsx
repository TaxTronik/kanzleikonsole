'use client';

import { useState, useTransition } from 'react';
import { Plus, Trash2, Upload, Check, ArrowLeft, ArrowRight, Loader } from 'lucide-react';
import { uploadIdImageAction, submitOnboardingAction } from './actions';
import { ConsentFields } from '@/components/consent-fields';
import { NoticeView } from '@/components/notice-view';
import {
  consentForNewDeclaration,
  missingRequiredConsentOptions,
  type ConsentSelections,
  type ResolvedConsentOption,
} from '@/server/privacy/consent';
import type { LoadedInviteDraft } from '@/server/gwg-onboarding/service';

// Client-seitiges Upload-Limit: Die Datei wird Base64-kodiert an die Server-
// Action geschickt (+33 % Overhead). Damit eine Datei knapp unter dem Limit
// das Server-Action-bodySizeLimit von 10 MB (next.config.mjs) nicht sprengt,
// liegt die effektive Grenze bei 7 MB (7 MB × 4/3 ≈ 9,3 MB + JSON-Overhead).
const MAX_UPLOAD_BYTES = 7 * 1024 * 1024;
const MAX_UPLOAD_LABEL = '7 MB';

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

interface BeneficialOwner {
  id: string; // nur clientseitig (React-Key), wird nicht übermittelt
  fullName: string;
  birthDate: string; // YYYY-MM-DD
  birthPlace: string;
  nationality: string;
  street: string;
  postalCode: string;
  city: string;
  countryIso: string;
  sharePercent: string; // String für freie Eingabe „>25%"
  isPep: boolean | null;
  idType: 'PERSONALAUSWEIS' | 'REISEPASS';
  idNumber: string;
  idIssuedBy: string;
  idIssueDate: string; // YYYY-MM-DD
  idExpiryDate: string; // YYYY-MM-DD
  // Hochgeladene Ausweis-Bilder (server-seitige documentId)
  idFront: { documentId: string; fileName: string } | null;
  idBack: { documentId: string; fileName: string } | null;
}

interface Representative {
  id: string;
  fullName: string;
  // undefined = noch keine bewusste Entscheidung, null = separate Person.
  linkedOwnerId: string | null | undefined;
  idType: 'PERSONALAUSWEIS' | 'REISEPASS';
  idNumber: string;
  idIssuedBy: string;
  idIssueDate: string;
  idExpiryDate: string;
  idFront: { documentId: string; fileName: string } | null;
  idBack: { documentId: string; fileName: string } | null;
}

interface ClientShape {
  id: string;
  name: string;
  kind: 'NATPERS' | 'JURPERS' | 'PERSGES';
  street: string | null;
  postalCode: string | null;
  city: string | null;
  countryIso: string | null;
  vatId: string | null;
}

const STEPS = [
  { key: 'master', label: 'Stammdaten' },
  { key: 'owners', label: 'Wirtschaftlich Berechtigte' },
  { key: 'documents', label: 'Nachweise' },
  { key: 'privacy', label: 'Datenschutz' },
  { key: 'submit', label: 'Übermitteln' },
] as const;

type EntityEvidenceType =
  | 'HANDELSREGISTERAUSZUG'
  | 'GESELLSCHAFTSVERTRAG'
  | 'TRANSPARENZREGISTER_AUSZUG'
  | 'VOLLMACHT'
  | 'SONSTIGES';

const ENTITY_EVIDENCE_TYPES: Array<{ value: EntityEvidenceType; label: string }> = [
  { value: 'GESELLSCHAFTSVERTRAG', label: 'Gesellschaftsvertrag / Gründungsnachweis' },
  { value: 'HANDELSREGISTERAUSZUG', label: 'Handelsregisterauszug' },
  { value: 'TRANSPARENZREGISTER_AUSZUG', label: 'Transparenzregister-Auszug' },
  { value: 'VOLLMACHT', label: 'Vertretungsvollmacht' },
  { value: 'SONSTIGES', label: 'Sonstiger Nachweis' },
];

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
  const [vatId, setVatId] = useState(client.vatId ?? '');

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
  const [extraDocs, setExtraDocs] = useState<
    Array<{ documentId: string; fileName: string; type: EntityEvidenceType }>
  >(() => initialDraft?.extraDocuments.map((document) => ({ ...document })) ?? []);
  const [extraType, setExtraType] = useState<EntityEvidenceType>(
    client.kind === 'NATPERS' ? 'SONSTIGES' : 'GESELLSCHAFTSVERTRAG',
  );
  const [noRegisterEntry, setNoRegisterEntry] = useState<boolean | null>(
    initialDraft?.noRegisterEntry ?? null,
  );
  const [extraUploadError, setExtraUploadError] = useState<string | null>(null);

  // Ausweis-Upload-Fehler je Owner+Seite (Key: `${ownerId}:${side}`).
  const [idUploadErrors, setIdUploadErrors] = useState<Record<string, string | null>>({});
  function setIdError(ownerId: string, side: 'front' | 'back', msg: string | null) {
    setIdUploadErrors((s) => ({ ...s, [`${ownerId}:${side}`]: msg }));
  }

  // Submit-State
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [isPending, start] = useTransition();

  function patchOwner(i: number, patch: Partial<BeneficialOwner>) {
    setOwners((s) => s.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));
  }
  function addOwner() {
    setOwners((s) => [...s, emptyOwner('')]);
  }
  function removeOwner(i: number) {
    setOwners((current) => {
      const removedId = current[i]?.id;
      if (removedId) {
        setRepresentatives((entries) =>
          entries.map((entry) =>
            entry.linkedOwnerId === removedId ? { ...entry, linkedOwnerId: undefined } : entry,
          ),
        );
      }
      return current.filter((_, idx) => idx !== i);
    });
  }
  function patchRepresentative(i: number, patch: Partial<Representative>) {
    setRepresentatives((current) =>
      current.map((representative, index) =>
        index === i ? { ...representative, ...patch } : representative,
      ),
    );
  }
  function addRepresentative() {
    setRepresentatives((current) => [...current, emptyRepresentative('')]);
  }
  function removeRepresentative(i: number) {
    setRepresentatives((current) => current.filter((_, index) => index !== i));
  }

  async function handleIdUpload(ownerId: string, side: 'front' | 'back', file: File) {
    setIdError(ownerId, side, null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setIdError(ownerId, side, `Datei zu groß (max. ${MAX_UPLOAD_LABEL}).`);
      return;
    }
    try {
      const base64 = await fileToBase64(file);
      const r = await uploadIdImageAction({
        token,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        base64,
        kind: 'ID_DOCUMENT',
      });
      if (!r.ok) {
        setIdError(ownerId, side, `Upload fehlgeschlagen: ${r.error ?? 'unbekannt'}`);
        return;
      }
      setOwners((s) =>
        s.map((o) =>
          o.id === ownerId
            ? {
                ...o,
                [side === 'front' ? 'idFront' : 'idBack']: {
                  documentId: r.documentId!,
                  fileName: file.name,
                },
              }
            : o,
        ),
      );
    } catch {
      setIdError(
        ownerId,
        side,
        'Upload fehlgeschlagen — bitte Verbindung prüfen und erneut versuchen.',
      );
    }
  }

  async function handleRepresentativeIdUpload(
    representativeId: string,
    side: 'front' | 'back',
    file: File,
  ) {
    setIdError(representativeId, side, null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setIdError(representativeId, side, `Datei zu groß (max. ${MAX_UPLOAD_LABEL}).`);
      return;
    }
    try {
      const base64 = await fileToBase64(file);
      const result = await uploadIdImageAction({
        token,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        base64,
        kind: 'ID_DOCUMENT',
      });
      if (!result.ok) {
        setIdError(representativeId, side, `Upload fehlgeschlagen: ${result.error ?? 'unbekannt'}`);
        return;
      }
      setRepresentatives((current) =>
        current.map((representative) =>
          representative.id === representativeId
            ? {
                ...representative,
                [side === 'front' ? 'idFront' : 'idBack']: {
                  documentId: result.documentId!,
                  fileName: file.name,
                },
              }
            : representative,
        ),
      );
    } catch {
      setIdError(
        representativeId,
        side,
        'Upload fehlgeschlagen — bitte Verbindung prüfen und erneut versuchen.',
      );
    }
  }

  async function handleExtraUpload(file: File, type: EntityEvidenceType) {
    setExtraUploadError(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setExtraUploadError(`Datei zu groß (max. ${MAX_UPLOAD_LABEL}).`);
      return;
    }
    try {
      const base64 = await fileToBase64(file);
      const r = await uploadIdImageAction({
        token,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        base64,
        kind: 'EXTRA',
      });
      if (!r.ok) {
        setExtraUploadError(r.error ?? 'Upload fehlgeschlagen.');
        return;
      }
      setExtraDocs((documents) => [
        ...documents,
        { documentId: r.documentId!, fileName: file.name, type },
      ]);
    } catch {
      setExtraUploadError('Upload fehlgeschlagen — bitte Verbindung prüfen und erneut versuchen.');
    }
  }

  function validateStep(): string | null {
    if (step === 0) {
      if (!companyName.trim()) return 'Firma / Name ist erforderlich.';
      if (!street.trim()) return 'Straße ist erforderlich.';
      if (!postalCode.trim()) return 'PLZ ist erforderlich.';
      if (!city.trim()) return 'Ort ist erforderlich.';
    }
    if (step === 1) {
      if (owners.length === 0) return 'Mindestens eine Person erforderlich.';
      for (const [i, o] of owners.entries()) {
        if (!o.fullName.trim()) return `Person ${i + 1}: Vollständiger Name fehlt.`;
        if (!o.birthDate) return `Person ${i + 1}: Geburtsdatum fehlt.`;
        // § 11 Abs. 4 GwG: Geburtsort, Staatsangehörigkeit, Wohnanschrift Pflicht.
        if (!o.birthPlace.trim()) return `Person ${i + 1}: Geburtsort fehlt (§ 11 Abs. 4 GwG).`;
        if (!o.nationality.trim())
          return `Person ${i + 1}: Staatsangehörigkeit fehlt (§ 11 Abs. 4 GwG).`;
        if (!o.street.trim() || !o.postalCode.trim() || !o.city.trim()) {
          return `Person ${i + 1}: Wohnanschrift (Straße, PLZ, Ort) fehlt (§ 11 Abs. 4 GwG).`;
        }
        if (!o.idFront) return `Person ${i + 1}: Ausweis Vorderseite fehlt.`;
        if (!o.idBack) return `Person ${i + 1}: Ausweis Rückseite fehlt.`;
        if (!o.idNumber.trim()) return `Person ${i + 1}: Ausweisnummer fehlt.`;
        if (!o.idIssuedBy.trim()) return `Person ${i + 1}: Ausstellende Behörde fehlt.`;
        if (!o.idExpiryDate) return `Person ${i + 1}: Gültigkeitsdatum des Ausweises fehlt.`;
        if (o.isPep === null) {
          return `Person ${i + 1}: Bitte den PEP-Status ausdrücklich angeben.`;
        }
      }
      if (client.kind !== 'NATPERS') {
        if (representatives.length === 0) {
          return 'Mindestens eine vertretungsberechtigte Person ist erforderlich.';
        }
        const linkedOwnerIds = new Set<string>();
        for (const [index, representative] of representatives.entries()) {
          const label = `Vertretung ${index + 1}`;
          if (representative.linkedOwnerId === undefined) {
            return `${label}: Bitte entscheiden Sie ausdrücklich, ob dieselbe Person bereits wirtschaftlich berechtigt ist.`;
          }
          if (representative.linkedOwnerId) {
            if (!owners.some((owner) => owner.id === representative.linkedOwnerId)) {
              return `${label}: Die verknüpfte Person ist nicht mehr vorhanden.`;
            }
            if (linkedOwnerIds.has(representative.linkedOwnerId)) {
              return `${label}: Dieselbe Doppelrolle wurde bereits erfasst.`;
            }
            linkedOwnerIds.add(representative.linkedOwnerId);
            continue;
          }
          if (!representative.fullName.trim()) return `${label}: Vollständiger Name fehlt.`;
          if (!representative.idFront) return `${label}: Ausweis Vorderseite fehlt.`;
          if (!representative.idBack) return `${label}: Ausweis Rückseite fehlt.`;
          if (!representative.idNumber.trim()) return `${label}: Ausweisnummer fehlt.`;
          if (!representative.idIssuedBy.trim()) {
            return `${label}: Ausstellende Behörde fehlt.`;
          }
          if (!representative.idExpiryDate) {
            return `${label}: Gültigkeitsdatum des Ausweises fehlt.`;
          }
        }
      }
    }
    if (STEPS[step]?.key === 'documents' && client.kind !== 'NATPERS') {
      if (noRegisterEntry === null) {
        return 'Bitte erklären Sie, ob ein Registereintrag vorhanden ist.';
      }
      if (
        noRegisterEntry &&
        !extraDocs.some((document) => document.type === 'GESELLSCHAFTSVERTRAG')
      ) {
        return 'Bitte laden Sie für die nicht registerpflichtige Gesellschaft einen Gesellschaftsvertrag oder Gründungsnachweis hoch.';
      }
      if (
        !noRegisterEntry &&
        !extraDocs.some(
          (document) =>
            document.type === 'GESELLSCHAFTSVERTRAG' || document.type === 'HANDELSREGISTERAUSZUG',
        )
      ) {
        return 'Bitte laden Sie einen Registerauszug oder Gründungsnachweis hoch.';
      }
      if (
        !noRegisterEntry &&
        !extraDocs.some((document) => document.type === 'TRANSPARENZREGISTER_AUSZUG')
      ) {
        return 'Bitte laden Sie zusätzlich einen Transparenzregister-Auszug hoch.';
      }
    }
    if (STEPS[step]?.key === 'privacy') {
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
      alert(err);
      return;
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }
  function prev() {
    setStep((s) => Math.max(0, s - 1));
  }

  function submit() {
    setSubmitError(null);
    const err = validateStep();
    if (err) {
      setSubmitError(err);
      return;
    }
    start(async () => {
      const r = await submitOnboardingAction({
        token,
        master: { companyName, street, postalCode, city, countryIso, vatId },
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

  if (submitted) {
    return (
      <div className="card p-10 text-center">
        <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
          <Check className="h-8 w-8 text-emerald-700" />
        </div>
        <h2 className="text-xl font-bold text-primary mb-2">Vielen Dank!</h2>
        <p className="text-sm text-secondary">
          Ihre Angaben wurden an die Steuerkanzlei übermittelt. Sie können dieses Fenster nun
          schließen.
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Stepper */}
      <ol className="flex items-center justify-between mb-8">
        {STEPS.map((s, i) => {
          const done = i < step;
          const current = i === step;
          return (
            <li key={s.key} className="flex-1 flex items-center">
              <div
                className={
                  done
                    ? 'w-8 h-8 rounded-full bg-emerald-600 text-white text-sm font-bold flex items-center justify-center'
                    : current
                      ? 'w-8 h-8 rounded-full bg-brand-600 text-white text-sm font-bold flex items-center justify-center'
                      : 'w-8 h-8 rounded-full bg-gray-200 text-muted text-sm font-bold flex items-center justify-center'
                }
              >
                {done ? <Check className="h-4 w-4" /> : i + 1}
              </div>
              <span
                className={
                  current ? 'ml-2 text-sm font-medium text-primary' : 'ml-2 text-sm text-muted'
                }
              >
                {s.label}
              </span>
              {i < STEPS.length - 1 && <div className="flex-1 h-px bg-gray-200 mx-3" />}
            </li>
          );
        })}
      </ol>

      {/* Schritt 0: Stammdaten */}
      {step === 0 && (
        <div className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-primary">Stammdaten</h2>
          <p className="text-sm text-muted">
            Bitte prüfen und ergänzen Sie die Daten Ihres Unternehmens.
          </p>
          <Field label="Firma / Name" value={companyName} onChange={setCompanyName} required />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Straße + Hausnr." value={street} onChange={setStreet} required />
            <Field label="USt-ID" value={vatId} onChange={setVatId} placeholder="DE123456789" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="PLZ" value={postalCode} onChange={setPostalCode} required />
            <Field label="Ort" value={city} onChange={setCity} required />
            <Field label="Land (ISO 2)" value={countryIso} onChange={setCountryIso} required />
          </div>
        </div>
      )}

      {/* Schritt 1: Wirtschaftlich Berechtigte */}
      {step === 1 && (
        <div className="space-y-4">
          <div className="card p-6">
            <h2 className="text-lg font-semibold text-primary">Wirtschaftlich Berechtigte</h2>
            <p className="text-sm text-muted mt-1">
              Bitte erfassen Sie alle Personen, die direkt oder indirekt mehr als 25 % der Anteile
              halten oder Kontrolle ausüben. Pro Person bitte den Personalausweis (Vorder- und
              Rückseite) hochladen.
            </p>
          </div>
          {owners.map((o, i) => (
            <OwnerCard
              key={o.id}
              index={i}
              owner={o}
              onPatch={(p) => patchOwner(i, p)}
              onRemove={owners.length > 1 ? () => removeOwner(i) : null}
              onUpload={(side, file) => {
                void handleIdUpload(o.id, side, file);
              }}
              frontError={idUploadErrors[`${o.id}:front`] ?? null}
              backError={idUploadErrors[`${o.id}:back`] ?? null}
            />
          ))}
          <button type="button" onClick={addOwner} className="btn-secondary">
            <Plus className="h-4 w-4" /> Weitere Person hinzufügen
          </button>
          {client.kind !== 'NATPERS' && (
            <div className="space-y-4 pt-4">
              <div className="card p-6">
                <h2 className="text-lg font-semibold text-primary">Gesetzliche Vertretung</h2>
                <p className="text-sm text-muted mt-1">
                  Erfassen Sie alle vertretungsberechtigten Personen. Ist eine Person bereits oben
                  wirtschaftlich berechtigt, verknüpfen Sie beide Rollen ausdrücklich. Name und
                  Ausweis werden dann nur einmal erfasst.
                </p>
              </div>
              {representatives.map((representative, index) => (
                <RepresentativeCard
                  key={representative.id}
                  index={index}
                  representative={representative}
                  owners={owners}
                  onPatch={(patch) => patchRepresentative(index, patch)}
                  onRemove={representatives.length > 1 ? () => removeRepresentative(index) : null}
                  onUpload={(side, file) => {
                    void handleRepresentativeIdUpload(representative.id, side, file);
                  }}
                  frontError={idUploadErrors[`${representative.id}:front`] ?? null}
                  backError={idUploadErrors[`${representative.id}:back`] ?? null}
                />
              ))}
              <button type="button" onClick={addRepresentative} className="btn-secondary">
                <Plus className="h-4 w-4" /> Weitere Vertretung hinzufügen
              </button>
            </div>
          )}
        </div>
      )}

      {/* Schritt 2: Sonstige Dokumente */}
      {step === 2 && (
        <div className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-primary">
            {client.kind === 'NATPERS' ? 'Weitere Nachweise (optional)' : 'Rechtsträgernachweise'}
          </h2>
          <p className="text-sm text-muted">
            {client.kind === 'NATPERS'
              ? 'Weitere für die Identifizierung relevante Unterlagen können Sie hier ergänzen.'
              : noRegisterEntry === true
                ? 'Laden Sie den Gesellschaftsvertrag oder einen gleichwertigen Gründungsnachweis hoch. Für die erklärte nicht registerpflichtige Gesellschaft wird kein Transparenzregister-Auszug verlangt.'
                : 'Laden Sie den Registerauszug oder den Gründungsnachweis sowie den Transparenzregister-Auszug direkt hier hoch.'}
          </p>
          {client.kind !== 'NATPERS' && (
            <div className="rounded-md border border-default bg-surface-raised p-4">
              <label className="label" htmlFor="legal-entity-register-status">
                Registerstatus des Rechtsträgers
              </label>
              <select
                id="legal-entity-register-status"
                className="input"
                value={
                  noRegisterEntry === null ? '' : noRegisterEntry ? 'NO_REGISTER' : 'REGISTERED'
                }
                onChange={(event) => {
                  const withoutRegister = event.target.value === 'NO_REGISTER';
                  setNoRegisterEntry(withoutRegister);
                  if (withoutRegister) setExtraType('GESELLSCHAFTSVERTRAG');
                }}
                required
              >
                <option value="" disabled>
                  — bitte auswählen —
                </option>
                <option value="REGISTERED">Register-/Transparenzregistereintrag vorhanden</option>
                <option value="NO_REGISTER">
                  Nicht registerpflichtig / kein Registereintrag (z. B. einfache GbR)
                </option>
              </select>
              <p className="text-xs text-muted mt-2">
                Die Erklärung wird mit der Einreichung dokumentiert und anschließend von der Kanzlei
                geprüft. Bei fehlender Registerpflicht dient der Gesellschaftsvertrag als
                Alternativnachweis.
              </p>
            </div>
          )}
          <div>
            <label className="label" htmlFor="entity-evidence-type">
              Dokumenttyp
            </label>
            <select
              id="entity-evidence-type"
              className="input max-w-md mb-3"
              value={extraType}
              onChange={(event) => setExtraType(event.target.value as EntityEvidenceType)}
            >
              {ENTITY_EVIDENCE_TYPES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
            <label className="block">
              <span className="btn-secondary cursor-pointer inline-flex">
                <Upload className="h-4 w-4" /> Datei hochladen
              </span>
              <input
                type="file"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleExtraUpload(f, extraType);
                  e.target.value = '';
                }}
              />
            </label>
            {extraUploadError && <p className="text-xs text-red-700 mt-2">{extraUploadError}</p>}
          </div>
          {extraDocs.length > 0 && (
            <ul className="divide-y divide-border-subtle border border-default rounded">
              {extraDocs.map((document) => (
                <li
                  key={document.documentId}
                  className="px-3 py-2 text-sm flex items-center justify-between gap-3"
                >
                  <span className="text-secondary">
                    {document.fileName}
                    <span className="block text-xs text-muted">
                      {ENTITY_EVIDENCE_TYPES.find((entry) => entry.value === document.type)?.label}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="text-xs text-red-700 inline-flex items-center gap-1"
                    onClick={() =>
                      setExtraDocs((documents) =>
                        documents.filter((entry) => entry.documentId !== document.documentId),
                      )
                    }
                  >
                    <Trash2 className="h-3 w-3" /> entfernen
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Schritt 3: Datenschutz & Einwilligungen */}
      {step === 3 && (
        <div className="card p-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-primary">Datenschutzhinweise</h2>
            <p className="text-xs text-muted mt-1">
              Bitte lesen Sie die Hinweise Ihrer Kanzlei (Fassung {noticeVersion}). Die zur
              Mandatsbearbeitung nötige Verarbeitung ist auch ohne Einwilligung zulässig.
            </p>
          </div>
          <div className="max-h-72 overflow-y-auto rounded-md border border-default bg-surface-raised p-4">
            <NoticeView body={noticeBody} />
          </div>

          <div>
            <h3 className="text-sm font-semibold text-primary mb-1">Datenschutz-Auswahl</h3>
            <p className="text-xs text-muted mb-3">
              Treffen Sie jede Auswahl aktiv. Empfehlungen der Kanzlei bleiben bewusst ungekreuzt.
              Als Pflichtfeld gekennzeichnete rechtlich notwendige Bestätigungen sind für den
              Abschluss erforderlich; alle übrigen Optionen können Sie frei wählen.
            </p>
            <ConsentFields
              initial={consent}
              options={consentOptions}
              onChange={setConsent}
              mode="catalog-only"
            />
          </div>

          <div className="border-t border-default pt-4 space-y-3">
            <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                checked={noticeAck}
                onChange={(e) => setNoticeAck(e.target.checked)}
                className="mt-0.5 rounded border-strong text-brand-600"
              />
              <span className="text-secondary">
                Ich habe die Datenschutzhinweise zur Kenntnis genommen. Die einzelnen Auswahlfelder
                habe ich aktiv bestätigt; nicht angekreuzte Optionen gelten als nicht erteilt
                beziehungsweise nicht bestätigt.
              </span>
            </label>
            <div>
              <label className="label-sm">Name der erklärenden Person *</label>
              <input
                value={signedByName}
                onChange={(e) => setSignedByName(e.target.value)}
                maxLength={300}
                className="input w-full"
                placeholder="Vor- und Nachname (vertretungsberechtigt)"
              />
            </div>
          </div>
        </div>
      )}

      {/* Schritt 4: Übermitteln */}
      {step === 4 && (
        <div className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-primary">Zusammenfassung</h2>
          <dl className="space-y-2 text-sm">
            <SummaryRow label="Firma" value={companyName} />
            <SummaryRow label="Adresse" value={`${street}, ${postalCode} ${city}, ${countryIso}`} />
            {vatId && <SummaryRow label="USt-ID" value={vatId} />}
            <SummaryRow
              label="Wirtschaftlich Berechtigte"
              value={`${owners.length} Person${owners.length === 1 ? '' : 'en'}`}
            />
            {client.kind !== 'NATPERS' && (
              <SummaryRow
                label="Gesetzliche Vertretung"
                value={`${representatives.length} Person${representatives.length === 1 ? '' : 'en'}, davon ${representatives.filter((representative) => representative.linkedOwnerId).length} Doppelrolle${representatives.filter((representative) => representative.linkedOwnerId).length === 1 ? '' : 'n'}`}
              />
            )}
            <SummaryRow
              label="Ausweisangaben"
              value={`${owners.filter((o) => o.idNumber || o.idExpiryDate).length} erfasst`}
            />
            {client.kind !== 'NATPERS' && noRegisterEntry !== null && (
              <SummaryRow
                label="Registerstatus"
                value={
                  noRegisterEntry
                    ? 'Nicht registerpflichtig / kein Eintrag erklärt'
                    : 'Registereintrag vorhanden'
                }
              />
            )}
            <SummaryRow label="Weitere Nachweise" value={`${extraDocs.length} hochgeladen`} />
          </dl>
          {submitError && <div className="alert-error-sm">{submitError}</div>}
          <button
            type="button"
            onClick={submit}
            disabled={isPending}
            className="btn-primary w-full"
          >
            {isPending ? (
              <>
                <Loader className="h-4 w-4 animate-spin" /> Wird übermittelt…
              </>
            ) : (
              'Jetzt übermitteln'
            )}
          </button>
          <p className="text-xs text-muted text-center">
            Mit dem Klick übermitteln Sie Ihre Angaben verschlüsselt an Ihre Steuerkanzlei.
          </p>
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between mt-6">
        <button
          type="button"
          onClick={prev}
          disabled={step === 0}
          className="btn-secondary disabled:opacity-30"
        >
          <ArrowLeft className="h-4 w-4" /> Zurück
        </button>
        {step < STEPS.length - 1 && (
          <button type="button" onClick={next} className="btn-primary">
            Weiter <ArrowRight className="h-4 w-4" />
          </button>
        )}
      </div>
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

function Field({
  label,
  value,
  onChange,
  type = 'text',
  required,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="label">
        {label}
        {required && <span className="text-red-700 ml-1">*</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        className="input"
      />
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-primary font-medium text-right">{value}</dd>
    </div>
  );
}

function OwnerCard({
  index,
  owner,
  onPatch,
  onRemove,
  onUpload,
  frontError,
  backError,
}: {
  index: number;
  owner: BeneficialOwner;
  onPatch: (p: Partial<BeneficialOwner>) => void;
  onRemove: (() => void) | null;
  onUpload: (side: 'front' | 'back', file: File) => void;
  frontError: string | null;
  backError: string | null;
}) {
  return (
    <div className="card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-primary">Person {index + 1}</h3>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-disabled hover:text-red-700 text-xs inline-flex items-center gap-1"
          >
            <Trash2 className="h-3 w-3" /> entfernen
          </button>
        )}
      </div>
      <Field
        label="Vollständiger Name"
        value={owner.fullName}
        onChange={(v) => onPatch({ fullName: v })}
        required
      />
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Geburtsdatum"
          type="date"
          value={owner.birthDate}
          onChange={(v) => onPatch({ birthDate: v })}
          required
        />
        <Field
          label="Geburtsort"
          value={owner.birthPlace}
          onChange={(v) => onPatch({ birthPlace: v })}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Staatsangehörigkeit"
          value={owner.nationality}
          onChange={(v) => onPatch({ nationality: v })}
          placeholder="DE"
        />
        <Field
          label={'Anteil (z. B. 50% oder „Alleingesellschafter")'}
          value={owner.sharePercent}
          onChange={(v) => onPatch({ sharePercent: v })}
        />
      </div>
      <div>
        <label className="label" htmlFor={`owner-${owner.id}-pep`}>
          Politisch exponierte Person (PEP) oder enges Familienmitglied
        </label>
        <select
          id={`owner-${owner.id}-pep`}
          className="input"
          value={owner.isPep === null ? '' : owner.isPep ? 'true' : 'false'}
          onChange={(event) =>
            onPatch({ isPep: event.target.value === '' ? null : event.target.value === 'true' })
          }
          required
        >
          <option value="" disabled>
            — bitte auswählen —
          </option>
          <option value="false">Nein</option>
          <option value="true">Ja</option>
        </select>
        <p className="text-xs text-muted mt-1">
          Die Angabe ist für verstärkte Sorgfaltspflichten und die Risikoeinstufung erforderlich.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Straße + Hausnr."
          value={owner.street}
          onChange={(v) => onPatch({ street: v })}
        />
        <Field label="Land" value={owner.countryIso} onChange={(v) => onPatch({ countryIso: v })} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="PLZ" value={owner.postalCode} onChange={(v) => onPatch({ postalCode: v })} />
        <Field label="Ort" value={owner.city} onChange={(v) => onPatch({ city: v })} />
      </div>

      <div className="rounded-md border border-default bg-subtle p-4 space-y-3">
        <div>
          <h4 className="text-sm font-medium text-primary">Ausweisdaten</h4>
          <p className="text-xs text-muted mt-0.5">
            Falls vorhanden, bitte direkt vom Ausweis übernehmen.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Ausweisnummer"
            value={owner.idNumber}
            onChange={(v) => onPatch({ idNumber: v })}
          />
          <Field
            label="Ausstellende Behörde"
            value={owner.idIssuedBy}
            onChange={(v) => onPatch({ idIssuedBy: v })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Ausgestellt am"
            type="date"
            value={owner.idIssueDate}
            onChange={(v) => onPatch({ idIssueDate: v })}
          />
          <Field
            label="Gültig bis"
            type="date"
            value={owner.idExpiryDate}
            onChange={(v) => onPatch({ idExpiryDate: v })}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 pt-2">
        <IdUploadField
          label="Personalausweis Vorderseite"
          file={owner.idFront}
          onUpload={(f) => onUpload('front', f)}
          error={frontError}
        />
        <IdUploadField
          label="Personalausweis Rückseite"
          file={owner.idBack}
          onUpload={(f) => onUpload('back', f)}
          error={backError}
        />
      </div>
    </div>
  );
}

function RepresentativeCard({
  index,
  representative,
  owners,
  onPatch,
  onRemove,
  onUpload,
  frontError,
  backError,
}: {
  index: number;
  representative: Representative;
  owners: BeneficialOwner[];
  onPatch: (patch: Partial<Representative>) => void;
  onRemove: (() => void) | null;
  onUpload: (side: 'front' | 'back', file: File) => void;
  frontError: string | null;
  backError: string | null;
}) {
  const linkedOwner = representative.linkedOwnerId
    ? owners.find((owner) => owner.id === representative.linkedOwnerId)
    : null;

  return (
    <div className="card p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-primary">Vertretung {index + 1}</h3>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-disabled hover:text-red-700 text-xs inline-flex items-center gap-1"
          >
            <Trash2 className="h-3 w-3" /> entfernen
          </button>
        )}
      </div>

      <div>
        <label className="label" htmlFor={`representative-${representative.id}-identity`}>
          Ist diese Person bereits wirtschaftlich berechtigt?
        </label>
        <select
          id={`representative-${representative.id}-identity`}
          className="input"
          value={
            representative.linkedOwnerId === undefined
              ? ''
              : representative.linkedOwnerId === null
                ? 'SEPARATE'
                : representative.linkedOwnerId
          }
          onChange={(event) => {
            const linkedOwnerId =
              event.target.value === 'SEPARATE' ? null : event.target.value || undefined;
            const owner = owners.find((entry) => entry.id === linkedOwnerId);
            onPatch({ linkedOwnerId, ...(owner ? { fullName: owner.fullName } : {}) });
          }}
        >
          <option value="" disabled>
            — bitte ausdrücklich auswählen —
          </option>
          <option value="SEPARATE">Nein – eigenständige Person erfassen</option>
          {owners.map((owner, ownerIndex) => (
            <option key={owner.id} value={owner.id}>
              Ja – {owner.fullName || `Person ${ownerIndex + 1}`} (dieselbe Person)
            </option>
          ))}
        </select>
      </div>

      {linkedOwner ? (
        <div className="rounded-md border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
          <strong>{linkedOwner.fullName}</strong> wird mit beiden Rollen gespeichert. Die bereits
          hochgeladenen Ausweisseiten werden derselben stabilen Personen-ID zugeordnet und nicht
          doppelt verlangt.
        </div>
      ) : (
        <>
          <Field
            label="Vollständiger Name"
            value={representative.fullName}
            onChange={(value) => onPatch({ fullName: value })}
            required
          />
          <div className="rounded-md border border-default bg-subtle p-4 space-y-3">
            <div>
              <h4 className="text-sm font-medium text-primary">Ausweisdaten der Vertretung</h4>
              <p className="text-xs text-muted mt-0.5">
                Diese Angaben entfallen, wenn Sie oben dieselbe wirtschaftlich berechtigte Person
                auswählen.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Ausweisnummer"
                value={representative.idNumber}
                onChange={(value) => onPatch({ idNumber: value })}
                required
              />
              <Field
                label="Ausstellende Behörde"
                value={representative.idIssuedBy}
                onChange={(value) => onPatch({ idIssuedBy: value })}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Ausgestellt am"
                type="date"
                value={representative.idIssueDate}
                onChange={(value) => onPatch({ idIssueDate: value })}
              />
              <Field
                label="Gültig bis"
                type="date"
                value={representative.idExpiryDate}
                onChange={(value) => onPatch({ idExpiryDate: value })}
                required
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 pt-2">
            <IdUploadField
              label="Personalausweis Vorderseite"
              file={representative.idFront}
              onUpload={(file) => onUpload('front', file)}
              error={frontError}
            />
            <IdUploadField
              label="Personalausweis Rückseite"
              file={representative.idBack}
              onUpload={(file) => onUpload('back', file)}
              error={backError}
            />
          </div>
        </>
      )}
    </div>
  );
}

function IdUploadField({
  label,
  file,
  onUpload,
  error,
}: {
  label: string;
  file: { documentId: string; fileName: string } | null;
  onUpload: (file: File) => void;
  error: string | null;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-primary mb-1">
        {label} <span className="text-red-700">*</span>
      </label>
      {file ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 inline-flex items-center gap-2">
          <Check className="h-4 w-4" />
          <span className="truncate max-w-[180px]">{file.fileName}</span>
        </div>
      ) : (
        <label className="block">
          <span className="btn-secondary cursor-pointer inline-flex">
            <Upload className="h-4 w-4" /> Foto hochladen
          </span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/heic,image/webp,application/pdf"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
              e.target.value = '';
            }}
          />
        </label>
      )}
      {error && <p className="text-xs text-red-700 mt-1">{error}</p>}
      <p className="text-xs text-muted mt-1">JPG / PNG / PDF, max. {MAX_UPLOAD_LABEL}</p>
    </div>
  );
}
