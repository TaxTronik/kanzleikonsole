import { redirect } from 'next/navigation';
import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { ArrowLeft } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { readModules } from '@/server/settings/modules';
import { NewPoaForm } from './form';
import { inaccessibleClientIdsFor } from '@/server/auth/rbac';
import { isUuid } from '@/lib/uuid';
import { resolveInitialPoaClientId } from './client-selection';
import { parsePoaCreateReturnContext } from './return-context';

type SearchParams = {
  clientId?: string;
  from?: string;
  pendingDocumentId?: string;
  uploadIntentId?: string;
};

export default async function NewPoaPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireStaffPage({ admin: true, deniedRedirect: '/staff/poa' });

  const query = await searchParams;
  const returnContext = parsePoaCreateReturnContext(query.from);
  const requestedClientId =
    typeof query.clientId === 'string' && isUuid(query.clientId) ? query.clientId : undefined;
  const pendingDocumentId =
    typeof query.pendingDocumentId === 'string' && isUuid(query.pendingDocumentId)
      ? query.pendingDocumentId
      : undefined;
  const uploadIntentId =
    typeof query.uploadIntentId === 'string' && isUuid(query.uploadIntentId)
      ? query.uploadIntentId
      : undefined;
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const modules = await readModules(ctx);
  if (modules.poaMode === 'PDF_TEMPLATE' && !pendingDocumentId && !uploadIntentId) {
    const params = new URLSearchParams();
    if (requestedClientId) params.set('clientId', requestedClientId);
    if (returnContext) params.set('from', returnContext);
    params.set('uploadIntentId', randomUUID());
    redirect(`/staff/poa/new?${params.toString()}`);
  }
  const clients = await withTenantContext(ctx, async (tx) => {
    const deniedClientIds = await inaccessibleClientIdsFor(tx, session);
    return tx.client.findMany({
      where: {
        anonymizedAt: null,
        mandateEndedAt: null,
        OR: [{ allowActive: true }, ...(requestedClientId ? [{ id: requestedClientId }] : [])],
        ...(deniedClientIds.length > 0 ? { id: { notIn: deniedClientIds } } : {}),
      },
      orderBy: { name: 'asc' },
      include: { contacts: { where: { active: true }, orderBy: { fullName: 'asc' } } },
    });
  });
  // Ein expliziter Onboarding-Kontext darf niemals still auf den alphabetisch
  // ersten anderen Mandanten zurueckfallen. Der angeforderte Mandant bleibt
  // auch vor der finalen Aktivierung auswaehlbar; unzugaengliche/falsche IDs
  // enden dagegen mit einer klaren Meldung.
  const { initialClientId, requestedClientAvailable } = resolveInitialPoaClientId(
    clients,
    requestedClientId,
  );
  const onboardingClientId =
    returnContext === 'onboarding' && requestedClientId === initialClientId
      ? initialClientId
      : undefined;

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex items-start gap-4 mb-6">
        <Link
          href={
            onboardingClientId
              ? `/staff/clients/onboarding/${onboardingClientId}?step=poa`
              : '/staff/poa'
          }
          aria-label="Zurück"
          className="text-disabled hover:text-secondary mt-1"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-bold text-primary">Neue Vollmacht</h1>
      </div>

      {modules.poaMode === 'OFF' ? (
        <div className="card p-8 text-center text-sm text-muted">
          Das Vollmachten-Modul ist deaktiviert (Einstellungen &rarr; Module).
        </div>
      ) : query.clientId && !requestedClientAvailable ? (
        <div className="alert-error-sm">
          Der aus dem Onboarding übergebene Mandant ist nicht mehr vorhanden oder für Sie nicht
          zugaenglich. Es wurde kein anderer Mandant vorausgewaehlt.
        </div>
      ) : clients.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">
          Keine aktiven Mandanten. Bitte zuerst GwG-Prüfung abschließen.
        </div>
      ) : (
        <NewPoaForm
          poaMode={modules.poaMode}
          initialClientId={initialClientId}
          initialPendingDocumentId={pendingDocumentId}
          uploadIntentId={uploadIntentId}
          returnContext={onboardingClientId ? returnContext : undefined}
          clients={clients.map((c) => ({
            id: c.id,
            name: c.name,
            contacts: c.contacts.map((ct) => ({
              id: ct.id,
              fullName: ct.fullName,
              email: ct.email,
            })),
          }))}
        />
      )}
    </div>
  );
}
