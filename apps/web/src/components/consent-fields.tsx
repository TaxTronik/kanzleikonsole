'use client';

// =============================================================================
// ConsentFields — geteilter Editor für die freiwilligen Einwilligungen (Teil B).
//
// Wird von der Staff-Erfassung UND dem Portal-Onboarding genutzt. Hält den
// Einwilligungsstand im State und schreibt ihn als JSON in ein verstecktes
// Feld `consentsJson`, das die Server-Action gegen ConsentSelectionsSchema
// parst. Die dynamischen Listen (Dritte/Spezialisten) sind zeilenweise editierbar.
// =============================================================================

import { useRef, useState } from 'react';
import {
  COMMUNICATION_LABELS,
  MARKETING_LABELS,
  emptyConsent,
  type ConsentSelections,
  type ThirdParty,
  type Specialist,
} from '@/server/privacy/consent';

function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-start gap-2 py-1 text-sm cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 rounded border-strong text-brand-600"
      />
      <span className="text-secondary">{label}</span>
    </label>
  );
}

export function ConsentFields({
  initial,
  onChange,
}: {
  initial?: ConsentSelections;
  /** Optional: meldet jede Änderung nach oben (Wizard hält State ohne <form>). */
  onChange?: (c: ConsentSelections) => void;
}) {
  const [c, setInner] = useState<ConsentSelections>(initial ?? emptyConsent());
  // Ref-Spiegel des aktuellen Stands: `onChange` (Parent-setState) darf NICHT
  // aus einem setState-Updater laufen — das aktualisiert die Elternkomponente
  // während des Renders („Cannot update a component while rendering …") und
  // feuert unter StrictMode doppelt. `next` daher aus dem Ref berechnen und
  // beide Seiteneffekte außerhalb des Updaters ausführen.
  const cRef = useRef(c);
  cRef.current = c;
  const setC = (updater: ConsentSelections | ((s: ConsentSelections) => ConsentSelections)) => {
    const next = typeof updater === 'function' ? updater(cRef.current) : updater;
    cRef.current = next;
    setInner(next);
    onChange?.(next);
  };

  const commKeys = Object.keys(COMMUNICATION_LABELS) as Array<keyof typeof COMMUNICATION_LABELS>;
  const mktKeys = Object.keys(MARKETING_LABELS) as Array<keyof typeof MARKETING_LABELS>;

  function addThird() {
    setC((s) => ({
      ...s,
      thirdParties: [...s.thirdParties, { recipient: '', purpose: '', data: '', channel: '' }],
    }));
  }
  function patchThird(i: number, patch: Partial<ThirdParty>) {
    setC((s) => ({
      ...s,
      thirdParties: s.thirdParties.map((t, idx) => (idx === i ? { ...t, ...patch } : t)),
    }));
  }
  function removeThird(i: number) {
    setC((s) => ({ ...s, thirdParties: s.thirdParties.filter((_, idx) => idx !== i) }));
  }
  function addSpec() {
    setC((s) => ({
      ...s,
      specialists: [
        ...s.specialists,
        { entity: '', service: '', accessType: '', requirements: '' },
      ],
    }));
  }
  function patchSpec(i: number, patch: Partial<Specialist>) {
    setC((s) => ({
      ...s,
      specialists: s.specialists.map((t, idx) => (idx === i ? { ...t, ...patch } : t)),
    }));
  }
  function removeSpec(i: number) {
    setC((s) => ({ ...s, specialists: s.specialists.filter((_, idx) => idx !== i) }));
  }

  return (
    <div className="space-y-6">
      {/* Nur die zeilenkomplett ausgefüllten Array-Einträge zählen; leere werden
          serverseitig ohnehin von der Validierung verworfen. */}
      <input type="hidden" name="consentsJson" value={JSON.stringify(c)} />

      <fieldset>
        <legend className="text-sm font-semibold text-primary mb-1">
          1. Elektronische Kommunikation
        </legend>
        <p className="text-xs text-muted mb-2">
          Über welche Kanäle darf die Kanzlei mandatsbezogen kommunizieren und Unterlagen
          bereitstellen/entgegennehmen?
        </p>
        {commKeys.map((k) => (
          <Check
            key={k}
            checked={c.communication[k]}
            onChange={(v) => setC((s) => ({ ...s, communication: { ...s.communication, [k]: v } }))}
            label={COMMUNICATION_LABELS[k]}
          />
        ))}
        <input
          type="text"
          value={c.communication.details}
          onChange={(e) =>
            setC((s) => ({ ...s, communication: { ...s.communication, details: e.target.value } }))
          }
          placeholder="Details (Portal-Name, E-Mail-Adressen, Faxnummer, Video-System …)"
          maxLength={1000}
          className="input w-full mt-2 text-sm"
        />
      </fieldset>

      <fieldset>
        <legend className="text-sm font-semibold text-primary mb-1">
          2. Informationen außerhalb des Mandats / Kanzleimarketing
        </legend>
        <p className="text-xs text-muted mb-2">
          Freiwillig, jederzeit widerrufbar — betrifft Newsletter/Veranstaltungen über das konkrete
          Mandat hinaus.
        </p>
        {mktKeys.map((k) => (
          <Check
            key={k}
            checked={c.marketing[k]}
            onChange={(v) => setC((s) => ({ ...s, marketing: { ...s.marketing, [k]: v } }))}
            label={MARKETING_LABELS[k]}
          />
        ))}
        <input
          type="text"
          value={c.marketing.details}
          onChange={(e) =>
            setC((s) => ({ ...s, marketing: { ...s.marketing, details: e.target.value } }))
          }
          placeholder="Details (z. B. abweichende E-Mail-Adresse)"
          maxLength={1000}
          className="input w-full mt-2 text-sm"
        />
      </fieldset>

      <fieldset>
        <legend className="text-sm font-semibold text-primary mb-1">
          3. Übermittlung an konkret benannte Dritte
        </legend>
        <p className="text-xs text-muted mb-2">
          Ohne Eintrag erfolgt keine Einwilligung. Nur Zeilen mit Empfänger zählen.
        </p>
        {c.thirdParties.map((t, i) => (
          <div key={i} className="grid grid-cols-1 sm:grid-cols-4 gap-2 mb-2">
            <input
              value={t.recipient}
              onChange={(e) => patchThird(i, { recipient: e.target.value })}
              placeholder="Empfänger *"
              className="input text-sm"
            />
            <input
              value={t.purpose}
              onChange={(e) => patchThird(i, { purpose: e.target.value })}
              placeholder="Zweck"
              className="input text-sm"
            />
            <input
              value={t.data}
              onChange={(e) => patchThird(i, { data: e.target.value })}
              placeholder="Daten/Unterlagen"
              className="input text-sm"
            />
            <div className="flex gap-2">
              <input
                value={t.channel}
                onChange={(e) => patchThird(i, { channel: e.target.value })}
                placeholder="Weg"
                className="input text-sm flex-1"
              />
              <button
                type="button"
                onClick={() => removeThird(i)}
                className="btn-secondary text-xs px-2"
                aria-label="Zeile entfernen"
              >
                ×
              </button>
            </div>
          </div>
        ))}
        <button type="button" onClick={addThird} className="btn-secondary text-xs">
          + Empfänger
        </button>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-semibold text-primary mb-1">
          4. Mandatsbezogene Spezialdienstleister
        </legend>
        <p className="text-xs text-muted mb-2">
          Externe Spezialisten mit Zugang zu Berufsgeheimnissen — nur mit Einwilligung. Ohne Eintrag
          erfolgt keine Einwilligung.
        </p>
        {c.specialists.map((t, i) => (
          <div key={i} className="grid grid-cols-1 sm:grid-cols-4 gap-2 mb-2">
            <input
              value={t.entity}
              onChange={(e) => patchSpec(i, { entity: e.target.value })}
              placeholder="Person/Stelle *"
              className="input text-sm"
            />
            <input
              value={t.service}
              onChange={(e) => patchSpec(i, { service: e.target.value })}
              placeholder="Leistung"
              className="input text-sm"
            />
            <input
              value={t.accessType}
              onChange={(e) => patchSpec(i, { accessType: e.target.value })}
              placeholder="Art des Zugangs"
              className="input text-sm"
            />
            <div className="flex gap-2">
              <input
                value={t.requirements}
                onChange={(e) => patchSpec(i, { requirements: e.target.value })}
                placeholder="Besondere Vorgaben"
                className="input text-sm flex-1"
              />
              <button
                type="button"
                onClick={() => removeSpec(i)}
                className="btn-secondary text-xs px-2"
                aria-label="Zeile entfernen"
              >
                ×
              </button>
            </div>
          </div>
        ))}
        <button type="button" onClick={addSpec} className="btn-secondary text-xs">
          + Spezialdienstleister
        </button>
      </fieldset>
    </div>
  );
}
