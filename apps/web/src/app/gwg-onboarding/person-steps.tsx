'use client';

// =============================================================================
// Schritt „Wirtschaftlich Berechtigte“: Übersicht aller Personen mit Stand und
// Bearbeitung einer Person nach der anderen – wirtschaftlich Berechtigte in
// Ausweis → Angaben → Beteiligung und PEP, Vertretungen in Rolle → Ausweis →
// Angaben. Pflichtprüfung beim Weiter bleibt onboardingOwnersStepError.
// =============================================================================

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowLeft, ArrowRight, Check, Loader, Plus, Trash2, Upload } from 'lucide-react';
import { IdentityCapture } from '@/components/gwg/identity-capture';
import type { IdentitySuggestions } from '@/lib/gwg/identity-ocr';
import type { IdentityViewport } from '@/lib/gwg/identity-viewport';
import { loadOnboardingIdentitySourceAction } from './actions';
import { Field, MAX_UPLOAD_LABEL } from './wizard-shared';
import type {
  BeneficialOwner,
  IdentitySide,
  OnboardingClientKind,
  OnboardingIdentityFile,
  Representative,
} from './wizard-steps';

/** Gerade bearbeitete Person; null zeigt die Übersicht. */
export interface OpenPerson {
  role: 'owner' | 'representative';
  id: string;
}

// Stabile React-Keys für Personen (Add/Remove) — kein key={index}.
let ownerIdSeq = 0;
const nextOwnerId = () => `owner-${++ownerIdSeq}`;
let representativeIdSeq = 0;
const nextRepresentativeId = () => `representative-${++representativeIdSeq}`;

