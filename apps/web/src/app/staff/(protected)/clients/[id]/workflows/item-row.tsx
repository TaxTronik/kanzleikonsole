'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Check, User, Play, Mail, FileText, Inbox, ListChecks, Zap, ExternalLink } from 'lucide-react';
import { SkillBadge } from '@/components/skill-badge';
import { toggleItemDoneAction, setItemAssigneeAction, setItemDueDateAction, executeItemAction } from './actions';
import { WorkflowUploadButton } from './workflow-upload-button';
import { WorkflowItemComments } from './comments';
import { HandoverButton } from './handover-button';

type StepKind =
  | 'TASK'
  | 'DOCUMENT_UPLOAD'
  | 'CLIENT_REQUEST'
  | 'CLIENT_FORM'
  | 'CLIENT_EMAIL'
  | 'N8N_TRIGGER';

const KIND_ICON: Record<StepKind, typeof ListChecks> = {
  TASK: ListChecks,
  DOCUMENT_UPLOAD: FileText,
  CLIENT_REQUEST: Inbox,
  CLIENT_FORM: FileText,
  CLIENT_EMAIL: Mail,
  N8N_TRIGGER: Zap,
};

const KIND_LABEL: Record<StepKind, string> = {
  TASK: 'Aufgabe',
  DOCUMENT_UPLOAD: 'Dokument hochladen',
  CLIENT_REQUEST: 'Anforderung erzeugen',
  CLIENT_FORM: 'Formular senden',
  CLIENT_EMAIL: 'E-Mail senden',
  N8N_TRIGGER: 'n8n-Webhook auslösen',
};

interface Skill { label: string; color: string | null; }
interface StaffOption { id: string; fullName: string; }

interface Props {
  id: string;
  clientId: string;
  title: string;
  description: string | null;
  kind: StepKind;
  config: Record<string, unknown>;
  n8nEvent: string | null;
  dueDate: string | null;
  doneAt: string | null;
  startedAt: string | null;
  notes: string | null;
  assigneeStaffId: string | null;
  skill: Skill | null;
  staffOptions: StaffOption[];
  triggeredRequestId: string | null;
  comments: { id: string; authorName: string; body: string; createdAt: string }[];
  documents: { id: string; title: string; createdAt: string }[];
}

const dateFmt = new Intl.DateTimeFormat('de-DE');

