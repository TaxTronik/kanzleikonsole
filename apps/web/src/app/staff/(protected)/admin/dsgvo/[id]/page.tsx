import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Download, UserX } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { updateStatusAction, anonymizeContactAction } from '../actions';
import { ExportContactButton } from './export-button';
import { fmtDateShort } from '@/lib/fmt';

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

export default async function DsgvoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) {
    redirect('/staff/dashboard');
  }

  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const req = await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, (tx) =>
    tx.dsgvoRequest.findUnique({ where: { id } }),
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
        <Link href="/staff/admin/dsgvo" className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-primary">{typeLabels[req.type]}</h1>
            {req.status === 'RECEIVED' && (
              <span className="badge-yellow">{statusLabels[req.status]}</span>
            )}
            {req.status === 'IN_PROGRESS' && (
              <span className="badge-yellow">{statusLabels[req.status]}</span>
            )}
            {req.status === 'COMPLETED' && (
              <span className="badge-green">{statusLabels[req.status]}</span>
            )}
            {req.status === 'REJECTED' && (
              <span className="badge-gray">{statusLabels[req.status]}</span>
            )}
          </div>
          <p className="text-muted text-sm">
            {subjectLabels[req.subjectType]} · {req.subjectName} ({req.subjectEmail})
          </p>
        </div>
      </div>

      <div className="card p-6 mb-6">
        <h2 className="text-xs font-medium text-muted uppercase tracking-wide mb-2">
          Beschreibung
        </h2>
        <p className="text-sm text-primary whitespace-pre-wrap">{req.description}</p>

        <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-default text-sm">
          <div>
            <p className="eyebrow">Frist</p>
            <p className="text-primary">{req.dueDate ? fmtDateShort(req.dueDate) : '—'}</p>
          </div>
          <div>
            <p className="eyebrow">Eingegangen</p>
            <p className="text-primary">{fmtDateShort(req.receivedAt)}</p>
          </div>
          <div>
            <p className="eyebrow">Im System erfasst</p>
            <p className="text-primary">{fmtDateShort(req.createdAt)}</p>
          </div>
        </div>
      </div>

      {/* Quick-Actions je nach Typ */}
      {(req.type === 'ACCESS' || req.type === 'PORTABILITY') &&
        req.subjectType === 'CLIENT_CONTACT' &&
        req.subjectRefId && (
          <div className="card p-6 mb-6 border-blue-200 bg-blue-50">
            <h2 className="text-sm font-medium text-blue-900 mb-2 flex items-center gap-2">
              <Download className="h-4 w-4" />
              Datenpaket generieren
            </h2>
            <p className="text-xs text-blue-800 mb-3">
              Sammelt sicher bzw. heuristisch zugeordnete Daten, Art.-15-Verarbeitungsinformationen
              und den personenbezogenen Audit-Ausschnitt als gehashtes JSON-Paket. Vor Herausgabe
              ist eine personelle Vollständigkeits- und Drittdatenprüfung zwingend.
            </p>
            <ExportContactButton
              requestId={req.id}
              contactId={req.subjectRefId}
              subjectName={req.subjectName}
            />
            {req.resultPreparedAt && (
              <div className="text-xs text-blue-900 mt-3">
                <p>
                  Letztes Paket erzeugt am {fmtDateShort(req.resultPreparedAt)} ·{' '}
                  {req.resultReviewedAt ? 'personell geprüft' : 'Prüfung noch offen'}
                </p>
                {req.resultSha256 && (
                  <p className="font-mono mt-1">
                    SHA-256: {Buffer.from(req.resultSha256).toString('hex')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

      {req.type === 'ERASURE' && isContactAction && req.subjectRefId && (
        <div className="card p-6 mb-6 border-red-200 bg-red-50">
          <h2 className="text-sm font-medium text-red-900 mb-2 flex items-center gap-2">
            <UserX className="h-4 w-4" />
            Portal-Kontakt anonymisieren (Teilschritt)
          </h2>
          <p className="text-xs text-red-800 mb-3">
            Kontaktstammdaten werden anonymisiert, der Zugang und offene Links gesperrt. Das ersetzt
            nicht die Datenklassenprüfung: Vollmachten, Einwilligungsnachweise, Freitexte, Dokumente
            und gesetzlich aufbewahrungspflichtige Daten sind separat zu löschen, einzuschränken
            oder mit der einschlägigen Ausnahme zu dokumentieren.
          </p>
          <form action={anonymizeContactAction}>
            <input type="hidden" name="contactId" value={req.subjectRefId} />
            <button
              type="submit"
              className="btn-secondary text-red-700 border-red-300 hover:bg-red-100"
            >
              <UserX className="h-4 w-4" />
              Portal-Kontakt jetzt anonymisieren
            </button>
          </form>
        </div>
      )}

      {/* Status-Update */}
      {req.status !== 'COMPLETED' && req.status !== 'REJECTED' && (
        <div className="card p-6">
          <h2 className="text-sm font-medium text-primary mb-3">Bearbeitung</h2>
          <form action={updateStatusAction} className="space-y-3">
            <input type="hidden" name="requestId" value={req.id} />
            <div>
              <label className="label" htmlFor="status">
                Neuer Status
              </label>
              <select id="status" name="status" className="input" defaultValue={req.status}>
                <option value="RECEIVED">Eingegangen</option>
                <option value="IN_PROGRESS">In Bearbeitung</option>
                <option value="COMPLETED">Erledigt</option>
                <option value="REJECTED">Abgelehnt</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="notes">
                Notizen / Maßnahmen
              </label>
              <textarea
                id="notes"
                name="notes"
                rows={3}
                className="input"
                defaultValue={req.notes ?? ''}
                maxLength={5000}
              />
              <p className="text-xs text-muted mt-1">
                Für „Erledigt“ müssen die konkret durchgeführten Maßnahmen dokumentiert sein.
              </p>
            </div>
            {(req.type === 'ACCESS' || req.type === 'PORTABILITY') && (
              <>
                <div>
                  <label className="label" htmlFor="resultDocumentId">
                    Ergebnisdokument-ID{' '}
                    <span className="text-muted font-normal">
                      (alternativ zum generierten JSON)
                    </span>
                  </label>
                  <input
                    id="resultDocumentId"
                    name="resultDocumentId"
                    className="input"
                    defaultValue={req.resultDocumentId ?? ''}
                    placeholder="UUID eines im System hinterlegten Ergebnisdokuments"
                  />
                </div>
                <label className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                  <input
                    type="checkbox"
                    name="resultReviewConfirmed"
                    className="mt-0.5"
                    defaultChecked={req.resultReviewedAt !== null}
                  />
                  <span>
                    Ich habe Datenklassen, Freitexte, Dokumentinhalte, mögliche Drittdaten,
                    Empfänger und fallbezogene Aufbewahrungsfristen personell auf Vollständigkeit
                    geprüft. Die Prüfung zunächst im Status „In Bearbeitung“ speichern; erst danach
                    versenden und abschließen.
                  </span>
                </label>
              </>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="responseSentAt">
                  Antwort versandt am
                </label>
                <input id="responseSentAt" name="responseSentAt" type="date" className="input" />
              </div>
              <div>
                <label className="label" htmlFor="responseMethod">
                  Antwortweg
                </label>
                <input
                  id="responseMethod"
                  name="responseMethod"
                  className="input"
                  maxLength={200}
                  placeholder="z. B. Mandantenportal / Einschreiben"
                />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="rejectionReason">
                Ablehnungsbegründung
              </label>
              <textarea
                id="rejectionReason"
                name="rejectionReason"
                rows={3}
                className="input"
                maxLength={5000}
                placeholder="Zwingend bei Status „Abgelehnt“"
              />
            </div>
            <label className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <input type="checkbox" name="rejectionNoticeComplete" className="mt-0.5" />
              <span>
                Bei Ablehnung enthält die versandte Mitteilung die Gründe sowie Hinweise auf das
                Beschwerderecht bei einer Aufsichtsbehörde und auf einen gerichtlichen Rechtsbehelf
                (Art. 12 Abs. 4 DSGVO).
              </span>
            </label>
            <p className="text-xs text-muted">
              „Erledigt“ und „Abgelehnt“ verlangen Versandtag und Antwortweg; Auskunft/Portabilität
              zusätzlich ein Ergebnis und eine zuvor gespeicherte personelle Prüfung. Bei Ablehnung
              sind Begründung und Rechtsbehelfshinweise Pflicht.
            </p>
            <button type="submit" className="btn-primary">
              Speichern
            </button>
          </form>
        </div>
      )}

      {(req.status === 'COMPLETED' || req.status === 'REJECTED') && (
        <div className="card p-6">
          <h2 className="text-xs font-medium text-muted uppercase tracking-wide mb-2">
            Abschlussnachweis
          </h2>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="eyebrow">Antwort versandt</dt>
              <dd>{req.responseSentAt ? fmtDateShort(req.responseSentAt) : '—'}</dd>
            </div>
            <div>
              <dt className="eyebrow">Antwortweg</dt>
              <dd>{req.responseMethod ?? '—'}</dd>
            </div>
          </dl>
          {req.rejectionReason && (
            <div className="mt-4">
              <p className="eyebrow">Ablehnungsbegründung</p>
              <p className="text-sm text-secondary whitespace-pre-wrap">{req.rejectionReason}</p>
            </div>
          )}
          {req.notes && (
            <div className="mt-4">
              <p className="eyebrow">Notizen / Maßnahmen</p>
              <p className="text-sm text-secondary whitespace-pre-wrap">{req.notes}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
