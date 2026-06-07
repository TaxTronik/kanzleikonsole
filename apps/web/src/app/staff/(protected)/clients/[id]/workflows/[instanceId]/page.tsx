// =============================================================================
// /staff/clients/[id]/workflows/[instanceId] — Workflow-Instanz-Detail
//
// Zeigt alle Schritte mit Status, Erledigt-Datum, Bearbeiter und Notizen.
// Nutzbar für laufende UND abgeschlossene Workflows — beim Abschluss bleibt
// die komplette Historie erhalten (Items werden nicht gelöscht).
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  Workflow,
  Clock,
  User as UserIcon,
  FileText,
  Inbox,
  Mail,
  Zap,
  ListChecks,
  ExternalLink,
} from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { SkillBadge } from '@/components/skill-badge';
import { fmtDateTimeShort } from '@/lib/fmt';


const KIND_LABEL: Record<string, string> = {
  TASK: 'Aufgabe',
  DOCUMENT_UPLOAD: 'Dokument',
  CLIENT_REQUEST: 'Anforderung',
  CLIENT_FORM: 'Formular',
  CLIENT_EMAIL: 'E-Mail',
  N8N_TRIGGER: 'n8n',
};

const KIND_ICON: Record<string, typeof ListChecks> = {
  TASK: ListChecks,
  DOCUMENT_UPLOAD: FileText,
  CLIENT_REQUEST: Inbox,
  CLIENT_FORM: FileText,
  CLIENT_EMAIL: Mail,
  N8N_TRIGGER: Zap,
};

