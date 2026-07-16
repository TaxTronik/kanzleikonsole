import { notFound } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { NewRequestForm } from './form';
import { readRequestCreationOptionsTx } from '@/server/request-creation-options';

export default async function NewRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireStaffPage();

  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const client = await tx.client.findUnique({ where: { id } });
      if (!client) return null;
      const creationOptions = await readRequestCreationOptionsTx(tx);
      return { client, ...creationOptions };
    },
  );
  if (!data) notFound();
  const { client, requestTemplates, requestFormTemplates, templatesLimited, formTemplatesLimited } =
    data;

  return (
    <div className="p-8 max-w-2xl">
      <div className="flex items-start gap-4 mb-8">
        <Link
          href={`/staff/clients/${client.id}`}
          className="text-disabled hover:text-secondary mt-1"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Neue Anforderung</h1>
          <p className="text-muted text-sm">an {client.name}</p>
        </div>
      </div>

      {!client.allowActive && (
        <div className="rounded-md bg-yellow-50 p-4 text-sm text-yellow-800 mb-4">
          Mandant ist nicht aktiv. Anforderungen sind erst nach abgeschlossener GwG-Prüfung möglich.
        </div>
      )}

      <div className="card p-6">
        <NewRequestForm
          requestId={randomUUID()}
          clientId={client.id}
          disabled={!client.allowActive}
          templates={requestTemplates}
          formTemplates={requestFormTemplates}
          templatesLimited={templatesLimited}
          formTemplatesLimited={formTemplatesLimited}
        />
      </div>
    </div>
  );
}