export function emptyOwner(name: string): BeneficialOwner {
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

export function emptyRepresentative(name: string): Representative {
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

type SectionKey = 'role' | 'id' | 'details' | 'share';
interface PersonSection {
  key: SectionKey;
  label: string;
  done: boolean;
}

const filled = (...values: string[]) => values.every((value) => value.trim() !== '');

function ownerSections(owner: BeneficialOwner): PersonSection[] {
  return [
    { key: 'id', label: 'Ausweis', done: Boolean(owner.idFront && owner.idBack) },
    {
      key: 'details',
      label: 'Angaben',
      done: filled(
        owner.fullName,
        owner.birthDate,
        owner.birthPlace,
        owner.nationality,
        owner.street,
        owner.postalCode,
        owner.city,
        owner.countryIso,
        owner.idNumber,
        owner.idIssuedBy,
        owner.idIssueDate,
        owner.idExpiryDate,
      ),
    },
    {
      key: 'share',
      label: 'Beteiligung und PEP',
      done: filled(owner.sharePercent) && owner.isPep !== null,
    },
  ];
}

function representativeSections(representative: Representative): PersonSection[] {
  const role: PersonSection = {
    key: 'role',
    label: 'Rolle',
    done: representative.linkedOwnerId !== undefined,
  };
  // Doppelrolle oder noch offen: Ausweis und Angaben entfallen bzw. folgen erst.
  if (representative.linkedOwnerId !== null) return [role];
  return [
    role,
    {
      key: 'id',
      label: 'Ausweis',
      done: Boolean(representative.idFront && representative.idBack),
    },
    {
      key: 'details',
      label: 'Angaben',
      done: filled(
        representative.fullName,
        representative.idNumber,
        representative.idIssuedBy,
        representative.idIssueDate,
        representative.idExpiryDate,
      ),
    },
  ];
}

interface OwnersStepProps {
  token: string;
  clientKind: OnboardingClientKind;
  owners: BeneficialOwner[];
  representatives: Representative[];
  openPerson: OpenPerson | null;
  idUploadErrors: Record<string, string | null>;
  discardingDocumentIds: ReadonlySet<string>;
  onOpenPerson: (person: OpenPerson | null) => void;
  onPatchOwner: (index: number, patch: Partial<BeneficialOwner>) => void;
  onRemoveOwner: (index: number) => void;
  onAddOwner: () => void;
  onOwnerUpload: (ownerId: string, side: IdentitySide, file: File) => void;
  onOwnerUploadRemove: (ownerId: string, side: IdentitySide, documentId: string) => void;
  onPatchRepresentative: (index: number, patch: Partial<Representative>) => void;
  onRemoveRepresentative: (index: number) => void;
  onAddRepresentative: () => void;
  onRepresentativeUpload: (representativeId: string, side: IdentitySide, file: File) => void;
  onRepresentativeUploadRemove: (
    representativeId: string,
    side: IdentitySide,
    documentId: string,
  ) => void;
}

export function OwnersStep(props: OwnersStepProps) {
  const { openPerson, owners, representatives, idUploadErrors, onOpenPerson } = props;
  const close = () => onOpenPerson(null);
  const ownerIndex =
    openPerson?.role === 'owner' ? owners.findIndex((entry) => entry.id === openPerson.id) : -1;
  const owner = owners[ownerIndex];
  if (owner) {
    return (
      <OwnerEditor
        key={owner.id}
        token={props.token}
        index={ownerIndex}
        owner={owner}
        onPatch={(patch) => props.onPatchOwner(ownerIndex, patch)}
        onUpload={(side, file) => props.onOwnerUpload(owner.id, side, file)}
        onUploadRemove={(side, documentId) => props.onOwnerUploadRemove(owner.id, side, documentId)}
        discardingDocumentIds={props.discardingDocumentIds}
        frontError={idUploadErrors[`${owner.id}:front`] ?? null}
        backError={idUploadErrors[`${owner.id}:back`] ?? null}
        onClose={close}
      />
    );
  }
  const representativeIndex =
    openPerson?.role === 'representative'
      ? representatives.findIndex((entry) => entry.id === openPerson.id)
      : -1;
  const representative = representatives[representativeIndex];
  if (representative) {
    return (
      <RepresentativeEditor
        key={representative.id}
        token={props.token}
        index={representativeIndex}
        representative={representative}
        owners={owners}
        onPatch={(patch) => props.onPatchRepresentative(representativeIndex, patch)}
        onUpload={(side, file) => props.onRepresentativeUpload(representative.id, side, file)}
        onUploadRemove={(side, documentId) =>
          props.onRepresentativeUploadRemove(representative.id, side, documentId)
        }
        discardingDocumentIds={props.discardingDocumentIds}
        frontError={idUploadErrors[`${representative.id}:front`] ?? null}
        backError={idUploadErrors[`${representative.id}:back`] ?? null}
        onClose={close}
      />
    );
  }
  return <PersonOverview {...props} />;
}

function PersonOverview({
  clientKind,
  owners,
  representatives,
  onOpenPerson,
  onRemoveOwner,
  onAddOwner,
  onRemoveRepresentative,
  onAddRepresentative,
}: OwnersStepProps) {
  return (
    <div className="space-y-4">
      <div className="card p-6">
        <h2 className="text-lg font-semibold text-primary">Wirtschaftlich Berechtigte</h2>
        <p className="text-sm text-muted mt-1">
          Bitte erfassen Sie alle Personen, die direkt oder indirekt mehr als 25 % der Anteile
          halten oder Kontrolle ausüben. Je Person brauchen wir den Personalausweis (Vorder- und
          Rückseite), die Angaben dazu sowie Beteiligung und PEP-Status.
        </p>
      </div>
      <ul className="space-y-3">
        {owners.map((owner, index) => (
          <PersonRow
            key={owner.id}
            title={`Person ${index + 1}`}
            name={owner.fullName}
            sections={ownerSections(owner)}
            onOpen={() => onOpenPerson({ role: 'owner', id: owner.id })}
            onRemove={owners.length > 1 ? () => onRemoveOwner(index) : null}
          />
        ))}
      </ul>
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
          <ul className="space-y-3">
            {representatives.map((representative, index) => {
              const linked = representative.linkedOwnerId
                ? owners.find((owner) => owner.id === representative.linkedOwnerId)
                : null;
              return (
                <PersonRow
                  key={representative.id}
                  title={`Vertretung ${index + 1}`}
                  name={linked?.fullName ?? representative.fullName}
                  note={linked ? 'Dieselbe Person wie oben; Ausweis bereits erfasst.' : undefined}
                  sections={representativeSections(representative)}
                  onOpen={() => onOpenPerson({ role: 'representative', id: representative.id })}
                  onRemove={representatives.length > 1 ? () => onRemoveRepresentative(index) : null}
                />
              );
            })}
          </ul>
          <button type="button" onClick={onAddRepresentative} className="btn-secondary">
            <Plus className="h-4 w-4" /> Weitere Vertretung hinzufügen
          </button>
        </div>
      )}
    </div>
  );
}

