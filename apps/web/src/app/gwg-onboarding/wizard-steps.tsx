'use client';

import { ArrowLeft, ArrowRight, Check, Loader, Plus, Trash2, Upload } from 'lucide-react';
import { ConsentFields } from '@/components/consent-fields';
import { NoticeView } from '@/components/notice-view';
import type { ConsentSelections, ResolvedConsentOption } from '@/server/privacy/consent';

export const MAX_UPLOAD_LABEL = '7 MB';

export const ONBOARDING_STEPS = [
  { key: 'master', label: 'Stammdaten' },
  { key: 'owners', label: 'Wirtschaftlich Berechtigte' },
  { key: 'documents', label: 'Nachweise' },
  { key: 'privacy', label: 'Datenschutz' },
  { key: 'submit', label: 'Übermitteln' },
] as const;

export type OnboardingClientKind = 'NATPERS' | 'JURPERS' | 'PERSGES';
export type IdentitySide = 'front' | 'back';

export interface BeneficialOwner {
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
  idFront: { documentId: string; fileName: string } | null;
  idBack: { documentId: string; fileName: string } | null;
}

export interface Representative {
  id: string;
  fullName: string;
  linkedOwnerId: string | null | undefined;
  idType: 'PERSONALAUSWEIS' | 'REISEPASS';
  idNumber: string;
  idIssuedBy: string;
  idIssueDate: string;
  idExpiryDate: string;
  idFront: { documentId: string; fileName: string } | null;
  idBack: { documentId: string; fileName: string } | null;
}

export type EntityEvidenceType =
  | 'HANDELSREGISTERAUSZUG'
  | 'GESELLSCHAFTSVERTRAG'
  | 'TRANSPARENZREGISTER_AUSZUG'
  | 'VOLLMACHT'
  | 'SONSTIGES';

export interface EntityEvidenceDocument {
  documentId: string;
  fileName: string;
  type: EntityEvidenceType;
}

export const ENTITY_EVIDENCE_TYPES: Array<{ value: EntityEvidenceType; label: string }> = [
  { value: 'GESELLSCHAFTSVERTRAG', label: 'Gesellschaftsvertrag / Gründungsnachweis' },
  { value: 'HANDELSREGISTERAUSZUG', label: 'Handelsregisterauszug' },
  { value: 'TRANSPARENZREGISTER_AUSZUG', label: 'Transparenzregister-Auszug' },
  { value: 'VOLLMACHT', label: 'Vertretungsvollmacht' },
  { value: 'SONSTIGES', label: 'Sonstiger Nachweis' },
];

