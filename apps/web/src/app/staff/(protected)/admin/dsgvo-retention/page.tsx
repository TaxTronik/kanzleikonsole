import { redirect } from 'next/navigation';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { fmtDateShort } from '@/lib/fmt';
import { findDueClientAnonymizations } from '@/server/dsgvo/client-retention';
import { ClientAnonymizeButton } from './anonymize-button';

export default async function DsgvoRetentionPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) redirect('/staff/dashboard');
  const { tenantId, staffId } = session.user;

  const due = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) => findDueClientAnonymizations(tx),
  );

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary mb-1">DSGVO-Anonymisierung (Mandanten)</h1>
        <p className="text-muted text-sm max-w-3xl">
          Beendete Mandate natürlicher Personen, deren gesetzliche Aufbewahrungsfristen
          vollständig abgelaufen sind (längste Frist: GoBD 10 Jahre nach § 147 AO ab
          Schluss des Kalenderjahres des Mandatsendes; GwG 5 Jahre). Danach entfällt
          die Rechtsgrundlage der Speicherung (DSGVO Art. 17, Art. 5 Abs. 1 lit. e) —
          Name, Adresse und Custom-Felder werden entfernt, verknüpfte Kontakte
          mit-anonymisiert. Ein Skelett-Datensatz mit Vernichtungsvermerk bleibt
          erhalten. Die Anonymisierung bestätigt der Berufsträger manuell und ist
          unwiderruflich.
        </p>
      </div>

      <div className="card overflow-hidden">
        {due.length === 0 ? (
          <div className="px-6 py-16 text-center text-muted text-sm">
            Aktuell keine anonymisierungsreifen Mandanten.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted">
                <th className="px-4 py-3 font-medium">Mandant</th>
                <th className="px-4 py-3 font-medium">Kontakte</th>
                <th className="px-4 py-3 font-medium">Mandatsende</th>
                <th className="px-4 py-3 font-medium">Frist abgelaufen</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {due.map((item) => (
                <tr key={item.clientId} className="border-b last:border-0">
                  <td className="px-4 py-3">{item.clientName}</td>
                  <td className="px-4 py-3">{item.contacts}</td>
                  <td className="px-4 py-3">{fmtDateShort(item.mandateEndedAt)}</td>
                  <td className="px-4 py-3">{fmtDateShort(item.anonymizationDeadline)}</td>
                  <td className="px-4 py-3 text-right">
                    <ClientAnonymizeButton
                      clientId={item.clientId}
                      label={item.clientName}
                      disabledReason={
                        item.openGwgItems > 0
                          ? `Erst ${item.openGwgItems} GwG-Eintr${item.openGwgItems === 1 ? 'ag' : 'äge'} vernichten (GwG-Pflichtlöschung)`
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
