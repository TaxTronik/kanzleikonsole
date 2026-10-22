'use client';

import { ArrowLeft, ArrowRight, Check, Loader, Plus, Trash2, Upload } from 'lucide-react';
import { ConsentFields } from '@/components/consent-fields';
import { NoticeView } from '@/components/notice-view';
import type { ConsentSelections, ResolvedConsentOption } from '@/server/privacy/consent';
import type { IdentityViewport } from '@/lib/gwg/identity-viewport';
import { countryName } from '@/lib/countries';
import { CountrySelect, Field } from './wizard-shared';
import type { OpenPerson } from './person-steps';

export { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from './wizard-shared';
export { OwnersStep, emptyOwner, emptyRepresentative, type OpenPerson } from './person-steps';

export const ONBOARDING_STEPS = [
  { key: 'master', label: 'Stammdaten' },
  { key: 'owners', label: 'Wirtschaftlich Berechtigte' },
  { key: 'documents', label: 'Nachweise' },
  { key: 'privacy', label: 'Datenschutz' },
  { key: 'submit', label: 'Übermitteln' },
] as const;

export type OnboardingClientKind = 'NATPERS' | 'JURPERS' | 'PERSGES';
export type IdentitySide = 'front' | 'back';
export interface OnboardingIdentityFile {
  documentId: string;
  fileName: string;
  versionId?: string;
  viewport?: IdentityViewport;
  localFile?: File;
  /** Vorschaubild der frisch gewählten Datei (Objekt-URL), nur im Browser. */
  previewUrl?: string;
}

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
  idFront: OnboardingIdentityFile | null;
  idBack: OnboardingIdentityFile | null;
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
  idFront: OnboardingIdentityFile | null;
  idBack: OnboardingIdentityFile | null;
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

/** `reached`: weitester bereits geprüfter Schritt; bleibt erledigt, wenn man zurückgeht. */
export function WizardStepper({ step, reached = step }: { step: number; reached?: number }) {
  return (
    <div className="mb-8">
      <ol className="flex items-center justify-between" aria-label="Fortschritt">
        {ONBOARDING_STEPS.map((entry, index) => {
          const done = index !== step && index < Math.max(step, reached);
          const current = index === step;
          return (
            <li key={entry.key} className="flex-1 min-w-0 flex items-center">
              <div
                className={
                  done
                    ? 'w-8 h-8 shrink-0 rounded-full bg-emerald-600 text-white text-sm font-bold flex items-center justify-center'
                    : current
                      ? 'w-8 h-8 shrink-0 rounded-full bg-brand-600 text-on-brand text-sm font-bold flex items-center justify-center'
                      : 'w-8 h-8 shrink-0 rounded-full bg-gray-200 text-muted text-sm font-bold flex items-center justify-center'
                }
              >
                {done ? <Check className="h-4 w-4" /> : index + 1}
              </div>
              {/* Schmale Bildschirme: Namen unter der Leiste (s. u.); für
                Screenreader bleiben sie in der Liste. */}
              <span
                className={`sr-only sm:not-sr-only sm:ml-2 text-sm ${
                  current ? 'font-medium text-primary' : 'text-muted'
                }`}
              >
                {entry.label}
              </span>
              {index < ONBOARDING_STEPS.length - 1 && (
                <div className="flex-1 h-px bg-gray-200 mx-1 sm:mx-3" />
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-sm font-medium text-primary sm:hidden" aria-hidden="true">
        Schritt {step + 1} von {ONBOARDING_STEPS.length}: {ONBOARDING_STEPS[step]?.label}
      </p>
    </div>
  );
}

interface MasterDataStepProps {
  companyName: string;
  street: string;
  postalCode: string;
  city: string;
  countryIso: string;
  onCompanyNameChange: (value: string) => void;
  onStreetChange: (value: string) => void;
  onPostalCodeChange: (value: string) => void;
  onCityChange: (value: string) => void;
  onCountryIsoChange: (value: string) => void;
}

export function MasterDataStep({
  companyName,
  street,
  postalCode,
  city,
  countryIso,
  onCompanyNameChange,
  onStreetChange,
  onPostalCodeChange,
  onCityChange,
  onCountryIsoChange,
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
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="PLZ" value={postalCode} onChange={onPostalCodeChange} required />
        <Field label="Ort" value={city} onChange={onCityChange} required />
        <CountrySelect label="Land" value={countryIso} onChange={onCountryIsoChange} required />
      </div>
    </div>
  );
}

interface DocumentsStepProps {
  clientKind: OnboardingClientKind;
  noRegisterEntry: boolean | null;
  extraType: EntityEvidenceType;
  extraDocs: EntityEvidenceDocument[];
  extraUploadError: string | null;
  discardingDocumentIds: ReadonlySet<string>;
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
  discardingDocumentIds,
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
                disabled={discardingDocumentIds.has(document.documentId)}
              >
                {discardingDocumentIds.has(document.documentId) ? (
                  <Loader className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}{' '}
                entfernen
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
        <h2 className="text-lg font-semibold text-primary">Datenschutz</h2>
        <p className="text-xs text-muted mt-1">
          Bitte lesen Sie die Hinweise Ihrer Kanzlei (Fassung {noticeVersion}). Sie erläutern die
          Rechtsgrundlagen der Mandatsbearbeitung und Ihre Rechte.
        </p>
      </div>
      <div className="max-h-72 overflow-y-auto rounded-md border border-default bg-surface-raised p-4">
        <NoticeView body={noticeBody} />
      </div>

      <section
        aria-labelledby="privacy-notice-ack-heading"
        className="rounded-md border border-default bg-surface-raised p-4 space-y-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="privacy-notice-ack-heading" className="text-sm font-semibold text-primary">
            Kenntnisnahme
          </h3>
          <span className="badge-brand">Zwingend</span>
        </div>
        <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={noticeAck}
            onChange={(event) => onNoticeAckChange(event.target.checked)}
            required
            className="mt-0.5 rounded border-strong text-brand-600"
          />
          <span className="text-secondary">
            Ich habe die Datenschutzhinweise zur Kenntnis genommen.
          </span>
        </label>
      </section>

      <div>
        <h3 className="text-sm font-semibold text-primary mb-1">Datenschutzoptionen</h3>
        <p className="text-xs text-muted mb-3">
          Die Kanzlei legt fest, welche Optionen für den Abschluss bestätigt werden müssen. Treffen
          Sie jede Auswahl aktiv; Empfehlungen sind nicht vorausgewählt.
        </p>
        <ConsentFields
          initial={consent}
          options={consentOptions}
          onChange={onConsentChange}
          mode="catalog-only"
        />
      </div>

      <div className="border-t border-default pt-4 space-y-3">
        <div>
          <label className="label-sm" htmlFor="gwg-onboarding-signed-by-name">
            Name der erklärenden Person *
          </label>
          <input
            id="gwg-onboarding-signed-by-name"
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
  clientKind: OnboardingClientKind;
  owners: BeneficialOwner[];
  representatives: Representative[];
  noRegisterEntry: boolean | null;
  extraDocs: EntityEvidenceDocument[];
  submitError: string | null;
  isPending: boolean;
  onSubmit: () => void;
  /** Vergessene Person ergänzen; der Wizard kehrt danach hierher zurück. */
  onAddPerson: (role: OpenPerson['role']) => void;
}

export function SubmitStep({
  companyName,
  street,
  postalCode,
  city,
  countryIso,
  clientKind,
  owners,
  representatives,
  noRegisterEntry,
  extraDocs,
  submitError,
  isPending,
  onSubmit,
  onAddPerson,
}: SubmitStepProps) {
  // Namen statt nur Anzahl: Wer fehlt, fällt in der Zusammenfassung auf.
  const ownerNames = owners.map((owner, index) => owner.fullName.trim() || `Person ${index + 1}`);
  const representativeNames = representatives.map((representative, index) => {
    const linked = owners.findIndex((owner) => owner.id === representative.linkedOwnerId);
    return linked >= 0
      ? `${ownerNames[linked]} (Doppelrolle)`
      : representative.fullName.trim() || `Vertretung ${index + 1}`;
  });

  return (
    <div className="card p-6 space-y-4">
      <h2 className="text-lg font-semibold text-primary">Zusammenfassung</h2>
      <dl className="space-y-2 text-sm">
        <SummaryRow label="Firma" value={companyName} />
        <SummaryRow
          label="Adresse"
          value={`${street}, ${postalCode} ${city}, ${countryName(countryIso) ?? countryIso}`}
        />
        <SummaryRow label="Wirtschaftlich Berechtigte" value={ownerNames.join(', ')} />
        {clientKind !== 'NATPERS' && (
          <SummaryRow
            label="Gesetzliche Vertretung"
            value={representativeNames.join(', ') || 'keine'}
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
      <div className="rounded-md border border-default bg-surface-raised p-4 space-y-3">
        <div>
          <h3 className="text-sm font-medium text-primary">Jemanden vergessen?</h3>
          <p className="text-xs text-muted mt-0.5">
            Sie können hier noch Personen ergänzen. Danach geht es direkt zurück zu dieser
            Zusammenfassung.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={() => onAddPerson('owner')}>
            <Plus className="h-4 w-4" /> Wirtschaftlich berechtigte Person hinzufügen
          </button>
          {clientKind !== 'NATPERS' && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => onAddPerson('representative')}
            >
              <Plus className="h-4 w-4" /> Vertretung hinzufügen
            </button>
          )}
        </div>
      </div>
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
  nextLabel?: string;
}

export function WizardNavigation({
  step,
  onPrevious,
  onNext,
  nextLabel = 'Weiter',
}: WizardNavigationProps) {
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
          {nextLabel} <ArrowRight className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-primary font-medium text-right [overflow-wrap:anywhere]">
        {value}
      </dd>
    </div>
  );
}
