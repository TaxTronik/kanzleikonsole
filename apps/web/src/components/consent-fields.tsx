'use client';

// =============================================================================
// ConsentFields — geteilter Editor für Datenschutz-Auswahl und Einwilligungen (Teil B).
//
// Wird von der Staff-Erfassung UND dem Portal-Onboarding genutzt. Hält den
// Einwilligungsstand im State und schreibt ihn als JSON in ein verstecktes
// Feld `consentsJson`, das die Server-Action gegen ConsentSelectionsSchema
// parst. Die dynamischen Listen (Dritte/Spezialisten) sind nur in der
// Kanzlei-Erfassung editierbar; das Portal darf ausschließlich Katalogoptionen
// auswählen.
// =============================================================================

import { useState } from 'react';
import { fmtIsoDate } from '@/lib/fmt';
import {
  consentForNewDeclaration,
  defaultConsentOptionsCatalog,
  isBuiltinConsentOptionId,
  isBuiltinConsentSelected,
  setBuiltinConsentSelected,
  type ConsentSelections,
  type ResolvedConsentOption,
  type ThirdParty,
  type Specialist,
} from '@/server/privacy/consent';

function Check({
  checked,
  onChange,
  label,
  hint,
  required = false,
  recommended = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string | null;
  required?: boolean;
  recommended?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-2 py-1 text-sm cursor-pointer select-none ${
        recommended ? 'rounded-md border border-default bg-surface-raised px-2' : ''
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        required={required}
        className="mt-0.5 rounded border-strong text-brand-600"
      />
      <span className="text-secondary">
        {label}
        {required && <span className="ml-1 text-xs font-medium text-red-700">(Pflichtfeld)</span>}
        {recommended && (
          <span className="ml-1 text-xs font-medium text-brand-700 dark:text-brand-300">
            (Empfehlung der Kanzlei)
          </span>
        )}
        {recommended && (
          <span className="block text-xs text-muted mt-0.5">
            Nicht vorausgewählt – Sie entscheiden durch aktives Anklicken.
          </span>
        )}
        {hint && <span className="block text-xs text-muted mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

export function ConsentFields({
  initial,
  onChange,
  options,
  mode = 'staff',
}: {
  initial?: ConsentSelections;
  /** Optional: meldet jede Änderung nach oben (Wizard hält State ohne <form>). */
  onChange?: (c: ConsentSelections) => void;
  /** Serverseitig aufgelöster, tenant-spezifischer Optionskatalog. */
  options?: ResolvedConsentOption[];
  /**
   * Im Portal werden ausschließlich Kanzlei-Optionen ausgewählt. Freitexte,
   * konkrete Empfänger und Spezialdienstleister bleiben der Kanzlei-Erfassung
   * vorbehalten und werden zusätzlich serverseitig abgewiesen.
   */
  mode?: 'staff' | 'catalog-only';
}) {
  const configuredOptions: ResolvedConsentOption[] =
    options ??
    defaultConsentOptionsCatalog().options.map((option) => ({
      ...option,
      serviceProvider: null,
      providerMissing: false,
    }));
  const [c, setInner] = useState<ConsentSelections>(initial ?? consentForNewDeclaration());
  // Jeder Bedienhandler erzeugt genau eine Änderung. Den Parent außerhalb
  // eines React-State-Updaters informieren, damit StrictMode sie nicht wiederholt.
  const setC = (updater: ConsentSelections | ((s: ConsentSelections) => ConsentSelections)) => {
    const next = typeof updater === 'function' ? updater(c) : updater;
    setInner(next);
    onChange?.(next);
  };

  const configuredIds = new Set(configuredOptions.map((option) => option.id));
  // Historische eigene Optionen bleiben selbst dann abwählbar, wenn ein alter
  // oder manuell beschädigter Katalog sie nicht mehr enthält. Speichern mit
  // weiterhin gesetzter unbekannter/inaktiver ID wird serverseitig abgewiesen.
  const historicalOptions: ResolvedConsentOption[] = c.optionSelections
    .filter(
      (selection) =>
        !isBuiltinConsentOptionId(selection.optionId) && !configuredIds.has(selection.optionId),
    )
    .map((selection, index) => ({
      id: selection.optionId,
      builtin: false,
      section: selection.section,
      label: selection.labelSnapshot,
      description:
        selection.descriptionSnapshot ??
        'Historische Option – im aktuellen Kanzlei-Katalog nicht mehr vorhanden.',
      active: false,
      required: selection.requiredSnapshot,
      recommended: selection.recommendedSnapshot,
      sortOrder: 100_000 + index,
      serviceProviderId: selection.serviceProviderSnapshot?.id ?? null,
      serviceProvider: selection.serviceProviderSnapshot,
      providerMissing: false,
    }));
  const allOptions = [...configuredOptions, ...historicalOptions];

  function isSelected(option: ResolvedConsentOption): boolean {
    if (isBuiltinConsentOptionId(option.id)) return isBuiltinConsentSelected(c, option.id);
    return c.optionSelections.some((selection) => selection.optionId === option.id);
  }

  function optionHint(option: ResolvedConsentOption): string | null {
    const parts = [option.description];
    if (option.serviceProvider) {
      const from = fmtIsoDate(option.serviceProvider.contractFromDate);
      const to = fmtIsoDate(option.serviceProvider.contractToDate);
      const contract = from
        ? `Vertrag ab ${from}${to ? ` bis ${to}` : ''}`
        : to
          ? `Vertrag bis ${to}`
          : 'AVV-/Vertragszeitraum nicht hinterlegt';
      parts.push(
        `Verknüpfter Dienstleister: ${option.serviceProvider.name} · Datenzugriff: ${option.serviceProvider.hasDataAccess === null ? 'nicht dokumentiert' : option.serviceProvider.hasDataAccess ? 'ja' : 'nein'} · ${contract}`,
      );
    } else if (option.providerMissing) {
      parts.push('Der verknüpfte Dienstleister ist nicht mehr verfügbar.');
    }
    if (!option.active) {
      parts.push('Nicht mehr angeboten; vor einem neuen Snapshot bitte abwählen.');
    }
    return parts.filter((part): part is string => Boolean(part)).join(' · ') || null;
  }

  function setOption(option: ResolvedConsentOption, selected: boolean) {
    setC((state) => {
      let next = state;
      if (isBuiltinConsentOptionId(option.id)) {
        next = setBuiltinConsentSelected(next, option.id, selected);
      }
      const without = next.optionSelections.filter((selection) => selection.optionId !== option.id);
      return {
        ...next,
        optionSelections: selected
          ? [
              ...without,
              {
                optionId: option.id,
                labelSnapshot: option.label,
                descriptionSnapshot: option.description,
                section: option.section,
                requiredSnapshot: option.required,
                recommendedSnapshot: option.recommended,
                serviceProviderSnapshot: option.serviceProvider,
              },
            ]
          : without,
      };
    });
  }

  const visibleOptions = allOptions.filter((option) => option.active || isSelected(option));
  const commOptions = visibleOptions.filter((option) => option.section === 'COMMUNICATION');
  const marketingOptions = visibleOptions.filter((option) => option.section === 'MARKETING');
  const otherOptions = visibleOptions.filter((option) => option.section === 'OTHER');

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

      {commOptions.length > 0 && (
        <fieldset>
          <legend className="text-sm font-semibold text-primary mb-1">
            1. Elektronische Kommunikation
          </legend>
          <p className="text-xs text-muted mb-2">
            Über welche Kanäle darf die Kanzlei mandatsbezogen kommunizieren und Unterlagen
            bereitstellen/entgegennehmen?
          </p>
          {commOptions.map((option) => (
            <Check
              key={option.id}
              checked={isSelected(option)}
              onChange={(selected) => setOption(option, selected)}
              label={option.label}
              hint={optionHint(option)}
              required={mode === 'catalog-only' && option.required}
              recommended={option.recommended}
            />
          ))}
          {mode === 'staff' && (
            <input
              type="text"
              value={c.communication.details}
              onChange={(e) =>
                setC((s) => ({
                  ...s,
                  communication: { ...s.communication, details: e.target.value },
                }))
              }
              placeholder="Details (Portal-Name, E-Mail-Adressen, Faxnummer, Video-System …)"
              maxLength={1000}
              className="input w-full mt-2 text-sm"
            />
          )}
        </fieldset>
      )}

      {marketingOptions.length > 0 && (
        <fieldset>
          <legend className="text-sm font-semibold text-primary mb-1">
            2. Informationen außerhalb des Mandats / Kanzleimarketing
          </legend>
          <p className="text-xs text-muted mb-2">
            Freiwillig, jederzeit widerrufbar — betrifft Newsletter/Veranstaltungen über das
            konkrete Mandat hinaus.
          </p>
          {marketingOptions.map((option) => (
            <Check
              key={option.id}
              checked={isSelected(option)}
              onChange={(selected) => setOption(option, selected)}
              label={option.label}
              hint={optionHint(option)}
              required={mode === 'catalog-only' && option.required}
              recommended={option.recommended}
            />
          ))}
          {mode === 'staff' && (
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
          )}
        </fieldset>
      )}

      {otherOptions.length > 0 && (
        <fieldset>
          <legend className="text-sm font-semibold text-primary mb-1">
            3. Weitere Datenschutz-Optionen
          </legend>
          <p className="text-xs text-muted mb-2">
            Kanzleispezifische Optionen. Pflichtfelder müssen rechtlich notwendige Bestätigungen
            oder eine anderweitig zulässige Pflichtauswahl abbilden.
          </p>
          {otherOptions.map((option) => (
            <Check
              key={option.id}
              checked={isSelected(option)}
              onChange={(selected) => setOption(option, selected)}
              label={option.label}
              hint={optionHint(option)}
              required={mode === 'catalog-only' && option.required}
              recommended={option.recommended}
            />
          ))}
        </fieldset>
      )}

      {mode === 'staff' && (
        <fieldset>
          <legend className="text-sm font-semibold text-primary mb-1">
            {otherOptions.length > 0 ? '4.' : '3.'} Übermittlung an konkret benannte Dritte
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
      )}

      {mode === 'staff' && (
        <fieldset>
          <legend className="text-sm font-semibold text-primary mb-1">
            {otherOptions.length > 0 ? '5.' : '4.'} Mandatsbezogene Spezialdienstleister
          </legend>
          <p className="text-xs text-muted mb-2">
            Externe Spezialisten mit Zugang zu Berufsgeheimnissen — nur mit Einwilligung. Ohne
            Eintrag erfolgt keine Einwilligung.
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
      )}
    </div>
  );
}
