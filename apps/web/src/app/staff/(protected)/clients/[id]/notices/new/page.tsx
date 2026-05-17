import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
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

export default async function NewNoticePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { id: clientId } = await params;
  const { tenantId, staffId } = session.user;

  const client = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) => tx.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } }),
  );
  if (!client) notFound();

  return (
    <div className="p-8 max-w-2xl">
      <Link
        href={`/staff/clients/${clientId}/notices`}
        className="text-sm text-gray-500 hover:text-gray-900 inline-flex items-center gap-1 mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Zurück
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Bescheid erfassen</h1>
        <p className="text-gray-500 text-sm">{client.name}</p>
      </div>

      <form action={createNoticeAction} className="card p-6 space-y-4">
        <input type="hidden" name="clientId" value={clientId} />

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Bescheid-Art *</label>
            <select name="kind" required className="input w-full">
              {KIND_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Periode * <span className="text-gray-400 font-normal">(z. B. 2025 oder 2025-Q3 oder 2025-09)</span>
            </label>
            <input name="period" required maxLength={20} className="input w-full" placeholder="2025" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Bescheid-Datum *</label>
            <input type="date" name="noticeDate" required className="input w-full" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Aktenzeichen FA</label>
            <input name="fileNumber" maxLength={100} className="input w-full" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Festgesetzt (EUR)</label>
            <input type="number" step="0.01" name="assessedAmount" className="input w-full" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Erwartet/Geschätzt (EUR) <span className="text-gray-400 font-normal">— für Soll/Ist-Vergleich</span>
            </label>
            <input type="number" step="0.01" name="expectedAmount" className="input w-full" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Vorausgezahlt (EUR)</label>
            <input type="number" step="0.01" name="prepaidAmount" className="input w-full" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Ergebnis (EUR) <span className="text-gray-400 font-normal">— positiv = Nachzahlung, negativ = Erstattung</span>
            </label>
            <input type="number" step="0.01" name="payAmount" className="input w-full" />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Notizen / Anmerkungen</label>
          <textarea name="reviewNotes" rows={3} className="input w-full" />
        </div>

        <div className="flex justify-end gap-2">
          <Link href={`/staff/clients/${clientId}/notices`} className="btn-secondary">Abbrechen</Link>
          <button type="submit" className="btn-primary">Bescheid speichern</button>
        </div>
      </form>
    </div>
  );
}