function PersonRow({
  title,
  name,
  note,
  sections,
  onOpen,
  onRemove,
}: {
  title: string;
  name: string;
  note?: string;
  sections: PersonSection[];
  onOpen: () => void;
  onRemove: (() => void) | null;
}) {
  const complete = sections.every((section) => section.done);
  const action = complete ? 'Bearbeiten' : 'Angaben ergänzen';
  return (
    <li className="card p-4 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-primary">{title}</h3>
        <p className="text-sm text-secondary [overflow-wrap:anywhere]">
          {name.trim() || 'Name noch nicht eingetragen'}
        </p>
        {note && <p className="text-xs text-muted">{note}</p>}
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {sections.map((section) => (
            <li
              key={section.key}
              className={section.done ? 'badge-green gap-1' : 'badge-yellow gap-1'}
            >
              {section.done && <Check className="h-3 w-3" aria-hidden="true" />}
              {section.label}
              {section.done ? <span className="sr-only"> erledigt</span> : ' offen'}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpen}
          className={complete ? 'btn-secondary' : 'btn-primary'}
          aria-label={`${title}: ${action}`}
        >
          {action}
        </button>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="btn-secondary text-red-700"
            aria-label={`${title} entfernen`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </li>
  );
}

/** Rahmen der Personenbearbeitung: Name, Abschnitte, Vor/Zurück, Fertig. */
function PersonEditorFrame({
  kicker,
  title,
  header,
  sections,
  container,
  onClose,
  children,
}: {
  kicker: string;
  title: string;
  header?: ReactNode;
  sections: PersonSection[];
  container: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  children: (key: SectionKey) => ReactNode;
}) {
  const [index, setIndex] = useState(0);
  const position = Math.min(index, sections.length - 1);
  const current = sections[position]!;
  const next = sections[position + 1];
  // Beim Öffnen und Abschnittswechsel nach oben, zu übernommenen Angaben zuerst.
  useEffect(() => {
    const root = container.current;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    (root?.querySelector<HTMLElement>('[data-identity-applied="true"]') ?? root)?.scrollIntoView({
      block: 'start',
      behavior: reduce ? 'auto' : 'smooth',
    });
  }, [container, current.key]);
  return (
    <div ref={container} className="card p-6 space-y-5">
      <button
        type="button"
        onClick={onClose}
        className="inline-flex items-center gap-1 text-sm text-secondary hover:text-primary"
      >
        <ArrowLeft className="h-4 w-4" /> Zur Übersicht
      </button>
      <div>
        <p className="text-xs text-muted">{kicker}</p>
        <h2 className="text-lg font-semibold text-primary">{title}</h2>
      </div>
      {header}
      <ol className="flex flex-wrap gap-2" aria-label="Abschnitte">
        {sections.map((section, sectionIndex) => (
          <li key={section.key}>
            <button
              type="button"
              onClick={() => setIndex(sectionIndex)}
              aria-current={sectionIndex === position ? 'step' : undefined}
              className={`${sectionIndex === position ? 'btn-primary' : 'btn-secondary'} text-xs`}
            >
              {section.done && <Check className="h-3 w-3" aria-hidden="true" />}
              {sectionIndex + 1}. {section.label}
              {section.done && <span className="sr-only"> (erledigt)</span>}
            </button>
          </li>
        ))}
      </ol>
      <section className="space-y-4">
        <h3 className="text-base font-semibold text-primary">{current.label}</h3>
        {children(current.key)}
      </section>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-default pt-4">
        {position > 0 ? (
          <button type="button" className="btn-secondary" onClick={() => setIndex(position - 1)}>
            <ArrowLeft className="h-4 w-4" /> Zurück
          </button>
        ) : (
          <span />
        )}
        {next ? (
          <button type="button" className="btn-primary" onClick={() => setIndex(position + 1)}>
            Weiter: {next.label} <ArrowRight className="h-4 w-4" />
          </button>
        ) : (
          <button type="button" className="btn-primary" onClick={onClose}>
            <Check className="h-4 w-4" /> Fertig – zur Übersicht
          </button>
        )}
      </div>
    </div>
  );
}

interface FieldBinding {
  value: string;
  highlighted: boolean;
  onChange: (value: string) => void;
}
type IdentityDetailKey = 'idNumber' | 'idIssuedBy' | 'idIssueDate' | 'idExpiryDate';
type OwnerDetailKey =
  | IdentityDetailKey
  | 'birthDate'
  | 'birthPlace'
  | 'nationality'
  | 'street'
  | 'postalCode'
  | 'city';

interface IdentityUploadProps {
  token: string;
  onUpload: (side: IdentitySide, file: File) => void;
  onUploadRemove: (side: IdentitySide, documentId: string) => void;
  discardingDocumentIds: ReadonlySet<string>;
  frontError: string | null;
  backError: string | null;
}

function OwnerEditor({
  index,
  owner,
  onPatch,
  onClose,
  ...upload
}: IdentityUploadProps & {
  index: number;
  owner: BeneficialOwner;
  onPatch: (patch: Partial<BeneficialOwner>) => void;
  onClose: () => void;
}) {
  const { bind, applyFromIdentity, container } = useIdentityApplied(owner, onPatch);
  return (
    <PersonEditorFrame
      kicker="Wirtschaftlich berechtigte Person"
      title={`Person ${index + 1}`}
      header={<Field label="Vollständiger Name" {...bind('fullName')} required />}
      sections={ownerSections(owner)}
      container={container}
      onClose={onClose}
    >
      {(key) =>
        key === 'id' ? (
          <IdentitySection
            {...upload}
            person={owner}
            onPatch={onPatch}
            onApplyFields={applyFromIdentity}
          />
        ) : key === 'details' ? (
          <OwnerDetails owner={owner} bind={bind} onPatch={onPatch} />
        ) : (
          <OwnerShare owner={owner} onPatch={onPatch} />
        )
      }
    </PersonEditorFrame>
  );
}

function OwnerDetails({
  owner,
  bind,
  onPatch,
}: {
  owner: BeneficialOwner;
  bind: (key: OwnerDetailKey) => FieldBinding;
  onPatch: (patch: Partial<BeneficialOwner>) => void;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Geburtsdatum" type="date" {...bind('birthDate')} required />
        <Field label="Geburtsort" {...bind('birthPlace')} required />
        <Field label="Staatsangehörigkeit" {...bind('nationality')} placeholder="DE" required />
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-primary">Wohnanschrift</legend>
        <Field label="Straße + Hausnr." {...bind('street')} required />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="PLZ" {...bind('postalCode')} required />
          <Field label="Ort" {...bind('city')} required />
          <Field
            label="Land"
            value={owner.countryIso}
            onChange={(value) => onPatch({ countryIso: value })}
            required
          />
        </div>
      </fieldset>
      <IdentityDetails bind={bind} />
    </>
  );
}

function IdentityDetails({ bind }: { bind: (key: IdentityDetailKey) => FieldBinding }) {
  return (
    <fieldset className="rounded-md border border-default bg-surface-raised p-4 space-y-3">
      {/* float: Überschrift innerhalb des Rahmens statt auf der Linie. */}
      <legend className="float-left w-full text-sm font-medium text-primary">Ausweisdaten</legend>
      <p className="clear-both text-xs text-muted">
        Bitte alle Angaben direkt vom Ausweis übernehmen.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Ausweisnummer" {...bind('idNumber')} required />
        <Field label="Ausstellende Behörde" {...bind('idIssuedBy')} required />
        <Field label="Ausgestellt am" type="date" {...bind('idIssueDate')} required />
        <Field label="Gültig bis" type="date" {...bind('idExpiryDate')} required />
      </div>
    </fieldset>
  );
}

function OwnerShare({
  owner,
  onPatch,
}: {
  owner: BeneficialOwner;
  onPatch: (patch: Partial<BeneficialOwner>) => void;
}) {
  return (
    <>
      <Field
        label={'Anteil (z. B. 50% oder „Alleingesellschafter")'}
        value={owner.sharePercent}
        onChange={(value) => onPatch({ sharePercent: value })}
        required
      />
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
    </>
  );
}

function RepresentativeEditor({
  index,
  representative,
  owners,
  onPatch,
  onClose,
  ...upload
}: IdentityUploadProps & {
  index: number;
  representative: Representative;
  owners: BeneficialOwner[];
  onPatch: (patch: Partial<Representative>) => void;
  onClose: () => void;
}) {
  const { bind, applyFromIdentity, container } = useIdentityApplied(representative, onPatch);
  return (
    <PersonEditorFrame
      kicker="Gesetzliche Vertretung"
      title={`Vertretung ${index + 1}`}
      header={
        representative.linkedOwnerId === null ? (
          <Field label="Vollständiger Name" {...bind('fullName')} required />
        ) : undefined
      }
      sections={representativeSections(representative)}
      container={container}
      onClose={onClose}
    >
      {(key) =>
        key === 'role' ? (
          <RepresentativeRole representative={representative} owners={owners} onPatch={onPatch} />
        ) : key === 'id' ? (
          <IdentitySection
            {...upload}
            person={representative}
            onPatch={onPatch}
            onApplyFields={applyFromIdentity}
          />
        ) : (
          <IdentityDetails bind={bind} />
        )
      }
    </PersonEditorFrame>
  );
}

function RepresentativeRole({
  representative,
  owners,
  onPatch,
}: {
  representative: Representative;
  owners: BeneficialOwner[];
  onPatch: (patch: Partial<Representative>) => void;
}) {
  const linkedOwner = representative.linkedOwnerId
    ? owners.find((owner) => owner.id === representative.linkedOwnerId)
    : null;
  return (
    <>
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
      {linkedOwner && (
        <div className="rounded-md border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
          <strong>{linkedOwner.fullName}</strong> wird mit beiden Rollen gespeichert. Die bereits
          hochgeladenen Ausweisseiten werden derselben stabilen Personen-ID zugeordnet und nicht
          doppelt verlangt.
        </div>
      )}
    </>
  );
}

type IdentityPerson = Pick<BeneficialOwner, 'idType' | 'idFront' | 'idBack'> & IdentitySuggestions;
type IdentityPatch = IdentitySuggestions & {
  idFront?: OnboardingIdentityFile;
  idBack?: OnboardingIdentityFile;
};

function IdentitySection({
  token,
  person,
  onPatch,
  onApplyFields,
  onUpload,
  onUploadRemove,
  discardingDocumentIds,
  frontError,
  backError,
}: IdentityUploadProps & {
  person: IdentityPerson;
  onPatch: (patch: IdentityPatch) => void;
  onApplyFields: (fields: IdentitySuggestions) => void;
}) {
  const deleting = (file: OnboardingIdentityFile | null) =>
    Boolean(file && discardingDocumentIds.has(file.documentId));
  return (
    <>
      <p className="text-sm text-muted">
        Bitte laden Sie Vorder- und Rückseite des Personalausweises hoch, als Foto oder PDF. Die
        Angaben lassen sich danach direkt vom Ausweis auslesen – oder Sie tragen sie im nächsten
        Abschnitt selbst ein.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <IdUploadField
          label="Personalausweis Vorderseite"
          file={person.idFront}
          onUpload={(file) => onUpload('front', file)}
          onRemove={() => onUploadRemove('front', person.idFront!.documentId)}
          deleting={deleting(person.idFront)}
          error={frontError}
        />
        <IdUploadField
          label="Personalausweis Rückseite"
          file={person.idBack}
          onUpload={(file) => onUpload('back', file)}
          onRemove={() => onUploadRemove('back', person.idBack!.documentId)}
          deleting={deleting(person.idBack)}
          error={backError}
        />
      </div>
      <OnboardingIdentityCapture
        token={token}
        person={person}
        onPatch={onPatch}
        onApplyFields={onApplyFields}
      />
    </>
  );
}

type StringFieldOf<T> = { [K in keyof T]: T[K] extends string ? K : never }[keyof T] & string;

/**
 * GWG-OCR-ASSIST-001: Felder, die der Mandant aus der Ausweishilfe übernommen
 * hat, bleiben grün markiert, bis er sie selbst bearbeitet – auch über die
 * Abschnitte einer Person hinweg. Eine Bestätigung entsteht nicht.
 */
function useIdentityApplied<T extends object>(person: T, onPatch: (patch: Partial<T>) => void) {
  const [applied, setApplied] = useState<ReadonlySet<string>>(() => new Set());
  const [revision, setRevision] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!revision) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    container.current
      ?.querySelector<HTMLElement>('[data-identity-applied="true"]')
      ?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }, [revision]);
  function bind(key: StringFieldOf<T>): FieldBinding {
    return {
      value: person[key] as string,
      highlighted: applied.has(key),
      onChange: (value: string) => {
        onPatch({ [key]: value } as Partial<T>);
        if (applied.has(key))
          setApplied((previous) => new Set([...previous].filter((entry) => entry !== key)));
      },
    };
  }
  function applyFromIdentity(fields: IdentitySuggestions) {
    onPatch(fields as Partial<T>);
    // Markierungen früherer Übernahmen (andere Ausweisseite) bleiben bis zur
    // eigenen Bearbeitung bestehen.
    const keys = Object.keys(fields).filter((key) => fields[key as keyof typeof fields]);
    setApplied((previous) => new Set([...previous, ...keys]));
    setRevision((value) => value + 1);
  }
  return { bind, applyFromIdentity, container };
}

