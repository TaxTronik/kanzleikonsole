import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { NewRequestForm } from './form';

export default async function NewRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const client = await tx.client.findUnique({ where: { id } });
      if (!client) return null;
      const [templates, formTemplates] = await Promise.all([
        tx.requestTemplate.findMany({
          where: { active: true },
          orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        }),
        tx.formTemplate.findMany({
          where: { active: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
      ]);
      return { client, templates, formTemplates };
    },
  );
  if (!data) notFound();
  const { client, templates, formTemplates } = data;

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
          Mandant ist nicht aktiv. Anforderungen sind erst nach abgeschlossener
          GwG-Prüfung möglich.
        </div>
      )}

      <div className="card p-6">
        <NewRequestForm
          clientId={client.id}
          disabled={!client.allowActive}
          templates={templates.map((t) => ({
            id: t.id,
            name: t.name,
            category: t.category,
            title: t.title,
            description: t.description,
            priority: t.priority,
            dueAfterDays: t.dueAfterDays,
            formTemplateId: t.formTemplateId,
          }))}
          formTemplates={formTemplates}
        />
      </div>
    </div>
  );
}
