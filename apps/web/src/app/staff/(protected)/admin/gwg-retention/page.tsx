import { redirect } from 'next/navigation';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { fmtDateShort } from '@/lib/fmt';
import { findDueGwgDeletionDocs, findDueGwgCheckDeletions } from '@/server/gwg/retention';
import { GwgDeleteButton, GwgCheckDeleteButton } from './delete-button';

const CHECK_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Entwurf',
  IN_REVIEW: 'In Prüfung',
  VERIFIED: 'Verifiziert',
  REJECTED: 'Abgelehnt',
  EXPIRED: 'Abgelaufen',
};

export default async function GwgRetentionPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) redirect('/staff/dashboard');
  const { tenantId, staffId } = session.user;

  const [due, dueChecks] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) => Promise.all([findDueGwgDeletionDocs(tx), findDueGwgCheckDeletions(tx)]),
  );

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary mb-1">GwG-Löschprüfung</h1>
        <p className="text-muted text-sm max-w-3xl">
          GwG-Belege beendeter Mandate sowie abgelehnter, abgebrochener oder abgelaufener
          Onboardings, deren gesetzliche Aufbewahrungsfrist abgelaufen ist (§ 8 Abs. 4 GwG: 5 Jahre
          ab Schluss des maßgeblichen Kalenderjahres). Die Vernichtung bestätigt der Berufsträger
          manuell und ist unwiderruflich. Ein Mandat wird über „Mandat beenden" auf der
          Mandanten-Bearbeitungsseite als beendet markiert.
        </p>
      </div>

      <h2 className="text-sm font-medium text-secondary uppercase tracking-wide mb-3">
        Datei-Belege
      </h2>
      <div className="card overflow-hidden mb-8">
        {due.length === 0 ? (
          <div className="px-6 py-16 text-center text-muted text-sm">
            Aktuell keine löschreifen GwG-Belege.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted">
                <th className="px-4 py-3 font-medium">Mandant</th>
                <th className="px-4 py-3 font-medium">Beleg</th>
                <th className="px-4 py-3 font-medium">Fristbeginn</th>
                <th className="px-4 py-3 font-medium">Frist abgelaufen</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {due.map((item) => (
                <tr key={item.documentId} className="border-b last:border-0">
                  <td className="px-4 py-3">{item.clientName}</td>
                  <td className="px-4 py-3">{item.title}</td>
                  <td className="px-4 py-3">
                    {fmtDateShort(item.retentionStartedAt)}
                    <span className="block text-xs text-muted">
                      {item.retentionReason === 'MANDATE_ENDED'
                        ? 'Mandatsende'
                        : 'beendetes Onboarding'}
                    </span>
                  </td>
                  <td className="px-4 py-3">{fmtDateShort(item.deletionDeadline)}</td>
                  <td className="px-4 py-3 text-right">
                    <GwgDeleteButton
                      documentId={item.documentId}
                      destructionPending={item.destructionPending}
                      label={`${item.clientName} — ${item.title}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2 className="text-sm font-medium text-secondary uppercase tracking-wide mb-3">
        Aufzeichnungen (DB)
      </h2>
      <p className="text-muted text-xs max-w-3xl mb-3">
        Die Aufbewahrung nach § 8 Abs. 1 und 4 GwG umfasst auch die Aufzeichnungen: wirtschaftlich
        Berechtigte werden gelöscht, Ausweis-Details und Risikoangaben entfernt. Ein
        Skelett-Datensatz (Status, Vernichtungsvermerk) bleibt als Nachweis erhalten, dass die
        Prüfung stattgefunden hat. Voraussetzung: die Datei-Belege des Mandanten sind bereits
        vernichtet.
      </p>
      <div className="card overflow-hidden">
        {dueChecks.length === 0 ? (
          <div className="px-6 py-16 text-center text-muted text-sm">
            Aktuell keine löschreifen GwG-Aufzeichnungen.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted">
                <th className="px-4 py-3 font-medium">Mandant</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Fristbeginn</th>
                <th className="px-4 py-3 font-medium">Frist abgelaufen</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {dueChecks.map((item) => (
                <tr key={item.checkId} className="border-b last:border-0">
                  <td className="px-4 py-3">{item.clientName}</td>
                  <td className="px-4 py-3">{CHECK_STATUS_LABELS[item.status] ?? item.status}</td>
                  <td className="px-4 py-3">
                    {fmtDateShort(item.retentionStartedAt)}
                    <span className="block text-xs text-muted">
                      {item.retentionReason === 'MANDATE_ENDED'
                        ? 'Mandatsende'
                        : 'beendetes Onboarding'}
                    </span>
                  </td>
                  <td className="px-4 py-3">{fmtDateShort(item.deletionDeadline)}</td>
                  <td className="px-4 py-3 text-right">
                    <GwgCheckDeleteButton
                      checkId={item.checkId}
                      label={`${item.clientName} — GwG-Prüfung (${CHECK_STATUS_LABELS[item.status] ?? item.status})`}
                      disabledReason={
                        item.openEvidenceDocs > 0
                          ? `Erst ${item.openEvidenceDocs} Datei-Beleg${item.openEvidenceDocs === 1 ? '' : 'e'} vernichten`
                          : undefined
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