/** Nur ausdrücklich gewählte Ausschnitte nennen; das ganze Original ist der Normalfall. */
function isCustomView(viewport: IdentityViewport | undefined): viewport is IdentityViewport {
  return Boolean(
    viewport &&
    (viewport.page !== 1 ||
      viewport.rotation !== 0 ||
      viewport.x !== 0 ||
      viewport.y !== 0 ||
      viewport.width !== 1 ||
      viewport.height !== 1),
  );
}

function OnboardingIdentityCapture({
  token,
  person,
  onPatch,
  onApplyFields,
}: {
  token: string;
  person: IdentityPerson;
  onPatch: (patch: IdentityPatch) => void;
  /** Übernahme aus der Ausweishilfe; markiert die Felder sichtbar. */
  onApplyFields: (fields: IdentitySuggestions) => void;
}) {
  const files = [person.idFront, person.idBack].filter(
    (file): file is OnboardingIdentityFile => !!file,
  );
  const unique = [...new Map(files.map((file) => [file.documentId, file])).values()];
  if (person.idType !== 'PERSONALAUSWEIS' || !unique.length) return null;
  return (
    <div className="space-y-2">
      <IdentityCapture
        sources={unique.map((file) => ({
          id: file.documentId,
          label: file.fileName,
          async load() {
            if (file.localFile && file.versionId)
              return { blob: file.localFile, versionId: file.versionId };
            const result = await loadOnboardingIdentitySourceAction({
              token,
              documentId: file.documentId,
            });
            if (!result.ok) throw new Error(result.error);
            const binary = atob(result.base64);
            return {
              blob: new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], {
                type: result.mimeType,
              }),
              versionId: result.versionId,
            };
          },
        }))}
        audience="client"
        sideSources={{ front: person.idFront?.documentId, back: person.idBack?.documentId }}
        current={person}
        initialViews={files.flatMap((file) =>
          file.viewport ? [{ ...file.viewport, documentId: file.documentId }] : [],
        )}
        onApply={onApplyFields}
        onViewChange={(view) => {
          const file = unique.find((entry) => entry.documentId === view.documentId);
          if (file)
            onPatch({
              [view.side === 'front' ? 'idFront' : 'idBack']: {
                ...file,
                versionId: view.versionId,
                viewport: view,
              },
            });
        }}
      />
      <p className="text-xs text-muted">
        Beide Seiten in einer PDF? Laden Sie die PDF als Vorderseite hoch, lesen Sie sie aus und
        ordnen Sie unter „Ausschnitt anpassen“ die PDF-Seite der Rückseite zu. Ihre Originaldatei
        bleibt unverändert.
      </p>
      {files
        .filter((file) => isCustomView(file.viewport))
        .map((file) => (
          <p key={file.viewport!.side} className="text-xs text-muted">
            {file.viewport!.side === 'front' ? 'Vorderseite' : 'Rückseite'}: {file.fileName}, Seite{' '}
            {file.viewport!.page}, Drehung {file.viewport!.rotation}°
          </p>
        ))}
    </div>
  );
}

function IdUploadField({
  label,
  file,
  onUpload,
  onRemove,
  deleting,
  error,
}: {
  label: string;
  file: { documentId: string; fileName: string } | null;
  onUpload: (file: File) => void;
  onRemove: () => void;
  deleting: boolean;
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
          <button
            type="button"
            onClick={onRemove}
            disabled={deleting}
            className="ml-1 text-red-700 hover:text-red-900 disabled:opacity-50"
            aria-label={`${label} entfernen`}
          >
            {deleting ? (
              <Loader className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
          </button>
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
