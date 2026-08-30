import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { REGION_LABELS } from '@taxtronik/tax';
import { createNoticeAction } from '../actions';

const KIND_OPTIONS: Array<[string, string]> = [
  ['USTA', 'USt-Voranmeldung'],
  ['UST_JAHR', 'USt-Jahresbescheid'],
  ['EST', 'Einkommensteuer'],
  ['KST', 'Körperschaftsteuer'],
  ['GEWST_MESSBESCHEID', 'GewSt-Messbescheid'],
  ['GEWST', 'GewSt-Bescheid (Gemeinde)'],
  ['LSTA', 'LSt-Anmeldung'],
  ['FESTSTELLUNG', 'Feststellungsbescheid'],
  ['ZERLEGUNG', 'Zerlegungsbescheid'],
  ['SONSTIGE', 'Sonstige'],
];

export default async function NewNoticePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireStaffPage();
  const { id: clientId } = await params;
  const { tenantId, staffId } = session.user;

  const client = await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, (tx) =>
    tx.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } }),
  );
  if (!client) notFound();

  return (
    <div className="p-8 max-w-4xl">
      <Link href={`/staff/clients/${clientId}/notices`} className="back-link">
        <ArrowLeft className="h-4 w-4" /> Zurück
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary mb-1">Bescheid erfassen</h1>
        <p className="text-muted text-sm">{client.name}</p>
      </div>

      <form action={createNoticeAction} className="card p-6 space-y-4">
        <input type="hidden" name="clientId" value={clientId} />

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-sm" htmlFor="notice-kind">
              Bescheid-Art *
            </label>
            <select id="notice-kind" name="kind" required className="input w-full">
              {KIND_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label-sm" htmlFor="notice-period">
              Periode *{' '}
              <span className="text-disabled font-normal">
                (z. B. 2025 oder 2025-Q3 oder 2025-09)
              </span>
            </label>
            <input
              id="notice-period"
              name="period"
              required
              maxLength={20}
              className="input w-full"
              placeholder="2025"
            />
          </div>
        </div>

        <fieldset className="rounded-md border border-border-subtle p-4 space-y-3">
          <legend className="px-1 text-sm font-medium text-primary">
            Ausgangsdatum und Nachweis
          </legend>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label-sm" htmlFor="notice-date">
                Datum *
              </label>
              <input
                id="notice-date"
                type="date"
                name="noticeDate"
                required
                className="input w-full"
              />
            </div>
            <div>
              <label className="label-sm" htmlFor="notice-date-basis">
                Bedeutung des Datums *
              </label>
              <select
                id="notice-date-basis"
                name="dateBasis"
                required
                className="input w-full"
                defaultValue=""
              >
                <option value="" disabled>
                  Bitte auswählen
                </option>
                <option value="DISPATCH_DATE">Postaufgabe / elektronische Absendung</option>
                <option value="PROVISION_DATE">Bereitstellung zum Datenabruf</option>
                <option value="ACTUAL_ACCESS_DETERMINED">
                  Fachlich festgestellter tatsächlicher Zugang
                </option>
                <option value="DOCUMENT_DATE_RISK_ONLY">
                  Nur Bescheiddatum (interner Risikotermin)
                </option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label-sm" htmlFor="notice-delivery-evidence-status">
                Nachweisstatus des Datums *
              </label>
              <select
                id="notice-delivery-evidence-status"
                name="deliveryEvidenceStatus"
                required
                className="input w-full"
                defaultValue="CLAIMED"
              >
                <option value="CLAIMED">nur angegeben</option>
                <option value="SUBSTANTIATED">durch Unterlagen/Technik belegt</option>
                <option value="PROFESSIONALLY_DETERMINED">fachlich festgestellt</option>
              </select>
            </div>
            <div>
              <label className="label-sm" htmlFor="notice-delivery-evidence-note">
                Nachweis / Fundstelle
              </label>
              <input
                id="notice-delivery-evidence-note"
                name="deliveryEvidenceNote"
                maxLength={2000}
                className="input w-full"
                placeholder="z. B. Postaufgabevermerk oder ELSTER-Protokoll"
              />
            </div>
          </div>
          <p className="text-xs text-muted">
            Ein Bescheiddatum ersetzt keinen unbekannten Aufgabe- oder Absendungstag. In diesem Fall
            wird nur ein sichtbar getrennter interner Risikotermin gespeichert. Bei „fachlich
            festgestellter tatsächlicher Zugang“ müssen dieses Datum und der unten dokumentierte
            Zugangstag übereinstimmen.
          </p>
        </fieldset>

        <div>
          <label className="label-sm" htmlFor="notice-file-number">
            Aktenzeichen FA
          </label>
          <input
            id="notice-file-number"
            name="fileNumber"
            maxLength={100}
            className="input w-full"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-sm" htmlFor="notice-delivery-method">
              Bekanntgabeweg *
            </label>
            <select
              id="notice-delivery-method"
              name="deliveryMethod"
              required
              className="input w-full"
              defaultValue="POST"
            >
              <option value="POST">Post (§ 122 Abs. 2 AO)</option>
              <option value="POST_ABROAD">Post ins Ausland (§ 122 Abs. 2 Nr. 2 AO)</option>
              <option value="ELECTRONIC">Elektronisch übermittelt (§ 122 Abs. 2a AO)</option>
              <option value="DATA_RETRIEVAL">Zum Datenabruf bereitgestellt (§ 122a AO)</option>
              <option value="FORMAL">Förmliche Zustellung</option>
              <option value="PERSONAL">Persönliche Übergabe</option>
              <option value="OTHER">Sonstiger nachgewiesener Zugang</option>
            </select>
          </div>
          <div>
            <label className="label-sm" htmlFor="notice-legal-remedy-instruction">
              Rechtsbehelfsbelehrung *
            </label>
            <select
              id="notice-legal-remedy-instruction"
              name="legalRemedyInstruction"
              required
              className="input w-full"
              defaultValue="UNKLAR"
            >
              <option value="WIRKSAM">wirksam geprüft</option>
              <option value="UNWIRKSAM">fehlt oder ist unwirksam</option>
              <option value="UNKLAR">unklar — Berufsträgerprüfung erforderlich</option>
            </select>
          </div>
        </div>
        <div>
          <label className="label-sm" htmlFor="notice-legal-remedy-instruction-note">
            Begründung der Belehrungsprüfung *
          </label>
          <textarea
            id="notice-legal-remedy-instruction-note"
            name="legalRemedyInstructionNote"
            required
            minLength={3}
            maxLength={2000}
            rows={2}
            className="input w-full"
            placeholder="Pflichtbestandteile, Auffälligkeiten oder Grund für den offenen Prüffall"
          />
        </div>

        <HolidayLocationFields
          prefix="recipient"
          title="Empfängerort der Bekanntgabefiktion"
          defaultName={client.name}
        />
        <HolidayLocationFields
          prefix="authority"
          title="Sitz der zuständigen Finanzbehörde für das Fristende"
        />
        <div>
          <label className="label-sm" htmlFor="notice-holiday-context-note">
            Kalenderquelle / Prüfnachweis *
          </label>
          <textarea
            id="notice-holiday-context-note"
            name="holidayContextNote"
            required
            minLength={3}
            rows={2}
            maxLength={2000}
            className="input w-full"
            placeholder="z. B. geprüfte Behördenquelle, Stand und Umfang der örtlichen Prüfung"
          />
          <p className="text-xs text-muted mt-1">
            Dokumentieren Sie Quelle und Prüfstand auch bei einem bestätigten Kalender. Der Nachweis
            gehört zur reproduzierbaren Berechnungsgrundlage.
          </p>
        </div>

        <fieldset className="rounded-md border border-border-subtle p-4 space-y-3">
          <legend className="px-1 text-sm font-medium text-primary">Datenabruf (§ 122a AO)</legend>
          <p className="text-xs text-muted">
            Nur beim Bekanntgabeweg „Datenabruf“ ausfüllen. Das Erlassdatum wählt das Regime;
            Bereitstellung, Benachrichtigung, Einwilligung und Postantrag bleiben getrennte
            Tatsachen.
          </p>
          <div>
            <label className="label-sm" htmlFor="notice-retrieval-issued-at">
              Erlass-/Bescheiddatum
            </label>
            <input
              id="notice-retrieval-issued-at"
              type="date"
              name="retrievalIssuedAt"
              className="input w-full"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label-sm" htmlFor="notice-retrieval-consent-status">
                Einwilligung im Jahr 2026
              </label>
              <select
                id="notice-retrieval-consent-status"
                name="retrievalConsentStatus"
                defaultValue="NOT_APPLICABLE"
                className="input w-full"
              >
                <option value="NOT_APPLICABLE">nicht anwendbar</option>
                <option value="CONFIRMED">aktiv erteilt und nachgewiesen</option>
                <option value="NOT_GIVEN">nicht erteilt</option>
                <option value="UNKNOWN">unbekannt</option>
              </select>
            </div>
            <div>
              <label className="label-sm" htmlFor="notice-retrieval-eligibility-2027-status">
                Voraussetzungen ab 2027
              </label>
              <select
                id="notice-retrieval-eligibility-2027-status"
                name="retrievalEligibility2027Status"
                defaultValue="NOT_APPLICABLE"
                className="input w-full"
              >
                <option value="NOT_APPLICABLE">nicht anwendbar</option>
                <option value="CONFIRMED">Voraussetzungen bestätigt</option>
                <option value="NOT_MET">nicht erfüllt</option>
                <option value="UNKNOWN">unbekannt</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label-sm" htmlFor="notice-retrieval-postal-request-status">
                Postantrag / Widerruf ab 2027
              </label>
              <select
                id="notice-retrieval-postal-request-status"
                name="retrievalPostalRequestStatus"
                defaultValue="NOT_APPLICABLE"
                className="input w-full"
              >
                <option value="NOT_APPLICABLE">nicht anwendbar</option>
                <option value="NONE_EFFECTIVE">kein wirksamer Antrag</option>
                <option value="EFFECTIVE">wirksamer Antrag liegt vor</option>
                <option value="UNKNOWN">unbekannt</option>
              </select>
            </div>
            <div>
              <label className="label-sm" htmlFor="notice-retrieval-postal-request-received-at">
                Postantrag bei Behörde eingegangen am
              </label>
              <input
                id="notice-retrieval-postal-request-received-at"
                type="date"
                name="retrievalPostalRequestReceivedAt"
                className="input w-full"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label-sm" htmlFor="notice-retrieval-notification-status">
                Benachrichtigungsstatus
              </label>
              <select
                id="notice-retrieval-notification-status"
                name="retrievalNotificationStatus"
                defaultValue="NOT_RECORDED"
                className="input w-full"
              >
                <option value="NOT_RECORDED">nicht erfasst</option>
                <option value="SENT">versandt</option>
                <option value="FAILED">technisch fehlgeschlagen</option>
                <option value="UNKNOWN">Ergebnis unbekannt</option>
              </select>
            </div>
            <div>
              <label className="label-sm" htmlFor="notice-retrieval-notification-date">
                Benachrichtigung versandt am
              </label>
              <input
                id="notice-retrieval-notification-date"
                type="date"
                name="retrievalNotificationDate"
                className="input w-full"
              />
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm text-secondary">
            <input type="checkbox" name="retrievalNotificationDisputedOrLate" className="mt-0.5" />
            <span>
              Altrecht: Zugang der Benachrichtigung bestritten oder erst verspätet erfolgt
            </span>
          </label>
          <div>
            <label className="label-sm" htmlFor="notice-retrieved-at">
              Tatsächlich abgerufen am
            </label>
            <input
              id="notice-retrieved-at"
              type="date"
              name="retrievedAt"
              className="input w-full"
            />
            <p className="text-xs text-muted mt-1">
              Der Abruf ist grundsätzlich Kontrollinformation. Nur im markierten altrechtlichen
              Ausnahmefall kann er fristauslösend sein.
            </p>
          </div>
          <p className="text-xs text-muted">
            Ein Benachrichtigungsfehler verändert den Vier-Tage-Fiktionstag nicht automatisch. Er
            wird separat als Pflichtabweichung und manueller §-110-Prüffall gespeichert.
          </p>
        </fieldset>

        <fieldset className="rounded-md border border-border-subtle p-4 space-y-3">
          <legend className="px-1 text-sm font-medium text-primary">
            Tatsächlicher Zugang und Einwendungen
          </legend>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label-sm" htmlFor="notice-access-status">
                Zugangslage *
              </label>
              <select
                id="notice-access-status"
                name="accessStatus"
                required
                defaultValue="UNCONTESTED"
                className="input w-full"
              >
                <option value="UNCONTESTED">keine Abweichung vorgetragen</option>
                <option value="NOT_RECEIVED_DISPUTED">Zugang vollständig bestritten</option>
                <option value="EARLIER_RECEIPT_RECORDED">
                  früherer tatsächlicher Eingang dokumentiert (Fiktion bleibt maßgeblich)
                </option>
                <option value="LATER_RECEIPT_CLAIMED">späterer Zugang behauptet</option>
                <option value="LATER_RECEIPT_DETERMINED">
                  späterer Zugang fachlich festgestellt
                </option>
              </select>
            </div>
            <div>
              <label className="label-sm" htmlFor="notice-received-at">
                Zugangstag
              </label>
              <input
                id="notice-received-at"
                type="date"
                name="receivedAt"
                className="input w-full"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label-sm" htmlFor="notice-access-evidence-status">
                Nachweisstatus des Zugangs
              </label>
              <select
                id="notice-access-evidence-status"
                name="accessEvidenceStatus"
                defaultValue=""
                className="input w-full"
              >
                <option value="">nicht anwendbar</option>
                <option value="CLAIMED">nur angegeben</option>
                <option value="SUBSTANTIATED">durch Unterlagen belegt</option>
                <option value="PROFESSIONALLY_DETERMINED">fachlich festgestellt</option>
              </select>
            </div>
            <div>
              <label className="label-sm" htmlFor="notice-access-evidence-note">
                Zugangsnachweis / Würdigung
              </label>
              <input
                id="notice-access-evidence-note"
                name="accessEvidenceNote"
                maxLength={2000}
                className="input w-full"
                placeholder="z. B. Posteingangsbuch, Umschlag, dokumentierte Würdigung"
              />
            </div>
          </div>
          <p className="text-xs text-muted">
            Ein behaupteter späterer Zugang öffnet einen manuellen Prüffall. Er wird erst nach
            dokumentierter fachlicher Feststellung als Rechtsdatum verwendet. Beim Datenabruf
            bleiben diese allgemeinen Felder unverändert; Benachrichtigung, Streitfall und Abruf
            werden ausschließlich im §-122a-Bereich darüber dokumentiert.
          </p>
        </fieldset>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-sm" htmlFor="notice-assessed-amount">
              Festgesetzt (EUR)
            </label>
            <input
              id="notice-assessed-amount"
              type="number"
              step="0.01"
              name="assessedAmount"
              className="input w-full"
            />
          </div>
          <div>
            <label className="label-sm" htmlFor="notice-expected-amount">
              Erwartet/Geschätzt (EUR){' '}
              <span className="text-disabled font-normal">— für Soll/Ist-Vergleich</span>
            </label>
            <input
              id="notice-expected-amount"
              type="number"
              step="0.01"
              name="expectedAmount"
              className="input w-full"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-sm" htmlFor="notice-prepaid-amount">
              Vorausgezahlt (EUR)
            </label>
            <input
              id="notice-prepaid-amount"
              type="number"
              step="0.01"
              name="prepaidAmount"
              className="input w-full"
            />
          </div>
          <div>
            <label className="label-sm" htmlFor="notice-pay-amount">
              Ergebnis (EUR){' '}
              <span className="text-disabled font-normal">
                — positiv = Nachzahlung, negativ = Erstattung
              </span>
            </label>
            <input
              id="notice-pay-amount"
              type="number"
              step="0.01"
              name="payAmount"
              className="input w-full"
            />
          </div>
        </div>

        <div>
          <label className="label-sm" htmlFor="notice-review-notes">
            Notizen / Anmerkungen
          </label>
          <textarea id="notice-review-notes" name="reviewNotes" rows={3} className="input w-full" />
        </div>

        <div className="flex justify-end gap-2">
          <Link href={`/staff/clients/${clientId}/notices`} className="btn-secondary">
            Abbrechen
          </Link>
          <button type="submit" className="btn-primary">
            Bescheid speichern
          </button>
        </div>
      </form>
    </div>
  );
}

