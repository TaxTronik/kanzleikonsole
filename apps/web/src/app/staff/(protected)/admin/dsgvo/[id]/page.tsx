import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Download, UserX } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { updateStatusAction, anonymizeContactAction } from '../actions';
import { ExportContactButton } from './export-button';

const typeLabels: Record<string, string> = {
  ACCESS: 'Auskunft (Art. 15)',
  RECTIFICATION: 'Berichtigung (Art. 16)',
  ERASURE: 'Löschung (Art. 17)',
  RESTRICTION: 'Einschränkung (Art. 18)',
  PORTABILITY: 'Datenübertragbarkeit (Art. 20)',
  OBJECTION: 'Widerspruch (Art. 21)',
};

const subjectLabels: Record<string, string> = {
  CLIENT_CONTACT: 'Mandanten-Ansprechpartner',
  STAFF_USER: 'Mitarbeiter',
  CLIENT: 'Mandant',
  EXTERNAL: 'Extern',
};

const statusLabels: Record<string, string> = {
  RECEIVED: 'Eingegangen',
  IN_PROGRESS: 'In Bearbeitung',
  COMPLETED: 'Erledigt',
  REJECTED: 'Abgelehnt',
};

export default async function DsgvoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) {
    redirect('/staff/dashboard');
  }

  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const req = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) => tx.dsgvoRequest.findUnique({ where: { id } }),
  );

  if (!req) notFound();

  const isContactAction =
    req.subjectType === 'CLIENT_CONTACT' &&
    req.subjectRefId !== null &&
    req.status !== 'COMPLETED' &&
    req.status !== 'REJECTED';

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex items-start gap-4 mb-6">
        <Link href="/staff/admin/dsgvo" className="text-gray-400 hover:text-gray-600 mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-gray-900">{typeLabels[req.type]}</h1>
            {req.status === 'RECEIVED' && <span className="badge-yellow">{statusLabels[req.status]}</span>}
            {req.status === 'IN_PROGRESS' && <span className="badge-yellow">{statusLabels[req.status]}</span>}
            {req.status === 'COMPLETED' && <span className="badge-green">{statusLabels[req.status]}</span>}
            {req.status === 'REJECTED' && <span className="badge-gray">{statusLabels[req.status]}</span>}
          </div>
          <p className="text-gray-500 text-sm">
            {subjectLabels[req.subjectType]} · {req.subjectName} ({req.subjectEmail})
          </p>
        </div>
      </div>

      <div className="card p-6 mb-6">
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Beschreibung</h2>
        <p className="text-sm text-gray-800 whitespace-pre-wrap">{req.description}</p>

        <div className="grid grid-cols-2 gap-4 mt-4 pt-4 border-t border-gray-200 text-sm">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Frist</p>
            <p className="text-gray-900">
              {req.dueDate ? new Intl.DateTimeFormat('de-DE').format(req.dueDate) : '—'}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Eingegangen</p>
            <p className="text-gray-900">
              {new Intl.DateTimeFormat('de-DE').format(req.createdAt)}
            </p>
          </div>
        </div>
      </div>

      {/* Quick-Actions je nach Typ */}
      {req.type === 'ACCESS' && req.subjectType === 'CLIENT_CONTACT' && req.subjectRefId && (
        <div className="card p-6 mb-6 border-blue-200 bg-blue-50">
          <h2 className="text-sm font-medium text-blue-900 mb-2 flex items-center gap-2">
            <Download className="h-4 w-4" />
            Auskunft generieren
          </h2>
          <p className="text-xs text-blue-800 mb-3">
            Sammelt alle personenbezogenen Daten dieses Kontakts und gibt sie als JSON-Export zurück.
            Wird automatisch im Audit-Log dokumentiert.
          </p>
          <ExportContactButton contactId={req.subjectRefId} subjectName={req.subjectName} />
        </div>
      )}

      {req.type === 'ERASURE' && isContactAction && req.subjectRefId && (
        <div className="card p-6 mb-6 border-red-200 bg-red-50">
          <h2 className="text-sm font-medium text-red-900 mb-2 flex items-center gap-2">
            <UserX className="h-4 w-4" />
            Anonymisierung durchführen
          </h2>
          <p className="text-xs text-red-800 mb-3">
            Die personenbezogenen Felder (E-Mail, Name) werden überschrieben, der Account
            deaktiviert. <strong>Aufbewahrungspflichtige Belege bleiben unverändert</strong>
            (GoBD/AO §147).
          </p>
          <form action={anonymizeContactAction}>
            <input type="hidden" name="contactId" value={req.subjectRefId} />
            <button type="submit" className="btn-secondary text-red-700 border-red-300 hover:bg-red-100">
              <UserX className="h-4 w-4" />
              Kontakt jetzt anonymisieren
            </button>
          </form>
        </div>
      )}

      {/* Status-Update */}
      {req.status !== 'COMPLETED' && req.status !== 'REJECTED' && (
        <div className="card p-6">
          <h2 className="text-sm font-medium text-gray-900 mb-3">Bearbeitung</h2>
          <form action={updateStatusAction} className="space-y-3">
            <input type="hidden" name="requestId" value={req.id} />
            <div>
              <label className="label" htmlFor="status">Neuer Status</label>
              <select id="status" name="status" className="input" defaultValue={req.status}>
                <option value="RECEIVED">Eingegangen</option>
                <option value="IN_PROGRESS">In Bearbeitung</option>
                <option value="COMPLETED">Erledigt</option>
                <option value="REJECTED">Abgelehnt</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="notes">Notizen / Maßnahmen</label>
              <textarea
                id="notes"
                name="notes"
                rows={3}
                className="input"
                defaultValue={req.notes ?? ''}
                maxLength={5000}
              />
            </div>
            <button type="submit" className="btn-primary">Speichern</button>
          </form>
        </div>
      )}

      {req.status === 'COMPLETED' && req.notes && (
        <div className="card p-6">
          <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
            Erledigung — Notizen
          </h2>
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{req.notes}</p>
        </div>
      )}
    </div>
  );
}
