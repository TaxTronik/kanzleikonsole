import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
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
    <div className="p-8 max-w-2xl">
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
            <label className="label-sm">Bescheid-Art *</label>
            <select name="kind" required className="input w-full">
              {KIND_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label-sm">
              Periode *{' '}
              <span className="text-disabled font-normal">
                (z. B. 2025 oder 2025-Q3 oder 2025-09)
              </span>
            </label>
            <input
              name="period"
              required
              maxLength={20}
              className="input w-full"
              placeholder="2025"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-sm">
              Versand / Bereitstellung / hilfsweise Bescheiddatum *
            </label>
            <input type="date" name="noticeDate" required className="input w-full" />
            <p className="text-xs text-muted mt-1">
              Maßgeblich ist der Tag der Aufgabe, elektronischen Absendung oder Bereitstellung. Beim
              Datenabruf ist hier stets der Bereitstellungstag einzutragen. Ist der Tag nicht sicher
              feststellbar, wird konservativ das Bescheiddatum verwendet.
            </p>
          </div>
          <div>
            <label className="label-sm">Aktenzeichen FA</label>
            <input name="fileNumber" maxLength={100} className="input w-full" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-sm">Bekanntgabeweg *</label>
            <select name="deliveryMethod" required className="input w-full" defaultValue="POST">
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
            <label className="label-sm">Rechtsbehelfsbelehrung *</label>
            <select
              name="legalRemedyInstruction"
              required
              className="input w-full"
              defaultValue="VALID"
            >
              <option value="VALID">vorhanden und korrekt</option>
              <option value="MISSING_OR_INVALID">fehlt oder ist unrichtig</option>
            </select>
          </div>
        </div>

        <fieldset className="rounded-md border border-border-subtle p-4 space-y-3">
          <legend className="px-1 text-sm font-medium text-primary">
            Datenabruf (§ 122a Abs. 4 AO)
          </legend>
          <p className="text-xs text-muted">
            Nur bei „Zum Datenabruf bereitgestellt“ ausfüllen. Das Erlassdatum entscheidet über Alt-
            oder Neurecht; der Bereitstellungstag steht oben im ersten Datumsfeld.
          </p>
          <div>
            <label className="label-sm">Erlass-/Bescheiddatum</label>
            <input type="date" name="retrievalIssuedAt" className="input w-full" />
            <p className="text-xs text-muted mt-1">
              Beim Datenabruf Pflicht. Für nach dem 31.12.2025 erlassene Bescheide gilt
              Bereitstellung + 4 Tage.
            </p>
          </div>
          <div>
            <label className="label-sm">Elektronische Benachrichtigung versandt am</label>
            <input type="date" name="retrievalNotificationDate" className="input w-full" />
            <p className="text-xs text-muted mt-1">
              Für bis 31.12.2025 erlassene Bescheide Pflicht; die alte Bekanntgabefiktion beginnt
              mit dieser Benachrichtigung, nicht mit der Bereitstellung.
            </p>
          </div>
          <label className="flex items-start gap-2 text-sm text-secondary">
            <input type="checkbox" name="retrievalNotificationDisputedOrLate" className="mt-0.5" />
            <span>Zugang der Benachrichtigung bestritten oder erst verspätet erfolgt</span>
          </label>
          <div>
            <label className="label-sm">Tatsächlich abgerufen am</label>
            <input type="date" name="retrievedAt" className="input w-full" />
            <p className="text-xs text-muted mt-1">
              Im markierten Ausnahmefall maßgeblich, sobald ein Abruf erfolgt ist. Ohne
              nachgewiesenen Benachrichtigungszugang und ohne Abruf läuft noch keine Frist.
            </p>
          </div>
        </fieldset>

        <div>
          <label className="label-sm">
            Tatsächlich bekanntgegeben / zugegangen am{' '}
            <span className="text-disabled font-normal">(bei Fiktionswegen optional)</span>
          </label>
          <input type="date" name="receivedAt" className="input w-full" />
          <p className="text-xs text-muted mt-1">
            Bei Post im Inland/Ausland oder elektronischer Übermittlung nur ausfüllen, wenn ein{' '}
            <strong>späterer</strong> Zugang als die gesetzliche Fiktion nachweisbar ist. Dieses
            Feld gilt nicht für den Datenabruf. Bei förmlicher, persönlicher oder sonstiger
            Bekanntgabe ist der rechtlich maßgebliche Tag Pflicht. Fehlende/unrichtige Belehrung
            führt grundsätzlich zur Jahresfrist (§ 356 Abs. 2 AO; Ausnahmen prüfen).
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-sm">Festgesetzt (EUR)</label>
            <input type="number" step="0.01" name="assessedAmount" className="input w-full" />
          </div>
          <div>
            <label className="label-sm">
              Erwartet/Geschätzt (EUR){' '}
              <span className="text-disabled font-normal">— für Soll/Ist-Vergleich</span>
            </label>
            <input type="number" step="0.01" name="expectedAmount" className="input w-full" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-sm">Vorausgezahlt (EUR)</label>
            <input type="number" step="0.01" name="prepaidAmount" className="input w-full" />
          </div>
          <div>
            <label className="label-sm">
              Ergebnis (EUR){' '}
              <span className="text-disabled font-normal">
                — positiv = Nachzahlung, negativ = Erstattung
              </span>
            </label>
            <input type="number" step="0.01" name="payAmount" className="input w-full" />
          </div>
        </div>

        <div>
          <label className="label-sm">Notizen / Anmerkungen</label>
          <textarea name="reviewNotes" rows={3} className="input w-full" />
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
