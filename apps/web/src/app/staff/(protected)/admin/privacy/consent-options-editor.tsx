'use client';

import { useActionState, useState } from 'react';
import { Link2, Plus, Save, Trash2 } from 'lucide-react';
import type { ActionResult } from '@/server/actions/types';
import type {
  ConsentOptionDefinition,
  ConsentOptionSection,
  ResolvedConsentOption,
} from '@/server/privacy/consent';
import { saveConsentOptionsAction } from './actions';

const SECTION_LABELS: Record<ConsentOptionSection, string> = {
  COMMUNICATION: 'Elektronische Kommunikation',
  MARKETING: 'Kanzleimarketing / Informationen',
  OTHER: 'Weitere freiwillige Einwilligungen',
};

interface ProviderOption {
  id: string;
  name: string;
  category: string;
  hasDataAccess: boolean;
  contractFromDate: string | null;
  contractToDate: string | null;
}

function providerAvvLabel(provider: ProviderOption): string {
  if (!provider.hasDataAccess) return 'kein Datenzugriff';
  if (provider.contractFromDate && provider.contractToDate) {
    return `AVV/Vertrag ${provider.contractFromDate} bis ${provider.contractToDate}`;
  }
  if (provider.contractFromDate) return `AVV/Vertrag ab ${provider.contractFromDate}`;
  if (provider.contractToDate) return `AVV/Vertrag bis ${provider.contractToDate}`;
  return 'Datenzugriff · AVV/Vertragszeitraum fehlt';
}

