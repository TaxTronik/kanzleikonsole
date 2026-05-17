import { redirect } from 'next/navigation';
import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { readPortalFeatures } from '@/server/settings/portal-features';
import { StammdatenForm } from './form';

export default async function PortalStammdatenPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');
  const { tenantId, contactId, clientId } = session.user;
  const features = await readPortalFeatures({ tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' });
  if (!features.stammdatenSelfService) redirect('/portal/dashboard');

  const [client, requests] = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    async (tx) =>
      Promise.all([
        tx.client.findUnique({
          where: { id: clientId },
          select: {
            id: true, name: true, street: true, postalCode: true,
            city: true, countryIso: true, vatId: true, invoiceEmail: true,
          },
        }),
        tx.clientMasterChangeRequest.findMany({
          where: { clientId },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      ]),
  );
  if (!client) redirect('/portal/dashboard');

  const pending = requests.find((r) => r.status === 'PENDING');

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Stammdaten</h1>
      <p className="text-gray-500 text-sm mb-6">
        Hier können Sie Änderungen an Ihren Stammdaten vorschlagen. Jede
        Änderung wird von Ihrer Kanzlei geprüft und nach Bestätigung
        übernommen.
      </p>

      {pending && (
        <div className="card p-4 mb-6 bg-yellow-50/60 border-yellow-200">
          <div className="flex items-start gap-2">
            <Clock className="h-4 w-4 text-yellow-700 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-yellow-900">
                Änderung in Prüfung
              </p>
              <p className="text-yellow-800 text-xs mt-1">
                Eingereicht am{' '}
                {new Intl.DateTimeFormat('de-DE', {
                  dateStyle: 'short',
                  timeStyle: 'short',
                }).format(pending.createdAt)}
                . Weitere Änderungen sind erst nach Entscheidung möglich.
              </p>
            </div>
          </div>
        </div>
      )}

      <StammdatenForm
        clientId={client.id}
        current={{
          name: client.name,
          street: client.street ?? '',
          postalCode: client.postalCode ?? '',
          city: client.city ?? '',
          countryIso: client.countryIso ?? 'DE',
          vatId: client.vatId ?? '',
          invoiceEmail: client.invoiceEmail ?? '',
        }}
        disabled={Boolean(pending)}
      />

      {requests.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-medium text-gray-900 mb-3">Verlauf</h2>
          <ul className="space-y-2">
            {requests.map((r) => (
              <li key={r.id} className="card p-3 text-sm">
                <div className="flex items-start gap-2">
                  <StatusIcon status={r.status} />
                  <div className="flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-gray-900">
                        {statusLabel(r.status)}
                      </span>
                      <span className="text-xs text-gray-400">
                        {new Intl.DateTimeFormat('de-DE', {
                          dateStyle: 'short',
                        }).format(r.createdAt)}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {summarize(r.fields)}
                    </p>
                    {r.decisionNote && (
                      <p className="text-xs text-gray-700 mt-1 italic">
                        „{r.decisionNote}"
                      </p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'APPROVED') return <CheckCircle2 className="h-4 w-4 text-emerald-700 mt-0.5" />;
  if (status === 'REJECTED') return <XCircle className="h-4 w-4 text-red-700 mt-0.5" />;
  return <Clock className="h-4 w-4 text-gray-400 mt-0.5" />;
}

function statusLabel(s: string): string {
  switch (s) {
    case 'PENDING': return 'In Prüfung';
    case 'APPROVED': return 'Genehmigt';
    case 'REJECTED': return 'Abgelehnt';
    case 'WITHDRAWN': return 'Zurückgezogen';
    default: return s;
  }
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  street: 'Straße',
  postalCode: 'PLZ',
  city: 'Ort',
  countryIso: 'Land',
  vatId: 'USt-ID',
  invoiceEmail: 'Rechnungs-Mail',
};

function summarize(fields: unknown): string {
  if (typeof fields !== 'object' || !fields) return '';
  const keys = Object.keys(fields as Record<string, unknown>);
  if (keys.length === 0) return '';
  return keys.map((k) => FIELD_LABELS[k] ?? k).join(', ');
}