export function WorkflowItemRow(p: Props) {
  const [done, setDone] = useState(Boolean(p.doneAt));
  const [started, setStarted] = useState(Boolean(p.startedAt));
  const [assignee, setAssignee] = useState(p.assigneeStaffId ?? '');
  const [triggeredRequestId, setTriggeredRequestId] = useState<string | null>(p.triggeredRequestId);
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  function toggle() {
    setError(null);
    const next = !done;
    setDone(next);
    start(async () => {
      await toggleItemDoneAction({ id: p.id, done: next });
    });
  }

  function execute() {
    setError(null);
    start(async () => {
      const r = await executeItemAction({ id: p.id });
      if (!r.ok) { setError(r.error ?? 'Aktion fehlgeschlagen.'); return; }
      if (r.itemMarkedDone) setDone(true);
      else setStarted(true);
      if (r.createdRequestId) setTriggeredRequestId(r.createdRequestId);
    });
  }

  function changeAssignee(value: string) {
    setAssignee(value);
    start(async () => {
      await setItemAssigneeAction({ id: p.id, staffId: value || null });
    });
  }

  const [dueDateIso, setDueDateIso] = useState(p.dueDate ? p.dueDate.slice(0, 10) : '');
  const [editingDue, setEditingDue] = useState(false);
  const dueDateObj = dueDateIso ? new Date(dueDateIso + 'T00:00:00') : null;
  const overdue = !done && dueDateObj && dueDateObj.getTime() < Date.now();
  const KindIcon = KIND_ICON[p.kind];

  function saveDue(value: string) {
    const next = value || null;
    setDueDateIso(value);
    setEditingDue(false);
    start(async () => {
      await setItemDueDateAction({ id: p.id, dueDate: next });
    });
  }

  // Wann zeigen wir den Häkchen-Checkmark vs. einen Action-Button?
  const isTaskLike = p.kind === 'TASK';
  const isUpload = p.kind === 'DOCUMENT_UPLOAD';
  const waitsForExternal = (p.kind === 'CLIENT_REQUEST' || p.kind === 'CLIENT_FORM') && started && !done;
  // Upload bekommt seinen eigenen Inline-Button — kein generischer „Anstoßen"
  const canExecute = !started && !done && !isTaskLike && !isUpload;
  // Upload bleibt immer möglich (auch nach Erledigung) — Mitarbeiter kann
  // weitere Dateien nachreichen.
  const canUpload = isUpload;

  return (
    <li className="px-4 py-3 flex items-start gap-3">
      {/* Linke Spalte: Status-Anzeige */}
      <button
        type="button"
        onClick={toggle}
        disabled={isPending || (!isTaskLike && !done)}
        className={
          done
            ? 'mt-0.5 w-5 h-5 rounded border-2 border-emerald-600 bg-emerald-600 text-white flex items-center justify-center shrink-0'
            : 'mt-0.5 w-5 h-5 rounded border-2 border-gray-300 hover:border-brand-600 shrink-0 disabled:cursor-not-allowed disabled:opacity-50'
        }
        aria-label={done ? 'Erledigt — klicken zum Zurücksetzen' : 'Als erledigt markieren'}
        title={isTaskLike ? 'Manuelle Aufgabe — direkt abhaken' : done ? 'Erledigt — zum Zurücksetzen klicken' : 'Diese Art Schritt wird über den Button rechts angestoßen'}
      >
        {done && <Check className="h-3 w-3" />}
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <KindIcon className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          <p className={done ? 'text-sm text-gray-400 line-through' : 'text-sm font-medium text-gray-900'}>
            {p.title}
          </p>
          {!isTaskLike && (
            <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500 bg-gray-100 dark:bg-gray-800 rounded px-1.5 py-0.5">
              {KIND_LABEL[p.kind]}
            </span>
          )}
          {p.n8nEvent && (
            <span className="text-[10px] font-medium uppercase tracking-wide text-purple-700 dark:text-purple-300 bg-purple-100 dark:bg-purple-900/40 rounded px-1.5 py-0.5 inline-flex items-center gap-0.5">
              <Zap className="h-2.5 w-2.5" />
              {p.n8nEvent}
            </span>
          )}
          {p.skill && <SkillBadge label={p.skill.label} color={p.skill.color} />}
          {/* Fälligkeit — Klick öffnet Datum-Picker (Inline-Override pro Item) */}
          {editingDue ? (
            <input
              type="date"
              value={dueDateIso}
              onChange={(e) => saveDue(e.target.value)}
              onBlur={() => setEditingDue(false)}
              autoFocus
              className="text-xs border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 bg-white dark:bg-gray-900"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingDue(true)}
              className={
                overdue
                  ? 'text-xs text-red-700 font-medium hover:underline cursor-pointer'
                  : 'text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:underline cursor-pointer'
              }
              title="Klicken, um Frist zu ändern"
            >
              {dueDateObj ? `fällig ${dateFmt.format(dueDateObj)}` : '+ Frist setzen'}
            </button>
          )}
        </div>
        {p.description && !done && (
          <p className="text-xs text-gray-500 mt-1">{p.description}</p>
        )}
        {waitsForExternal && (
          <p className="text-xs text-amber-700 dark:text-amber-400 mt-1 inline-flex items-center gap-1">
            wartet —
            {triggeredRequestId && (
              <Link href={`/staff/requests/${triggeredRequestId}`} className="hover:underline inline-flex items-center gap-0.5">
                Anforderung öffnen <ExternalLink className="h-3 w-3" />
              </Link>
            )}
            {!triggeredRequestId && p.kind === 'DOCUMENT_UPLOAD' && <span>Dokument-Upload offen</span>}
          </p>
        )}
        {error && <p className="text-xs text-red-700 mt-1">{error}</p>}
        {p.documents.length > 0 && (
          <div className="mt-2 space-y-1">
            <p className="text-[10px] uppercase tracking-wide text-gray-400">
              Hochgeladene Dateien ({p.documents.length})
            </p>
            <ul className="space-y-0.5">
              {p.documents.map((d) => (
                <li key={d.id} className="flex items-center gap-2 text-xs">
                  <FileText className="h-3 w-3 text-gray-400 shrink-0" />
                  <Link
                    href={`/staff/documents/${d.id}`}
                    className="text-brand-700 dark:text-brand-300 hover:underline truncate flex-1"
                  >
                    {d.title}
                  </Link>
                  <span className="text-[10px] text-gray-400 shrink-0">
                    {new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(d.createdAt))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <WorkflowItemComments itemId={p.id} initial={p.comments} />
      </div>

      {/* Rechte Spalte: Action-Button + Assignee */}
      <div className="shrink-0 flex items-center gap-2">
        {canExecute && (
          <button
            type="button"
            onClick={execute}
            disabled={isPending}
            className="btn-secondary text-xs inline-flex items-center gap-1"
            title="Schritt anstoßen"
          >
            <Play className="h-3 w-3" />
            {isPending ? 'Läuft…' : 'Anstoßen'}
          </button>
        )}
        {canUpload && (
          <WorkflowUploadButton
            itemId={p.id}
            clientId={p.clientId}
            itemTitle={p.title}
            expectedClassification={String(p.config['expectedClassification'] ?? 'GENERAL')}
            onUploaded={() => {
              if (!done) {
                setDone(true);
                // Item als erledigt markieren — idempotent, mehrfacher Aufruf schadet nicht
                start(async () => {
                  await toggleItemDoneAction({ id: p.id, done: true });
                });
              }
            }}
            buttonLabel={p.documents.length === 0 ? 'Hochladen' : 'Weitere Datei'}
          />
        )}
        <User className="h-3.5 w-3.5 text-gray-400" />
        <select
          value={assignee}
          onChange={(e) => changeAssignee(e.target.value)}
          className="text-xs border border-gray-200 rounded px-2 py-1 bg-white dark:bg-gray-900 dark:border-gray-700"
          disabled={isPending}
        >
          <option value="">— niemand —</option>
          {p.staffOptions.map((s) => (
            <option key={s.id} value={s.id}>{s.fullName}</option>
          ))}
        </select>
        {!done && (
          <HandoverButton
            itemId={p.id}
            currentAssigneeStaffId={p.assigneeStaffId}
            itemTitle={p.title}
            staffOptions={p.staffOptions}
          />
        )}
      </div>
    </li>
  );
}