export default async function WorkflowInstanceDetail({
  params,
}: {
  params: Promise<{ id: string; instanceId: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { id: clientId, instanceId } = await params;
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const inst = await tx.workflowInstance.findUnique({
        where: { id: instanceId },
        include: {
          client: { select: { id: true, name: true } },
          template: { select: { id: true, name: true } },
          items: {
            orderBy: { position: 'asc' },
            include: {
              skill: { select: { label: true, color: true } },
              triggeredRequests: { select: { id: true, title: true, closedAt: true } },
              triggeredSubmissions: { select: { id: true, name: true, submittedAt: true } },
            },
          },
        },
      });
      if (!inst || inst.clientId !== clientId) return null;
      // Alle referenzierten Staff-IDs (Assignee, Done-By, Started-By) auflösen
      const ids = new Set<string>([inst.startedByStaff]);
      for (const it of inst.items) {
        if (it.assigneeStaffId) ids.add(it.assigneeStaffId);
        if (it.doneByStaff) ids.add(it.doneByStaff);
      }
      const staffList = await tx.staffUser.findMany({
        where: { id: { in: Array.from(ids) } },
        select: { id: true, fullName: true },
      });
      return { inst, staffList };
    },
  );
  if (!data) notFound();
  const { inst, staffList } = data;
  const staffName = new Map(staffList.map((s) => [s.id, s.fullName]));

  const total = inst.items.length;
  const doneCount = inst.items.filter((it) => it.doneAt).length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  const isCompleted = inst.status !== 'ACTIVE';

  return (
    <div className="p-8 max-w-4xl">
      <Link
        href={`/staff/clients/${clientId}/workflows`}
        className="back-link"
      >
        <ArrowLeft className="h-4 w-4" /> Zurück zu Workflows
      </Link>

      <div className="card p-6 mb-6">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-primary mb-1 flex items-center gap-2">
              <Workflow className="h-5 w-5 text-brand-600" />
              {inst.name}
            </h1>
            <p className="text-sm text-secondary">
              Mandant: <Link href={`/staff/clients/${clientId}`} className="hover:underline">{inst.client.name}</Link>
              {inst.template ? (
                <>
                  {' · '}
                  Vorlage: <Link href={`/staff/workflows/templates/${inst.template.id}`} className="hover:underline">{inst.template.name}</Link>
                </>
              ) : (
                <> · <span className="text-disabled">Eigener Workflow</span></>
              )}
            </p>
          </div>
          <div className="shrink-0 text-right">
            {isCompleted ? (
              <span className="badge-green inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                {inst.status === 'COMPLETED' ? 'Abgeschlossen' : inst.status === 'CANCELLED' ? 'Abgebrochen' : inst.status}
              </span>
            ) : (
              <span className="badge-yellow">Laufend</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 text-xs text-secondary">
          <div className="inline-flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-disabled" />
            Gestartet: <strong className="text-primary">{fmtDateTimeShort(inst.startedAt)}</strong>
          </div>
          <div className="inline-flex items-center gap-1.5">
            <UserIcon className="h-3.5 w-3.5 text-disabled" />
            Von: <strong className="text-primary">{staffName.get(inst.startedByStaff) ?? '—'}</strong>
          </div>
          {inst.completedAt && (
            <div className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              Erledigt: <strong className="text-primary">{fmtDateTimeShort(inst.completedAt)}</strong>
            </div>
          )}
        </div>

        <div className="mt-3 flex items-center gap-3">
          <div className="h-2 flex-1 rounded-full bg-gray-100 overflow-hidden">
            <div className="h-full bg-brand-600" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs text-muted shrink-0">{doneCount} / {total} erledigt</span>
        </div>

        {inst.notes && (
          <div className="mt-4 rounded-md bg-amber-50/40 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/40 p-3">
            <p className="text-xs font-semibold text-amber-900 dark:text-amber-200 mb-1">Notiz zur Instanz</p>
            <p className="text-sm text-amber-900 dark:text-amber-100 whitespace-pre-wrap">{inst.notes}</p>
          </div>
        )}
      </div>

      {/* Items mit Verlauf */}
      <ol className="space-y-3">
        {inst.items.map((it, idx) => {
          const KindIcon = KIND_ICON[it.kind] ?? ListChecks;
          const done = Boolean(it.doneAt);
          return (
            <li key={it.id} className={`card p-4 ${done ? '' : 'border-l-4 border-l-brand-500'}`}>
              <div className="flex items-start gap-3">
                <div className="shrink-0 mt-0.5">
                  {done ? (
                    <div className="w-6 h-6 rounded-full bg-emerald-600 text-white flex items-center justify-center">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    </div>
                  ) : (
                    <div className="w-6 h-6 rounded-full border-2 border-strong flex items-center justify-center text-xs text-muted">
                      {idx + 1}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <KindIcon className="h-3.5 w-3.5 text-disabled shrink-0" />
                    <span className={done ? 'text-sm text-muted line-through' : 'text-sm font-medium text-primary'}>
                      {it.title}
                    </span>
                    {it.kind !== 'TASK' && (
                      <span className="text-[10px] font-medium uppercase tracking-wide text-muted bg-gray-100 rounded px-1.5 py-0.5">
                        {KIND_LABEL[it.kind]}
                      </span>
                    )}
                    {it.skill && <SkillBadge label={it.skill.label} color={it.skill.color} />}
                    {it.n8nEvent && (
                      <span className="text-[10px] font-medium uppercase tracking-wide text-purple-700 dark:text-purple-300 bg-purple-100 dark:bg-purple-900/40 rounded px-1.5 py-0.5 inline-flex items-center gap-0.5">
                        <Zap className="h-2.5 w-2.5" />
                        {it.n8nEvent}
                      </span>
                    )}
                  </div>
                  {it.description && (
                    <p className="text-xs text-secondary mt-1 whitespace-pre-wrap">{it.description}</p>
                  )}

                  {/* Verlauf-Zeile */}
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
                    {it.assigneeStaffId && (
                      <span>Zuständig: <strong className="text-secondary">{staffName.get(it.assigneeStaffId) ?? '—'}</strong></span>
                    )}
                    {it.startedAt && !done && (
                      <span>Angestoßen {fmtDateTimeShort(it.startedAt)}</span>
                    )}
                    {it.doneAt && (
                      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="h-3 w-3" />
                        Erledigt {fmtDateTimeShort(it.doneAt)}
                        {it.doneByStaff && <span>· {staffName.get(it.doneByStaff) ?? '—'}</span>}
                      </span>
                    )}
                    {!it.doneAt && !it.startedAt && (
                      <span className="inline-flex items-center gap-1 text-disabled">
                        <Circle className="h-3 w-3" /> Offen
                      </span>
                    )}
                  </div>

                  {/* Verknüpfte Anforderungen / Submissions */}
                  {it.triggeredRequests.length > 0 && (
                    <div className="mt-2 text-xs">
                      {it.triggeredRequests.map((r) => (
                        <Link
                          key={r.id}
                          href={`/staff/requests/${r.id}`}
                          className="inline-flex items-center gap-1 text-brand-700 dark:text-brand-300 hover:underline mr-3"
                        >
                          <Inbox className="h-3 w-3" />
                          {r.title}
                          {r.closedAt && <span className="text-disabled">(geschlossen {fmtDateTimeShort(r.closedAt)})</span>}
                          <ExternalLink className="h-2.5 w-2.5" />
                        </Link>
                      ))}
                    </div>
                  )}
                  {it.triggeredSubmissions.length > 0 && (
                    <div className="mt-2 text-xs">
                      {it.triggeredSubmissions.map((s) => (
                        <span key={s.id} className="inline-flex items-center gap-1 text-secondary mr-3">
                          <FileText className="h-3 w-3" />
                          Formular „{s.name}"
                          {s.submittedAt && <span className="text-emerald-700 dark:text-emerald-400">(ausgefüllt {fmtDateTimeShort(s.submittedAt)})</span>}
                        </span>
                      ))}
                    </div>
                  )}

                  {it.notes && (
                    <div className="mt-2 rounded-md bg-surface-raised border border-subtle p-2">
                      <p className="text-xs text-secondary whitespace-pre-wrap">{it.notes}</p>
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