export function OnboardingSubmitted() {
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

export function WizardStepper({ step }: { step: number }) {
  return (
    <ol className="flex items-center justify-between mb-8">
      {ONBOARDING_STEPS.map((entry, index) => {
        const done = index < step;
        const current = index === step;
        return (
          <li key={entry.key} className="flex-1 flex items-center">
            <div
              className={
                done
                  ? 'w-8 h-8 rounded-full bg-emerald-600 text-white text-sm font-bold flex items-center justify-center'
                  : current
                    ? 'w-8 h-8 rounded-full bg-brand-600 text-white text-sm font-bold flex items-center justify-center'
                    : 'w-8 h-8 rounded-full bg-gray-200 text-muted text-sm font-bold flex items-center justify-center'
              }
            >
              {done ? <Check className="h-4 w-4" /> : index + 1}
            </div>
            <span
              className={
                current ? 'ml-2 text-sm font-medium text-primary' : 'ml-2 text-sm text-muted'
              }
            >
              {entry.label}
            </span>
            {index < ONBOARDING_STEPS.length - 1 && (
              <div className="flex-1 h-px bg-gray-200 mx-3" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

interface MasterDataStepProps {
  companyName: string;
  street: string;
  postalCode: string;
  city: string;
  countryIso: string;
  vatId: string;
  onCompanyNameChange: (value: string) => void;
  onStreetChange: (value: string) => void;
  onPostalCodeChange: (value: string) => void;
  onCityChange: (value: string) => void;
  onCountryIsoChange: (value: string) => void;
  onVatIdChange: (value: string) => void;
}

export function MasterDataStep({
  companyName,
  street,
  postalCode,
  city,
  countryIso,
  vatId,
  onCompanyNameChange,
  onStreetChange,
  onPostalCodeChange,
  onCityChange,
  onCountryIsoChange,
  onVatIdChange,
}: MasterDataStepProps) {
  return (
    <div className="card p-6 space-y-4">
      <h2 className="text-lg font-semibold text-primary">Stammdaten</h2>
      <p className="text-sm text-muted">
        Bitte prüfen und ergänzen Sie die Daten Ihres Unternehmens.
      </p>
      <Field label="Firma / Name" value={companyName} onChange={onCompanyNameChange} required />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Straße + Hausnr." value={street} onChange={onStreetChange} required />
        <Field label="USt-ID" value={vatId} onChange={onVatIdChange} placeholder="DE123456789" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="PLZ" value={postalCode} onChange={onPostalCodeChange} required />
        <Field label="Ort" value={city} onChange={onCityChange} required />
        <Field label="Land (ISO 2)" value={countryIso} onChange={onCountryIsoChange} required />
      </div>
    </div>
  );
}

interface OwnersStepProps {
  clientKind: OnboardingClientKind;
  owners: BeneficialOwner[];
  representatives: Representative[];
  idUploadErrors: Record<string, string | null>;
  onPatchOwner: (index: number, patch: Partial<BeneficialOwner>) => void;
  onRemoveOwner: (index: number) => void;
  onAddOwner: () => void;
  onOwnerUpload: (ownerId: string, side: IdentitySide, file: File) => void;
  onPatchRepresentative: (index: number, patch: Partial<Representative>) => void;
  onRemoveRepresentative: (index: number) => void;
  onAddRepresentative: () => void;
  onRepresentativeUpload: (representativeId: string, side: IdentitySide, file: File) => void;
}

export function OwnersStep({
  clientKind,
  owners,
  representatives,
  idUploadErrors,
  onPatchOwner,
  onRemoveOwner,
  onAddOwner,
  onOwnerUpload,
  onPatchRepresentative,
  onRemoveRepresentative,
  onAddRepresentative,
  onRepresentativeUpload,
}: OwnersStepProps) {
  return (
    <div className="space-y-4">
      <div className="card p-6">
        <h2 className="text-lg font-semibold text-primary">Wirtschaftlich Berechtigte</h2>
        <p className="text-sm text-muted mt-1">
          Bitte erfassen Sie alle Personen, die direkt oder indirekt mehr als 25 % der Anteile
          halten oder Kontrolle ausüben. Pro Person bitte den Personalausweis (Vorder- und
          Rückseite) hochladen.
        </p>
      </div>
      {owners.map((owner, index) => (
        <OwnerCard
          key={owner.id}
          index={index}
          owner={owner}
          onPatch={(patch) => onPatchOwner(index, patch)}
          onRemove={owners.length > 1 ? () => onRemoveOwner(index) : null}
          onUpload={(side, file) => onOwnerUpload(owner.id, side, file)}
          frontError={idUploadErrors[`${owner.id}:front`] ?? null}
          backError={idUploadErrors[`${owner.id}:back`] ?? null}
        />
      ))}
      <button type="button" onClick={onAddOwner} className="btn-secondary">
        <Plus className="h-4 w-4" /> Weitere Person hinzufügen
      </button>
      {clientKind !== 'NATPERS' && (
        <div className="space-y-4 pt-4">
          <div className="card p-6">
            <h2 className="text-lg font-semibold text-primary">Gesetzliche Vertretung</h2>
            <p className="text-sm text-muted mt-1">
              Erfassen Sie alle vertretungsberechtigten Personen. Ist eine Person bereits oben
              wirtschaftlich berechtigt, verknüpfen Sie beide Rollen ausdrücklich. Name und Ausweis
              werden dann nur einmal erfasst.
            </p>
          </div>
          {representatives.map((representative, index) => (
            <RepresentativeCard
              key={representative.id}
              index={index}
              representative={representative}
              owners={owners}
              onPatch={(patch) => onPatchRepresentative(index, patch)}
              onRemove={representatives.length > 1 ? () => onRemoveRepresentative(index) : null}
              onUpload={(side, file) => onRepresentativeUpload(representative.id, side, file)}
              frontError={idUploadErrors[`${representative.id}:front`] ?? null}
              backError={idUploadErrors[`${representative.id}:back`] ?? null}
            />
          ))}
          <button type="button" onClick={onAddRepresentative} className="btn-secondary">
            <Plus className="h-4 w-4" /> Weitere Vertretung hinzufügen
          </button>
        </div>
      )}
    </div>
  );
}

interface DocumentsStepProps {
  clientKind: OnboardingClientKind;
  noRegisterEntry: boolean | null;
  extraType: EntityEvidenceType;
  extraDocs: EntityEvidenceDocument[];
  extraUploadError: string | null;
  onRegisterStatusChange: (withoutRegister: boolean) => void;
  onExtraTypeChange: (type: EntityEvidenceType) => void;
  onUpload: (file: File, type: EntityEvidenceType) => void;
  onRemove: (documentId: string) => void;
}

export function DocumentsStep({
  clientKind,
  noRegisterEntry,
  extraType,
  extraDocs,
  extraUploadError,
  onRegisterStatusChange,
  onExtraTypeChange,
  onUpload,
  onRemove,
}: DocumentsStepProps) {
  return (
    <div className="card p-6 space-y-4">
      <h2 className="text-lg font-semibold text-primary">
        {clientKind === 'NATPERS' ? 'Weitere Nachweise (optional)' : 'Rechtsträgernachweise'}
      </h2>
      <p className="text-sm text-muted">
        {clientKind === 'NATPERS'
          ? 'Weitere für die Identifizierung relevante Unterlagen können Sie hier ergänzen.'
          : noRegisterEntry === true
            ? 'Laden Sie den Gesellschaftsvertrag oder einen gleichwertigen Gründungsnachweis hoch. Für die erklärte nicht registerpflichtige Gesellschaft wird kein Transparenzregister-Auszug verlangt.'
            : 'Laden Sie den Registerauszug oder den Gründungsnachweis direkt hier hoch. Den Transparenzregister-Auszug ruft Ihre Kanzlei selbst ab — ein Upload ist optional.'}
      </p>
      {clientKind !== 'NATPERS' && (
        <div className="rounded-md border border-default bg-surface-raised p-4">
          <label className="label" htmlFor="legal-entity-register-status">
            Registerstatus des Rechtsträgers
          </label>
          <select
            id="legal-entity-register-status"
            className="input"
            value={noRegisterEntry === null ? '' : noRegisterEntry ? 'NO_REGISTER' : 'REGISTERED'}
            onChange={(event) => {
              const withoutRegister = event.target.value === 'NO_REGISTER';
              onRegisterStatusChange(withoutRegister);
              if (withoutRegister) onExtraTypeChange('GESELLSCHAFTSVERTRAG');
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
          onChange={(event) => onExtraTypeChange(event.target.value as EntityEvidenceType)}
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
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onUpload(file, extraType);
              event.target.value = '';
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
                onClick={() => onRemove(document.documentId)}
              >
                <Trash2 className="h-3 w-3" /> entfernen
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface PrivacyStepProps {
  noticeVersion: number;
  noticeBody: string;
  consent: ConsentSelections;
  consentOptions: ResolvedConsentOption[];
  noticeAck: boolean;
  signedByName: string;
  onConsentChange: (value: ConsentSelections) => void;
  onNoticeAckChange: (value: boolean) => void;
  onSignedByNameChange: (value: string) => void;
}

export function PrivacyStep({
  noticeVersion,
  noticeBody,
  consent,
  consentOptions,
  noticeAck,
  signedByName,
  onConsentChange,
  onNoticeAckChange,
  onSignedByNameChange,
}: PrivacyStepProps) {
  return (
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
          Treffen Sie jede Auswahl aktiv. Empfehlungen der Kanzlei bleiben bewusst ungekreuzt. Als
          Pflichtfeld gekennzeichnete rechtlich notwendige Bestätigungen sind für den Abschluss
          erforderlich; alle übrigen Optionen können Sie frei wählen.
        </p>
        <ConsentFields
          initial={consent}
          options={consentOptions}
          onChange={onConsentChange}
          mode="catalog-only"
        />
      </div>

      <div className="border-t border-default pt-4 space-y-3">
        <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={noticeAck}
            onChange={(event) => onNoticeAckChange(event.target.checked)}
            className="mt-0.5 rounded border-strong text-brand-600"
          />
          <span className="text-secondary">
            Ich habe die Datenschutzhinweise zur Kenntnis genommen. Die einzelnen Auswahlfelder habe
            ich aktiv bestätigt; nicht angekreuzte Optionen gelten als nicht erteilt beziehungsweise
            nicht bestätigt.
          </span>
        </label>
        <div>
          <label className="label-sm">Name der erklärenden Person *</label>
          <input
            value={signedByName}
            onChange={(event) => onSignedByNameChange(event.target.value)}
            maxLength={300}
            className="input w-full"
            placeholder="Vor- und Nachname (vertretungsberechtigt)"
          />
        </div>
      </div>
    </div>
  );
}

interface SubmitStepProps {
  companyName: string;
  street: string;
  postalCode: string;
  city: string;
  countryIso: string;
  vatId: string;
  clientKind: OnboardingClientKind;
  owners: BeneficialOwner[];
  representatives: Representative[];
  noRegisterEntry: boolean | null;
  extraDocs: EntityEvidenceDocument[];
  submitError: string | null;
  isPending: boolean;
  onSubmit: () => void;
}

export function SubmitStep({
  companyName,
  street,
  postalCode,
  city,
  countryIso,
  vatId,
  clientKind,
  owners,
  representatives,
  noRegisterEntry,
  extraDocs,
  submitError,
  isPending,
  onSubmit,
}: SubmitStepProps) {
  const linkedRepresentatives = representatives.filter(
    (representative) => representative.linkedOwnerId,
  ).length;

  return (
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
        {clientKind !== 'NATPERS' && (
          <SummaryRow
            label="Gesetzliche Vertretung"
            value={`${representatives.length} Person${representatives.length === 1 ? '' : 'en'}, davon ${linkedRepresentatives} Doppelrolle${linkedRepresentatives === 1 ? '' : 'n'}`}
          />
        )}
        <SummaryRow
          label="Ausweisangaben"
          value={`${owners.filter((owner) => owner.idNumber || owner.idExpiryDate).length} erfasst`}
        />
        {clientKind !== 'NATPERS' && noRegisterEntry !== null && (
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
      <button type="button" onClick={onSubmit} disabled={isPending} className="btn-primary w-full">
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
  );
}

interface WizardNavigationProps {
  step: number;
  onPrevious: () => void;
  onNext: () => void;
}

export function WizardNavigation({ step, onPrevious, onNext }: WizardNavigationProps) {
  return (
    <div className="flex items-center justify-between mt-6">
      <button
        type="button"
        onClick={onPrevious}
        disabled={step === 0}
        className="btn-secondary disabled:opacity-30"
      >
        <ArrowLeft className="h-4 w-4" /> Zurück
      </button>
      {step < ONBOARDING_STEPS.length - 1 && (
        <button type="button" onClick={onNext} className="btn-primary">
          Weiter <ArrowRight className="h-4 w-4" />
        </button>
      )}
    </div>
  );
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
  onChange: (value: string) => void;
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
        onChange={(event) => onChange(event.target.value)}
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
  onPatch: (patch: Partial<BeneficialOwner>) => void;
  onRemove: (() => void) | null;
  onUpload: (side: IdentitySide, file: File) => void;
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
        onChange={(value) => onPatch({ fullName: value })}
        required
      />
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Geburtsdatum"
          type="date"
          value={owner.birthDate}
          onChange={(value) => onPatch({ birthDate: value })}
          required
        />
        <Field
          label="Geburtsort"
          value={owner.birthPlace}
          onChange={(value) => onPatch({ birthPlace: value })}
          required
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Staatsangehörigkeit"
          value={owner.nationality}
          onChange={(value) => onPatch({ nationality: value })}
          placeholder="DE"
          required
        />
        <Field
          label={'Anteil (z. B. 50% oder „Alleingesellschafter")'}
          value={owner.sharePercent}
          onChange={(value) => onPatch({ sharePercent: value })}
          required
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
          onChange={(value) => onPatch({ street: value })}
          required
        />
        <Field
          label="Land"
          value={owner.countryIso}
          onChange={(value) => onPatch({ countryIso: value })}
          required
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="PLZ"
          value={owner.postalCode}
          onChange={(value) => onPatch({ postalCode: value })}
          required
        />
        <Field
          label="Ort"
          value={owner.city}
          onChange={(value) => onPatch({ city: value })}
          required
        />
      </div>

      <div className="rounded-md border border-default bg-subtle p-4 space-y-3">
        <div>
          <h4 className="text-sm font-medium text-primary">Ausweisdaten</h4>
          <p className="text-xs text-muted mt-0.5">
            Bitte alle Angaben direkt vom Ausweis übernehmen.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Ausweisnummer"
            value={owner.idNumber}
            onChange={(value) => onPatch({ idNumber: value })}
            required
          />
          <Field
            label="Ausstellende Behörde"
            value={owner.idIssuedBy}
            onChange={(value) => onPatch({ idIssuedBy: value })}
            required
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Ausgestellt am"
            type="date"
            value={owner.idIssueDate}
            onChange={(value) => onPatch({ idIssueDate: value })}
            required
          />
          <Field
            label="Gültig bis"
            type="date"
            value={owner.idExpiryDate}
            onChange={(value) => onPatch({ idExpiryDate: value })}
            required
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 pt-2">
        <IdUploadField
          label="Personalausweis Vorderseite"
          file={owner.idFront}
          onUpload={(file) => onUpload('front', file)}
          error={frontError}
        />
        <IdUploadField
          label="Personalausweis Rückseite"
          file={owner.idBack}
          onUpload={(file) => onUpload('back', file)}
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
  onUpload: (side: IdentitySide, file: File) => void;
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
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onUpload(file);
              event.target.value = '';
            }}
          />
        </label>
      )}
      {error && <p className="text-xs text-red-700 mt-1">{error}</p>}
      <p className="text-xs text-muted mt-1">JPG / PNG / PDF, max. {MAX_UPLOAD_LABEL}</p>
    </div>
  );
}
