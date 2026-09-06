'use client';

import { useActionState } from 'react';
import { saveModulesAction, type ActionResult } from './actions';
import type { ModuleConfig } from '@/server/settings/modules';
import { EXPANSION_MODULES } from '@/lib/expansion-modules';

const MODULES: Array<{ key: keyof ModuleConfig; label: string; description: string }> = [
  ...EXPANSION_MODULES,
  { key: 'bwa', label: 'BWA & Auswertungen', description: 'Mandanten-BWA-Importe und KPI-Reports' },
  {
    key: 'knowledge',
    label: 'Wissensdatenbank',
    description: 'Interne Knowledge-Base mit Volltext-Suche',
  },
  {
    key: 'timeTracking',
    label: 'Zeiterfassung',
    description: 'Mitarbeiter-Zeiten + Time-to-Invoice',
  },
  {
    key: 'phoneNotes',
    label: 'Telefonzettel',
    description: 'Telefonnotiz-Workflow inkl. Übertragen / → Wiedervorlage',
  },
  {
    key: 'taxNotices',
    label: 'Steuertermine & Bescheide',
    description: 'Termin-Kalender und Bescheid-Postfach',
  },
  {
    key: 'workflows',
    label: 'Workflows',
    description: 'Wiederkehrende Prozesse als Checklisten-Vorlagen mit Schritten',
  },
  {
    key: 'forms',
    label: 'Formulare',
    description: 'Eigene Anfrage-Formulare an Mandanten (Formular-Builder)',
  },
  {
    key: 'reminders',
    label: 'Wiedervorlagen',
    description: 'Pro Mandant Datum + Stichwort hinterlegen, Erinnerung im Dashboard',
  },
  {
    key: 'binders',
    label: 'Pendelordner',
    description: 'Physische Belege-Ordner verfolgen (Kanzlei → Mandant → zurück)',
  },
  {
    key: 'handovers',
    label: 'Anlieferungen',
    description: 'Vom Mandanten gebrachte Unterlagen tracken (Eingang → bearbeiten → abholbereit)',
  },
  {
    key: 'appointments',
    label: 'Termine (Kanzleikalender)',
    description: 'Termine im Kanzleikalender + Mandanten-Anfragen im Portal',
  },
  {
    key: 'rssReader',
    label: 'RSS-Reader',
    description: 'Dashboard-Widget mit eigenen RSS-Feeds (BMF, BFH, weitere)',
  },
  {
    key: 'inboundMail',
    label: 'E-Mail-Antworten (Inbound)',
    description:
      'Mandanten-Antworten per E-Mail landen automatisch als Anforderungs-Antwort (erfordert n8n-Inbound-Strecke)',
  },
  {
    key: 'risk',
    label: 'Subsumtion / TCMS',
    description:
      'Subsumtions-Workspace: Sachverhalt analysieren, markieren, entscheiden, delegieren (erfordert die deployte Risk-Engine)',
  },
  {
    key: 'signalEngine',
    label: 'Signal-Engine',
    description:
      'Netzinterne Engine für externe Signale (Rechtsänderungen, Fristen, Anomalien). Zeigt Status unter Einstellungen → Integrationen (erfordert die deployte Signal-Engine)',
  },
];

const POA_MODES: Array<{
  value: 'OFF' | 'MARKDOWN_OTP' | 'PDF_TEMPLATE';
  label: string;
  description: string;
}> = [
  { value: 'OFF', label: 'Aus', description: 'Vollmachten-Modul deaktiviert.' },
  {
    value: 'MARKDOWN_OTP',
    label: 'In-App (Markdown + OTP-Signatur)',
    description: 'Vollmachts-Text in der App, Mandant signiert per E-Mail-OTP.',
  },
  {
    value: 'PDF_TEMPLATE',
    label: 'PDF-Template (extern)',
    description: 'Standardtext-Mail mit PDF-Anhang. Externe Vollmachtsdatenbank.',
  },
];

const INVOICE_MODES: Array<{
  value: 'OFF' | 'IN_APP' | 'EXTERNAL';
  label: string;
  description: string;
}> = [
  {
    value: 'OFF',
    label: 'Aus',
    description:
      'Rechnungs-Modul deaktiviert (z. B. Partnerschaft mit zentraler DATEV-Abrechnung).',
  },
  {
    value: 'IN_APP',
    label: 'In-App (Erstellung + XRechnung/ZUGFeRD)',
    description: 'Vollständige Rechnungserstellung in taxtronik.',
  },
  {
    value: 'EXTERNAL',
    label: 'PDF-Template (extern)',
    description: 'Erstellung extern, taxtronik versendet nur eine Standard-Mail mit PDF-Anhang.',
  },
];

