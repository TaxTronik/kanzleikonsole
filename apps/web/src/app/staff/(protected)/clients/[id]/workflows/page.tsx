// =============================================================================
// /staff/clients/[id]/workflows — Mandanten-Workflows
//
// Listet aktive + erledigte Workflow-Instanzen für diesen Mandanten.
// Erlaubt das Starten neuer Workflows aus den Tenant-Vorlagen.
// Die Darstellung (laufend + Archiv) liegt in WorkflowSection — dieselbe
// Komponente nutzt der Subsumtions-Tab „Aufgaben" (kein Doppel-Code).
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Workflow } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { StartWorkflowForm } from './start-form';
import { WorkflowSection } from './workflow-section';
import { autoResumePausedWorkflows } from '@/server/workflows/auto-resume';
import { loadClientWorkflows } from '@/server/workflows/queries';

export default async function ClientWorkflowsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ filter?: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { id: clientId } = await params;
  const { tenantId, staffId } = session.user;
  const sp = await searchParams;
  const filter = (sp.filter ?? 'all') as 'all' | 'mine';

  // Lazy-Resume: pausierte Workflows, deren Timer abgelaufen ist, reaktivieren
  await autoResumePausedWorkflows(tenantId, staffId);

  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const client = await withTenantContext(ctx, (tx) =>
    tx.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } }),
  );
  if (!client) notFound();

  const { instances, templates, staffList, formTemplates, requestTemplates, emailTemplates } =
    await loadClientWorkflows(ctx, { clientId, mineStaffId: filter === 'mine' ? staffId : undefined });

  return (
    <div className="p-8 max-w-5xl">
      <Link href={`/staff/clients/${clientId}`} className="back-link">
        <ArrowLeft className="h-4 w-4" /> Zurück
      </Link>

      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="page-title">
            <Workflow className="h-6 w-6 text-brand-600" />
            Workflows
          </h1>
          <p className="text-muted text-sm">{client.name}</p>
        </div>
        <StartWorkflowForm clientId={clientId} templates={templates} staffOptions={staffList} />
      </div>

      {/* Filter-Pills */}
      <div className="flex items-center gap-2 mb-4">
        <Link
          href={`/staff/clients/${clientId}/workflows`}
          className={
            filter === 'all'
              ? 'inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-brand-600 text-white'
              : 'inline-flex items-center px-3 py-1 rounded-full text-xs text-secondary bg-gray-100 hover:bg-gray-200'
          }
        >
          Alle Workflows
        </Link>
        <Link
          href={`/staff/clients/${clientId}/workflows?filter=mine`}
          className={
            filter === 'mine'
              ? 'inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-brand-600 text-white'
              : 'inline-flex items-center px-3 py-1 rounded-full text-xs text-secondary bg-gray-100 hover:bg-gray-200'
          }
        >
          Nur meine
        </Link>
      </div>

      <WorkflowSection
        clientId={clientId}
        instances={instances}
        staffList={staffList}
        formTemplates={formTemplates}
        requestTemplates={requestTemplates}
        emailTemplates={emailTemplates}
      />
    </div>
  );
}
