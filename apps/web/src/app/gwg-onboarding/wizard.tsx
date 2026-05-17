'use client';

import { useState, useTransition } from 'react';
import { Plus, Trash2, Upload, Check, ArrowLeft, ArrowRight, Loader } from 'lucide-react';
import { uploadIdImageAction, submitOnboardingAction } from './actions';

interface BeneficialOwner {
  fullName: string;
  birthDate: string;       // YYYY-MM-DD
  nationality: string;
  street: string;
  postalCode: string;
  city: string;
  countryIso: string;
  sharePercent: string;    // String für freie Eingabe „>25%"
  // Hochgeladene Ausweis-Bilder (server-seitige documentId)
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
  { key: 'documents', label: 'Sonstige Dokumente' },
  { key: 'submit', label: 'Übermitteln' },
] as const;

export function OnboardingWizard({
  token,
  inviteName,
  client,
}: {
  token: string;
  inviteName: string;
  client: ClientShape;
}) {
  const [step, setStep] = useState(0);

  // Stammdaten
  const [companyName, setCompanyName] = useState(client.name);
  const [street, setStreet] = useState(client.street ?? '');
  const [postalCode, setPostalCode] = useState(client.postalCode ?? '');
  const [city, setCity] = useState(client.city ?? '');
  const [countryIso, setCountryIso] = useState(client.countryIso ?? 'DE');
  const [vatId, setVatId] = useState(client.vatId ?? '');

  // Wirtschaftlich Berechtigte
  const [owners, setOwners] = useState<BeneficialOwner[]>([emptyOwner(inviteName)]);

  // Sonstige Dokumente
  const [extraDocs, setExtraDocs] = useState<Array<{ documentId: string; fileName: string }>>([]);
  const [extraUploadError, setExtraUploadError] = useState<string | null>(null);

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
    setOwners((s) => s.filter((_, idx) => idx !== i));
  }

  async function handleIdUpload(
    ownerIndex: number,
    side: 'front' | 'back',
    file: File,
  ) {
    if (file.size > 10 * 1024 * 1024) {
      patchOwner(ownerIndex, side === 'front' ? { idFront: null } : { idBack: null });
      return;
    }
    const buf = await file.arrayBuffer();
    const base64 = Buffer.from(buf).toString('base64');
    const r = await uploadIdImageAction({
      token,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      base64,
      kind: 'ID_DOCUMENT',
    });
    if (!r.ok) {
      alert(`Upload fehlgeschlagen: ${r.error ?? 'unbekannt'}`);
      return;
    }
    if (side === 'front') {
      patchOwner(ownerIndex, { idFront: { documentId: r.documentId!, fileName: file.name } });
    } else {
      patchOwner(ownerIndex, { idBack: { documentId: r.documentId!, fileName: file.name } });
    }
  }

  async function handleExtraUpload(file: File) {
    setExtraUploadError(null);
    if (file.size > 10 * 1024 * 1024) {
      setExtraUploadError('Datei zu groß (max. 10 MB).');
      return;
    }
    const buf = await file.arrayBuffer();
    const base64 = Buffer.from(buf).toString('base64');
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
    setExtraDocs((d) => [...d, { documentId: r.documentId!, fileName: file.name }]);
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
        if (!o.idFront) return `Person ${i + 1}: Ausweis Vorderseite fehlt.`;
        if (!o.idBack) return `Person ${i + 1}: Ausweis Rückseite fehlt.`;
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
        owners: owners.map((o) => ({
          fullName: o.fullName,
          birthDate: o.birthDate,
          nationality: o.nationality,
          street: o.street,
          postalCode: o.postalCode,
          city: o.city,
          countryIso: o.countryIso,
          sharePercent: o.sharePercent,
          idFrontDocumentId: o.idFront!.documentId,
          idBackDocumentId: o.idBack!.documentId,
        })),
        extraDocumentIds: extraDocs.map((d) => d.documentId),
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
        <h2 className="text-xl font-bold text-gray-900 mb-2">Vielen Dank!</h2>
        <p className="text-sm text-gray-600">
          Ihre Angaben wurden an die Steuerkanzlei übermittelt. Sie können dieses
          Fenster nun schließen.
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
                      : 'w-8 h-8 rounded-full bg-gray-200 text-gray-500 text-sm font-bold flex items-center justify-center'
                }
              >
                {done ? <Check className="h-4 w-4" /> : i + 1}
              </div>
              <span className={current ? 'ml-2 text-sm font-medium text-gray-900' : 'ml-2 text-sm text-gray-500'}>
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
          <h2 className="text-lg font-semibold text-gray-900">Stammdaten</h2>
          <p className="text-sm text-gray-500">
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
            <h2 className="text-lg font-semibold text-gray-900">Wirtschaftlich Berechtigte</h2>
            <p className="text-sm text-gray-500 mt-1">
              Bitte erfassen Sie alle Personen, die direkt oder indirekt mehr als 25 %
              der Anteile halten oder Kontrolle ausüben. Pro Person bitte den
              Personalausweis (Vorder- und Rückseite) hochladen.
            </p>
          </div>
          {owners.map((o, i) => (
            <OwnerCard
              key={i}
              index={i}
              owner={o}
              onPatch={(p) => patchOwner(i, p)}
              onRemove={owners.length > 1 ? () => removeOwner(i) : null}
              onUpload={(side, file) => handleIdUpload(i, side, file)}
            />
          ))}
          <button type="button" onClick={addOwner} className="btn-secondary">
            <Plus className="h-4 w-4" /> Weitere Person hinzufügen
          </button>
        </div>
      )}

      {/* Schritt 2: Sonstige Dokumente */}
      {step === 2 && (
        <div className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Sonstige Dokumente (optional)</h2>
          <p className="text-sm text-gray-500">
            Falls Sie schon einen Handelsregisterauszug oder andere relevante Unterlagen
            haben, können Sie diese hier hochladen. Wenn nicht: kein Problem — die
            Kanzlei besorgt HR-Auszug und Transparenzregister-Auszug selbst.
          </p>
          <div>
            <label className="block">
              <span className="btn-secondary cursor-pointer inline-flex">
                <Upload className="h-4 w-4" /> Datei hochladen
              </span>
              <input
                type="file"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleExtraUpload(f);
                  e.target.value = '';
                }}
              />
            </label>
            {extraUploadError && (
              <p className="text-xs text-red-700 mt-2">{extraUploadError}</p>
            )}
          </div>
          {extraDocs.length > 0 && (
            <ul className="divide-y divide-gray-100 border border-gray-200 rounded">
              {extraDocs.map((d, i) => (
                <li key={i} className="px-3 py-2 text-sm flex items-center justify-between">
                  <span className="text-gray-700">{d.fileName}</span>
                  <span className="text-xs text-emerald-700">✓ hochgeladen</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Schritt 3: Übermitteln */}
      {step === 3 && (
        <div className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Zusammenfassung</h2>
          <dl className="space-y-2 text-sm">
            <SummaryRow label="Firma" value={companyName} />
            <SummaryRow label="Adresse" value={`${street}, ${postalCode} ${city}, ${countryIso}`} />
            {vatId && <SummaryRow label="USt-ID" value={vatId} />}
            <SummaryRow label="Wirtschaftlich Berechtigte" value={`${owners.length} Person${owners.length === 1 ? '' : 'en'}`} />
            <SummaryRow label="Sonstige Dokumente" value={`${extraDocs.length} hochgeladen`} />
          </dl>
          {submitError && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{submitError}</div>}
          <button type="button" onClick={submit} disabled={isPending} className="btn-primary w-full">
            {isPending ? (
              <><Loader className="h-4 w-4 animate-spin" /> Wird übermittelt…</>
            ) : (
              'Jetzt übermitteln'
            )}
          </button>
          <p className="text-xs text-gray-500 text-center">
            Mit dem Klick übermitteln Sie Ihre Angaben verschlüsselt an Ihre Steuerkanzlei.
          </p>
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between mt-6">
        <button type="button" onClick={prev} disabled={step === 0} className="btn-secondary disabled:opacity-30">
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
    fullName: name,
    birthDate: '',
    nationality: 'DE',
    street: '',
    postalCode: '',
    city: '',
    countryIso: 'DE',
    sharePercent: '',
    idFront: null,
    idBack: null,
  };
}

function Field({
  label, value, onChange, type = 'text', required, placeholder,
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
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-gray-900 font-medium text-right">{value}</dd>
    </div>
  );
}

function OwnerCard({
  index, owner, onPatch, onRemove, onUpload,
}: {
  index: number;
  owner: BeneficialOwner;
  onPatch: (p: Partial<BeneficialOwner>) => void;
  onRemove: (() => void) | null;
  onUpload: (side: 'front' | 'back', file: File) => void;
}) {
  return (
    <div className="card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Person {index + 1}</h3>
        {onRemove && (
          <button type="button" onClick={onRemove} className="text-gray-400 hover:text-red-700 text-xs inline-flex items-center gap-1">
            <Trash2 className="h-3 w-3" /> entfernen
          </button>
        )}
      </div>
      <Field label="Vollständiger Name" value={owner.fullName} onChange={(v) => onPatch({ fullName: v })} required />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Geburtsdatum" type="date" value={owner.birthDate} onChange={(v) => onPatch({ birthDate: v })} required />
        <Field label="Staatsangehörigkeit" value={owner.nationality} onChange={(v) => onPatch({ nationality: v })} placeholder="DE" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Straße + Hausnr." value={owner.street} onChange={(v) => onPatch({ street: v })} />
        <Field label={'Anteil (z. B. 50% oder „Alleingesellschafter")'} value={owner.sharePercent} onChange={(v) => onPatch({ sharePercent: v })} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="PLZ" value={owner.postalCode} onChange={(v) => onPatch({ postalCode: v })} />
        <Field label="Ort" value={owner.city} onChange={(v) => onPatch({ city: v })} />
        <Field label="Land" value={owner.countryIso} onChange={(v) => onPatch({ countryIso: v })} />
      </div>

      <div className="grid grid-cols-2 gap-4 pt-2">
        <IdUploadField
          label="Personalausweis Vorderseite"
          file={owner.idFront}
          onUpload={(f) => onUpload('front', f)}
        />
        <IdUploadField
          label="Personalausweis Rückseite"
          file={owner.idBack}
          onUpload={(f) => onUpload('back', f)}
        />
      </div>
    </div>
  );
}

function IdUploadField({
  label, file, onUpload,
}: {
  label: string;
  file: { documentId: string; fileName: string } | null;
  onUpload: (file: File) => void;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-900 mb-1">
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
      <p className="text-xs text-gray-500 mt-1">JPG / PNG / PDF, max. 10 MB</p>
    </div>
  );
}