export function ModulesForm({ initial }: { initial: ModuleConfig }) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    saveModulesAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-5">
      <div className="space-y-3">
        {MODULES.map((m) => (
          <label
            key={m.key}
            className="flex items-start gap-3"
            htmlFor={`module-${m.key}`}
            aria-label={m.label}
          >
            <input
              id={`module-${m.key}`}
              type="checkbox"
              name={`enabled.${m.key}`}
              defaultChecked={initial[m.key] as boolean}
              className="switch mt-1"
            />
            <span>
              <span className="block text-sm font-medium text-primary">{m.label}</span>
              <span className="block text-xs text-muted">{m.description}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="border-t border-default pt-5">
        <label
          className="flex items-start gap-3"
          htmlFor="subsumtion-floating-toolbar-default"
          aria-label="Schwebende Formatierleiste im Subsumtions-Editor"
        >
          <input
            id="subsumtion-floating-toolbar-default"
            type="checkbox"
            name="subsumtionFloatingToolbarDefault"
            defaultChecked={initial.subsumtionFloatingToolbarDefault}
            className="switch mt-1"
          />
          <span>
            <span className="block text-sm font-medium text-primary">
              Schwebende Formatierleiste im Subsumtions-Editor
            </span>
            <span className="block text-xs text-muted">
              Legt den Kanzlei-Standard fest. Die feste Leiste bleibt immer sichtbar; die
              zusätzliche Leiste an einer Textauswahl kann im Editor jederzeit ein- oder
              ausgeschaltet werden.
            </span>
          </span>
        </label>
      </div>

      <fieldset className="border-t border-default pt-5">
        <legend className="block text-sm font-medium text-primary mb-1">Vollmachten-Modus</legend>
        <p className="text-xs text-muted mb-3">
          Welcher Workflow soll für Vollmachten verwendet werden?
        </p>
        <div className="space-y-2">
          {POA_MODES.map((m) => (
            <label
              key={m.value}
              className="flex items-start gap-3"
              htmlFor={`poa-mode-${m.value}`}
              aria-label={m.label}
            >
              <input
                id={`poa-mode-${m.value}`}
                type="radio"
                name="poaMode"
                value={m.value}
                defaultChecked={initial.poaMode === m.value}
                className="mt-1 text-brand-600"
              />
              <span>
                <span className="block text-sm font-medium text-primary">{m.label}</span>
                <span className="block text-xs text-muted">{m.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="border-t border-default pt-5">
        <p className="block text-sm font-medium text-primary mb-1">
          Vollmachten-PDF-Begleittext{' '}
          <span className="text-xs font-normal text-muted">(nur bei „PDF-Template")</span>
        </p>
        <label className="sr-only" htmlFor="poa-pdf-subject">
          Betreff des Vollmachten-PDF-Begleittexts
        </label>
        <input
          id="poa-pdf-subject"
          name="poaPdfSubject"
          type="text"
          maxLength={200}
          placeholder="Vollmacht zur Unterzeichnung"
          defaultValue={initial.poaPdfTemplate?.subject ?? 'Vollmacht zur Unterzeichnung'}
          className="input mb-2"
        />
        <label className="sr-only" htmlFor="poa-pdf-body">
          Nachricht des Vollmachten-PDF-Begleittexts
        </label>
        <textarea
          id="poa-pdf-body"
          name="poaPdfBodyMd"
          rows={5}
          maxLength={5000}
          placeholder="Sehr geehrte/r {name}, …"
          defaultValue={initial.poaPdfTemplate?.bodyMd ?? ''}
          className="input"
        />
        <p className="text-xs text-muted mt-1">
          Markdown. Platzhalter: <code>{'{name}'}</code>, <code>{'{client}'}</code>.
        </p>
      </div>

      <fieldset className="border-t border-default pt-5">
        <legend className="block text-sm font-medium text-primary mb-1">Rechnungs-Modus</legend>
        <p className="text-xs text-muted mb-3">
          Wie sollen Rechnungen verarbeitet werden? Bei zentraler DATEV-Abrechnung oder externer
          Fakturierung „Aus" oder „PDF-Template" wählen.
        </p>
        <div className="space-y-2">
          {INVOICE_MODES.map((m) => (
            <label
              key={m.value}
              className="flex items-start gap-3"
              htmlFor={`invoice-mode-${m.value}`}
              aria-label={m.label}
            >
              <input
                id={`invoice-mode-${m.value}`}
                type="radio"
                name="invoiceMode"
                value={m.value}
                defaultChecked={initial.invoiceMode === m.value}
                className="mt-1 text-brand-600"
              />
              <span>
                <span className="block text-sm font-medium text-primary">{m.label}</span>
                <span className="block text-xs text-muted">{m.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <p className="block text-sm font-medium text-primary mb-1">
          Rechnungs-PDF-Begleittext{' '}
          <span className="text-xs font-normal text-muted">(nur bei „PDF-Template")</span>
        </p>
        <label className="sr-only" htmlFor="invoice-pdf-subject">
          Betreff des Rechnungs-PDF-Begleittexts
        </label>
        <input
          id="invoice-pdf-subject"
          name="invoicePdfSubject"
          type="text"
          maxLength={200}
          placeholder="Ihre Rechnung Nr. {number}"
          defaultValue={initial.invoicePdfTemplate?.subject ?? 'Ihre Rechnung'}
          className="input mb-2"
        />
        <label className="sr-only" htmlFor="invoice-pdf-body">
          Nachricht des Rechnungs-PDF-Begleittexts
        </label>
        <textarea
          id="invoice-pdf-body"
          name="invoicePdfBodyMd"
          rows={5}
          maxLength={5000}
          placeholder="Sehr geehrte/r {name}, anbei Ihre Rechnung Nr. {number}. …"
          defaultValue={initial.invoicePdfTemplate?.bodyMd ?? ''}
          className="input"
        />
        <p className="text-xs text-muted mt-1">
          Markdown. Platzhalter: <code>{'{name}'}</code>, <code>{'{client}'}</code>,{' '}
          <code>{'{number}'}</code>, <code>{'{amount}'}</code>.
        </p>
      </div>

      {state?.error && (
        <div className="alert-error-sm" role="alert">
          {state.error}
        </div>
      )}
      {state?.ok && (
        <div className="alert-success-sm" role="status">
          Module-Konfiguration gespeichert. Wird beim nächsten Pageload sichtbar.
        </div>
      )}

      <button type="submit" className="btn-primary" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Speichern'}
      </button>
    </form>
  );
}
