// =============================================================================
// WorkflowSection — der laufende + archivierte Workflow-Block.
//
// Aus clients/[id]/workflows/page.tsx herausgelöst, damit der Sachverhalt-Tab
// „Aufgaben" (subsumtion) exakt dieselbe Darstellung wiederverwendet (kein
// Doppel-Code). Reiner Render — Daten kommen aus loadClientWorkflows. Die
// StartWorkflowForm platziert der Aufrufer selbst (mit/ohne analysisId-Scope).
// =============================================================================

import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import { WorkflowItemRow } from './item-row';
import { CancelWorkflowButton } from './cancel-button';
import { DeleteWorkflowButton } from './delete-button';
import {
  PauseWorkflowButton,
  ResumeWorkflowButton,
  RestoreWorkflowButton,
} from './pause-restore-buttons';
import { AddStepForm } from './add-step-form';
import { TeamEditorButton } from './team-editor';
import { fmtDateShort } from '@/lib/fmt';
import type { ClientWorkflowsData } from '@/server/workflows/queries';

export function WorkflowSection({
  clientId,
  instances,
  staffList,
  formTemplates,
  requestTemplates,
  emailTemplates,
  emptyHint = 'Kein laufender Workflow.',
}: {
  clientId: string;
  instances: ClientWorkflowsData['instances'];
  staffList: ClientWorkflowsData['staffList'];
  formTemplates: ClientWorkflowsData['formTemplates'];
  requestTemplates: ClientWorkflowsData['requestTemplates'];
  emailTemplates: ClientWorkflowsData['emailTemplates'];
  emptyHint?: string;
}) {
  // ACTIVE + PAUSED bilden den „laufenden" Block (oben). COMPLETED + CANCELLED gehen ins Archiv (unten).
  const active = instances.filter((i) => i.status === 'ACTIVE' || i.status === 'PAUSED');
  const done = instances.filter((i) => i.status === 'COMPLETED' || i.status === 'CANCELLED');

  return (
    <>
      {active.length === 0 ? (
        <div className="card p-10 text-center mb-6">
          <p className="text-sm text-disabled">{emptyHint}</p>
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
              <div
                key={inst.id}
                className={`card overflow-hidden ${inst.status === 'PAUSED' ? 'opacity-80' : ''}`}
              >
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
                          pausiert{inst.pausedUntil ? ` bis ${fmtDateShort(inst.pausedUntil)}` : ''}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted">
                      gestartet am {fmtDateShort(inst.startedAt)} · {doneCount}/{total} erledigt
                    </p>
                    <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                      <span className="text-[10px] uppercase tracking-wide text-disabled mr-1">
                        Team:
                      </span>
                      {team.map((s) => {
                        const initials = s.fullName
                          .split(/\s+/)
                          .slice(0, 2)
                          .map((p) => p[0])
                          .join('')
                          .toUpperCase();
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
                        <CancelWorkflowButton
                          instanceId={inst.id}
                          instanceName={inst.name}
                          variant="full"
                        />
                      </>
                    )}
                    {inst.status === 'PAUSED' && (
                      <>
                        <ResumeWorkflowButton instanceId={inst.id} />
                        <CancelWorkflowButton
                          instanceId={inst.id}
                          instanceName={inst.name}
                          variant="full"
                        />
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
            {done.length} abgeschlossene{done.length === 1 ? 'r' : ''} / abgebrochene Workflow
            {done.length === 1 ? '' : 's'} — Archiv
          </summary>
          <ul className="divide-y divide-border-subtle">
            {done.map((inst) => {
              const totalI = inst.items.length;
              const doneI = inst.items.filter((it) => it.doneAt).length;
              const cancelled = inst.status === 'CANCELLED';
              return (
                <li
                  key={inst.id}
                  className="flex items-center justify-between gap-3 px-6 py-3 hover:bg-gray-50"
                >
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
                        {doneI}/{totalI} · {inst.completedAt ? fmtDateShort(inst.completedAt) : '—'}
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
    </>
  );
}