function HolidayLocationFields({
  prefix,
  title,
  defaultName = '',
}: {
  prefix: 'recipient' | 'authority';
  title: string;
  defaultName?: string;
}) {
  return (
    <fieldset className="rounded-md border border-border-subtle p-4 space-y-3">
      <legend className="px-1 text-sm font-medium text-primary">{title}</legend>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label-sm" htmlFor={`notice-${prefix}-name`}>
            Empfänger / Behörde *
          </label>
          <input
            id={`notice-${prefix}-name`}
            name={prefix + 'Name'}
            defaultValue={defaultName}
            required
            maxLength={200}
            className="input w-full"
          />
        </div>
        <div>
          <label className="label-sm" htmlFor={`notice-${prefix}-country-code`}>
            Staat (ISO-2) *
          </label>
          <input
            id={`notice-${prefix}-country-code`}
            name={prefix + 'CountryCode'}
            defaultValue="DE"
            required
            minLength={2}
            maxLength={2}
            pattern="[A-Z]{2}"
            className="input w-full uppercase"
          />
        </div>
      </div>
      <div>
        <label className="label-sm" htmlFor={`notice-${prefix}-local-holiday-dates`}>
          Zusätzliche örtliche Feiertage
        </label>
        <input
          id={`notice-${prefix}-local-holiday-dates`}
          name={prefix + 'LocalHolidayDates'}
          maxLength={1000}
          className="input w-full"
          placeholder="2026-08-08, 2026-08-17"
          aria-describedby={`notice-${prefix}-local-holiday-dates-hint`}
        />
        <p id={`notice-${prefix}-local-holiday-dates-hint`} className="text-xs text-muted mt-1">
          Nur gesetzliche Feiertage ergänzen, die für diesen konkreten Ort gelten und nicht bereits
          im Bundeslandkalender enthalten sind; Format JJJJ-MM-TT, getrennt durch Komma oder
          Leerzeichen.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label-sm" htmlFor={`notice-${prefix}-region`}>
            Bundesland
          </label>
          <select
            id={`notice-${prefix}-region`}
            name={prefix + 'Region'}
            defaultValue=""
            className="input w-full"
          >
            <option value="">Unbekannt / nicht deutsch</option>
            {Object.entries(REGION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label-sm" htmlFor={`notice-${prefix}-locality`}>
            Ort / Gemeinde (bei bestätigtem Kalender Pflicht)
          </label>
          <input
            id={`notice-${prefix}-locality`}
            name={prefix + 'Locality'}
            maxLength={200}
            className="input w-full"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label-sm" htmlFor={`notice-${prefix}-holiday-context-status`}>
            Kalenderstand *
          </label>
          <select
            id={`notice-${prefix}-holiday-context-status`}
            name={prefix + 'HolidayContextStatus'}
            required
            defaultValue="UNKNOWN"
            className="input w-full"
          >
            <option value="CONFIRMED_FOR_DATE_AND_LOCATION">
              für Datum und konkreten Ort bestätigt
            </option>
            <option value="STATE_LEVEL_ONLY">nur Bundeslandkalender geprüft</option>
            <option value="HISTORICAL_UNVERIFIED">historischer Stand ungeprüft</option>
            <option value="FOREIGN_UNSUPPORTED">ausländischer Kalender nicht unterstützt</option>
            <option value="UNKNOWN">unklar — manuell prüfen</option>
          </select>
        </div>
        <div>
          <label className="label-sm" htmlFor={`notice-${prefix}-bavaria-assumption`}>
            Mariä Himmelfahrt in Bayern *
          </label>
          <select
            id={`notice-${prefix}-bavaria-assumption`}
            name={prefix + 'BavariaAssumption'}
            required
            defaultValue="UNKNOWN"
            className="input w-full"
          >
            <option value="UNKNOWN">nicht geklärt / nicht relevant</option>
            <option value="YES">am Ort gesetzlicher Feiertag</option>
            <option value="NO">am Ort kein gesetzlicher Feiertag</option>
          </select>
        </div>
      </div>
      <p className="text-xs text-muted">
        Beide Orte werden getrennt gespeichert. Der Kanzleisitz wird nicht stillschweigend als
        Empfänger- oder Behördenort übernommen. „Für Datum und konkreten Ort bestätigt“ darf nur
        gewählt werden, wenn Ort, örtliche Feiertage und gegebenenfalls die bayerische
        Gemeindeannahme tatsächlich geprüft wurden.
      </p>
    </fieldset>
  );
}