export function ConsentOptionsEditor({
  initial,
  providers,
  repairRequired = false,
  revision,
}: {
  initial: ResolvedConsentOption[];
  providers: ProviderOption[];
  repairRequired?: boolean;
  revision: string;
}) {
  const [options, setOptions] = useState<ConsentOptionDefinition[]>(
    initial.map(({ serviceProvider: _provider, providerMissing: _missing, ...option }) => option),
  );
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    saveConsentOptionsAction,
    null,
  );
  const missingProviderLinks = options.filter(
    (option) =>
      option.serviceProviderId !== null &&
      !providers.some((provider) => provider.id === option.serviceProviderId),
  );

  function patch(id: string, change: Partial<ConsentOptionDefinition>) {
    setOptions((current) =>
      current.map((option) => (option.id === id ? { ...option, ...change } : option)),
    );
  }

  function addCustom() {
    const maxSort = options.reduce((max, option) => Math.max(max, option.sortOrder), 0);
    setOptions((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        builtin: false,
        section: 'OTHER',
        label: '',
        description: null,
        active: true,
        sortOrder: maxSort + 10,
        serviceProviderId: null,
      },
    ]);
  }

  function removeCustom(id: string) {
    // Die Action schreibt bereits persistierte, hier ausgelassene Optionen als
    // inaktiv fort. Ein noch nicht gespeicherter leerer Entwurf verschwindet
    // dagegen vollständig und blockiert nicht die native Formularvalidierung.
    setOptions((current) => current.filter((option) => option.id !== id));
  }

  return (
    <form action={formAction} className="card p-6 space-y-5 mt-8">
      <input type="hidden" name="catalogJson" value={JSON.stringify({ version: 1, options })} />
      <input type="hidden" name="expectedRevision" value={revision} />

      <div>
        <h2 className="text-base font-semibold text-primary">Freiwillige Einwilligungsoptionen</h2>
        <p className="text-sm text-muted mt-1">
          Optionen gelten gemeinsam in der Kanzlei-Erfassung und im öffentlichen GwG-Onboarding.
          Deaktivieren blendet sie für neue Erklärungen aus; bestehende Nachweise bleiben
          unverändert.
        </p>
      </div>

      {repairRequired && (
        <div role="alert" className="alert-error-sm">
          Der gespeicherte Einwilligungskatalog ist beschädigt. Unten wurden sichere
          Standardoptionen geladen. Prüfen Sie die Auswahl und speichern Sie sie, um den Katalog zu
          reparieren; bis dahin bleibt die Einwilligungserfassung gesperrt.
        </div>
      )}

      {missingProviderLinks.length > 0 && (
        <div role="alert" className="alert-error-sm">
          Bei {missingProviderLinks.length === 1 ? 'einer Option ist' : 'mehreren Optionen sind'}{' '}
          der bisher verknüpfte Dienstleister nicht mehr verfügbar. Wählen Sie dort einen neuen
          Dienstleister oder „keiner“, bevor Sie speichern.
        </div>
      )}

      <div className="rounded-md border border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/30 p-3 text-xs text-yellow-900 dark:text-yellow-200">
        <strong>Wichtig:</strong> Eine freiwillige Einwilligung ersetzt keinen erforderlichen
        Auftragsverarbeitungsvertrag nach Art. 28 DSGVO. Die Verknüpfung dokumentiert nur, welcher
        erfasste Dienstleister zu dieser Option gehört.
      </div>

      <div className="space-y-3">
        {options.map((option) => (
          <div
            key={option.id}
            className={`rounded-md border p-4 ${
              option.active ? 'border-default' : 'border-dashed border-strong opacity-75'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  {option.builtin ? (
                    <span className="font-medium text-primary">{option.label}</span>
                  ) : (
                    <input
                      value={option.label}
                      onChange={(event) => patch(option.id, { label: event.target.value })}
                      className="input min-w-[260px] flex-1"
                      placeholder="Bezeichnung der Einwilligung *"
                      maxLength={300}
                      required={option.active}
                    />
                  )}
                  {option.builtin && <span className="badge-gray">Standard</span>}
                  {!option.active && <span className="badge-yellow">deaktiviert</span>}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="label-sm">Bereich</label>
                    {option.builtin ? (
                      <p className="text-sm text-secondary py-2">
                        {SECTION_LABELS[option.section]}
                      </p>
                    ) : (
                      <select
                        value={option.section}
                        onChange={(event) =>
                          patch(option.id, {
                            section: event.target.value as ConsentOptionSection,
                          })
                        }
                        className="input"
                      >
                        {(Object.keys(SECTION_LABELS) as ConsentOptionSection[]).map((section) => (
                          <option key={section} value={section}>
                            {SECTION_LABELS[section]}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div>
                    <label className="label-sm flex items-center gap-1">
                      <Link2 className="h-3.5 w-3.5" /> Dienstleister (optional)
                    </label>
                    <select
                      value={option.serviceProviderId ?? ''}
                      onChange={(event) =>
                        patch(option.id, { serviceProviderId: event.target.value || null })
                      }
                      className="input"
                    >
                      <option value="">— keiner —</option>
                      {option.serviceProviderId !== null &&
                        !providers.some((provider) => provider.id === option.serviceProviderId) && (
                          <option value={option.serviceProviderId}>
                            — nicht verfügbar; bitte Verknüpfung ändern —
                          </option>
                        )}
                      {providers.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name} · {provider.category} · {providerAvvLabel(provider)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {!option.builtin && (
                  <div>
                    <label className="label-sm">Erläuterung (optional)</label>
                    <input
                      value={option.description ?? ''}
                      onChange={(event) =>
                        patch(option.id, { description: event.target.value || null })
                      }
                      className="input"
                      maxLength={1000}
                      placeholder="Kurzer Hinweis, der neben der Checkbox erscheint"
                    />
                  </div>
                )}
              </div>

              <div className="shrink-0">
                {option.builtin ? (
                  <label className="flex items-center gap-2 text-sm text-secondary">
                    <input
                      type="checkbox"
                      checked={option.active}
                      onChange={(event) => patch(option.id, { active: event.target.checked })}
                      className="rounded border-strong text-brand-600"
                    />
                    Aktiv
                  </label>
                ) : option.active ? (
                  <button
                    type="button"
                    onClick={() => removeCustom(option.id)}
                    className="text-disabled hover:text-red-700 p-2"
                    title="Für neue Erklärungen entfernen"
                    aria-label={`${option.label || 'Eigene Option'} entfernen`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => patch(option.id, { active: true })}
                    className="btn-secondary text-xs py-1"
                  >
                    Reaktivieren
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <button type="button" onClick={addCustom} className="btn-secondary">
        <Plus className="h-4 w-4" /> Eigene Option anlegen
      </button>

      {state && !state.ok && state.error && <div className="alert-error-sm">{state.error}</div>}
      {state?.ok && (
        <div className="alert-success-sm">Einwilligungsoptionen wurden gespeichert.</div>
      )}

      <div className="flex justify-end">
        <button type="submit" className="btn-primary" disabled={isPending}>
          <Save className="h-4 w-4" />
          {isPending ? 'Speichert…' : 'Optionen speichern'}
        </button>
      </div>
    </form>
  );
}
