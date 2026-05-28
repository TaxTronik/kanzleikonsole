// =============================================================================
// /staff/clients/[id]/workflows — Mandanten-Workflows
//
// Listet aktive + erledigte Workflow-Instanzen für diesen Mandanten.
// Erlaubt das Starten neuer Workflows aus den Tenant-Vorlagen.
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Workflow, CheckCircle2 } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { StartWorkflowForm } from './start-form';
import { WorkflowItemRow } from './item-row';
import { CancelWorkflowButton } from './cancel-button';
import { DeleteWorkflowButton } from './delete-button';
import {
  PauseWorkflowButton,
  ResumeWorkflowButton,
  RestoreWorkflowButton,
} from './pause-restore-buttons';
import { AddStepForm } from './add-step-form';
import { autoResumePausedWorkflows } from './actions';
import { TeamEditorButton } from './team-editor';

const dateFmt = new Intl.DateTimeFormat('de-DE');

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

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const client = await tx.client.findUnique({
        where: { id: clientId },
        select: { id: true, name: true },
      });
      if (!client) return null;
      const [instances, templates, staffList, formTemplates, requestTemplates, emailTemplates] = await Promise.all([
        tx.workflowInstance.findMany({
          where: {
            clientId,
            ...(filter === 'mine'
              ? {
                  OR: [
                    { startedByStaff: staffId },
                    { items: { some: { assigneeStaffId: staffId, doneAt: null } } },
                  ],
                }
              : {}),
          },
          orderBy: [{ status: 'asc' }, { startedAt: 'desc' }],
          include: {
            members: { select: { staffId: true } },
            items: {
              orderBy: { position: 'asc' },
              include: {
                skill: { select: { label: true, color: true } },
                triggeredRequests: { select: { id: true } },
                comments: {
                  orderBy: { createdAt: 'asc' },
                  select: { id: true, authorName: true, body: true, createdAt: true },
                },
                documents: {
                  orderBy: { createdAt: 'asc' },
                  select: { id: true, title: true, createdAt: true },
                },
              },
            },
          },
        }),
        tx.workflowTemplate.findMany({
          where: { active: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, _count: { select: { steps: true } } },
        }),
        tx.staffUser.findMany({
          where: { active: true },
          orderBy: { fullName: 'asc' },
          select: { id: true, fullName: true },
        }),
        tx.formTemplate.findMany({
          where: { active: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
        tx.requestTemplate.findMany({
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, name: true, category: true },
        }),
        tx.emailTemplate.findMany({
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, name: true, category: true },
        }),
      ]);
      return { client, instances, templates, staffList, formTemplates, requestTemplates, emailTemplates };
    },
  );
  if (!data) notFound();
  const { client, instances, templates, staffList, formTemplates, requestTemplates, emailTemplates } = data;

  // ACTIVE + PAUSED bilden den „laufenden" Block (oben). COMPLETED + CANCELLED gehen ins Archiv (unten).
  const active = instances.filter((i) => i.status === 'ACTIVE' || i.status === 'PAUSED');
  const done = instances.filter((i) => i.status === 'COMPLETED' || i.status === 'CANCELLED');

  return (
    <div className="p-8 max-w-5xl">
      <Link
        href={`/staff/clients/${clientId}`}
        className="back-link"
      >
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

      {active.length === 0 ? (
        <div className="card p-10 text-center mb-6">
          <p className="text-sm text-disabled">Kein laufender Workflow.</p>
        </div>
      ) : (
        <div className="space-y-6 mb-8">
          {active.map((inst) => {
            const total = inst.items.length;
            const doneCount = inst.items.filter((it) => it.doneAt).length;
            // Workflow-Team: offizielle Member-Liste + implizit alle, die in
            // Items als Assignee/Done-By auftauchen (auch Ad-hoc-Assignments
            // sollen sichtbar sein).
            const memberIds = new Set<string>(inst.members.map((m) => m.staffId));
            const involvedIds = new Set<string>(memberIds);
            for (const it of inst.items) {
              if (it.assigneeStaffId) involvedIds.add(it.assigneeStaffId);
              if (it.doneByStaff) involvedIds.add(it.doneByStaff);
            }
            const team = staffList.filter((s) => involvedIds.has(s.id));
            return (
              <div key={inst.id} className={`card overflow-hidden ${inst.status === 'PAUSED' ? 'opacity-80' : ''}`}>
                <div className="px-6 py-4 border-b border-default flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        href={`/staff/clients/${clientId}/workflows/${inst.id}`}
                        className="text-sm font-semibold text-primary hover:underline"
                      >
                        {inst.name}
                      </Link>
                      {inst.status === 'PAUSED' && (
                        <span className="text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/40 rounded px-1.5 py-0.5">
                          pausiert{inst.pausedUntil ? ` bis ${dateFmt.format(inst.pausedUntil)}` : ''}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted">
                      gestartet am {dateFmt.format(inst.startedAt)} · {doneCount}/{total} erledigt
                    </p>
                    <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                      <span className="text-[10px] uppercase tracking-wide text-disabled mr-1">Team:</span>
                      {team.map((s) => {
                        const initials = s.fullName.split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
                        return (
                          <span
                            key={s.id}
                            title={s.fullName}
                            className="inline-flex items-center justify-center h-5 min-w-5 px-1 rounded-full bg-brand-100 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300 text-[10px] font-medium"
                          >
                            {initials}
                          </span>
                        );
                      })}
                      {(inst.status === 'ACTIVE' || inst.status === 'PAUSED') && (
                        <TeamEditorButton
                          instanceId={inst.id}
                          startedByStaff={inst.startedByStaff}
                          currentMemberIds={Array.from(memberIds)}
                          staffOptions={staffList}
                        />
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {inst.status === 'ACTIVE' && (
                      <>
                        <PauseWorkflowButton instanceId={inst.id} instanceName={inst.name} />
                        <CancelWorkflowButton instanceId={inst.id} instanceName={inst.name} variant="full" />
                      </>
                    )}
                    {inst.status === 'PAUSED' && (
                      <>
                        <ResumeWorkflowButton instanceId={inst.id} />
                        <CancelWorkflowButton instanceId={inst.id} instanceName={inst.name} variant="full" />
                      </>
                    )}
                  </div>
                </div>
                <div className="px-2 py-2">
                  <ul className="divide-y divide-border-subtle">
                    {inst.items.map((it) => (
                      <WorkflowItemRow
                        key={it.id}
                        id={it.id}
                        clientId={clientId}
                        title={it.title}
                        description={it.description}
                        kind={it.kind}
                        config={(it.config ?? {}) as Record<string, unknown>}
                        n8nEvent={it.n8nEvent}
                        dueDate={it.dueDate ? it.dueDate.toISOString() : null}
                        doneAt={it.doneAt ? it.doneAt.toISOString() : null}
                        startedAt={it.startedAt ? it.startedAt.toISOString() : null}
                        notes={it.notes}
                        assigneeStaffId={it.assigneeStaffId}
                        skill={it.skill}
                        staffOptions={staffList}
                        triggeredRequestId={it.triggeredRequests[0]?.id ?? null}
                        comments={it.comments.map((c) => ({
                          id: c.id,
                          authorName: c.authorName,
                          body: c.body,
                          createdAt: c.createdAt.toISOString(),
                        }))}
                        documents={it.documents.map((d) => ({
                          id: d.id,
                          title: d.title,
                          createdAt: d.createdAt.toISOString(),
                        }))}
                      />
                    ))}
                  </ul>
                  <AddStepForm
                    instanceId={inst.id}
                    staffOptions={staffList}
                    formTemplates={formTemplates}
                    requestTemplates={requestTemplates}
                    emailTemplates={emailTemplates}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {done.length > 0 && (
        <details className="card overflow-hidden">
          <summary className="px-6 py-4 border-b border-default cursor-pointer text-sm text-secondary flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            {done.length} abgeschlossene{done.length === 1 ? 'r' : ''} / abgebrochene Workflow{done.length === 1 ? '' : 's'} — Archiv
          </summary>
          <ul className="divide-y divide-border-subtle">
            {done.map((inst) => {
              const totalI = inst.items.length;
              const doneI = inst.items.filter((it) => it.doneAt).length;
              const cancelled = inst.status === 'CANCELLED';
              return (
                <li key={inst.id} className="flex items-center justify-between gap-3 px-6 py-3 hover:bg-gray-50">
                  <Link
                    href={`/staff/clients/${clientId}/workflows/${inst.id}`}
                    className="flex-1 min-w-0 -my-3 py-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-primary truncate inline-flex items-center gap-2">
                        {inst.name}
                        {cancelled && (
                          <span className="text-[10px] font-medium uppercase tracking-wide text-red-700 dark:text-red-400 bg-red-100 dark:bg-red-900/40 rounded px-1.5 py-0.5">
                            abgebrochen
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-disabled shrink-0">
                        {doneI}/{totalI} · {inst.completedAt ? dateFmt.format(inst.completedAt) : '—'}
                      </span>
                    </div>
                  </Link>
                  {cancelled && (
                    <div className="flex items-center gap-2 shrink-0">
                      <RestoreWorkflowButton instanceId={inst.id} />
                      <DeleteWorkflowButton instanceId={inst.id} instanceName={inst.name} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
